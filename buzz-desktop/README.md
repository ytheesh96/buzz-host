# Buzz Desktop Infra (Omarchy)

Personal host scripts and systemd units for running and updating the patched Buzz desktop app built from the public fork [ytheesh96/buzz-app](https://github.com/ytheesh96/buzz-app) (`patched` branch).

## How Buzz gets built and updated

- **Source & CI:** [ytheesh96/buzz-app](https://github.com/ytheesh96/buzz-app) (`patched` branch, based on `block/buzz-app` stable tags). `.github/workflows/buzz-release.yml` builds signed, self-updating Linux AppImages (`x86_64` and `aarch64`) on public GitHub Actions runners and publishes a GitHub Release with `latest.json`.
- **Signing:** Tauri updater key backed up on omarchy in `~/.config/buzz-pkg/` (0600) and stored as repo secrets (`TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`) on `ytheesh96/buzz-app`.
- **Direct updates (`1.0.6+3`+):** Built apps check `https://github.com/ytheesh96/buzz-app/releases/latest/download/latest.json` directly via **Buzz → Settings → Software update**.
- **One-time install:** `buzz-desktop/install-appimage.sh` downloads the latest AppImage for the host architecture into `~/Applications/Buzz.AppImage` and installs a desktop entry.

## Tailnet feed mirror (transition / optional)

Older installs (`1.0.6+2` and earlier from `buzz-pkg`) check `https://omarchy.tail65c5a9.ts.net:8450/latest.json`. `buzz-feed-sync.sh` mirrors the latest release from `ytheesh96/buzz-app` into `~/.local/share/buzz-feed`, served by `buzz-feed.service` behind `tailscale serve`. Once every machine has updated to `1.0.6+3`+, the mirror is optional.

## Owner desktop (headless display :60)

`owner-desktop.mjs` + `buzz-owner-desktop.service` run the patched Buzz AppImage in Xvnc + Xfce behind `tailscale serve` (`https://omarchy.tail65c5a9.ts.net:8448/`), reusing `~/.local/lib/buzz-host/desktop` and `~/.config/buzz-host/config.json` `allowLogins`.

## Fast local UI iteration

1. Run `.github/workflows/buzz-dev-appimage.yml` on `ytheesh96/buzz-app` once per upstream tag and save the `buzz-dev-x86_64` artifact to `~/Applications/Buzz-dev.AppImage` (`chmod +x`).
2. Ensure `"http://localhost:1430"` is in `~/.config/buzz-host/config.json` `allowOrigins`.
3. Run `buzz-desktop/run-dev-buzz.sh ~/Work/buzz-app` to launch Vite HMR + dev Buzz on `:60`.
