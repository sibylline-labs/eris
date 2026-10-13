#!/bin/sh
# install.sh — put `eris` on PATH. POSIX sh.
#
#   ./install.sh              the release binary for this OS/arch (darwin-arm64, linux-x64): downloaded with
#                             `curl` from https://github.com/sibylline-labs/eris/releases, checked against the
#                             release's SHA256SUMS, installed to ~/.local/bin/eris. ERIS_VERSION=<tag> pins a
#                             release; unset is the latest (GitHub skips pre-releases for "latest").
#   ./install.sh --checkout   the dev install: `bun install --frozen-lockfile`, and a wrapper that execs this
#                             checkout's `eris`, so the working tree is live.
#
# Both modes stage the file in a fresh directory inside the bin dir, so the final `mv` is a same-filesystem
# rename and never leaves a half-written eris. Nothing is executed from the staging directory: verify, `mv`,
# run from the bin dir. A default install over a `--checkout` wrapper says so, and an x86_64 shell on Apple
# Silicon (Rosetta) gets the arm64 binary. The shell surface is frozen (tests/source-is-text.test.ts): fit
# changes inside its budget.
set -eu

bin_dir="$HOME/.local/bin"
bin_path="$bin_dir/eris"
[ -z "$*" ] || [ "$*" = --checkout ] || { echo "usage: ./install.sh [--checkout]" >&2; exit 2; }
mkdir -p "$bin_dir"
tmp=$(mktemp -d "$bin_dir/.eris-install.XXXXXX")
trap 'rm -rf "$tmp"' EXIT

if [ "${1:-}" = --checkout ]; then
  script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
  [ -f "$script_dir/eris" ] || { echo "eris not found at $script_dir/eris" >&2; exit 1; }
  command -v bun >/dev/null 2>&1 || { echo "bun is not installed — see https://bun.sh" >&2; exit 1; }
  (cd "$script_dir" && bun install --frozen-lockfile)
  staged="$tmp/eris"
  printf '#!/bin/sh\nexec "%s/eris" "$@"\n' "$script_dir" >"$staged"
else
  os_arch="$(uname -s)-$(uname -m)"
  [ "$os_arch" != Darwin-x86_64 ] || [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" != 1 ] || os_arch=Darwin-arm64
  case "$os_arch" in
    Darwin-arm64) target=darwin-arm64 hasher='shasum -a 256' ;;
    Linux-x86_64) target=linux-x64 hasher=sha256sum ;;
    *) echo "no eris release binary for $(uname -s) $(uname -m) (darwin-arm64 and linux-x64 only); use ./install.sh --checkout" >&2; exit 1 ;;
  esac
  command -v curl >/dev/null 2>&1 || { echo "curl is not installed — see https://curl.se" >&2; exit 1; }
  staged="$tmp/eris-$target" releases=https://github.com/sibylline-labs/eris/releases
  url="$releases/${ERIS_VERSION:+download/}${ERIS_VERSION:-latest/download}"
  { curl -fsSL -o "$staged" "$url/eris-$target" && curl -fsSL -o "$tmp/SHA256SUMS" "$url/SHA256SUMS"; } || { echo "download failed (${ERIS_VERSION:-no stable release found; pre-releases are skipped}): check the release exists at $releases; set ERIS_VERSION=<tag> or use ./install.sh --checkout" >&2; exit 1; }
  got=$($hasher "$staged" | cut -d' ' -f1)
  grep -q "^$got [ *]eris-$target\$" "$tmp/SHA256SUMS" || { echo "checksum mismatch for eris-$target; nothing installed" >&2; exit 1; }
  # A --checkout wrapper is a script whose `exec "` line runs the checkout; a previous release binary is not a script.
  [ "$(head -c 2 "$bin_path" 2>/dev/null)" != '#!' ] || ! grep -q '^exec "' "$bin_path" || echo "replacing the --checkout wrapper at $bin_path with the release binary" >&2
fi
chmod +x "$staged"
mv "$staged" "$bin_path"

echo "Installed eris → $bin_path"
case ":$PATH:" in *":$bin_dir:"*) ;; *) printf '\n~/.local/bin is not on your PATH. Add to your shell profile:\n  export PATH="$HOME/.local/bin:$PATH"\n' ;; esac
