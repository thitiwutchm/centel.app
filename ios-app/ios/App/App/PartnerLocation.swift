import Capacitor
import CoreLocation
import Foundation
import MapKit
import Security
import UIKit

// Partner location (แชร์ตำแหน่งกับคู่). With "Always" location access, iOS wakes the app
// (or relaunches it, even after it was closed) on significant location changes, roughly
// every 500 m, using cell towers and Wi-Fi rather than GPS, so it costs little battery.
// Each new place is named on the phone with Apple's geocoder and posted straight to
// /api/location/ping with the app's own key (from /api/location/token), because the web
// page is not running in the background and the cookie lives in the web view.
// The server answers 410 once sharing is turned off anywhere; the watcher stops then.
// The page (partnerloc.js) starts and stops it and asks for one place on demand.

@objc(PartnerLocationPlugin)
public class PartnerLocationPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "PartnerLocationPlugin"
    public let jsName = "PartnerLocation"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "now", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openSettings", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "showMap", returnType: CAPPluginReturnPromise),
    ]

    // -> { on, access, userId, precise }
    @objc func status(_ call: CAPPluginCall) {
        DispatchQueue.main.async { call.resolve(PartnerLocationAgent.shared.statusDict()) }
    }

    // { token, url, userId }: keeps the key, asks for location access (While Using, then
    // Always), starts watching and sends the current place. -> status
    @objc func start(_ call: CAPPluginCall) {
        guard let token = call.getString("token"), !token.isEmpty,
              let url = call.getString("url"), url.hasPrefix("https://") || url.hasPrefix("http://localhost") else {
            call.reject("bad_args"); return
        }
        let userId = call.getString("userId") ?? ""
        DispatchQueue.main.async {
            PartnerLocationAgent.shared.start(token: token, url: url, userId: userId) { call.resolve($0) }
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            PartnerLocationAgent.shared.stop()
            call.resolve(PartnerLocationAgent.shared.statusDict())
        }
    }

    // Sends the current place once (the app was opened, or "อัปเดตตำแหน่งตอนนี้").
    @objc func now(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            PartnerLocationAgent.shared.sendNow()
            call.resolve(PartnerLocationAgent.shared.statusDict())
        }
    }

    // { points: [{ lat, lon, title, subtitle, me }], focus? }: both of you on Apple's map,
    // drawn by MapKit on the phone (no server, no key). `focus` is the index to zoom to.
    @objc func showMap(_ call: CAPPluginCall) {
        let raw = (call.getArray("points") ?? []).compactMap { $0 as? JSObject }
        let num: (JSValue?) -> Double? = { v in (v as? Double) ?? (v as? NSNumber)?.doubleValue ?? (v as? Int).map(Double.init) }
        let points: [PartnerMapPoint] = raw.compactMap { d in
            guard let lat = num(d["lat"]), let lon = num(d["lon"]),
                  CLLocationCoordinate2DIsValid(CLLocationCoordinate2D(latitude: lat, longitude: lon)) else { return nil }
            return PartnerMapPoint(coordinate: CLLocationCoordinate2D(latitude: lat, longitude: lon),
                                   title: d["title"] as? String ?? "", subtitle: d["subtitle"] as? String,
                                   me: d["me"] as? Bool ?? false)
        }
        guard !points.isEmpty else { call.reject("no_points"); return }
        let focus = call.getInt("focus")
        DispatchQueue.main.async {
            guard let vc = self.bridge?.viewController else { call.reject("no_view"); return }
            let map = PartnerMapController(points: points, focus: focus)
            let nav = UINavigationController(rootViewController: map)
            nav.modalPresentationStyle = .pageSheet
            if let sheet = nav.sheetPresentationController {
                sheet.detents = [.large()]
                sheet.prefersGrabberVisible = true
            }
            vc.present(nav, animated: true)
            call.resolve()
        }
    }

    @objc func openSettings(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
            call.resolve()
        }
    }
}

final class PartnerLocationAgent: NSObject, CLLocationManagerDelegate {
    static let shared = PartnerLocationAgent()

    private static let urlKey = "partnerLocation.url"
    private static let userKey = "partnerLocation.userId"
    private static let lastKey = "partnerLocation.last" // [lat, lon, time] of the last place sent
    private static let keychainAccount = "partnerLocation.token"

    private let manager = CLLocationManager()
    private let geocoder = CLGeocoder()
    private var waiters: [([String: Any]) -> Void] = []
    private var wantOne = false
    private var askedAlways = false

    private override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
        manager.pausesLocationUpdatesAutomatically = true
    }

    var isOn: Bool { UserDefaults.standard.string(forKey: Self.urlKey) != nil && Self.readToken() != nil }

    private var access: CLAuthorizationStatus { manager.authorizationStatus }

    private static func accessName(_ s: CLAuthorizationStatus) -> String {
        switch s {
        case .authorizedAlways: return "always"
        case .authorizedWhenInUse: return "whenInUse"
        case .denied: return "denied"
        case .restricted: return "restricted"
        default: return "notDetermined"
        }
    }

    func statusDict() -> [String: Any] {
        let precise = manager.accuracyAuthorization == .fullAccuracy
        return [
            "on": isOn,
            "access": Self.accessName(access),
            "userId": UserDefaults.standard.string(forKey: Self.userKey) ?? "",
            "precise": precise,
        ]
    }

    // Called at launch (AppDelegate). When iOS relaunches the app for a significant change,
    // the watcher has to be started again for the new place to be delivered.
    func resume() {
        guard isOn, access == .authorizedAlways || access == .authorizedWhenInUse else { return }
        manager.startMonitoringSignificantLocationChanges()
    }

    func start(token: String, url: String, userId: String, done: @escaping ([String: Any]) -> Void) {
        Self.saveToken(token)
        UserDefaults.standard.set(url, forKey: Self.urlKey)
        UserDefaults.standard.set(userId, forKey: Self.userKey)
        UserDefaults.standard.removeObject(forKey: Self.lastKey)
        switch access {
        case .notDetermined:
            waiters.append(done)
            manager.requestWhenInUseAuthorization()
        case .authorizedWhenInUse where !askedAlways:
            // iOS shows "Change to Always Allow?" for this (once per install).
            askedAlways = true
            waiters.append(done)
            manager.requestAlwaysAuthorization()
            answerWhenSettled()
        default:
            begin()
            done(statusDict())
        }
    }

    func stop() {
        manager.stopMonitoringSignificantLocationChanges()
        manager.stopUpdatingLocation()
        wantOne = false
        Self.deleteToken()
        UserDefaults.standard.removeObject(forKey: Self.urlKey)
        UserDefaults.standard.removeObject(forKey: Self.lastKey)
    }

    func sendNow() {
        guard isOn, access == .authorizedAlways || access == .authorizedWhenInUse else { return }
        UserDefaults.standard.removeObject(forKey: Self.lastKey)
        wantOne = true
        manager.requestLocation()
    }

    private func begin() {
        guard isOn, access == .authorizedAlways || access == .authorizedWhenInUse else { return }
        manager.startMonitoringSignificantLocationChanges()
        wantOne = true
        manager.requestLocation()
    }

    // Keeping "While Using" in the Always prompt brings no authorization callback, so the
    // answer goes out once the prompt is gone (the app is active again), or right away when
    // iOS showed no prompt at all (it is shown once per install).
    private var activeObserver: NSObjectProtocol?
    private func answerWhenSettled() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
            guard let self = self, !self.waiters.isEmpty else { return }
            if UIApplication.shared.applicationState == .active { self.answerWaiters(); return }
            if self.activeObserver != nil { return }
            self.activeObserver = NotificationCenter.default.addObserver(
                forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
                guard let self = self else { return }
                if let o = self.activeObserver { NotificationCenter.default.removeObserver(o) }
                self.activeObserver = nil
                self.answerWaiters()
            }
        }
    }

    private func answerWaiters() {
        let list = waiters
        waiters = []
        if list.isEmpty { return }
        begin()
        let st = statusDict()
        list.forEach { $0(st) }
    }

    /* ---------- CLLocationManagerDelegate ---------- */

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) { authChanged() }

    private func authChanged() {
        let s = access
        if s == .notDetermined { return }
        if s == .authorizedWhenInUse && !askedAlways && !waiters.isEmpty {
            // Allowed While Using: now ask to upgrade to Always for background updates.
            askedAlways = true
            manager.requestAlwaysAuthorization()
            answerWhenSettled()
            return
        }
        if s == .denied || s == .restricted { manager.stopMonitoringSignificantLocationChanges() }
        answerWaiters()
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let loc = locations.last, isOn else { return }
        let forced = wantOne
        wantOne = false
        // Old cached fixes (iOS can hand those over first) are skipped unless asked for one.
        if !forced && loc.timestamp.timeIntervalSinceNow < -600 { return }
        if !forced, let last = UserDefaults.standard.array(forKey: Self.lastKey) as? [Double], last.count == 3 {
            let moved = loc.distance(from: CLLocation(latitude: last[0], longitude: last[1]))
            if moved < 200 && Date().timeIntervalSince1970 - last[2] < 600 { return }
        }
        post(loc)
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        wantOne = false
    }

    /* ---------- Sending ---------- */

    private func post(_ loc: CLLocation) {
        guard let urlString = UserDefaults.standard.string(forKey: Self.urlKey), let url = URL(string: urlString),
              let token = Self.readToken() else { return }
        // A little extra time while the app is in the background for naming and posting.
        var task = UIBackgroundTaskIdentifier.invalid
        task = UIApplication.shared.beginBackgroundTask(withName: "partnerLocation") {
            UIApplication.shared.endBackgroundTask(task); task = .invalid
        }
        let finish = {
            if task != .invalid { UIApplication.shared.endBackgroundTask(task); task = .invalid }
        }
        placeName(loc) { place in
            var body: [String: Any] = [
                "lat": loc.coordinate.latitude, "lon": loc.coordinate.longitude,
                "acc": max(0, loc.horizontalAccuracy),
            ]
            if let place = place { body["place"] = place }
            var req = URLRequest(url: url, timeoutInterval: 20)
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            req.httpBody = try? JSONSerialization.data(withJSONObject: body)
            URLSession.shared.dataTask(with: req) { _, res, _ in
                let code = (res as? HTTPURLResponse)?.statusCode ?? 0
                DispatchQueue.main.async {
                    if code == 200 {
                        UserDefaults.standard.set(
                            [loc.coordinate.latitude, loc.coordinate.longitude, Date().timeIntervalSince1970], forKey: Self.lastKey)
                    } else if code == 410 || code == 401 {
                        self.stop() // sharing was turned off
                    }
                    finish()
                }
            }.resume()
        }
    }

    // "บางนา, กรุงเทพมหานคร" in Thai; the country is added when it isn't Thailand.
    private func placeName(_ loc: CLLocation, done: @escaping (String?) -> Void) {
        let handler: ([CLPlacemark]?, Error?) -> Void = { marks, _ in
            guard let p = marks?.first else { return done(nil) }
            var parts: [String] = []
            for s in [p.subLocality, p.locality, p.administrativeArea] {
                if let s = s, !s.isEmpty, !parts.contains(s), parts.count < 2 { parts.append(s) }
            }
            if let cc = p.isoCountryCode, cc != "TH", let country = p.country { parts.append(country) }
            done(parts.isEmpty ? nil : parts.joined(separator: ", "))
        }
        if geocoder.isGeocoding { geocoder.cancelGeocode() }
        geocoder.reverseGeocodeLocation(loc, preferredLocale: Locale(identifier: "th_TH"), completionHandler: handler)
    }

    /* ---------- The key, in the Keychain (readable after the first unlock, for background launches) ---------- */

    private static func baseQuery() -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "app.centel.partnerLocation",
         kSecAttrAccount as String: keychainAccount]
    }

    static func saveToken(_ token: String) {
        deleteToken()
        var q = baseQuery()
        q[kSecValueData as String] = Data(token.utf8)
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(q as CFDictionary, nil)
    }

    static func readToken() -> String? {
        var q = baseQuery()
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return nil }
        return String(data: d, encoding: .utf8)
    }

    static func deleteToken() { SecItemDelete(baseQuery() as CFDictionary) }
}

/* ---------- The map (MapKit, on the phone) ---------- */

final class PartnerMapPoint: NSObject, MKAnnotation {
    let coordinate: CLLocationCoordinate2D
    let title: String?
    let subtitle: String?
    let me: Bool
    init(coordinate: CLLocationCoordinate2D, title: String, subtitle: String?, me: Bool) {
        self.coordinate = coordinate; self.title = title; self.subtitle = subtitle; self.me = me
    }
}

final class PartnerMapController: UIViewController, MKMapViewDelegate {
    private let points: [PartnerMapPoint]
    private let focus: Int?
    private let map = MKMapView()

    init(points: [PartnerMapPoint], focus: Int?) {
        self.points = points; self.focus = focus
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "ตอนนี้อยู่ที่ไหน"
        navigationItem.leftBarButtonItem = UIBarButtonItem(systemItem: .close, primaryAction: UIAction { [weak self] _ in
            self?.dismiss(animated: true)
        })
        navigationItem.rightBarButtonItem = UIBarButtonItem(title: "เปิดใน Maps", primaryAction: UIAction { [weak self] _ in
            self?.openInMaps()
        })
        map.delegate = self
        map.translatesAutoresizingMaskIntoConstraints = false
        map.pointOfInterestFilter = .excludingAll
        map.showsCompass = true
        map.showsScale = true
        view.addSubview(map)
        NSLayoutConstraint.activate([
            map.topAnchor.constraint(equalTo: view.topAnchor),
            map.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            map.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            map.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])
        map.register(MKMarkerAnnotationView.self, forAnnotationViewWithReuseIdentifier: "p")
        map.addAnnotations(points)
        if points.count > 1 {
            let line = MKPolyline(coordinates: points.map { $0.coordinate }, count: points.count)
            map.addOverlay(line)
        }
    }

    private var placed = false
    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        guard !placed, map.bounds.width > 0 else { return }
        placed = true
        if let i = focus, i >= 0, i < points.count {
            map.setRegion(MKCoordinateRegion(center: points[i].coordinate, latitudinalMeters: 3000, longitudinalMeters: 3000), animated: false)
            map.selectAnnotation(points[i], animated: false)
        } else {
            map.showAnnotations(points, animated: false)
            if let p = points.first(where: { !$0.me }) ?? points.first { map.selectAnnotation(p, animated: false) }
        }
    }

    func mapView(_ mapView: MKMapView, viewFor annotation: MKAnnotation) -> MKAnnotationView? {
        guard let p = annotation as? PartnerMapPoint else { return nil }
        let v = mapView.dequeueReusableAnnotationView(withIdentifier: "p", for: p) as! MKMarkerAnnotationView
        v.markerTintColor = p.me ? .systemBlue : .systemPink
        v.glyphImage = UIImage(systemName: p.me ? "person.fill" : "heart.fill")
        v.canShowCallout = true
        v.displayPriority = .required
        return v
    }

    func mapView(_ mapView: MKMapView, rendererFor overlay: MKOverlay) -> MKOverlayRenderer {
        guard let line = overlay as? MKPolyline else { return MKOverlayRenderer(overlay: overlay) }
        let r = MKPolylineRenderer(polyline: line)
        r.strokeColor = UIColor.systemPink.withAlphaComponent(0.6)
        r.lineWidth = 2
        r.lineDashPattern = [4, 6]
        return r
    }

    // Both places in the Apple Maps app (for directions and the like).
    private func openInMaps() {
        let items = points.map { p -> MKMapItem in
            let item = MKMapItem(placemark: MKPlacemark(coordinate: p.coordinate))
            item.name = p.title
            return item
        }
        MKMapItem.openMaps(with: items, launchOptions: nil)
    }
}
