#!/bin/sh
# Build the single-binary installer for both Mac architectures into dist/.
set -e
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/go/bin:/usr/local/go/bin:$PATH"
command -v go >/dev/null || { echo "go not found (install to ~/.local/go or /usr/local/go)"; exit 1; }
mkdir -p dist
for arch in arm64 amd64; do
  CGO_ENABLED=0 GOOS=darwin GOARCH=$arch go build -trimpath -ldflags="-s -w" \
    -o "dist/jev-runner-setup-darwin-$arch" ./cmd/jev-runner-setup
done
cp "dist/jev-runner-setup-darwin-$(uname -m | sed 's/x86_64/amd64/')" dist/jev-runner-setup
ls -lh dist/
