#!/bin/sh
# Update the Homebrew tap to a published release. Run it after release.yml has
# finished and the release page carries the four .tar.gz archives and SHA256SUMS.
#
#   scripts/update-homebrew-tap.sh vX.Y.Z <tap checkout> [--push]
#
# <tap checkout> is a clone of github.com/SamSnead85/homebrew-tap. The script
# downloads the release's SHA256SUMS and archives, refuses any archive that
# does not match SHA256SUMS or has no signed build attestation from this
# repository, renders Formula/agent-console.rb from the template
# (scripts/render-homebrew-formula.mjs), and commits it. With --push it also
# pushes. Needs gh (signed in), git and Node.js 22+.
set -eu

repo=SamSnead85/agent-console
tag=${1:-}
tap=${2:-}
push=${3:-}
case "$tag" in v[0-9]*.[0-9]*.[0-9]*) ;; *) echo "usage: $0 vX.Y.Z <tap checkout> [--push]" >&2; exit 2 ;; esac
if [ -z "$tap" ] || [ ! -d "$tap/.git" ]; then echo "$0: $tap is not a git checkout of the tap" >&2; exit 2; fi
if [ -n "$push" ] && [ "$push" != "--push" ]; then echo "$0: unknown option $push" >&2; exit 2; fi
here=$(cd "$(dirname "$0")/.." && pwd)

work=$(mktemp -d)
cleanup() { rm -f "$work"/*; rmdir "$work"; }
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

gh release download "$tag" --repo "$repo" --dir "$work" --pattern SHA256SUMS --pattern 'agent-console-*.tar.gz'
for target in darwin-arm64 darwin-x64 linux-arm64 linux-x64; do
  file="agent-console-$target.tar.gz"
  [ -f "$work/$file" ] || { echo "$0: $tag has no $file" >&2; exit 1; }
  expected=$(awk -v f="$file" '$2 == f { print $1 }' "$work/SHA256SUMS")
  if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$work/$file" | awk '{ print $1 }')
  else actual=$(shasum -a 256 "$work/$file" | awk '{ print $1 }'); fi
  [ "${#expected}" -eq 64 ] && [ "$actual" = "$expected" ] || { echo "$0: $file does not match SHA256SUMS" >&2; exit 1; }
  gh attestation verify "$work/$file" -R "$repo" >/dev/null
  echo "checked $file"
done

mkdir -p "$tap/Formula"
node "$here/scripts/render-homebrew-formula.mjs" "$tag" "$work/SHA256SUMS" "$tap/Formula/agent-console.rb"
git -C "$tap" add Formula/agent-console.rb
if git -C "$tap" diff --cached --quiet; then
  echo "The tap already has agent-console ${tag#v}."
else
  git -C "$tap" commit -m "agent-console ${tag#v}" >/dev/null
  echo "Committed agent-console ${tag#v} to $tap."
fi
if [ "$push" = "--push" ]; then
  git -C "$tap" push origin HEAD
else
  echo "Review it, then push: git -C '$tap' push origin HEAD"
fi
