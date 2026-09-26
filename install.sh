#!/bin/sh
# Install the release executable for this machine into a user-owned directory.
# It installs nothing unless the download matches the release's SHA256SUMS.
#
#   AGENT_CONSOLE_VERSION=vX.Y.Z    that release instead of the latest
#   AGENT_CONSOLE_INSTALL_DIR=DIR   that directory instead of ~/.local/bin
#
# curl honours HTTPS_PROXY, and CURL_CA_BUNDLE for a network that inspects TLS.
set -eu

repo=SamSnead85/agent-console
proxy_help='Behind a proxy? Set HTTPS_PROXY=http://<proxy>:<port>. A network that inspects TLS: set CURL_CA_BUNDLE to your company root certificate (.pem).'
fetch() {
  if ! curl -fsSL "$1" -o "$2"; then
    printf 'Could not download %s. Nothing was installed.\n%s\n' "$1" "$proxy_help" >&2
    exit 1
  fi
}

version=${AGENT_CONSOLE_VERSION:-}
if [ -z "$version" ]; then
  # github.com redirects releases/latest to the latest tag: no API, no rate limit.
  if ! latest=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$repo/releases/latest"); then
    printf 'Could not reach github.com to find the latest release.\n%s\n' "$proxy_help" >&2
    exit 1
  fi
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
package="$base/lockedinlabs-agent-console-${version#v}.tgz"

# The Linux executable is Node.js 24's official build, which needs glibc 2.28
# or newer: not musl (Alpine) and not older distributions such as CentOS 7.
if [ "$platform" = linux ]; then
  glibc=$(getconf GNU_LIBC_VERSION 2>/dev/null | awk '{ print $2 }') || glibc=
  unsupported=
  if [ -n "$glibc" ]; then
    if ! printf '%s\n' "$glibc" | awk -F. '{ exit !($1 > 2 || ($1 == 2 && $2 >= 28)) }'; then
      unsupported="glibc $glibc"
    fi
  elif (ldd --version 2>&1 || true) | grep -qi musl; then
    unsupported='musl libc'
  fi
  if [ -n "$unsupported" ]; then
    printf 'This Linux has %s; the Agent Console executable needs glibc 2.28 or newer. Nothing was installed.\n' "$unsupported" >&2
    printf 'Install Node.js 22 or newer from your distribution instead, then run:\n  npx --yes %s --open\n' "$package" >&2
    exit 1
  fi
fi
tmp=$(mktemp -d)
cleanup() { rm -f "$tmp/$asset" "$tmp/SHA256SUMS"; rmdir "$tmp"; }
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

fetch "$base/SHA256SUMS" "$tmp/SHA256SUMS"
fetch "$base/$asset" "$tmp/$asset"
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
dest_dir=$(cd "$dest_dir" && pwd)
install -m 755 "$tmp/$asset" "$dest_dir/agent-console"
printf 'Installed %s to %s\n' "$version" "$dest_dir/agent-console"
case ":$PATH:" in
  *":$dest_dir:"*)
    printf 'Start it:  agent-console --open\n'
    exit 0 ;;
esac

# Not on PATH: the exact line for this shell, with $HOME kept as $HOME.
printf 'Start it:  %s --open\n\n' "$dest_dir/agent-console"
case "$dest_dir" in
  "$HOME"/*) shown="\$HOME/${dest_dir#"$HOME"/}" ;;
  *) shown=$dest_dir ;;
esac
case "${SHELL:-}" in
  */fish)
    printf '%s is not on your PATH. To run it as just agent-console, run:\n  fish_add_path %s\n' "$dest_dir" "$dest_dir" ;;
  *)
    case "${SHELL:-}" in
      */zsh) profile='~/.zshrc' ;;
      */bash) if [ "$platform" = darwin ]; then profile='~/.bash_profile'; else profile='~/.bashrc'; fi ;;
      *) profile='~/.profile' ;;
    esac
    printf '%s is not on your PATH. To run it as just agent-console, run:\n' "$dest_dir"
    printf '  echo '"'"'export PATH="%s:$PATH"'"'"' >> %s\n' "$shown" "$profile"
    printf 'then open a new terminal.\n' ;;
esac
