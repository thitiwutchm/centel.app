import UIKit
import Capacitor

// Main.storyboard uses this instead of CAPBridgeViewController. It hides the web
// view's scroll indicators and owns the native tab bar (Liquid Glass on iOS 26)
// that replaces the web page's own .tabbar when the page asks for it.
class CentelViewController: CAPBridgeViewController, UITabBarDelegate {
    private let tabBar = UITabBar()
    private var tabIds: [String] = []

    override func capacitorDidLoad() {
        webView?.scrollView.showsVerticalScrollIndicator = false
        webView?.scrollView.showsHorizontalScrollIndicator = false
        bridge?.registerPluginInstance(NativeTabsPlugin())
        bridge?.registerPluginInstance(GoogleAuthPlugin())
        bridge?.registerPluginInstance(WidgetDataPlugin())
        bridge?.registerPluginInstance(AppIconPlugin())
        bridge?.registerPluginInstance(ShareInboxPlugin())
        bridge?.registerPluginInstance(PhotoSlipsPlugin())
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        tabBar.delegate = self
        tabBar.isHidden = true
        tabBar.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(tabBar)
        NSLayoutConstraint.activate([
            tabBar.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            tabBar.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            tabBar.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            tabBar.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -49),
        ])
    }

    struct Tab { let id: String; let title: String; let symbol: String }

    // Called by the page through NativeTabs.sync whenever its tab, labels, theme or overlays change.
    func apply(tabs: [Tab], selected: String, visible: Bool, tint: UIColor?, dark: Bool) {
        if tabs.map({ $0.id }) != tabIds || zip(tabs, tabBar.items ?? []).contains(where: { $0.title != $1.title }) {
            tabIds = tabs.map { $0.id }
            tabBar.items = tabs.enumerated().map { i, t in
                UITabBarItem(title: t.title, image: UIImage(systemName: t.symbol), tag: i)
            }
        }
        if let i = tabIds.firstIndex(of: selected), let items = tabBar.items, i < items.count {
            tabBar.selectedItem = items[i]
        }
        tabBar.tintColor = tint
        tabBar.overrideUserInterfaceStyle = dark ? .dark : .light
        guard tabBar.isHidden == visible else { return }
        if visible { tabBar.alpha = 0; tabBar.isHidden = false }
        UIView.animate(withDuration: 0.2, animations: { self.tabBar.alpha = visible ? 1 : 0 },
                       completion: { _ in if !visible { self.tabBar.isHidden = true } })
    }

    func tabBar(_ tabBar: UITabBar, didSelect item: UITabBarItem) {
        guard item.tag < tabIds.count else { return }
        UISelectionFeedbackGenerator().selectionChanged()
        let id = tabIds[item.tag].replacingOccurrences(of: "'", with: "")
        webView?.evaluateJavaScript("window.centelNativeTab && window.centelNativeTab('\(id)')")
    }
}

@objc(NativeTabsPlugin)
public class NativeTabsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativeTabsPlugin"
    public let jsName = "NativeTabs"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "sync", returnType: CAPPluginReturnPromise)
    ]

    // { tabs: [{id, title, symbol}], selected, visible, tint: "#rrggbb", dark }
    @objc func sync(_ call: CAPPluginCall) {
        let tabs = (call.getArray("tabs") ?? []).compactMap { v -> CentelViewController.Tab? in
            guard let o = v as? JSObject, let id = o["id"] as? String else { return nil }
            return .init(id: id, title: o["title"] as? String ?? id, symbol: o["symbol"] as? String ?? "circle")
        }
        let selected = call.getString("selected") ?? ""
        let visible = call.getBool("visible") ?? true
        let tint = call.getString("tint").flatMap(UIColor.init(hex:))
        let dark = call.getBool("dark") ?? true
        DispatchQueue.main.async {
            guard let vc = self.bridge?.viewController as? CentelViewController else { return call.reject("no_view") }
            vc.apply(tabs: tabs, selected: selected, visible: visible, tint: tint, dark: dark)
            call.resolve()
        }
    }
}

private extension UIColor {
    convenience init?(hex: String) {
        let s = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        guard s.count == 6, let v = UInt32(s, radix: 16) else { return nil }
        self.init(red: CGFloat((v >> 16) & 0xff) / 255, green: CGFloat((v >> 8) & 0xff) / 255, blue: CGFloat(v & 0xff) / 255, alpha: 1)
    }
}
