#!/usr/bin/env bash
# Build the notification helper bundle.
#
# UserNotifications refuses to post from a bare executable with no
# CFBundleIdentifier, so the Swift helper is compiled into an .app bundle.
#
# ONE bundle, deliberately. A second bundle (one per power state) would let the
# notification icon differ by state, but macOS treats each bundle as a separate
# app — so it costs the user a second notification-permission grant. Not worth
# it: the icon stays constant and the state is carried by the title instead.
#
# The icon is rendered at build time (swift/make-icon.swift) so no binary artwork
# is committed. Pick a palette with the environment:
#
#   PLUGWATCH_ICON_STYLE=ac-teal yarn build:notify
#
# Usage: build-notify.sh [outDir]   (defaults to the package root)
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Output dir: where the bundle is built. Defaults to the package root (dev), but
# an installed package must build somewhere writable — the CLI passes its data
# dir (e.g. ~/Library/Application Support/plugwatch).
OUT_DIR="${1:-$DIR}"
SRC="$DIR/swift/PlugNotify.swift"
PLIST="$DIR/swift/Info.plist"
ICON_SRC="$DIR/swift/make-icon.swift"
ICON_STYLE="${PLUGWATCH_ICON_STYLE:-ac}"

APP="$OUT_DIR/PlugNotify.app"
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

if ! command -v swiftc >/dev/null 2>&1; then
	echo "error: swiftc not found — install Xcode command line tools (xcode-select --install)" >&2
	exit 1
fi

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

swiftc -O "$SRC" -o "$APP/Contents/MacOS/PlugNotify"
cp "$PLIST" "$APP/Contents/Info.plist"

# App icon (best-effort: notifications still work with the default icon).
if command -v swift >/dev/null 2>&1 && command -v iconutil >/dev/null 2>&1; then
	ICONSET="$(mktemp -d)/AppIcon.iconset"
	if swift "$ICON_SRC" "$ICONSET" "$ICON_STYLE" >/dev/null 2>&1 &&
		iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"; then
		echo "icon: AppIcon.icns <- $ICON_STYLE"
	else
		echo "warning: icon generation failed — using the default icon" >&2
	fi
	rm -rf "$(dirname "$ICONSET")"
fi

# Ad-hoc sign so macOS treats it as a stable app (keeps the notification
# permission grant tied to this bundle rather than re-prompting every run).
codesign --force --sign - "$APP" >/dev/null 2>&1 || true

# Register with LaunchServices so UserNotifications can attribute the app.
# Without this the first run fails with UNErrorDomain code 1
# ("Notifications are not allowed for this application").
if [ -x "$LSREGISTER" ]; then
	"$LSREGISTER" -f "$APP" >/dev/null 2>&1 || true
fi

echo "built $APP"
