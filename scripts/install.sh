#!/usr/bin/env bash
# Install the stable Tetris release for this machine.
#
# Usage:
#   scripts/install.sh [--install-dir DIR] [--version TAG]
#
# Environment overrides:
#   TETRIS_INSTALL_DIR  Install directory (default: $HOME/.local/bin).
#                       This is the Tetris-specific override; only the
#                       `tetris` executable is installed there.
#   TETRIS_VERSION      Stable release tag to install (for example v0.1.0).
#                       Defaults to the tag published in latest.txt.
#
# Releases are downloaded from https://github.com/lianihossam-eng/Tetris and
# every archive is verified against its published SHA-256 checksum before the
# executable is installed.
set -euo pipefail

REPOSITORY="lianihossam-eng/Tetris"
RELEASES_URL="https://github.com/${REPOSITORY}/releases"
PRODUCT="tetris"

VERSION="${TETRIS_VERSION:-}"
INSTALL_DIR="${TETRIS_INSTALL_DIR:-}"

usage() {
  cat <<'EOF'
Install the stable Tetris release for this machine.

Usage:
  install.sh [--install-dir DIR] [--version TAG]

Options:
  --install-dir DIR  Install into DIR (default: $TETRIS_INSTALL_DIR or
                     $HOME/.local/bin). Only the `tetris` executable is
                     installed.
  --version TAG      Install a specific stable release tag (for example
                     v0.1.0). Defaults to the tag in latest.txt.
  -h, --help         Show this help.

Environment:
  TETRIS_INSTALL_DIR  Tetris-specific install directory override.
  TETRIS_VERSION      Stable release tag to install.

Supported platforms:
  Linux and macOS on x86_64 or aarch64/arm64.
EOF
}

error() {
  printf '%s: %s\n' "${0##*/}" "$*" >&2
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --install-dir)
      [ "$#" -ge 2 ] || error "missing value for --install-dir"
      INSTALL_DIR="$2"
      shift 2
      ;;
    --version)
      [ "$#" -ge 2 ] || error "missing value for --version"
      VERSION="$2"
      shift 2
      ;;
    *)
      error "unknown argument: $1 (try --help)"
      ;;
  esac
done

if [ -z "$INSTALL_DIR" ]; then
  [ -n "${HOME:-}" ] || error "HOME is not set; set TETRIS_INSTALL_DIR to choose an install directory"
  INSTALL_DIR="${HOME}/.local/bin"
fi

uname_s=$(uname -s)
case "$uname_s" in
  Linux) os="linux" ;;
  Darwin) os="macos" ;;
  *) error "unsupported operating system: ${uname_s} (supported: Linux, macOS)" ;;
esac

uname_m=$(uname -m)
case "$uname_m" in
  x86_64|amd64) arch="x86_64" ;;
  arm64|aarch64) arch="aarch64" ;;
  *) error "unsupported architecture: ${uname_m} (supported: x86_64, aarch64/arm64)" ;;
esac

platform="${os}-${arch}"
archive="${PRODUCT}-${platform}.tar.gz"
checksum="${archive}.sha256"

command -v tar >/dev/null 2>&1 || error "tar is required"
if command -v curl >/dev/null 2>&1; then
  download() {
    curl -fsSL --retry 3 --retry-delay 1 -o "$2" "$1"
  }
elif command -v wget >/dev/null 2>&1; then
  download() {
    wget -q -O "$2" "$1"
  }
else
  error "curl or wget is required to download Tetris releases"
fi

if command -v sha256sum >/dev/null 2>&1; then
  sha256_file() {
    sha256sum "$1" | awk '{print $1}'
  }
elif command -v shasum >/dev/null 2>&1; then
  sha256_file() {
    shasum -a 256 "$1" | awk '{print $1}'
  }
elif command -v openssl >/dev/null 2>&1; then
  sha256_file() {
    openssl dgst -sha256 -r "$1" | awk '{print $1}'
  }
else
  error "sha256sum, shasum, or openssl is required to verify the download"
fi

tmpdir=$(mktemp -d "${TMPDIR:-/tmp}/tetris-install.XXXXXX") || error "failed to create a temporary directory"
stage=""
cleanup() {
  [ -z "$stage" ] || rm -f "$stage"
  rm -rf "$tmpdir"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

if [ -z "$VERSION" ]; then
  printf 'Fetching the latest stable release tag...\n'
  download "${RELEASES_URL}/latest/download/latest.txt" "$tmpdir/latest.txt" \
    || error "failed to download latest.txt from ${RELEASES_URL}"
  VERSION=$(tr -d '[:space:]' < "$tmpdir/latest.txt")
  [ -n "$VERSION" ] || error "latest.txt from ${RELEASES_URL} is empty"
fi

case "$VERSION" in
  v*) ;;
  *) VERSION="v${VERSION}" ;;
esac
if ! [[ "$VERSION" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
  error "invalid stable release tag: ${VERSION}"
fi

printf 'Downloading %s %s for %s...\n' "$PRODUCT" "$VERSION" "$platform"
download "${RELEASES_URL}/download/${VERSION}/${archive}" "$tmpdir/$archive" \
  || error "failed to download ${archive} for ${VERSION}"
download "${RELEASES_URL}/download/${VERSION}/${checksum}" "$tmpdir/$checksum" \
  || error "failed to download ${checksum} for ${VERSION}"

expected=$(awk 'NR == 1 {print $1}' "$tmpdir/$checksum")
expected=$(printf '%s' "$expected" | tr 'A-F' 'a-f')
if ! [[ "$expected" =~ ^[0-9a-f]{64}$ ]]; then
  error "${checksum} does not contain a valid SHA-256 digest"
fi

actual=$(sha256_file "$tmpdir/$archive")
actual=$(printf '%s' "$actual" | tr 'A-F' 'a-f')
if [ "$actual" != "$expected" ]; then
  error "checksum mismatch for ${archive}: expected ${expected}, got ${actual}"
fi

mkdir -p "$tmpdir/extract"
if ! tar -tzf "$tmpdir/$archive" | grep -qx "$PRODUCT"; then
  error "${archive} does not contain a ${PRODUCT} executable"
fi
tar -xzf "$tmpdir/$archive" -C "$tmpdir/extract" "$PRODUCT" \
  || error "failed to extract ${PRODUCT} from ${archive}"
[ -f "$tmpdir/extract/$PRODUCT" ] || error "${archive} did not extract a regular ${PRODUCT} file"

mkdir -p "$INSTALL_DIR" || error "failed to create ${INSTALL_DIR}"
stage="$INSTALL_DIR/.${PRODUCT}.tmp.$$"
install -m 0755 "$tmpdir/extract/$PRODUCT" "$stage" \
  || error "failed to stage ${PRODUCT} in ${INSTALL_DIR}"
mv -f "$stage" "$INSTALL_DIR/$PRODUCT"
stage=""

printf 'Installed %s %s to %s\n' "$PRODUCT" "$VERSION" "$INSTALL_DIR/$PRODUCT"
case ":${PATH:-}:" in
  *":${INSTALL_DIR}:"*)
    printf '%s is already on your PATH.\n' "$INSTALL_DIR"
    ;;
  *)
    printf 'PATH may need updating. Add %s to it, for example:\n' "$INSTALL_DIR"
    # Keep $PATH literal for the command the user will run in their shell.
    # shellcheck disable=SC2016
    printf '  export PATH="%s:$PATH"\n' "$INSTALL_DIR"
    ;;
esac
# These backticks are display formatting, not command substitution here.
# shellcheck disable=SC2016
printf 'Run `%s --version` to verify the installation.\n' "$PRODUCT"
