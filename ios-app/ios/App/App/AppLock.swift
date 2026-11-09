import UIKit
import Capacitor
import LocalAuthentication

// Face ID lock for METANG, switched on in Account › ล็อกแอปด้วย Face ID (applock.js).
// Ported from the UMAKER Portal app (BiometricLock.swift there), lock part only: Centel's
// sign-in lasts 90 days, so there is no sign-in key to keep in the Keychain.
//
// On a cold start, and when the app comes back after more than a minute away, a cover in the
// app's colours sits over the page until Face ID (or the iPhone passcode, when Face ID fails)
// unlocks it. While the app is in the background the cover also hides balances from the app
// switcher. The first time, iOS asks "Allow METANG to use Face ID?" with the text in Info.plist
// (NSFaceIDUsageDescription).
final class AppLock {
    static let shared = AppLock()

    private static let onKey = "AppLock.on"
    private static let accentKey = "AppLock.accent"
    private static let themeKey = "AppLock.theme"
    private static let languageKey = "AppLock.language"
    // Back within a minute (a quick look at LINE, a bank app to pay) and the page is just there.
    private static let grace: TimeInterval = 60

    private weak var window: UIWindow?
    private var cover: AppLockCoverView?
    private var backgroundedAt: Date?
    private var needsUnlock = false
    private var prompting = false

    private var defaults: UserDefaults { .standard }
    var enabled: Bool { defaults.bool(forKey: AppLock.onKey) }
    var thai: Bool { (defaults.string(forKey: AppLock.languageKey) ?? "th") != "en" }

    // ─── What this iPhone can do ────────────────────────────────────────────────────

    struct Capability {
        let biometry: String   // faceID, touchID, opticID, none
        let available: Bool    // ready to use now
        let reason: String?    // denied, not_enrolled, no_passcode, lockout, unavailable
    }

    func capability() -> Capability {
        let context = LAContext()
        var error: NSError?
        let ok = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)
        let biometry: String
        switch context.biometryType {
        case .faceID: biometry = "faceID"
        case .touchID: biometry = "touchID"
        default:
            if #available(iOS 17.0, *), context.biometryType == .opticID { biometry = "opticID" } else { biometry = "none" }
        }
        if ok { return Capability(biometry: biometry, available: true, reason: nil) }
        let code = LAError.Code(rawValue: error?.code ?? LAError.Code.invalidContext.rawValue) ?? .invalidContext
        let reason: String
        switch code {
        case .biometryNotEnrolled: reason = "not_enrolled"
        case .passcodeNotSet: reason = "no_passcode"
        case .biometryNotAvailable: reason = biometry == "none" ? "unavailable" : "denied"
        case .biometryLockout: reason = "lockout"
        default: reason = "unavailable"
        }
        return Capability(biometry: biometry, available: false, reason: reason)
    }

    var biometryName: String {
        switch capability().biometry {
        case "touchID": return "Touch ID"
        case "opticID": return "Optic ID"
        default: return "Face ID"
        }
    }

    func setOn(_ on: Bool) {
        defaults.set(on, forKey: AppLock.onKey)
        if !on { disarm() }
    }

    func setLook(accent: String?, theme: String?, language: String?) {
        if let accent, accent.hasPrefix("#") { defaults.set(accent, forKey: AppLock.accentKey) }
        if let theme, theme == "light" || theme == "dark" { defaults.set(theme, forKey: AppLock.themeKey) }
        if let language, language == "th" || language == "en" { defaults.set(language, forKey: AppLock.languageKey) }
        cover?.apply(look())
    }

    func look() -> AppLockCoverView.Look {
        AppLockCoverView.Look(
            accent: AppLock.color(defaults.string(forKey: AppLock.accentKey)) ?? UIColor(red: 0xf2 / 255, green: 0x7a / 255, blue: 0x1a / 255, alpha: 1),
            dark: defaults.string(forKey: AppLock.themeKey).map { $0 == "dark" },
            thai: thai,
            biometry: biometryName)
    }

    // ─── The lock ──────────────────────────────────────────────────────────────────

    // The app has just started: with the lock on, the page starts covered.
    func attach(_ window: UIWindow?) {
        self.window = window
        guard enabled else { return }
        needsUnlock = true
        showCover(locked: true)
        scheduleAutoUnlock(after: 0.35)
    }

    func didEnterBackground() {
        guard enabled else { return }
        if !needsUnlock { backgroundedAt = Date() }
        showCover(locked: needsUnlock)
    }

    func willEnterForeground() {
        guard enabled, !needsUnlock else { return }
        if let away = backgroundedAt, Date().timeIntervalSince(away) < AppLock.grace {
            hideCover()
        } else {
            needsUnlock = true
            showCover(locked: true)
        }
        backgroundedAt = nil
    }

    func didBecomeActive() {
        // A moment after the app comes forward: Face ID asked mid-transition is cancelled by iOS.
        scheduleAutoUnlock(after: 0.35)
    }

    private var sceneActive: Bool {
        if let scene = window?.windowScene { return scene.activationState == .foregroundActive }
        return UIApplication.shared.applicationState == .active
    }

    // Face ID starts by itself whenever the lock is up and the app is on screen; the button is
    // only for trying again.
    private func scheduleAutoUnlock(after delay: TimeInterval) {
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { self.unlockIfNeeded(retries: 1) }
    }

    private func unlockIfNeeded(retries: Int) {
        guard needsUnlock, !prompting, sceneActive else { return }
        prompting = true
        cover?.setLocked(false)
        let context = LAContext()
        context.localizedFallbackTitle = thai ? "ใช้รหัสเครื่อง" : "Use Passcode"
        let reason = thai ? "ปลดล็อก METANG" : "Unlock METANG"
        // .deviceOwnerAuthentication: Face ID, and the iPhone passcode when Face ID fails.
        context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { ok, error in
            DispatchQueue.main.async {
                self.prompting = false
                if ok {
                    self.needsUnlock = false
                    self.hideCover()
                    return
                }
                // Cancelled by iOS (the app was still coming forward, a call came in): ask once more.
                let code = (error as NSError?)?.code ?? 0
                if retries > 0, code == LAError.Code.systemCancel.rawValue || code == LAError.Code.appCancel.rawValue {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                        self.unlockIfNeeded(retries: retries - 1)
                        if !self.prompting && self.needsUnlock { self.cover?.setLocked(true) }
                    }
                    return
                }
                // No passcode any more (Face ID can't be used either): don't lock the person out.
                if code == LAError.Code.passcodeNotSet.rawValue {
                    self.needsUnlock = false
                    self.hideCover()
                    return
                }
                self.cover?.setLocked(true)
            }
        }
    }

    // Lock switched off: nothing stays locked.
    func disarm() {
        needsUnlock = false
        backgroundedAt = nil
        hideCover()
    }

    private func showCover(locked: Bool) {
        guard let window else { return }
        if cover == nil {
            let view = AppLockCoverView(frame: window.bounds)
            view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            view.onUnlock = { [weak self] in self?.unlockIfNeeded(retries: 0) }
            cover = view
        }
        guard let cover else { return }
        cover.apply(look())
        cover.setLocked(locked && !prompting)
        cover.alpha = 1
        if cover.superview !== window { window.addSubview(cover) }
        window.bringSubviewToFront(cover)
    }

    private func hideCover() {
        guard let cover, cover.superview != nil else { return }
        UIView.animate(withDuration: 0.25, animations: { cover.alpha = 0 }) { _ in
            if cover.alpha == 0 { cover.removeFromSuperview() }
        }
    }

    static func color(_ hex: String?) -> UIColor? {
        guard var text = hex?.trimmingCharacters(in: .whitespaces), text.hasPrefix("#") else { return nil }
        text.removeFirst()
        guard text.count == 6, let value = UInt32(text, radix: 16) else { return nil }
        return UIColor(red: CGFloat((value >> 16) & 0xff) / 255, green: CGFloat((value >> 8) & 0xff) / 255, blue: CGFloat(value & 0xff) / 255, alpha: 1)
    }
}

// The cover over the page: the app's icon and name, and a Face ID button in the theme colour.
// While the app is in the background (or Face ID is on screen) only the icon and name show.
final class AppLockCoverView: UIView {
    struct Look { let accent: UIColor; let dark: Bool?; let thai: Bool; let biometry: String }

    var onUnlock: (() -> Void)?

    private let badge = UIView()
    private let symbol = UIImageView()
    private let title = UILabel()
    private let subtitle = UILabel()
    private let unlock = UIButton(type: .system)

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .systemBackground

        badge.layer.cornerRadius = 22
        badge.layer.cornerCurve = .continuous
        badge.translatesAutoresizingMaskIntoConstraints = false
        symbol.image = UIImage(systemName: "lock.fill", withConfiguration: UIImage.SymbolConfiguration(pointSize: 34, weight: .semibold))
        symbol.tintColor = .white
        symbol.contentMode = .center
        symbol.translatesAutoresizingMaskIntoConstraints = false
        badge.addSubview(symbol)

        title.text = "METANG"
        title.font = .systemFont(ofSize: 24, weight: .bold)
        title.textColor = .label
        title.textAlignment = .center
        subtitle.font = .systemFont(ofSize: 15)
        subtitle.textColor = .secondaryLabel
        subtitle.textAlignment = .center
        subtitle.numberOfLines = 0

        unlock.titleLabel?.font = .systemFont(ofSize: 17, weight: .semibold)
        unlock.setTitleColor(.white, for: .normal)
        unlock.tintColor = .white
        unlock.layer.cornerRadius = 26
        unlock.layer.cornerCurve = .continuous
        unlock.contentEdgeInsets = UIEdgeInsets(top: 0, left: 24, bottom: 0, right: 24)
        unlock.imageEdgeInsets = UIEdgeInsets(top: 0, left: -6, bottom: 0, right: 6)
        unlock.addTarget(self, action: #selector(tapUnlock), for: .touchUpInside)
        unlock.translatesAutoresizingMaskIntoConstraints = false

        let stack = UIStackView(arrangedSubviews: [badge, title, subtitle])
        stack.axis = .vertical
        stack.alignment = .center
        stack.spacing = 14
        stack.setCustomSpacing(22, after: badge)
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        addSubview(unlock)

        NSLayoutConstraint.activate([
            badge.widthAnchor.constraint(equalToConstant: 84),
            badge.heightAnchor.constraint(equalToConstant: 84),
            symbol.centerXAnchor.constraint(equalTo: badge.centerXAnchor),
            symbol.centerYAnchor.constraint(equalTo: badge.centerYAnchor),
            stack.centerXAnchor.constraint(equalTo: centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: centerYAnchor, constant: -60),
            stack.leadingAnchor.constraint(greaterThanOrEqualTo: leadingAnchor, constant: 32),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -32),
            unlock.bottomAnchor.constraint(equalTo: safeAreaLayoutGuide.bottomAnchor, constant: -32),
            unlock.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 24),
            unlock.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -24),
            unlock.heightAnchor.constraint(equalToConstant: 52),
        ])
        setLocked(false)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func apply(_ look: Look) {
        if let dark = look.dark { overrideUserInterfaceStyle = dark ? .dark : .light } else { overrideUserInterfaceStyle = .unspecified }
        badge.backgroundColor = look.accent
        unlock.backgroundColor = look.accent
        let symbolName = look.biometry == "Touch ID" ? "touchid" : look.biometry == "Optic ID" ? "opticid" : "faceid"
        unlock.setImage(UIImage(systemName: symbolName, withConfiguration: UIImage.SymbolConfiguration(pointSize: 18, weight: .semibold)), for: .normal)
        unlock.setTitle(look.thai ? "ปลดล็อกด้วย \(look.biometry)" : "Unlock with \(look.biometry)", for: .normal)
        subtitle.text = look.thai ? "แอปถูกล็อกอยู่ ใช้ \(look.biometry) เพื่อเปิด" : "Locked. Use \(look.biometry) to open."
    }

    func setLocked(_ locked: Bool) {
        unlock.isHidden = !locked
        subtitle.isHidden = !locked
    }

    @objc private func tapUnlock() { onUnlock?() }
}

// The page's side (applock.js): Account switches the lock on and off and tells it the
// theme colour and language so the cover matches the app.
@objc(AppLockPlugin)
public class AppLockPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AppLockPlugin"
    public let jsName = "AppLock"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "enable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "disable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openSettings", returnType: CAPPluginReturnPromise),
    ]

    private func statusObject() -> [String: Any] {
        let lock = AppLock.shared
        let can = lock.capability()
        var answer: [String: Any] = ["biometry": can.biometry, "available": can.available, "enabled": lock.enabled]
        if let reason = can.reason { answer["reason"] = reason }
        return answer
    }

    @objc func status(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            AppLock.shared.setLook(accent: call.getString("accent"), theme: call.getString("theme"), language: call.getString("language"))
            call.resolve(self.statusObject())
        }
    }

    // Face ID once (iOS asks for permission the first time), then the lock is on.
    @objc func enable(_ call: CAPPluginCall) {
        let lock = AppLock.shared
        let context = LAContext()
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) else {
            call.reject("biometrics unavailable", lock.capability().reason ?? "unavailable")
            return
        }
        let reason = lock.thai ? "ยืนยันตัวตนเพื่อเปิดใช้ \(lock.biometryName)" : "Confirm to turn on \(lock.biometryName)"
        context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason) { ok, failure in
            DispatchQueue.main.async {
                guard ok else {
                    let code = LAError.Code(rawValue: (failure as NSError?)?.code ?? LAError.Code.invalidContext.rawValue) ?? .invalidContext
                    switch code {
                    case .userCancel, .appCancel, .systemCancel, .userFallback: call.reject("cancelled", "cancelled")
                    case .biometryNotAvailable: call.reject("denied", "denied")
                    case .biometryLockout: call.reject("lockout", "lockout")
                    default: call.reject("failed", "failed")
                    }
                    return
                }
                lock.setOn(true)
                call.resolve(self.statusObject())
            }
        }
    }

    @objc func disable(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            AppLock.shared.setOn(false)
            call.resolve(self.statusObject())
        }
    }

    @objc func openSettings(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
            call.resolve()
        }
    }
}
