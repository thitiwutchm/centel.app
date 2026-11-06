import BackgroundTasks
import Capacitor
import Foundation
import Photos
import UserNotifications
import UIKit
import Vision

// Slips from Photos (ดึงสลิปจากรูปภาพ). With the person's permission, new pictures in the
// photo library are checked here, on the iPhone, with Apple's text recognition (Vision):
// a picture counts as a slip when it has a money amount (like 1,250.00), many numbers, and
// slip words (บาท, โอนเงิน, THB, Ref, Total…) or a QR code. Only those pictures leave the phone:
// the page (photoslips.js) asks for each one and sends it to AI Slips, and the result waits
// on Home for the person to approve. Every other picture is never read by anything but Vision.
//
// The plugin remembers how far it has checked (`since`, the creation date of the last picture
// looked at), so each picture is checked once. Turning the feature off forgets it.
@objc(PhotoSlipsPlugin)
public class PhotoSlipsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "PhotoSlipsPlugin"
    public let jsName = "PhotoSlips"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "enable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "disable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "scan", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "image", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openSettings", returnType: CAPPluginReturnPromise),
    ]

    static let sinceKey = "photoSlips.since"
    private let queue = DispatchQueue(label: "app.centel.photoslips", qos: .userInitiated)

    private var since: Date? {
        get { UserDefaults.standard.object(forKey: Self.sinceKey) as? Date }
        set { UserDefaults.standard.set(newValue, forKey: Self.sinceKey) }
    }

    private static func accessName(_ s: PHAuthorizationStatus) -> String {
        switch s {
        case .authorized: return "authorized"
        case .limited: return "limited"
        case .denied: return "denied"
        case .restricted: return "restricted"
        default: return "notDetermined"
        }
    }

    private func statusDict() -> [String: Any] {
        let access = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        return [
            "access": Self.accessName(access),
            "on": since != nil,
            "since": since.map { Int($0.timeIntervalSince1970 * 1000) as Any } ?? NSNull(),
        ]
    }

    // -> { access, on, since }
    @objc func status(_ call: CAPPluginCall) {
        if let l = call.getString("lang") { UserDefaults.standard.set(l, forKey: PhotoSlipsBackground.langKey) }
        call.resolve(statusDict())
    }

    // { days }: asks for Photos access, then starts checking pictures from `days` days ago.
    @objc func enable(_ call: CAPPluginCall) {
        let days = max(0, min(30, call.getInt("days") ?? 3))
        PHPhotoLibrary.requestAuthorization(for: .readWrite) { s in
            DispatchQueue.main.async {
                if s == .authorized || s == .limited {
                    if self.since == nil {
                        self.since = Date().addingTimeInterval(-Double(days) * 86400)
                    }
                    PhotoSlipsBackground.schedule()
                }
                call.resolve(self.statusDict())
            }
        }
    }

    @objc func disable(_ call: CAPPluginCall) {
        since = nil
        UserDefaults.standard.removeObject(forKey: Self.foundKey)
        call.resolve(statusDict())
    }

    // Opens this app's page in iOS Settings (to allow Photos after saying no).
    @objc func openSettings(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
            call.resolve()
        }
    }

    // { max } -> { slips: [{ id, created, score, amount }], checked, more }
    // Slips found in the background since last time, then up to `max` more pictures newer
    // than `since` checked now, oldest first. `since` moves past every picture checked.
    @objc func scan(_ call: CAPPluginCall) {
        let limit = max(1, min(60, call.getInt("max") ?? 30))
        queue.async {
            let r = Self.check(limit: limit, seconds: 25)
            let slips = Self.takeFound() + r.slips
            call.resolve(["slips": slips, "checked": r.checked, "more": r.more, "busy": r.busy])
        }
    }

    /* ---------- The check itself, shared with the background task ---------- */

    private static let lock = NSLock()
    private static var busy = false
    static let foundKey = "photoSlips.found"

    // Checks pictures newer than `since` (at most `limit`, for about `seconds`), moving `since`
    // past each one. `stop` is asked between pictures (the background task's time running out).
    static func check(limit: Int, seconds: TimeInterval, stop: () -> Bool = { false })
        -> (slips: [[String: Any]], checked: Int, more: Bool, busy: Bool) {
        let access = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        guard let from = UserDefaults.standard.object(forKey: sinceKey) as? Date,
              access == .authorized || access == .limited else { return ([], 0, false, false) }
        lock.lock()
        if busy { lock.unlock(); return ([], 0, true, true) }
        busy = true
        lock.unlock()
        defer { lock.lock(); busy = false; lock.unlock() }

        let opts = PHFetchOptions()
        opts.predicate = NSPredicate(format: "creationDate > %@", from as NSDate)
        opts.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: true)]
        opts.fetchLimit = limit + 1
        let assets = PHAsset.fetchAssets(with: .image, options: opts)
        var slips: [[String: Any]] = []
        var checked = 0
        let started = Date()
        for i in 0..<min(assets.count, limit) {
            // Keep each pass short; the rest is checked on the next one.
            if Date().timeIntervalSince(started) > seconds || stop() { break }
            let a = assets.object(at: i)
            checked += 1
            autoreleasepool {
                if let img = load(a, side: 1400) {
                    let r = looksLikeSlip(img)
                    if r.slip {
                        slips.append([
                            "id": a.localIdentifier,
                            "created": Int((a.creationDate ?? Date()).timeIntervalSince1970 * 1000),
                            "score": r.score,
                            "amount": r.amount.map { $0 as Any } ?? NSNull(),
                        ])
                    }
                }
            }
            // Turned off meanwhile: leave it off.
            if let made = a.creationDate, UserDefaults.standard.object(forKey: sinceKey) != nil {
                UserDefaults.standard.set(made, forKey: sinceKey)
            }
        }
        return (slips, checked, checked < assets.count, false)
    }

    // Slips the background task found, waiting for the page; taking them clears the list.
    static func takeFound() -> [[String: Any]] {
        lock.lock(); defer { lock.unlock() }
        let list = UserDefaults.standard.array(forKey: foundKey) as? [[String: Any]] ?? []
        UserDefaults.standard.removeObject(forKey: foundKey)
        return list
    }

    static func addFound(_ slips: [[String: Any]]) {
        guard !slips.isEmpty else { return }
        lock.lock(); defer { lock.unlock() }
        var list = UserDefaults.standard.array(forKey: foundKey) as? [[String: Any]] ?? []
        // Only plist types are kept (no NSNull).
        list += slips.map { s in s.filter { !($0.value is NSNull) } }
        UserDefaults.standard.set(Array(list.suffix(100)), forKey: foundKey)
    }

    static var waitingCount: Int {
        (UserDefaults.standard.array(forKey: foundKey) ?? []).count
    }

    // { id } -> { image: base64 JPEG (long side 1600) | null }
    @objc func image(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else { return call.reject("no_id") }
        queue.async {
            let found = PHAsset.fetchAssets(withLocalIdentifiers: [id], options: nil).firstObject
            guard let a = found, let img = Self.load(a, side: 1600),
                  let jpg = img.jpegData(compressionQuality: 0.85) else {
                return call.resolve(["image": NSNull()])
            }
            call.resolve(["image": jpg.base64EncodedString()])
        }
    }

    // The picture at most `side` points on its long side. Runs off the main thread.
    private static func load(_ a: PHAsset, side: CGFloat) -> UIImage? {
        let o = PHImageRequestOptions()
        o.isSynchronous = true
        o.deliveryMode = .highQualityFormat
        o.resizeMode = .fast
        o.isNetworkAccessAllowed = true // pictures kept only in iCloud
        let k = min(1, side / CGFloat(max(a.pixelWidth, a.pixelHeight, 1)))
        let size = CGSize(width: CGFloat(a.pixelWidth) * k, height: CGFloat(a.pixelHeight) * k)
        var out: UIImage?
        PHImageManager.default().requestImage(for: a, targetSize: size, contentMode: .aspectFit, options: o) { img, _ in
            out = img
        }
        return out
    }

    static let words = [
        "บาท", "โอนเงิน", "โอน", "สำเร็จ", "จำนวนเงิน", "ค่าธรรมเนียม", "เลขที่รายการ", "รหัสอ้างอิง",
        "พร้อมเพย์", "ยอดชำระ", "ยอดรวม", "รวมทั้งสิ้น", "ใบเสร็จ", "ชำระ", "ผู้รับ", "ธนาคาร", "สลิป",
        "thb", "baht", "transfer", "successful", "amount", "fee", "ref", "promptpay", "total",
        "receipt", "vat", "subtotal", "paid", "payment", "k plus", "scb", "krungthai", "grab", "line man",
    ]

    // Vision reads the picture's text; a slip has a money amount, plenty of numbers, and slip
    // words or a QR code. -> (slip, score, the biggest amount seen)
    static func looksLikeSlip(_ img: UIImage) -> (slip: Bool, score: Int, amount: Double?) {
        guard let cg = img.cgImage else { return (false, 0, nil) }
        let text = VNRecognizeTextRequest()
        text.recognitionLevel = .accurate
        text.usesLanguageCorrection = false
        let langs = (try? text.supportedRecognitionLanguages()) ?? []
        text.recognitionLanguages = ["th-TH", "en-US"].filter { langs.contains($0) }
        let qr = VNDetectBarcodesRequest()
        qr.symbologies = [.qr]
        let handler = VNImageRequestHandler(cgImage: cg, orientation: cgOrientation(img.imageOrientation), options: [:])
        try? handler.perform([text, qr])

        let lines = (text.results ?? []).compactMap { $0.topCandidates(1).first?.string }
        let all = lines.joined(separator: "\n")
        let low = all.lowercased()
        let numbers = matches(#"\d[\d,]*(?:\.\d+)?"#, in: all)
        let moneys = matches(#"(?<![\d.])\d{1,3}(?:,\d{3})*\.\d{2}(?![\d])|(?<![\d.,])\d+\.\d{2}(?![\d])"#, in: all)
            .compactMap { Double($0.replacingOccurrences(of: ",", with: "")) }
        let hits = words.filter { low.contains($0) }.count
        let hasQR = !(qr.results ?? []).isEmpty

        var score = min(numbers.count, 20) + hits * 3 + (hasQR ? 5 : 0) + (moneys.isEmpty ? 0 : 5)
        if lines.count > 120 { score -= 10 } // a page of text (a document, a chat) rather than a slip
        let slip = !moneys.isEmpty && numbers.count >= 6 && (hits >= 1 || hasQR || numbers.count >= 12) && score >= 15
        return (slip, score, moneys.max())
    }

    private static func matches(_ pattern: String, in s: String) -> [String] {
        guard let re = try? NSRegularExpression(pattern: pattern) else { return [] }
        let ns = s as NSString
        return re.matches(in: s, range: NSRange(location: 0, length: ns.length)).map { ns.substring(with: $0.range) }
    }

    private static func cgOrientation(_ o: UIImage.Orientation) -> CGImagePropertyOrientation {
        switch o {
        case .up: return .up
        case .down: return .down
        case .left: return .left
        case .right: return .right
        case .upMirrored: return .upMirrored
        case .downMirrored: return .downMirrored
        case .leftMirrored: return .leftMirrored
        case .rightMirrored: return .rightMirrored
        @unknown default: return .up
        }
    }
}

// Checking in the background (Background Tasks). iOS picks the moments itself: a short app
// refresh now and then, and a longer run mostly at night while charging. Each run checks new
// pictures on the phone the same way, keeps the slips it finds for the page (scan() hands them
// over) and posts a notification "พบสลิปใหม่ N ใบ". Reading them with AI Slips waits until the
// app is opened, because that goes through the signed-in page.
enum PhotoSlipsBackground {
    static let refreshId = "app.centel.photoslips.refresh"
    static let processId = "app.centel.photoslips.process"
    static let langKey = "photoSlips.lang"

    private final class Flag { var stop = false }

    // From application(_:didFinishLaunchingWithOptions:), before launch ends.
    static func register() {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: refreshId, using: nil) { handle($0, seconds: 25) }
        BGTaskScheduler.shared.register(forTaskWithIdentifier: processId, using: nil) { handle($0, seconds: 240) }
    }

    // When the app goes to the background, and after each run: ask iOS for the next ones.
    static func schedule() {
        guard UserDefaults.standard.object(forKey: PhotoSlipsPlugin.sinceKey) != nil else { return }
        let r = BGAppRefreshTaskRequest(identifier: refreshId)
        r.earliestBeginDate = Date(timeIntervalSinceNow: 30 * 60)
        try? BGTaskScheduler.shared.submit(r)
        let p = BGProcessingTaskRequest(identifier: processId)
        p.requiresNetworkConnectivity = false
        p.requiresExternalPower = false
        p.earliestBeginDate = Date(timeIntervalSinceNow: 60 * 60)
        try? BGTaskScheduler.shared.submit(p)
    }

    private static func handle(_ task: BGTask, seconds: TimeInterval) {
        schedule()
        let flag = Flag()
        task.expirationHandler = { flag.stop = true }
        DispatchQueue.global(qos: .utility).async {
            let before = PhotoSlipsPlugin.waitingCount
            var found: [[String: Any]] = []
            let started = Date()
            while !flag.stop {
                let left = seconds - Date().timeIntervalSince(started)
                if left < 4 { break }
                let r = PhotoSlipsPlugin.check(limit: 60, seconds: left - 3, stop: { flag.stop })
                found += r.slips
                if !r.more || r.busy || r.checked == 0 { break }
            }
            PhotoSlipsPlugin.addFound(found)
            if !found.isEmpty { notify(before + found.count) }
            task.setTaskCompleted(success: true)
        }
    }

    private static func notify(_ n: Int) {
        let center = UNUserNotificationCenter.current()
        center.getNotificationSettings { st in
            guard st.authorizationStatus == .authorized || st.authorizationStatus == .provisional else { return }
            let en = UserDefaults.standard.string(forKey: langKey) == "en"
            let c = UNMutableNotificationContent()
            c.title = en ? "New slips in Photos" : "พบสลิปใหม่ในรูปภาพ"
            c.body = en ? "\(n) slip\(n == 1 ? "" : "s") waiting. Tap to read and approve" : "\(n) ใบรอยืนยัน แตะเพื่อให้ AI อ่านและยืนยันรายการ"
            c.sound = .default
            c.userInfo = ["url": "/"]
            // One notification, replaced as more are found.
            center.add(UNNotificationRequest(identifier: "photoslips", content: c, trigger: nil))
        }
    }
}
