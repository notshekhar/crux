#!/usr/bin/env bash
# crux installer — downloads a prebuilt binary from GitHub Releases.
#   curl -fsSL https://raw.githubusercontent.com/notshekhar/crux/main/install.sh | bash
#
# Layout after install:
#   $CRUX_HOME/               (default: ~/.crux-bin)
#     ├── crux                (standalone binary; no node/bun needed)
#     └── package.json        (version metadata, read on the next upgrade)
#   $BIN_DIR/crux → $CRUX_HOME/crux   (symlink on PATH)
#
# Language grammars are NOT bundled — they are ~40 MB of WASM for languages you
# may not use. `crux init` fetches the ones it needs on first run, or fetch them
# up front with `crux doctor --fetch`.
#
# Env knobs:
#   CRUX_REPO_SLUG   notshekhar/crux    override repo
#   CRUX_VERSION     vX.Y.Z             pin a tag
#   CRUX_HOME        $HOME/.crux-bin    install dir
#   CRUX_BIN_DIR                        symlink dir (auto-detected)
#   CRUX_FORCE       1                  skip the "already up to date" gate
#   CRUX_UNINSTALL   1                  remove install + symlinks and exit

set -euo pipefail

REPO_SLUG="${CRUX_REPO_SLUG:-notshekhar/crux}"
CRUX_HOME="${CRUX_HOME:-$HOME/.crux-bin}"
FORCE="${CRUX_FORCE:-0}"
UNINSTALL="${CRUX_UNINSTALL:-0}"
PIN_VERSION="${CRUX_VERSION:-}"

bold() { printf "\033[1m%s\033[0m\n" "$*"; }
dim()  { printf "\033[2m%s\033[0m\n" "$*"; }
err()  { printf "\033[31m%s\033[0m\n" "$*" >&2; }

need_tool() {
  command -v "$1" >/dev/null 2>&1 || { err "Missing required tool: $1"; exit 1; }
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  else err "missing sha256sum/shasum"; return 1; fi
}

ver_gt() {
  local a="${1#v}" b="${2#v}"
  [ "$a" = "$b" ] && return 1
  [ "$(printf '%s\n%s\n' "$a" "$b" | sort -V | head -n1)" = "$b" ]
}

# ── Download progress bar ──────────────────────────────────────────────────
# curl writes a --trace-ascii stream into a FIFO; we parse content-length and
# `<= recv data` records live and draw a ■■■･･･ 42% bar on stderr. Only used
# when stderr is a TTY; anything else falls back to plain curl in the caller.

# sed with unbuffered output — GNU (-u), BSD/macOS (-l), else pad each line
# past the libc buffer so records flush through the pipe as they happen.
unbuffered_sed() {
  if echo | sed -u -e "" >/dev/null 2>&1; then
    sed -nu "$@"
  elif echo | sed -l -e "" >/dev/null 2>&1; then
    sed -nl "$@"
  else
    local pad="$(printf "\n%512s" "")"
    sed -ne "s/$/\\${pad}/" "$@"
  fi
}

PROGRESS_COLOR='\033[38;5;215m'
PROGRESS_NC='\033[0m'

print_progress() {
  local bytes="$1" length="$2"
  [ "$length" -gt 0 ] || return 0

  local width=50
  local percent=$(( bytes * 100 / length ))
  [ "$percent" -gt 100 ] && percent=100
  local on=$(( percent * width / 100 ))
  local off=$(( width - on ))

  local filled=$(printf "%*s" "$on" "")
  filled=${filled// /■}
  local empty=$(printf "%*s" "$off" "")
  empty=${empty// /･}

  printf "\r${PROGRESS_COLOR}%s%s %3d%%${PROGRESS_NC}" "$filled" "$empty" "$percent" >&4
}

download_with_progress() {
  local url="$1" output="$2"

  if [ -t 2 ]; then exec 4>&2; else exec 4>/dev/null; fi

  local tmp_dir="${TMPDIR:-/tmp}"
  local tracefile="${tmp_dir}/crux_install_$$.trace"

  rm -f "$tracefile"
  mkfifo "$tracefile" 2>/dev/null || return 1

  # Hide the cursor while the bar redraws; always restore it on the way out.
  printf "\033[?25l" >&4
  trap "trap - RETURN; rm -f \"$tracefile\"; printf '\033[?25h' >&4; exec 4>&-" RETURN

  # -f so an HTTP error fails the download (and the caller's fallback runs)
  # instead of tracing a 404 page into the output file.
  ( curl -f --trace-ascii "$tracefile" -s -L -o "$output" "$url" ) &
  local curl_pid=$!

  unbuffered_sed \
    -e 'y/ACDEGHLNORTV/acdeghlnortv/' \
    -e '/^0000: content-length:/p' \
    -e '/^<= recv data/p' \
    "$tracefile" | \
  {
    local length=0 bytes=0
    while IFS= read -r line; do
      case "$line" in
        *content-length:*)
          [ "$length" -eq 0 ] && length="$(printf "%s" "$line" | sed -e 's/.*content-length: *//' -e 's/[^0-9].*//')"
          [ -z "$length" ] && length=0
          ;;
        "<= recv data"*)
          local n
          n="$(printf "%s" "$line" | sed -e 's/.*, *//' -e 's/ bytes.*//')"
          case "$n" in ''|*[!0-9]*) n=0 ;; esac
          bytes=$(( bytes + n ))
          print_progress "$bytes" "$length"
          ;;
      esac
    done
    [ "$length" -gt 0 ] && print_progress "$length" "$length"
    printf "\n" >&4
  }

  wait "$curl_pid"
}

detect_target() {
  local os arch
  case "$(uname -s)" in
    Darwin) os="darwin" ;;
    Linux)  os="linux" ;;
    MINGW*|MSYS*|CYGWIN*)
      err "Windows: run the PowerShell installer instead —"
      err "  irm https://raw.githubusercontent.com/${REPO_SLUG}/main/install.ps1 | iex"
      exit 1 ;;
    *) err "unsupported OS: $(uname -s)"; exit 1 ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64)  arch="x64" ;;
    arm64|aarch64) arch="arm64" ;;
    *) err "unsupported arch: $(uname -m)"; exit 1 ;;
  esac
  # A shell under Rosetta reports x86_64 on Apple Silicon — install the native
  # arm64 build instead of the emulated one.
  if [ "$os" = "darwin" ] && [ "$arch" = "x64" ]; then
    [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ] && arch="arm64"
  fi
  printf "%s-%s" "$os" "$arch"
}

# Release binaries are glibc builds; musl distros need a source build.
check_libc() {
  [ "$(uname -s)" = "Linux" ] || return 0
  if [ -f /etc/alpine-release ] || (ldd --version 2>&1 | grep -qi musl); then
    err "musl libc detected (Alpine?). Release binaries are glibc builds."
    err "  options:"
    err "    • apk add gcompat            (glibc compatibility layer)"
    err "    • git clone + bun install    (run from source)"
    exit 1
  fi
}

resolve_latest_tag() {
  local final tag
  final="$(curl -fsSLI -o /dev/null -w '%{url_effective}' \
    "https://github.com/${REPO_SLUG}/releases/latest" 2>/dev/null || true)"
  tag="${final##*/}"
  case "$tag" in v[0-9]*) printf "%s" "$tag" ;; esac
}

resolve_bin_dir() {
  if [ -n "${CRUX_BIN_DIR:-}" ]; then mkdir -p "$CRUX_BIN_DIR"; printf "%s" "$CRUX_BIN_DIR"; return; fi
  for d in /usr/local/bin /opt/homebrew/bin; do
    [ -w "$d" ] 2>/dev/null && { printf "%s" "$d"; return; }
  done
  local fallback="$HOME/.local/bin"; mkdir -p "$fallback"; printf "%s" "$fallback"
}

uninstall() {
  bold "▶ Uninstalling crux"
  for link in "$HOME/.local/bin/crux" "/usr/local/bin/crux" "/opt/homebrew/bin/crux" \
              "${CRUX_BIN_DIR:+$CRUX_BIN_DIR/crux}"; do
    [ -n "$link" ] || continue
    { [ -L "$link" ] || [ -f "$link" ]; } && rm -f "$link" 2>/dev/null && dim "  removed $link" || true
  done
  rm -rf "$CRUX_HOME" 2>/dev/null && dim "  removed $CRUX_HOME" || true
  dim "  note: grammars in ~/.cache/crux and per-repo .crux/ indexes are left alone"
  bold "✓ Uninstalled."
}

main() {
  [ "$UNINSTALL" = "1" ] && { uninstall; exit 0; }

  bold "▶ crux installer"
  need_tool curl; need_tool tar
  check_libc

  local target latest installed
  target="$(detect_target)"
  dim "  target: $target"

  latest="${PIN_VERSION:-$(resolve_latest_tag)}"
  if [ -z "$latest" ]; then
    err "could not resolve the latest release tag from $REPO_SLUG"
    err "set CRUX_VERSION=vX.Y.Z to pin a release"
    exit 1
  fi
  case "$latest" in v*) ;; *) latest="v$latest" ;; esac

  installed=""
  [ -f "$CRUX_HOME/package.json" ] && \
    installed="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$CRUX_HOME/package.json" | head -n1 || true)"
  if [ "$FORCE" != "1" ] && [ -n "$installed" ] && ! ver_gt "${latest#v}" "${installed#v}"; then
    bold "✓ Up to date (installed $installed, latest $latest)"
    dim "  CRUX_FORCE=1 to reinstall"
    exit 0
  fi
  [ -n "$installed" ] && dim "  update: $installed → $latest" || dim "  installing $latest"

  local scratch tarball url base
  # Sweep leftovers from interrupted runs before the fresh scratch exists, so
  # the glob can't eat it.
  rm -rf "${CRUX_HOME}".old.* "${CRUX_HOME}".new.* 2>/dev/null || true
  scratch="${CRUX_HOME}.new.$$"
  trap 'rm -rf "$scratch" 2>/dev/null || true' EXIT
  mkdir -p "$scratch"

  base="https://github.com/${REPO_SLUG}/releases/download/${latest}"
  url="${base}/crux-${target}.tar.gz"
  tarball="$scratch/crux.tar.gz"

  bold "▶ Downloading ${url##*/}"
  if ! { [ -t 2 ] && download_with_progress "$url" "$tarball"; }; then
    curl -fL --progress-bar "$url" -o "$tarball" || {
      err "download failed: $url"
      err "the release may not have a $target asset"
      exit 1
    }
  fi

  if curl -fsSL "${url}.sha256" -o "$scratch/sum" 2>/dev/null && [ -s "$scratch/sum" ]; then
    local expected got
    expected="$(awk '{print $1}' "$scratch/sum")"
    got="$(sha256_of "$tarball")"
    [ "$expected" = "$got" ] || { err "sha256 mismatch (expected $expected, got $got)"; exit 1; }
    dim "  sha256 ok"
  else
    dim "  sha256 file missing — skipping verify"
  fi

  bold "▶ Extracting"
  tar -xzf "$tarball" -C "$scratch"
  [ -x "$scratch/$target/crux" ] || { err "tarball missing $target/crux"; exit 1; }

  # Gatekeeper blocks unsigned quarantined binaries with a scary dialog.
  if [ "$(uname -s)" = "Darwin" ] && command -v xattr >/dev/null 2>&1; then
    xattr -dr com.apple.quarantine "$scratch/$target" 2>/dev/null || true
  fi

  bold "▶ Installing to $CRUX_HOME"
  [ -e "$CRUX_HOME" ] && rm -rf "${CRUX_HOME}.old.$$" && mv "$CRUX_HOME" "${CRUX_HOME}.old.$$"
  mv "$scratch/$target" "$CRUX_HOME"
  rm -rf "${CRUX_HOME}.old.$$" 2>/dev/null || true
  trap - EXIT
  rm -rf "$scratch" 2>/dev/null || true

  local bin_dir; bin_dir="$(resolve_bin_dir)"
  ln -sf "$CRUX_HOME/crux" "$bin_dir/crux"
  hash -r 2>/dev/null || true

  case ":$PATH:" in
    *":$bin_dir:"*) ;;
    *) err "warning: $bin_dir is not on PATH — add it to your shell rc" ;;
  esac

  "$CRUX_HOME/crux" --version >/dev/null 2>&1 || { err "installed binary failed to run"; exit 1; }

  bold "✓ Installed crux $latest → $bin_dir/crux"
  printf "\n"
  dim "  next:"
  dim "    crux init .        index this repo and print agent config"
  dim "    crux doctor        check the install"
  printf "\n"
}

main "$@"
