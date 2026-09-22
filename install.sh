#!/bin/sh
# One-line install for Jev Runner on macOS:
#   curl -fsSL https://raw.githubusercontent.com/ylemiesa57/jev-runner/main/install.sh | sh
#
# Downloads the latest jev-runner-setup binary from GitHub Releases and runs it.
# Fetching with curl (not a browser) means macOS does not quarantine the binary,
# so Gatekeeper does not block it.
set -e

REPO="${JEV_RUNNER_REPO:-ylemiesa57/jev-runner}"
DEST="${HOME}/.local/bin/jev-runner-setup"

[ "$(uname -s)" = "Darwin" ] || { echo "Jev Runner is macOS-only (it drives the Mac with open/osascript)." >&2; exit 1; }
case "$(uname -m)" in
  arm64)  ARCH=arm64 ;;
  x86_64) ARCH=amd64 ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

URL="https://github.com/${REPO}/releases/latest/download/jev-runner-setup-darwin-${ARCH}"
mkdir -p "$(dirname "$DEST")"
echo "downloading ${URL}"
curl -fsSL "$URL" -o "$DEST"
chmod +x "$DEST"

# When piped through `sh`, stdin is the script itself; give the installer the terminal for prompts.
if [ -t 1 ] && [ -r /dev/tty ]; then
  exec "$DEST" install "$@" < /dev/tty
else
  exec "$DEST" install --yes "$@"
fi
