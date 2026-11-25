// One headless desktop per buzz-host agent: TigerVNC Xvnc + a minimal Xfce
// (Hermes Bot Desktop's launcher.sh, unchanged), plus a cua-driver daemon bound
// to that display only. Never touches the owner's own (Hyprland) session.
//
// State per agent, next to the rest of the agent's buzz-host state:
//   <root>/<pubkey>/desktop/
//     launcher.pid  display  env  Xauthority  xdg/  launcher.log
//     cua.pid  cua.log  lease.json  browser/  bin/browser
//   $XDG_RUNTIME_DIR/buzz-host/desktop/<pubkey[:16]>/rfb.sock, cua.sock
//
// Both the launcher and cua-driver are detached (own session), so the desktop
// outlives whoever started it; status() and stop() work from any process.
//
// Sandboxed (Docker) agents get the same desktop inside a sidecar container
// instead (start(pubkey, { sandboxed: true }), see sandboxStart below): the
// launcher and cua-driver run there, and only the two sockets come out
// through the bind-mounted socket dir, so the Viewport bridge, snapshots,
// lease and computer tools on this side are unchanged.
//
//   node desktop.mjs start|stop|status <agent-pubkey>

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readLease, publicView } from "./lease.mjs";
import * as sidecar from "../sandbox/desktop-sidecar.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const LAUNCHER = path.join(HERE, "launcher.sh");
export const ROOT =
  process.env.BUZZHOST_DESKTOP_ROOT ?? path.join(os.homedir(), ".local/share/buzz-host/agents");
export const CUA_DRIVER =
  process.env.BUZZHOST_CUA_DRIVER ??
  path.join(os.homedir(), ".local/share/buzz-host/tools/cua-driver-0.55.0-linux-x64/cua-driver");
const GEOMETRY = process.env.BUZZHOST_DESKTOP_GEOMETRY ?? "1280x800";
const DISPLAY_RANGE = [90, 189];
// Only these reach the desktop: no agent keys, relay auth or provider tokens.
const PASS_ENV = ["HOME", "USER", "LOGNAME", "PATH", "LANG", "LC_ALL", "SHELL", "TERM", "XDG_RUNTIME_DIR", "TZ"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function desktopDir(pubkey) {
  if (!/^[0-9a-f]{64}$/.test(pubkey)) throw new Error("desktop: agent pubkey must be 64 hex chars");
  return path.join(ROOT, pubkey, "desktop");
}

/** Sockets live under the runtime dir: a Unix socket path is capped at 107
 *  bytes, and <ROOT>/<64-hex>/desktop/rfb.sock is longer than that. */
export const RUN_ROOT =
  process.env.BUZZHOST_DESKTOP_RUN ??
  path.join(process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid()}`, "buzz-host", "desktop");

export function socketDir(pubkey) {
  desktopDir(pubkey);
  return path.join(RUN_ROOT, pubkey.slice(0, 16));
}
const rfbSock = (pubkey) => path.join(socketDir(pubkey), "rfb.sock");
const cuaSock = (pubkey) => path.join(socketDir(pubkey), "cua.sock");

const read = (f) => {
  try {
    return fs.readFileSync(f, "utf8").trim();
  } catch {
    return null;
  }
};

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  // A zombie still answers kill(0); it is not running.
  const st = read(`/proc/${pid}/stat`);
  return !st || !/^\d+ \(.*\) Z /.test(st);
}

/** pid recorded in `file` as "<pid> <starttime>", if that exact process still runs. */
function recordedPid(file) {
  const [pid, born] = (read(file) ?? "").split(" ");
  const n = Number(pid);
  if (!alive(n)) return null;
  if (born && procStart(n) !== born) return null; // pid reused by something else
  return n;
}

function procStart(pid) {
  const st = read(`/proc/${pid}/stat`);
  if (!st) return null;
  return st.slice(st.lastIndexOf(")") + 2).split(" ")[19] ?? null; // field 22: starttime
}

function writePid(file, pid) {
  fs.writeFileSync(file, `${pid} ${procStart(pid) ?? ""}`.trim(), { mode: 0o600 });
}

/** The env published by the running desktop (DISPLAY, XAUTHORITY, DBUS…), or null. */
export function desktopEnv(dir) {
  const raw = read(path.join(dir, "env"));
  if (!raw) return null;
  return Object.fromEntries(
    raw
      .split("\n")
      .map((l) => l.split(/=(.*)/s))
      .filter(([k]) => k),
  );
}

function displayInUse(n) {
  const lock = read(`/tmp/.X${n}-lock`);
  if (lock && alive(Number(lock))) return true;
  try {
    // A live X server keeps its abstract socket bound even after /tmp is cleaned.
    return fs.readFileSync("/proc/net/unix", "utf8").includes(`@/tmp/.X11-unix/X${n}\n`);
  } catch {
    return false;
  }
}

async function withAllocLock(fn) {
  const lock = path.join(ROOT, ".display-alloc.lock");
  fs.mkdirSync(ROOT, { recursive: true });
  for (let i = 0; ; i++) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 30_000) fs.rmSync(lock, { recursive: true });
      } catch {}
      if (i > 300) throw new Error("desktop: timed out waiting for the display allocation lock");
      await sleep(100);
    }
  }
  try {
    return await fn();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

function pickDisplay(dir) {
  const prev = Number(read(path.join(dir, "display")));
  if (prev >= DISPLAY_RANGE[0] && prev <= DISPLAY_RANGE[1] && !displayInUse(prev)) return prev;
  for (let n = DISPLAY_RANGE[0]; n <= DISPLAY_RANGE[1]; n++) if (!displayInUse(n)) return n;
  throw new Error("desktop: no free X display number");
}

function findBrowser() {
  for (const b of ["chromium", "google-chrome-stable", "brave", "firefox"]) {
    try {
      return execFileSync("which", [b], { encoding: "utf8" }).trim();
    } catch {}
  }
  return null;
}

/** Per-desktop browser: its own profile, no keyring prompt, and the desktop's
 *  default for links, so nothing opened elsewhere lands here and the Xfce
 *  "Choose Preferred Application" dialog never appears. */
function seedBrowser(dir, { exe = findBrowser(), extraArgs = "" } = {}) {
  if (!exe) return null;
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin, { recursive: true, mode: 0o700 });
  const wrapper = path.join(bin, "browser");
  const chromish = !/firefox/.test(exe);
  const args = chromish
    ? `--ozone-platform=x11 --password-store=basic --no-first-run --no-default-browser-check --hide-crash-restore-bubble ` +
      `--force-renderer-accessibility ${extraArgs}--user-data-dir="${path.join(dir, "browser")}"`
    : `--profile "${path.join(dir, "browser")}"`;
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${exe}" ${args} "$@"\n`, { mode: 0o700 });
  if (!chromish) fs.mkdirSync(path.join(dir, "browser"), { recursive: true, mode: 0o700 });

  const xdg = path.join(dir, "xdg");
  const helpers = path.join(xdg, ".local-share", "xfce4", "helpers");
  fs.mkdirSync(path.join(xdg, "xfce4"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(helpers, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(xdg, "xfce4", "helpers.rc"), "WebBrowser=agent-browser\n");
  fs.writeFileSync(
    path.join(helpers, "agent-browser.desktop"),
    `[Desktop Entry]\nVersion=1.0\nType=X-XFCE-Helper\nName=Agent browser\nX-XFCE-Category=WebBrowser\n` +
      `X-XFCE-Commands=${wrapper}\nX-XFCE-CommandsWithParameter=${wrapper} "%s"\n`,
  );
  const apps = path.join(xdg, ".local-share", "applications");
  fs.mkdirSync(apps, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(apps, "agent-browser.desktop"),
    `[Desktop Entry]\nType=Application\nName=Browser\nExec=${wrapper} %U\n` +
      `MimeType=text/html;x-scheme-handler/http;x-scheme-handler/https;\n`,
  );
  fs.writeFileSync(
    path.join(xdg, "mimeapps.list"),
    "[Default Applications]\n" +
      ["text/html", "x-scheme-handler/http", "x-scheme-handler/https"]
        .map((m) => `${m}=agent-browser.desktop`)
        .join("\n") +
      "\n",
  );
  return wrapper;
}

const CHAT_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:_[0-9a-f]{64})?$/;
const MAX_CHAT_ACTIVITY = 64;
const ACTIVITY_TTL_MS = 24 * 3600_000;

/** The agent's last computer-tool call, for the owner's in-chat preview:
 *  <desktopDir>/activity.json = {at (ms), tool, chat?, byChat?, unscoped?}.
 *  Written by computer.mjs (the agent's MCP process, labelled with
 *  BUZZHOST_CHAT by acp-proxy), read by buzz-host. Never throws. */
export function recordUse(pubkey, tool, chat = "") {
  try {
    const dir = desktopDir(pubkey);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, "activity.json");
    let prev = {};
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (parsed && typeof parsed === "object") prev = parsed;
    } catch {}
    const now = Date.now();
    const entry = { at: now, tool: String(tool).slice(0, 80) };
    const chatKey = typeof chat === "string" && CHAT_KEY.test(chat) ? chat : "";
    const rawByChat = prev.byChat && typeof prev.byChat === "object" ? prev.byChat : {};
    const entries = Object.entries(rawByChat).filter(
      ([k, v]) => CHAT_KEY.test(k) && Number.isFinite(v?.at) && now - v.at < ACTIVITY_TTL_MS,
    );
    const byChat = Object.fromEntries(entries.sort((a, b) => b[1].at - a[1].at).slice(0, MAX_CHAT_ACTIVITY - 1));
    if (chatKey) byChat[chatKey] = entry;
    const record = {
      ...entry,
      ...(chatKey ? { chat: chatKey } : {}),
      byChat,
      ...(!chatKey ? { unscoped: entry } : prev.unscoped && Number.isFinite(prev.unscoped.at) ? { unscoped: prev.unscoped } : {}),
    };
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {}
}

export function lastUse(pubkey, place) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(desktopDir(pubkey), "activity.json"), "utf8"));
    const norm = (v, chat) =>
      Number.isFinite(v?.at)
        ? { at: v.at, tool: typeof v.tool === "string" ? v.tool : "", ...(chat ? { chat } : {}) }
        : null;
    if (!place?.channelId) return norm(d, typeof d?.chat === "string" ? d.chat : undefined);
    const { channelId, threadRootId } = place;
    const byChat = d?.byChat && typeof d.byChat === "object" ? d.byChat : null;
    if (byChat) {
      // Exact thread match first, else bare channel (Solo chats / DMs where
      // buzz-acp keys the session by channelId while Buzz turns may carry a
      // top-level threadRootId). Never leaks across different chats/threads.
      const threadKey = threadRootId ? `${channelId}_${threadRootId}` : "";
      if (threadKey && byChat[threadKey]) return norm(byChat[threadKey], threadKey);
      if (byChat[channelId]) return norm(byChat[channelId], channelId);
      // Fallback only for unscoped calls (adapters that don't pass BUZZHOST_CHAT).
      return norm(d.unscoped);
    }
    // Legacy activity.json (before per-chat tracking).
    return d?.chat ? null : norm(d);
  } catch {
    return null;
  }
}

export function baseEnv() {
  const env = {};
  for (const k of PASS_ENV) if (process.env[k] !== undefined) env[k] = process.env[k];
  return env;
}

export function status(pubkey) {
  const dir = desktopDir(pubkey);
  const launcher = recordedPid(path.join(dir, "launcher.pid"));
  const driver = recordedPid(path.join(dir, "cua.pid"));
  const env = launcher ? desktopEnv(dir) : null;
  return {
    running: Boolean(launcher && env && fs.existsSync(rfbSock(pubkey))),
    display: env?.DISPLAY ?? null,
    driver: Boolean(driver && fs.existsSync(cuaSock(pubkey))),
    rfbSocket: rfbSock(pubkey),
    cuaSocket: cuaSock(pubkey),
    geometry: GEOMETRY,
    sandboxed: sidecar.isSidecar(dir),
    lease: publicView(readLease(dir)),
  };
}

async function waitFor(check, ms, what, onFail) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const r = check();
    if (r === true) return;
    if (r instanceof Error) {
      onFail?.();
      throw r;
    }
    await sleep(100);
  }
  onFail?.();
  throw new Error(`desktop: ${what} did not come up within ${ms / 1000}s`);
}

function killGroup(pid) {
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, "SIGTERM");
    } catch {}
  }
}

async function startDriver(pubkey) {
  const dir = desktopDir(pubkey);
  const sock = cuaSock(pubkey);
  if (recordedPid(path.join(dir, "cua.pid")) && fs.existsSync(sock)) return;
  fs.rmSync(sock, { force: true });
  const log = fs.openSync(path.join(dir, "cua.log"), "a", 0o600);
  // Sandboxed with a minimal /dev: cua-driver (>= 0.28) prefers kernel uinput
  // devices for X11 input, and a uinput device is seen by the owner's real
  // session (Hyprland/libinput), so agent clicks could land on their screen.
  // Without /dev/uinput it must use the desktop's own X input (XTEST).
  const child = spawn("bwrap", ["--bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--", CUA_DRIVER, "serve", "--socket", sock], {
    env: { ...baseEnv(), ...desktopEnv(dir), XDG_SESSION_TYPE: "x11" },
    stdio: ["ignore", log, log],
    detached: true,
  });
  fs.closeSync(log);
  child.unref();
  writePid(path.join(dir, "cua.pid"), child.pid);
  await waitFor(
    () => (fs.existsSync(sock) ? true : alive(child.pid) ? false : new Error("desktop: cua-driver exited (see cua.log)")),
    10_000,
    "cua-driver",
  );
}

/** Start (or reuse) the agent's desktop and its cua-driver. Idempotent.
 *  `sandboxed`: the agent runs in Docker, so its desktop does too. */
export async function start(pubkey, { waitMs = 20_000, sandboxed = false } = {}) {
  const dir = desktopDir(pubkey);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(socketDir(pubkey), { recursive: true, mode: 0o700 });
  // A desktop left from the other kind of runner (the owner switched it) goes first.
  if (sidecar.isSidecar(dir) !== sandboxed && (status(pubkey).running || recordedPid(path.join(dir, "launcher.pid"))))
    await stop(pubkey);
  if (sandboxed) return sandboxStart(pubkey, dir, { waitMs: Math.max(waitMs, 60_000) });
  sidecar.clearMarker(dir);
  if (!status(pubkey).running) {
    await withAllocLock(async () => {
      if (status(pubkey).running) return;
      const num = pickDisplay(dir);
      fs.writeFileSync(path.join(dir, "display"), String(num));
      for (const f of [path.join(dir, "env"), rfbSock(pubkey), cuaSock(pubkey)]) fs.rmSync(f, { force: true });
      const browser = seedBrowser(dir);
      const env = {
        ...baseEnv(),
        HERMES_BD_PROFILE: `agent ${pubkey.slice(0, 8)}`,
        HERMES_BD_DISPLAY_NUM: String(num),
        HERMES_BD_SOCKET: rfbSock(pubkey),
        HERMES_BD_XAUTH: path.join(dir, "Xauthority"),
        HERMES_BD_ENV_FILE: path.join(dir, "env"),
        HERMES_BD_CONFIG_HOME: path.join(dir, "xdg"),
        HERMES_BD_GEOMETRY: GEOMETRY,
        ...(browser
          ? { HERMES_BD_BROWSER_EXEC: browser, HERMES_BD_BROWSER_EXEC_LINE: `Exec="${browser}" %U` }
          : {}),
      };
      const log = fs.openSync(path.join(dir, "launcher.log"), "w", 0o600);
      const child = spawn("bash", [LAUNCHER], { env, stdio: ["ignore", log, log], detached: true });
      fs.closeSync(log);
      child.unref();
      let exited = null;
      child.on("exit", (code) => (exited = code ?? -1));
      writePid(path.join(dir, "launcher.pid"), child.pid);
      await waitFor(
        () => {
          if (exited !== null) {
            const tail = (read(path.join(dir, "launcher.log")) ?? "").slice(-1500);
            return new Error(`desktop: launcher exited with ${exited}:\n${tail}`);
          }
          return fs.existsSync(path.join(dir, "env")) && fs.existsSync(rfbSock(pubkey));
        },
        waitMs,
        "the desktop",
        () => {
          // A launch we gave up on must not come up later as "running".
          killGroup(child.pid);
          for (const f of [path.join(dir, "launcher.pid"), path.join(dir, "env"), rfbSock(pubkey)])
            fs.rmSync(f, { force: true });
        },
      );
    });
  }
  await startDriver(pubkey);
  return status(pubkey);
}

// Container paths equal host paths (dir, socket dir, cua-driver, launcher), so
// the env file, the browser wrapper and launch_app paths read the same on
// both sides. The container's init (tini) runs as this user; its host pid is
// recorded as launcher.pid and cua.pid, so status() needs no docker call.
const SANDBOX_BROWSER = "/usr/bin/chromium";
// Needs no display number, so no allocation lock (whose 30 s staleness rule
// a container start could outlast); concurrent starts in this process share one.
const sandboxStarting = new Map(); // pubkey -> promise
function sandboxStart(pubkey, dir, opts) {
  const st = status(pubkey);
  if (st.running && st.driver) return Promise.resolve(st);
  let p = sandboxStarting.get(pubkey);
  if (!p) {
    p = sandboxLaunch(pubkey, dir, opts).finally(() => sandboxStarting.delete(pubkey));
    sandboxStarting.set(pubkey, p);
  }
  return p;
}
async function sandboxLaunch(pubkey, dir, { waitMs }) {
  await sidecar.remove(pubkey);
  for (const f of ["launcher.pid", "cua.pid", path.join(dir, "env"), rfbSock(pubkey), cuaSock(pubkey)])
    fs.rmSync(path.isAbsolute(f) ? f : path.join(dir, f), { force: true });
  // Chromium's own sandbox needs user namespaces, which the container
  // (no capabilities, no-new-privileges) does not have; the container is
  // the sandbox here.
  const browser = seedBrowser(dir, { exe: SANDBOX_BROWSER, extraArgs: "--no-sandbox --disable-dev-shm-usage " });
  sidecar.writeMarker(dir);
  const pid = await sidecar.run(pubkey, {
    dir,
    socketDir: socketDir(pubkey),
    launcherDir: HERE,
    cuaDriver: CUA_DRIVER,
    env: {
      HERMES_BD_PROFILE: `agent ${pubkey.slice(0, 8)}`,
      HERMES_BD_DISPLAY_NUM: "1",
      HERMES_BD_SOCKET: rfbSock(pubkey),
      HERMES_BD_XAUTH: path.join(dir, "Xauthority"),
      HERMES_BD_ENV_FILE: path.join(dir, "env"),
      HERMES_BD_CONFIG_HOME: path.join(dir, "xdg"),
      HERMES_BD_GEOMETRY: GEOMETRY,
      BUZZ_DESKTOP_CUA_SOCKET: cuaSock(pubkey),
      BUZZ_DESKTOP_CUA_LOG: path.join(dir, "cua.log"),
      ...(browser ? { HERMES_BD_BROWSER_EXEC: browser, HERMES_BD_BROWSER_EXEC_LINE: `Exec="${browser}" %U` } : {}),
    },
  });
  writePid(path.join(dir, "launcher.pid"), pid);
  writePid(path.join(dir, "cua.pid"), pid);
  await waitFor(
    () => {
      if (!alive(pid)) {
        const tail = (read(path.join(dir, "launcher.log")) ?? "").slice(-1500);
        return new Error(`desktop: the desktop container exited:\n${tail}`);
      }
      return fs.existsSync(path.join(dir, "env")) && fs.existsSync(rfbSock(pubkey)) && fs.existsSync(cuaSock(pubkey));
    },
    waitMs,
    "the desktop container",
    () => {
      sidecar.remove(pubkey).catch(() => {});
      for (const f of ["launcher.pid", "cua.pid", "env"]) fs.rmSync(path.join(dir, f), { force: true });
    },
  );
  return status(pubkey);
}

/** Stop the agent's cua-driver and desktop (Xvnc, Xfce, its browser). */
export async function stop(pubkey) {
  const dir = desktopDir(pubkey);
  if (sidecar.isSidecar(dir)) {
    await sidecar.remove(pubkey);
    for (const f of ["launcher.pid", "cua.pid", "env"]) fs.rmSync(path.join(dir, f), { force: true });
    for (const f of [rfbSock(pubkey), cuaSock(pubkey)]) fs.rmSync(f, { force: true });
    return status(pubkey);
  }
  const pids = ["cua.pid", "launcher.pid"].map((f) => recordedPid(path.join(dir, f))).filter(Boolean);
  // Xvnc is in the launcher's group, but outlives the launcher by a moment
  // (the launcher's EXIT trap kills it): wait for it too.
  const xvnc = Number(read(`/tmp/.X${Number(read(path.join(dir, "display")))}-lock`));
  if (pids.length && alive(xvnc) && (read(`/proc/${xvnc}/cmdline`) ?? "").includes(rfbSock(pubkey))) pids.push(xvnc);
  for (const pid of pids) killGroup(pid);
  const deadline = Date.now() + 5000;
  while (pids.some(alive) && Date.now() < deadline) await sleep(100);
  for (const pid of pids.filter(alive))
    for (const target of [-pid, pid]) {
      try {
        process.kill(target, "SIGKILL");
      } catch {}
    }
  for (const f of ["launcher.pid", "cua.pid", "env"]) fs.rmSync(path.join(dir, f), { force: true });
  for (const f of [rfbSock(pubkey), cuaSock(pubkey)]) fs.rmSync(f, { force: true });
  return status(pubkey);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, pubkey] = process.argv.slice(2);
  const fn = { start, stop, status }[cmd];
  if (!fn || !pubkey) {
    process.stderr.write("usage: desktop.mjs start|stop|status <agent-pubkey>\n");
    process.exit(2);
  }
  Promise.resolve(fn(pubkey)).then(
    (r) => console.log(JSON.stringify(r, null, 2)),
    (e) => {
      console.error(e.message);
      process.exit(1);
    },
  );
}
