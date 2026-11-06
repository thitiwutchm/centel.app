# Centel iOS app

A Capacitor 8 shell that opens https://centel.app inside a native iOS app.
The web app stays the single source of truth: deploy to Railway and the iOS
app picks it up on next launch, with no App Store update needed.

- Bundle ID: `app.centel` · name: Centel · iPhone only, portrait · iOS 15+
- `capacitor.config.json` points `server.url` at https://centel.app.
  `www/offline.html` shows when there is no network.
- Native plugins: push notifications (APNs), haptics, app lifecycle, plus the app's
  own NativeTabs, GoogleAuth and WidgetData (registered in CentelViewController).
- `CentelWidget/` is a WidgetKit extension (`app.centel.widget`, iOS 17+): Home Screen
  widgets: Expenses (month spend, vs last month by today, spend line, + opens a new
  transaction), Centel (spend + upcoming bills, also Lock Screen) and to-dos.
  The page (`widget.js`) saves a snapshot into the App Group `group.app.centel`
  through WidgetData; the widget reads it. Taps open `centel://bills|todos|home|add`.
- `CentelShare/` is a Share Extension (`app.centel.share`, iOS 15+): Centel shows in the
  share sheet for one picture. It shrinks the picture, saves it in the App Group's
  `Inbox/` folder and opens `centel://share`. The page (`share.js`) takes it through the
  ShareInbox plugin (`App/ShareInbox.swift`), opens a new expense and reads it with
  AI Slips. If the app could not be opened, the picture is picked up the next time
  Centel comes to the front. The App ID `app.centel.share` needs the App Group
  `group.app.centel` on developer.apple.com, like the widget.
- Slips from Photos (`App/PhotoSlips.swift`, Account › ดึงสลิปจากรูปภาพ): with Photos access,
  each time the app comes to the front it checks new pictures on the iPhone with Vision text
  recognition. Only pictures with a money amount, many numbers and slip words (or a QR code)
  are sent to AI Slips (`photoslips.js`); the results wait on Home for approval. It remembers
  how far it has checked in UserDefaults (`photoSlips.since`).
  Background Tasks (`app.centel.photoslips.refresh` / `.process`, UIBackgroundModes fetch +
  processing) run the same check while the app is closed, keep the slips found in
  UserDefaults (`photoSlips.found`) and post a "พบสลิปใหม่" notification; AI reading waits
  for the app to open.
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

## Ad Hoc install (no App Store)

For our own iPhones: install from a Safari link, valid for a year.

1. On each iPhone open https://centel.app/udid in Safari, install the profile,
   and copy the UDID it shows. Add it at developer.apple.com > Devices.
2. On the Mac: `TEAM_ID=<your team id> ./scripts/build-adhoc.sh`. It archives,
   exports with `ExportOptions-adhoc.plist`, and writes `install/Centel.ipa`
   and `install/manifest.plist` at the repo root.
3. Commit `install/` and push. After the deploy, open https://centel.app/install
   on the iPhone and tap ติดตั้งแอป.

A newly added iPhone needs a fresh build. Web changes do not.

## Before App Store review (still to do)

1. **Native push** is done: the Account switch registers the APNs token
   (`push.js` -> `/api/push/apns`) and the api sends through APNs
   (`server/src/apns.js`). The api service needs `APNS_KEY` (the .p8 text) and
   `APNS_KEY_ID` from developer.apple.com > Keys.
2. **Google sign-in**: Google blocks its sign-in page inside an embedded web
   view. Use a native Google sign-in plugin and pass the ID token to the
   existing `/api` Google login. The same applies to Gmail AutoSync.
3. **Sign in with Apple**: required by App Store rule 4.8 when Google sign-in
   is offered.
4. **Delete account** inside the app (rule 5.1.1(v)) and a **privacy policy**
   URL.
