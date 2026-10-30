# Centel iOS app

A Capacitor 8 shell that opens https://centel.app inside a native iOS app.
The web app stays the single source of truth: deploy to Railway and the iOS
app picks it up on next launch, with no App Store update needed.

- Bundle ID: `app.centel` · name: Centel · iPhone only, portrait · iOS 15+
- `capacitor.config.json` points `server.url` at https://centel.app.
  `www/offline.html` shows when there is no network.
- Native plugins: push notifications (APNs), haptics, app lifecycle.
- Swift Package Manager (no CocoaPods).

## Build on the Mac

Needs Xcode 16+ and Node 22.

```sh
cd ios-app
npm install
npx cap sync ios
npx cap open ios        # opens ios/App/App.xcodeproj in Xcode
```

In Xcode: App target → Signing & Capabilities → pick your Team.
Push Notifications is already on via `App/App.entitlements`.
Plug in the iPhone and press Run, or Product → Archive to upload to
TestFlight / App Store Connect.

## Before App Store review (still to do)

1. **Native push**: Web Push does not run inside the app. Register the APNs
   token from `@capacitor/push-notifications` with the api and send through
   APNs with a `.p8` key from the Apple Developer account.
2. **Google sign-in**: Google blocks its sign-in page inside an embedded web
   view. Use a native Google sign-in plugin and pass the ID token to the
   existing `/api` Google login. The same applies to Gmail AutoSync.
3. **Sign in with Apple**: required by App Store rule 4.8 when Google sign-in
   is offered.
4. **Delete account** inside the app (rule 5.1.1(v)) and a **privacy policy**
   URL.
