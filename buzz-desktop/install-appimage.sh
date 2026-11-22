#!/bin/bash
# One-time install of the self-updating patched Buzz AppImage for this user.
# After this, updates come from Buzz: Settings -> Software update.
#
#   install-appimage.sh [path-or-url-of-AppImage]
#
# Default source: ytheesh96/buzz-app public GitHub Releases latest.json, for this machine's arch.
# Installs to ~/Applications/Buzz.AppImage (the updater replaces this file in
# place, so it must stay user-writable) and adds a launcher entry that shadows
# a system /usr/share/applications/buzz.desktop. Buzz registers its own
# buzz:// handler (Buzz-handler.desktop) on first launch.
set -euo pipefail
FEED="${BUZZ_FEED_URL:-https://github.com/ytheesh96/buzz-app/releases/latest/download}"
DEST="$HOME/Applications/Buzz.AppImage"
arch="$(uname -m)"
mkdir -p "$HOME/Applications" "$HOME/.local/share/applications" "$HOME/.local/share/icons/hicolor/128x128/apps"

src="${1:-}"
if [[ -z "$src" ]]; then
  src="$(curl -fsSL "$FEED/latest.json" | jq -r --arg k "linux-$arch-appimage" '.platforms[$k].url')"
  [[ "$src" != null ]] || { echo "no $arch build in $FEED/latest.json" >&2; exit 1; }
fi
tmp="$(mktemp "$DEST.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
if [[ -f "$src" ]]; then cp "$src" "$tmp"; else curl -fL --progress-bar -o "$tmp" "$src"; fi
chmod 755 "$tmp"
mv "$tmp" "$DEST"
trap - EXIT

# Icon from inside the AppImage.
x="$(mktemp -d)"
# The top-level Buzz.png is a symlink into usr/share/icons, so extract from there.
(cd "$x" && APPIMAGE_EXTRACT_AND_RUN=1 "$DEST" --appimage-extract 'usr/share/icons/*' >/dev/null 2>&1 || true)
icon="$(find "$x/squashfs-root/usr/share/icons" -path '*128x128*' -name '*.png' 2>/dev/null | head -1)"
[[ -n "$icon" ]] || icon="$(find "$x/squashfs-root/usr/share/icons" -name '*.png' 2>/dev/null | head -1)"
if [[ -n "$icon" ]]; then cp "$icon" "$HOME/.local/share/icons/hicolor/128x128/apps/buzz-appimage.png"; fi
rm -rf "$x"

cat > "$HOME/.local/share/applications/buzz.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Buzz
Comment=Team chat and AI agents
Exec="$DEST" %u
Icon=buzz-appimage
Categories=Network;Chat;
StartupWMClass=Buzz
MimeType=x-scheme-handler/buzz
Terminal=false
DESKTOP
update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
echo "Installed $DEST. Open Buzz from the launcher; quit any running Buzz first."
