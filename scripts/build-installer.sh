#!/bin/sh
# Build the single-binary installer for both Mac architectures into dist/.
# Requires the Go version declared in go.mod (major.minor) or newer.
set -e
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/go/bin:/usr/local/go/bin:/opt/homebrew/bin:$PATH"

# --- Go version check: go.mod is the single source of truth ------------------------------------
REQUIRED=$(sed -n 's/^go[[:space:]]\{1,\}\([0-9]\{1,\}\.[0-9]\{1,\}\).*/\1/p' go.mod)
[ -n "$REQUIRED" ] || { echo "error: no 'go X.Y' directive found in go.mod" >&2; exit 1; }

if ! command -v go >/dev/null 2>&1; then
  echo "error: go not found. Need Go ${REQUIRED}+ — https://go.dev/dl/ (the macOS .pkg), or 'brew install go'," >&2
  echo "       or unpack the tarball into ~/.local/go." >&2
  exit 1
fi

HAVE=$(go version 2>/dev/null | sed -n 's/^go version go\([0-9]\{1,\}\.[0-9]\{1,\}\).*/\1/p')
[ -n "$HAVE" ] || { echo "error: could not parse the output of 'go version': $(go version 2>&1)" >&2; exit 1; }

req_major=${REQUIRED%%.*}; req_minor=${REQUIRED#*.}
have_major=${HAVE%%.*};    have_minor=${HAVE#*.}
if [ "$have_major" -lt "$req_major" ] || { [ "$have_major" -eq "$req_major" ] && [ "$have_minor" -lt "$req_minor" ]; }; then
  echo "error: Go ${HAVE} is too old; go.mod requires ${REQUIRED} or newer (found $(command -v go))." >&2
  echo "       Upgrade at https://go.dev/dl/ or with 'brew upgrade go'." >&2
  exit 1
fi
if [ "$have_major" -gt "$req_major" ]; then
  echo "note: Go ${HAVE} is a newer major than go.mod's ${REQUIRED}; building anyway."
fi
echo "using Go ${HAVE} (go.mod requires ${REQUIRED}+) at $(command -v go)"

# --- Build ------------------------------------------------------------------------------------
mkdir -p dist
for arch in arm64 amd64; do
  CGO_ENABLED=0 GOOS=darwin GOARCH=$arch go build -trimpath -ldflags="-s -w" \
    -o "dist/jev-runner-setup-darwin-$arch" ./cmd/jev-runner-setup
done
cp "dist/jev-runner-setup-darwin-$(uname -m | sed 's/x86_64/amd64/')" dist/jev-runner-setup
ls -lh dist/
