import Capacitor
import UIKit

// Lets the person pick the Home Screen icon in Account (appicon.js): the Centel default
// or one of the alternate icons in Assets.xcassets (listed in the App target's
// ASSETCATALOG_COMPILER_ALTERNATE_APPICON_NAMES).
@objc(AppIconPlugin)
public class AppIconPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AppIconPlugin"
    public let jsName = "AppIcon"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise),
    ]

    static let icons = ["orange": "AppIcon-Orange", "green": "AppIcon-Green"]

    // -> { icon: "centel" | "orange" | "green" }
    @objc func get(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let name = UIApplication.shared.alternateIconName
            call.resolve(["icon": Self.icons.first(where: { $0.value == name })?.key ?? "centel"])
        }
    }

    // { icon: "centel" | "orange" | "green" }. iOS shows its own "You have changed the icon" alert.
    @objc func set(_ call: CAPPluginCall) {
        let want = call.getString("icon") ?? "centel"
        let name = Self.icons[want]
        DispatchQueue.main.async {
            guard UIApplication.shared.supportsAlternateIcons else { return call.reject("unsupported") }
            if UIApplication.shared.alternateIconName == name { return call.resolve(["icon": want]) }
            UIApplication.shared.setAlternateIconName(name) { error in
                if let error = error { call.reject(error.localizedDescription) } else { call.resolve(["icon": want]) }
            }
        }
    }
}
