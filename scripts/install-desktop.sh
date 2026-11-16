#!/bin/sh
# Installs or updates the fork's Apple Silicon macOS app without touching T3 home.
#   curl -fsSL https://raw.githubusercontent.com/uiliugang/t3code/main/scripts/install-desktop.sh | sh
# Environment: T3CODE_VERSION, T3CODE_DESKTOP_INSTALL_DIR (default: /Applications),
# and T3CODE_RELEASE_BASE_URL (a trusted mirror of releases/download).
set -eu

fail() {
  printf '\nt3 desktop install: %s\n' "$1" >&2
  exit 1
}

[ "$(uname -s)" = Darwin ] || fail "this installer supports macOS only"
if [ "$(uname -m)" != arm64 ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" != 1 ]; then
  fail "this fork publishes macOS desktop builds for Apple Silicon only"
fi
for command in curl plutil hdiutil ditto codesign shasum lsappinfo sw_vers; do
  command -v "$command" >/dev/null 2>&1 || fail "$command is required"
done

bundle_id="com.t3tools.t3code"
check_running() {
  running="$(lsappinfo find "bundleID=$bundle_id")" || fail "could not check whether T3 Code is running"
  [ -z "$running" ] || fail "Quit T3 Code, then run this installer again. Active agents may be interrupted when you quit."
}
check_running

repo="uiliugang/t3code"
base_url="${T3CODE_RELEASE_BASE_URL:-https://github.com/${repo}/releases/download}"
install_dir="${T3CODE_DESKTOP_INSTALL_DIR:-/Applications}"
case "$install_dir" in /*) ;; *) fail "T3CODE_DESKTOP_INSTALL_DIR must be an absolute path" ;; esac
mkdir -p "$install_dir" || fail "cannot create $install_dir; set T3CODE_DESKTOP_INSTALL_DIR to a writable directory"
[ -w "$install_dir" ] || fail "cannot write to $install_dir; set T3CODE_DESKTOP_INSTALL_DIR to a writable directory"

work=
staging=
lock=
mounted=false
installed=false
cleanup() {
  status=$?
  trap - EXIT
  if [ -n "$staging" ]; then
    if [ "$installed" = false ] && [ -d "$staging/previous.app" ]; then
      if [ ! -e "$destination" ] && [ ! -L "$destination" ] && mv "$staging/previous.app" "$destination"; then
        printf 'Restored the previous app.\n' >&2
      else
        printf 'Previous app preserved at %s/previous.app; restore it manually.\n' "$staging" >&2
        staging=
        status=1
      fi
    fi
    [ -z "$staging" ] || rm -rf "$staging"
  fi
  [ -z "$lock" ] || rmdir "$lock"
  if [ "$mounted" = true ] && ! hdiutil detach -quiet "$work/mount"; then
    printf 'Could not unmount %s/mount; temporary files were preserved.\n' "$work" >&2
    work=
    status=1
  fi
  [ -z "$work" ] || rm -rf "$work"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
work="$(mktemp -d "${TMPDIR:-/tmp}/t3-desktop.XXXXXX")"

fetch() {
  curl -fSL --connect-timeout 15 --max-time "${3:-900}" -H "Accept: ${4:-*/*}" -o "$2" "$1" ||
    fail "could not download $1"
}

version="${T3CODE_VERSION:-}"
if [ -z "$version" ]; then
  printf 'Finding the latest desktop release...\n'
  fetch "https://github.com/${repo}/releases/latest" "$work/release.json" 30 application/json
  tag="$(plutil -extract tag_name raw -o - "$work/release.json")" || fail "could not read the latest release version"
  version="${tag#v}"
fi
case "$version" in *[!0-9.]* | '') fail "invalid stable version: $version" ;; esac
printf '%s\n' "$version" | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' ||
  fail "invalid version: use a stable version such as T3CODE_VERSION=0.0.17"

asset="T3-Code-${version}-arm64.dmg"
printf 'Downloading T3 Code %s...\n' "$version"
fetch "${base_url%/}/v${version}/SHA256SUMS" "$work/SHA256SUMS" 30
expected="$(awk -v name="$asset" '$2 == name || $2 == "*" name { print $1 }' "$work/SHA256SUMS")"
[ "${#expected}" -eq 64 ] && printf '%s\n' "$expected" | grep -Eq '^[0-9a-f]{64}$' ||
  fail "missing or invalid checksum for $asset"
fetch "${base_url%/}/v${version}/${asset}" "$work/$asset"
actual="$(shasum -a 256 < "$work/$asset" | awk '{ print $1 }')"
[ "$actual" = "$expected" ] || fail "checksum mismatch for $asset"

mkdir "$work/mount"
hdiutil attach -quiet -readonly -nobrowse -mountpoint "$work/mount" "$work/$asset" ||
  fail "could not mount $asset"
mounted=true
set -- "$work/mount/"*.app
[ "$#" -eq 1 ] && [ -d "$1" ] && [ ! -L "$1" ] || fail "the disk image must contain one app bundle"
source_app="$1"
info="$source_app/Contents/Info.plist"
[ "$(plutil -extract CFBundleIdentifier raw -o - "$info")" = "$bundle_id" ] || fail "unexpected app bundle identifier"
[ "$(plutil -extract CFBundleShortVersionString raw -o - "$info")" = "$version" ] || fail "the app version does not match the release"
minimum_macos="$(plutil -extract LSMinimumSystemVersion raw -o - "$info" 2>/dev/null || true)"
if [ -n "$minimum_macos" ]; then
  system_macos="$(SYSTEM_VERSION_COMPAT=0 sw_vers -productVersion)" || fail "could not read the macOS version"
  awk -v installed="$system_macos" -v minimum="$minimum_macos" 'BEGIN {
    split(installed, current, "."); split(minimum, required, ".")
    for (i = 1; i <= 3; i++) {
      if (current[i] + 0 > required[i] + 0) exit 0
      if (current[i] + 0 < required[i] + 0) exit 1
    }
  }' || fail "this release requires macOS $minimum_macos or newer; this Mac runs $system_macos"
fi
destination="$install_dir/${source_app##*/}"

if ! mkdir "$install_dir/.t3-desktop-install.lock"; then
  fail "another installer holds $install_dir/.t3-desktop-install.lock; if it stopped unexpectedly, remove the empty lock directory and retry"
fi
lock="$install_dir/.t3-desktop-install.lock"
[ ! -L "$destination" ] || fail "refusing to replace a symbolic link at $destination"
if [ -e "$destination" ]; then
  [ -d "$destination" ] &&
    [ "$(plutil -extract CFBundleIdentifier raw -o - "$destination/Contents/Info.plist")" = "$bundle_id" ] ||
    fail "refusing to replace another app at $destination"
fi

staging="$(mktemp -d "$install_dir/.t3-desktop.XXXXXX")"
new_app="$staging/${source_app##*/}"
printf 'Verifying and staging the app...\n'
ditto "$source_app" "$new_app" || fail "could not copy the app; the existing installation was not changed"
codesign --verify --deep --strict "$new_app" || fail "app signature verification failed"
hdiutil detach -quiet "$work/mount" || fail "could not unmount the disk image"
mounted=false
check_running
if [ -e "$destination" ]; then
  mv "$destination" "$staging/previous.app" || fail "could not back up the existing app"
fi
mv "$new_app" "$destination" || fail "could not install the new app"
installed=true
printf 'Installed T3 Code %s at %s\nOpen it from Applications when ready. This installer does not enable in-app automatic updates.\n' "$version" "$destination"
