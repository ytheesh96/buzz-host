#!/bin/sh
# Render the plugin icons (376x376 PNG, like Buzz's bundled icons) from SVG.
set -eu
cd "$(dirname "$0")"
rsvg-convert -w 376 -h 376 remote-agents.svg -o ../icon.png
rsvg-convert -w 376 -h 376 viewport.svg -o ../../plugins/viewport/icon.png
rsvg-convert -w 376 -h 376 hive-watch.svg -o ../../plugins/hive-watch/icon.png
