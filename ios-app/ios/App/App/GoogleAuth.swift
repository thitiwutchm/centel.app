import AuthenticationServices
import Capacitor
import CryptoKit

// Sign in with Google for the iOS app. Google blocks its sign-in page inside a
// WKWebView, so this runs the OAuth code flow (PKCE) in the system sign-in sheet
// with Centel's iOS OAuth client and hands the page back the ID and access tokens.
@objc(GoogleAuthPlugin)
public class GoogleAuthPlugin: CAPPlugin, CAPBridgedPlugin, ASWebAuthenticationPresentationContextProviding {
    public let identifier = "GoogleAuthPlugin"
    public let jsName = "GoogleAuth"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "signIn", returnType: CAPPluginReturnPromise)
    ]

    static let clientId = "590849579351-ljsoeokcsmmsffdamqngq3k6qh45jf2r.apps.googleusercontent.com"
    static let scheme = "com.googleusercontent.apps.590849579351-ljsoeokcsmmsffdamqngq3k6qh45jf2r"
    static var redirect: String { scheme + ":/oauth2redirect" }

    private var session: ASWebAuthenticationSession?

    // { scopes?: [String], hint?: String } -> { idToken, accessToken, expiresIn, scope }
    @objc func signIn(_ call: CAPPluginCall) {
        let extra = call.getArray("scopes", String.self) ?? []
        let scope = (["openid", "email", "profile"] + extra).joined(separator: " ")
        let verifier = Self.randomToken()
        let challenge = Data(SHA256.hash(data: Data(verifier.utf8))).base64URL
        let state = Self.randomToken()

        var url = URLComponents(string: "https://accounts.google.com/o/oauth2/v2/auth")!
        url.queryItems = [
            .init(name: "client_id", value: Self.clientId),
            .init(name: "redirect_uri", value: Self.redirect),
            .init(name: "response_type", value: "code"),
            .init(name: "scope", value: scope),
            .init(name: "code_challenge", value: challenge),
            .init(name: "code_challenge_method", value: "S256"),
            .init(name: "state", value: state),
            .init(name: "include_granted_scopes", value: "true"),
            .init(name: "prompt", value: "select_account"),
        ]
        if let hint = call.getString("hint"), !hint.isEmpty { url.queryItems?.append(.init(name: "login_hint", value: hint)) }

        DispatchQueue.main.async {
            let s = ASWebAuthenticationSession(url: url.url!, callbackURLScheme: Self.scheme) { [weak self] back, error in
                self?.session = nil
                if let error = error as? ASWebAuthenticationSessionError, error.code == .canceledLogin {
                    return call.reject("canceled", "canceled")
                }
                guard error == nil, let back = back,
                      let items = URLComponents(url: back, resolvingAgainstBaseURL: false)?.queryItems else {
                    return call.reject(error?.localizedDescription ?? "no_response")
                }
                if let e = items.first(where: { $0.name == "error" })?.value { return call.reject(e, e) }
                guard items.first(where: { $0.name == "state" })?.value == state,
                      let code = items.first(where: { $0.name == "code" })?.value else {
                    return call.reject("bad_state")
                }
                Self.exchange(code: code, verifier: verifier, call: call)
            }
            s.presentationContextProvider = self
            self.session = s
            if !s.start() { self.session = nil; call.reject("cannot_start") }
        }
    }

    private static func exchange(code: String, verifier: String, call: CAPPluginCall) {
        var req = URLRequest(url: URL(string: "https://oauth2.googleapis.com/token")!)
        req.httpMethod = "POST"
        req.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        let form = ["code": code, "client_id": clientId, "redirect_uri": redirect,
                    "grant_type": "authorization_code", "code_verifier": verifier]
        req.httpBody = form.map { "\($0.key)=\(formEncode($0.value))" }.joined(separator: "&").data(using: .utf8)
        URLSession.shared.dataTask(with: req) { data, _, error in
            guard let data = data,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                return call.reject(error?.localizedDescription ?? "token_failed")
            }
            guard let idToken = json["id_token"] as? String else {
                let e = json["error"] as? String ?? "token_failed"
                return call.reject(e, e)
            }
            call.resolve([
                "idToken": idToken,
                "accessToken": json["access_token"] as? String ?? "",
                "expiresIn": json["expires_in"] as? Int ?? 3600,
                "scope": json["scope"] as? String ?? "",
            ])
        }.resume()
    }

    public func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        bridge?.viewController?.view.window ?? ASPresentationAnchor()
    }

    private static func randomToken() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return Data(bytes).base64URL
    }

    private static func formEncode(_ s: String) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        return s.addingPercentEncoding(withAllowedCharacters: allowed) ?? s
    }
}

private extension Data {
    var base64URL: String {
        base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
