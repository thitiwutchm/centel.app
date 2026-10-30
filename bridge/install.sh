#!/bin/bash
# Installs the Centel bridge on this Mac and starts it at login (launchd).
#   curl -fsSL https://centel.app/bridge/install.sh | bash -s -- cb_YOUR_TOKEN
# Optional second argument: the Hermes API key (API_SERVER_KEY in ~/.hermes/.env).
set -euo pipefail

TOKEN="${1:-}"
HKEY="${2:-}"
DIR="$HOME/.centel-bridge"
ENV="$HOME/.centel-bridge.env"
PLIST="$HOME/Library/LaunchAgents/app.centel.bridge.plist"

if [[ "$TOKEN" != cb_* ]]; then
  echo "ใส่ token จาก Centel › บัญชี › ผู้ช่วย AI:  bash install.sh cb_xxxx [HERMES_KEY]" >&2
  exit 1
fi
PY="$(command -v python3 || true)"
if [ -z "$PY" ]; then echo "ต้องมี python3 (xcode-select --install)" >&2; exit 1; fi

mkdir -p "$DIR" "$HOME/Library/LaunchAgents"
curl -fsSL https://centel.app/bridge/centel_bridge.py -o "$DIR/centel_bridge.py"

# Keep an existing Hermes key when none is given.
if [ -z "$HKEY" ] && [ -f "$HOME/.hermes/.env" ]; then
  HKEY="$(grep -E '^API_SERVER_KEY=' "$HOME/.hermes/.env" | tail -1 | cut -d= -f2- | tr -d '"'"'" || true)"
fi
cat > "$ENV" <<EOF
CENTEL_URL=https://centel.app
CENTEL_TOKEN=$TOKEN
HERMES_URL=http://127.0.0.1:8642/v1
HERMES_KEY=$HKEY
HERMES_MODEL=hermes-agent
EOF
chmod 600 "$ENV"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>app.centel.bridge</string>
  <key>ProgramArguments</key><array><string>$PY</string><string>$DIR/centel_bridge.py</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$DIR/bridge.log</string>
  <key>StandardErrorPath</key><string>$DIR/bridge.log</string>
</dict></plist>
EOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "✅ Centel bridge ทำงานแล้ว ดู log: tail -f $DIR/bridge.log"
echo "   อย่าลืมเปิด Hermes: API_SERVER_ENABLED=true ใน ~/.hermes/.env แล้วรัน  hermes gateway"
