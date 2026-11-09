#!/bin/sh
# Build an Ad Hoc .ipa for the iPhones registered at developer.apple.com > Devices
# and drop it in ../install/ for https://centel.app/install. Run on the Mac with
# Xcode signed in to the Apple ID (Settings > Accounts):
#   TEAM_ID=ABCDE12345 ./scripts/build-adhoc.sh
# Then commit install/ and push; Railway deploys it.
set -eu
: "${TEAM_ID:?set TEAM_ID (developer.apple.com > Membership details > Team ID)}"
cd "$(dirname "$0")/.."

npm install --no-audit --no-fund
npx cap sync ios

BUILD=$(date +%Y%m%d%H%M)
rm -rf build
xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Release \
  -destination generic/platform=iOS -archivePath build/Centel.xcarchive \
  DEVELOPMENT_TEAM="$TEAM_ID" CURRENT_PROJECT_VERSION="$BUILD" \
  -allowProvisioningUpdates archive

sed "s/TEAM_ID/$TEAM_ID/" ExportOptions-adhoc.plist > build/ExportOptions.plist
xcodebuild -exportArchive -archivePath build/Centel.xcarchive -exportPath build/export \
  -exportOptionsPlist build/ExportOptions.plist -allowProvisioningUpdates

cp build/export/*.ipa ../install/Centel.ipa
# Xcode writes manifest.plist with the right bundle version next to the .ipa.
# The Xcode target is named App, so put the real name back on the install sheet.
if [ -f build/export/manifest.plist ]; then
  sed 's#<string>App</string>#<string>METANG</string>#' build/export/manifest.plist > ../install/manifest.plist
fi
# The installed app compares its own build with this (applock.js › เวอร์ชันแอป) and offers
# "อัปเดต" when this one is newer. Builds are numbered by time, so larger is newer.
VERSION=$(/usr/libexec/PlistBuddy -c 'Print :ApplicationProperties:CFBundleShortVersionString' build/Centel.xcarchive/Info.plist)
printf '{ "version": "%s", "build": "%s", "created_at": "%s" }\n' "$VERSION" "$BUILD" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > ../install/build.json
echo "Built ../install/Centel.ipa (version $VERSION build $BUILD)"
