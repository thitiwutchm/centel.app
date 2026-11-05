import Capacitor
import WidgetKit

// The page (widget.js) hands over a snapshot for the Home Screen widget: this month's
// spending, the next unpaid bills and the open to-dos. It is kept in the App Group shared
// with the CentelWidget extension, which reads it on its next redraw.
// The widget's taps open centel://bills, centel://todos, centel://home or centel://add (the share extension opens centel://share); SceneDelegate
// passes them to the page, or keeps them in `pending` until the page asks.
@objc(WidgetDataPlugin)
public class WidgetDataPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "WidgetDataPlugin"
    public let jsName = "WidgetData"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pending", returnType: CAPPluginReturnPromise),
    ]

    static let group = "group.app.centel"
    static let key = "snapshot"
    static var pending: String?

    // { json: String }
    @objc func set(_ call: CAPPluginCall) {
        guard let json = call.getString("json"), json.utf8.count < 200_000 else { return call.reject("bad_json") }
        guard let store = UserDefaults(suiteName: Self.group) else { return call.reject("no_app_group") }
        store.set(json, forKey: Self.key)
        store.set(Date().timeIntervalSince1970, forKey: "savedAt")
        WidgetCenter.shared.reloadAllTimelines()
        call.resolve()
    }

    // -> { link: "bills" | "todos" | "home" | "add" | "share" | null }: a widget tap that opened the app before the page was ready.
    @objc func pending(_ call: CAPPluginCall) {
        let link = Self.pending
        Self.pending = nil
        call.resolve(["link": link as Any])
    }

    // centel://bills -> "bills"
    static func link(from url: URL) -> String? {
        guard url.scheme == "centel" else { return nil }
        let what = url.host ?? url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return ["bills", "todos", "home", "add", "share"].contains(what) ? what : "home"
    }
}
