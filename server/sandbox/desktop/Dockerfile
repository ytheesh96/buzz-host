# Desktop sidecar for sandboxed buzz-host agents (issue #39): TigerVNC Xvnc + a
# minimal Xfce + Chromium + cua-driver's runtime libraries. One container per
# agent, on the filtered buzz-sandbox network. It exposes only two unix sockets
# (rfb.sock for the Viewport bridge, cua.sock for the computer tools) through a
# bind-mounted directory; buzz-host's launcher.sh, entry.sh and the cua-driver
# binary are mounted read-only from the host (see ../desktop-sidecar.mjs).
# Build: server/sandbox/build-image.sh --desktop
FROM debian:trixie-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash ca-certificates dbus dbus-x11 procps \
    tigervnc-standalone-server x11-utils x11-xserver-utils x11-xkb-utils xauth \
    xfwm4 xfdesktop4 xfce4-panel xfce4-settings xfconf xfce4-terminal \
    adwaita-icon-theme papirus-icon-theme gnome-themes-extra \
    fonts-dejavu-core fonts-noto-color-emoji \
    chromium xdg-utils at-spi2-core \
    libxtst6 libxi6 libxkbcommon0 libx11-6 libxext6 libxinerama1 libxrandr2 \
  && rm -rf /var/lib/apt/lists/*
