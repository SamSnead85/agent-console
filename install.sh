#!/bin/sh
# Install the release executable for this machine into a user-owned directory.
# Set AGENT_CONSOLE_VERSION=vX.Y.Z to install an earlier release.
set -eu

repo=SamSnead85/agent-console
version=${AGENT_CONSOLE_VERSION:-}
if [ -z "$version" ]; then
  latest=$(curl -fsSL -o /dev/null -w '%{url_effective}' "https://github.com/$repo/releases/latest")
  version=${latest##*/}
fi
if ! printf '%s' "$version" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo 'Could not determine a release tag. Set AGENT_CONSOLE_VERSION=vX.Y.Z.' >&2
  exit 1
fi

case "$(uname -s)" in
  Darwin) platform=darwin ;;
  Linux) platform=linux ;;
  *) echo 'This installer supports macOS and Linux. Use install.ps1 on Windows.' >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64) arch=x64 ;;
  *) echo 'No Agent Console executable is available for this CPU.' >&2; exit 1 ;;
esac
asset="agent-console-$platform-$arch"
base="https://github.com/$repo/releases/download/$version"
tmp=$(mktemp -d)
cleanup() { rm -f "$tmp/$asset" "$tmp/SHA256SUMS"; rmdir "$tmp"; }
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

curl -fsSL "$base/SHA256SUMS" -o "$tmp/SHA256SUMS"
curl -fsSL "$base/$asset" -o "$tmp/$asset"
expected=$(awk -v file="$asset" '$2 == file { print $1 }' "$tmp/SHA256SUMS")
case "$expected" in
  *[!0-9a-fA-F]*|'') echo 'Release checksum is missing or invalid.' >&2; exit 1 ;;
esac
if [ "${#expected}" -ne 64 ]; then
  echo 'Release checksum is not SHA-256.' >&2
  exit 1
fi
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$tmp/$asset" | awk '{ print $1 }')
else
  actual=$(shasum -a 256 "$tmp/$asset" | awk '{ print $1 }')
fi
if [ "$actual" != "$expected" ]; then
  echo 'SHA-256 mismatch. Nothing was installed.' >&2
  exit 1
fi

dest_dir=${AGENT_CONSOLE_INSTALL_DIR:-${XDG_BIN_HOME:-$HOME/.local/bin}}
mkdir -p "$dest_dir"
install -m 755 "$tmp/$asset" "$dest_dir/agent-console"
printf 'Installed %s to %s\n' "$version" "$dest_dir/agent-console"
printf 'Run: %s --open\n' "$dest_dir/agent-console"
