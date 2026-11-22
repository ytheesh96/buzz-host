// Owner desktop: the patched Buzz desktop app running on omarchy in its own
// headless Xvnc + Xfce display, viewable from any browser (the iPhone
// included) through noVNC behind `tailscale serve`.
//
//   tailscale serve --bg --https=8448 http://127.0.0.1:8458
//
// Reuses buzz-host's agent-desktop modules from ~/.local/lib/buzz-host/desktop
// (launcher.sh for Xvnc + Xfce, rfb-bridge for WebSocket <-> RFB, the lease
// for "who may type") and buzz-host's Tailscale login allowlist.
//
// Requests must come through tailscale serve with a Tailscale-User-Login in
// ~/.config/buzz-host/config.json allowLogins, and WebSocket upgrades must
// come from this page's own origin. The newest viewer gets keyboard and mouse;
// an older one is disconnected (same rule as agent desktops).

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const LIB = process.env.BUZZ_HOST_LIB ?? path.join(os.homedir(), ".local/lib/buzz-host");
const { acceptUpgrade, bridge } = await import(path.join(LIB, "desktop/rfb-bridge.mjs"));
const { acquire } = await import(path.join(LIB, "desktop/lease.mjs"));

const HOME = os.homedir();
const DIR = process.env.OWNER_DESKTOP_DIR ?? path.join(HOME, ".local/share/buzz-owner-desktop");
const NOVNC = path.join(DIR, "novnc");
const RUN = path.join(process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid()}`, "buzz-owner-desktop");
const RFB = path.join(RUN, "rfb.sock");
const ENV_FILE = path.join(DIR, "env");
const PORT = Number(process.env.OWNER_DESKTOP_PORT ?? 8458);
const DISPLAY_NUM = process.env.OWNER_DESKTOP_DISPLAY ?? "60";
const GEOMETRY = process.env.OWNER_DESKTOP_GEOMETRY ?? "1280x800";
// The self-updating AppImage (client/install-appimage.sh); its updater replaces it in place.
const BUZZ = process.env.OWNER_DESKTOP_APP ?? path.join(HOME, "Applications/Buzz.AppImage");
const CONFIG = path.join(HOME, ".config/buzz-host/config.json");
const PASS_ENV = ["HOME", "USER", "LOGNAME", "PATH", "LANG", "LC_ALL", "SHELL", "TERM", "XDG_RUNTIME_DIR", "TZ"];

const log = (...a) => console.log(new Date().toISOString(), ...a);
fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
fs.mkdirSync(RUN, { recursive: true, mode: 0o700 });

const allowLogins = () => {
  try {
    return new Set(JSON.parse(fs.readFileSync(CONFIG, "utf8")).allowLogins ?? []);
  } catch {
    return new Set();
  }
};

function baseEnv() {
  const env = {};
  for (const k of PASS_ENV) if (process.env[k] !== undefined) env[k] = process.env[k];
  return env;
}

// ---- the display: launcher.sh in the foreground; restart if it dies ----
let launcher = null;
let stopping = false;
function startDisplay() {
  fs.rmSync(ENV_FILE, { force: true });
  const env = {
    ...baseEnv(),
    HERMES_BD_PROFILE: "owner",
    HERMES_BD_DISPLAY_NUM: DISPLAY_NUM,
    HERMES_BD_SOCKET: RFB,
    HERMES_BD_XAUTH: path.join(DIR, "Xauthority"),
    HERMES_BD_ENV_FILE: ENV_FILE,
    HERMES_BD_CONFIG_HOME: path.join(DIR, "xdg"),
    HERMES_BD_GEOMETRY: GEOMETRY,
  };
  launcher = spawn("bash", [path.join(LIB, "desktop/launcher.sh")], { env, stdio: "inherit", detached: true });
  log("display: launcher pid", launcher.pid);
  launcher.on("exit", (code) => {
    log("display: launcher exited", code);
    launcher = null;
    if (!stopping) setTimeout(startDisplay, 3000);
  });
}

function displayEnv() {
  try {
    return Object.fromEntries(
      fs
        .readFileSync(ENV_FILE, "utf8")
        .split("\n")
        .map((l) => l.split(/=(.*)/s))
        .filter(([k]) => k),
    );
  } catch {
    return null;
  }
}

// ---- Buzz itself: start once the display is up; restart when it exits ----
// An in-app update relaunches Buzz itself (the old process exits, a new one
// starts outside our control), so before starting one, look for a Buzz
// already running on this display.
function buzzOnDisplay() {
  const want = `DISPLAY=:${DISPLAY_NUM}`;
  for (const pid of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      if (!fs.readFileSync(`/proc/${pid}/comm`, "utf8").startsWith("Buzz")) continue;
      if (fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes(want)) return Number(pid);
    } catch {}
  }
  return null;
}

// Buzz keeps its identity in the Secret Service. This display's private
// D-Bus has none (the system keyring belongs to the owner's real session), so
// run a dedicated gnome-keyring on it: its keyring file lives under this
// display's XDG_DATA_HOME, and it is created/unlocked with an empty password,
// i.e. protected by file permissions only (like any 0600 file on omarchy).
let keyringBus = null;
function ensureKeyring(denv) {
  if (keyringBus === denv.DBUS_SESSION_BUS_ADDRESS) return;
  // An unencrypted "login" keyring as the default collection; without one,
  // gnome-keyring prompts to create it, which a headless session can't answer.
  const keyrings = path.join(denv.XDG_DATA_HOME ?? path.join(DIR, "xdg/.local-share"), "keyrings");
  fs.mkdirSync(keyrings, { recursive: true, mode: 0o700 });
  const login = path.join(keyrings, "login.keyring");
  if (!fs.existsSync(login)) {
    fs.writeFileSync(login, "[keyring]\ndisplay-name=login\nctime=0\nmtime=0\nlock-on-idle=false\nlock-after=false\n", { mode: 0o600 });
    fs.writeFileSync(path.join(keyrings, "default"), "login", { mode: 0o600 });
  }
  const control = path.join(RUN, "keyring");
  fs.mkdirSync(control, { recursive: true, mode: 0o700 });
  const r = spawnSync(
    "gnome-keyring-daemon",
    ["--replace", "--unlock", "--daemonize", "--components=secrets", `--control-directory=${control}`],
    { env: { ...baseEnv(), ...denv }, input: "", encoding: "utf8", timeout: 10_000 },
  );
  if (r.status === 0) keyringBus = denv.DBUS_SESSION_BUS_ADDRESS;
  log("keyring:", r.status === 0 ? "started" : `failed (${r.status}) ${r.stderr ?? ""}`.trim());
}

let app = null;
let fastFails = 0;
function startApp() {
  if (stopping || app) return;
  const denv = displayEnv();
  if (!denv || !fs.existsSync(RFB)) return void setTimeout(startApp, 1000);
  if (buzzOnDisplay()) return void setTimeout(startApp, 5000);
  if (!fs.existsSync(BUZZ)) {
    log("app: not installed at", BUZZ, "- retrying in 30 s");
    return void setTimeout(startApp, 30_000);
  }
  ensureKeyring(denv);
  const started = Date.now();
  // WEBKIT_DISABLE_DMABUF_RENDERER: Xvnc has no GPU; without it WebKitGTK can render blank.
  app = spawn(BUZZ, [], {
    env: { ...baseEnv(), ...denv, GDK_BACKEND: "x11", WEBKIT_DISABLE_DMABUF_RENDERER: "1" },
    stdio: "inherit",
  });
  log("app: Buzz pid", app.pid);
  app.on("exit", (code, sig) => {
    log("app: Buzz exited", code ?? sig);
    app = null;
    fastFails = Date.now() - started < 10_000 ? fastFails + 1 : 0;
    // Quitting from the app menu is fine: it comes back. A crash loop backs off.
    setTimeout(startApp, fastFails >= 3 ? 60_000 : 2000);
  });
}

// ---- web: noVNC static files + /websockify ----
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".woff": "font/woff",
  ".woff2": "font/woff2", ".ttf": "font/ttf", ".mp3": "audio/mpeg", ".oga": "audio/ogg" };

function authorized(req) {
  const login = req.headers["tailscale-user-login"];
  return typeof login === "string" && allowLogins().has(login);
}

const server = http.createServer((req, res) => {
  if (!authorized(req)) {
    res.writeHead(403, { "content-type": "text/plain" }).end("forbidden\n");
    return;
  }
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/") {
    res.writeHead(302, {
      location: "/vnc.html?autoconnect=1&resize=remote&reconnect=1&reconnect_delay=2000&path=websockify",
    }).end();
    return;
  }
  const file = path.normalize(path.join(NOVNC, decodeURIComponent(url.pathname)));
  if (!file.startsWith(NOVNC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, {
    "content-type": TYPES[path.extname(file)] ?? "application/octet-stream",
    "cache-control": "no-cache",
  });
  fs.createReadStream(file).pipe(res);
});

server.on("upgrade", (req, socket) => {
  const refuse = (status) => socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
  if (!authorized(req)) return refuse("403 Forbidden");
  if (new URL(req.url, "http://x").pathname !== "/websockify") return refuse("404 Not Found");
  // Only this page may open the socket (no cross-site WebSocket hijacking).
  const host = req.headers["x-forwarded-host"] ?? req.headers.host;
  if (req.headers.origin !== `https://${host}`) return refuse("403 Forbidden");
  if (!fs.existsSync(RFB)) return refuse("503 Service Unavailable");
  const viewerId = randomUUID();
  acquire(DIR, viewerId, "owner viewer");
  acceptUpgrade(req, socket);
  log("viewer connected", req.headers["tailscale-user-login"]);
  bridge(socket, { rfbSocket: RFB, leaseDir: DIR, viewerId });
});

const shutdown = () => {
  stopping = true;
  app?.kill("SIGTERM");
  if (launcher) {
    try {
      process.kill(-launcher.pid, "SIGTERM");
    } catch {}
  }
  server.close();
  setTimeout(() => process.exit(0), 1500);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

startDisplay();
startApp();
server.listen(PORT, "127.0.0.1", () => log(`owner desktop on http://127.0.0.1:${PORT}`));
