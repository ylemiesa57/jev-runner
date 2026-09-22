#!/bin/sh
# Build the single-binary installer for both Mac architectures into dist/.
#
# Requires the Go version declared in go.mod (major.minor) or newer. If Go is missing or too
# old, offers to install the current stable release into ~/.local/go (no sudo, nothing outside
# your home directory). Pass --yes (or set CI=1) to do that without asking.
set -e
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/go/bin:/usr/local/go/bin:/opt/homebrew/bin:$PATH"

YES=0
for a in "$@"; do case "$a" in -y|--yes) YES=1 ;; esac; done
[ -n "$CI" ] && YES=1

# --- What go.mod requires ---------------------------------------------------------------------
REQUIRED=$(sed -n 's/^go[[:space:]]\{1,\}\([0-9]\{1,\}\.[0-9]\{1,\}\).*/\1/p' go.mod)
[ -n "$REQUIRED" ] || { echo "error: no 'go X.Y' directive found in go.mod" >&2; exit 1; }
req_major=${REQUIRED%%.*}; req_minor=${REQUIRED#*.}

# version_ok X.Y  → true when X.Y >= required major.minor
version_ok() {
  maj=${1%%.*}; min=${1#*.}
  [ "$maj" -gt "$req_major" ] || { [ "$maj" -eq "$req_major" ] && [ "$min" -ge "$req_minor" ]; }
}

# have_go → prints the installed major.minor, or nothing
have_go() {
  command -v go >/dev/null 2>&1 || return 0
  go version 2>/dev/null | sed -n 's/^go version go\([0-9]\{1,\}\.[0-9]\{1,\}\).*/\1/p'
}

# --- Install Go into ~/.local/go from go.dev --------------------------------------------------
install_go() {
  case "$(uname -s)" in Darwin) os=darwin ;; Linux) os=linux ;; *) echo "error: unsupported OS $(uname -s)" >&2; return 1 ;; esac
  case "$(uname -m)" in arm64|aarch64) arch=arm64 ;; x86_64|amd64) arch=amd64 ;; *) echo "error: unsupported arch $(uname -m)" >&2; return 1 ;; esac

  latest=$(curl -fsSL 'https://go.dev/VERSION?m=text' | head -1)   # e.g. go1.27.1
  case "$latest" in go[0-9]*) ;; *) echo "error: could not read the latest Go version from go.dev" >&2; return 1 ;; esac
  latest_mm=$(echo "$latest" | sed -n 's/^go\([0-9]\{1,\}\.[0-9]\{1,\}\).*/\1/p')
  version_ok "$latest_mm" || { echo "error: latest Go is $latest but go.mod requires $REQUIRED; check go.mod" >&2; return 1; }

  url="https://go.dev/dl/${latest}.${os}-${arch}.tar.gz"
  dest="$HOME/.local/go"
  echo "downloading $url → $dest"
  tmp=$(mktemp -d)
  curl -fsSL "$url" -o "$tmp/go.tgz"
  rm -rf "$dest" && mkdir -p "$HOME/.local"
  tar -C "$tmp" -xzf "$tmp/go.tgz" && mv "$tmp/go" "$dest"
  rm -rf "$tmp"
  export PATH="$dest/bin:$PATH"
  echo "installed $("$dest/bin/go" version)"
  case ":$PATH:" in *":$dest/bin:"*) ;; esac
  echo "note: add  export PATH=\"\$HOME/.local/go/bin:\$PATH\"  to your shell profile to use it outside this script."
}

# --- Check, and install if that fails ---------------------------------------------------------
HAVE=$(have_go)
if [ -n "$HAVE" ] && version_ok "$HAVE"; then
  :
else
  if [ -z "$HAVE" ]; then
    echo "Go not found; go.mod requires ${REQUIRED}+."
  else
    echo "Go ${HAVE} at $(command -v go) is too old; go.mod requires ${REQUIRED}+."
  fi
  if [ "$YES" -eq 1 ]; then
    install_go
  elif [ -t 0 ]; then
    printf 'Install the current stable Go into ~/.local/go? [Y/n] '
    read -r ans
    case "$ans" in ""|y|Y|yes|YES) install_go ;; *)
      echo "Get Go ${REQUIRED}+ from https://go.dev/dl/ (macOS .pkg), 'brew install go', or rerun with --yes." >&2; exit 1 ;;
    esac
  else
    echo "error: non-interactive and no --yes; get Go ${REQUIRED}+ from https://go.dev/dl/ or rerun with --yes." >&2
    exit 1
  fi
  HAVE=$(have_go)
  { [ -n "$HAVE" ] && version_ok "$HAVE"; } || { echo "error: Go install did not produce a usable go ${REQUIRED}+" >&2; exit 1; }
fi
[ "${HAVE%%.*}" -gt "$req_major" ] && echo "note: Go ${HAVE} is a newer major than go.mod's ${REQUIRED}; building anyway."
echo "using Go ${HAVE} (go.mod requires ${REQUIRED}+) at $(command -v go)"

# --- Build ------------------------------------------------------------------------------------
mkdir -p dist
for arch in arm64 amd64; do
  CGO_ENABLED=0 GOOS=darwin GOARCH=$arch go build -trimpath -ldflags="-s -w" \
    -o "dist/jev-runner-setup-darwin-$arch" ./cmd/jev-runner-setup
done
cp "dist/jev-runner-setup-darwin-$(uname -m | sed 's/x86_64/amd64/')" dist/jev-runner-setup
ls -lh dist/
