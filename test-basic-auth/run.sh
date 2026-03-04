#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CADDY_BIN="$SCRIPT_DIR/caddy"

# Download caddy if not present
if [ ! -f "$CADDY_BIN" ]; then
  echo "Downloading Caddy..."
  curl -fsSL "https://caddyserver.com/api/download?os=linux&arch=amd64" -o "$CADDY_BIN"
  chmod +x "$CADDY_BIN"
  echo "Caddy downloaded."
fi

# Generate bcrypt hash for password "test"
HASH=$("$CADDY_BIN" hash-password --plaintext test)

# Replace placeholder in Caddyfile
sed "s|{BASIC_AUTH_HASH}|$HASH|" "$SCRIPT_DIR/Caddyfile" > "$SCRIPT_DIR/Caddyfile.run"

echo ""
echo "Starting Caddy basic auth proxy on :8443 -> localhost:18671"
echo "  Credentials: test / test"
echo ""

"$CADDY_BIN" run --config "$SCRIPT_DIR/Caddyfile.run" --adapter caddyfile
