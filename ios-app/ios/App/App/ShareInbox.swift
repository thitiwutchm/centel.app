import Capacitor
import Foundation

// Pictures shared to Centel from the iOS share sheet (CentelShare extension) wait as JPEG files
// in the App Group's Inbox folder. The page (share.js) takes them here, oldest first, and opens
// a new purchase read by AI Slips. A taken file is deleted, so each picture is used once.
@objc(ShareInboxPlugin)
public class ShareInboxPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ShareInboxPlugin"
    public let jsName = "ShareInbox"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "take", returnType: CAPPluginReturnPromise),
    ]

    static let group = "group.app.centel"
    // Older than this, a picture is from a share long ago that never reached the page: dropped.
    static let maxAge: TimeInterval = 24 * 3600

    // -> { image: base64 JPEG | null, sharedAt: ms | null }: the oldest waiting picture.
    @objc func take(_ call: CAPPluginCall) {
        let fm = FileManager.default
        guard let base = fm.containerURL(forSecurityApplicationGroupIdentifier: Self.group) else {
            return call.resolve(["image": NSNull(), "sharedAt": NSNull()])
        }
        let dir = base.appendingPathComponent("Inbox", isDirectory: true)
        let files = ((try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.creationDateKey])) ?? [])
            .filter { $0.pathExtension.lowercased() == "jpg" }
            .map { url -> (URL, Date) in
                let made = (try? url.resourceValues(forKeys: [.creationDateKey]).creationDate) ?? Date()
                return (url, made)
            }
            .sorted { $0.1 < $1.1 }
        let now = Date()
        for (url, made) in files {
            defer { try? fm.removeItem(at: url) }
            if now.timeIntervalSince(made) > Self.maxAge { continue }
            guard let data = try? Data(contentsOf: url) else { continue }
            return call.resolve(["image": data.base64EncodedString(), "sharedAt": Int(made.timeIntervalSince1970 * 1000)])
        }
        call.resolve(["image": NSNull(), "sharedAt": NSNull()])
    }
}
