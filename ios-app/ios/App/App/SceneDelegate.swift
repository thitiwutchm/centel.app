import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        // CentelViewController (NativeTabs.swift) registers the app's own plugins.
        window?.rootViewController = CentelViewController()
        window?.makeKeyAndVisible()

        // Opened by tapping the widget: the page is not loaded yet, so it asks for this later.
        if let url = connectionOptions.urlContexts.first?.url, let link = WidgetDataPlugin.link(from: url) {
            WidgetDataPlugin.pending = link
        }

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        if let url = URLContexts.first?.url, let link = WidgetDataPlugin.link(from: url) {
            let vc = window?.rootViewController as? CAPBridgeViewController
            vc?.webView?.evaluateJavaScript("window.centelWidgetOpen && window.centelWidgetOpen('\(link)')")
            return
        }
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func sceneDidEnterBackground(_ scene: UIScene) {
        PhotoSlipsBackground.schedule()
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
