// Per-agent process supervision for buzz-host, one backend per host OS.
//
//   linux:  systemd --user template units (buzz-agent@<pubkey>.service), logs
//           from journalctl. Behavior is exactly what buzz-host.mjs did inline.
//   darwin: launchd LaunchAgents (~/Library/LaunchAgents/com.buzz-host.agent.
//           <pubkey>.plist) in the user's gui/<uid> domain, logs appended to
//           ~/Library/Logs/buzz-host/agent-<pubkey>.log.
//
// Every backend answers the same calls: enableAndStart, restart,
// disableAndStop, status (systemd's `is-active` words: active, activating,
// inactive, failed, unknown) and logs(pubkey, lines).
//
// The run dir (control and MCP sockets) is `$XDG_RUNTIME_DIR/buzz-host`
// everywhere: agent-run, acp-proxy, the C MCP bridge and docker-run all derive
// it that way. macOS has no XDG_RUNTIME_DIR and its $TMPDIR
// (/var/folders/…/T/) is long enough to push sockets past the 104-byte
// sun_path limit, so on darwin the base is /tmp/bh-<uid> (mode 0700,
// owner-checked) and the launchd plists export it as XDG_RUNTIME_DIR. The
// longest socket, <base>/buzz-host/<64-hex pubkey>.sock, is then 91 bytes for
// uid 501 and 98 for a 10-digit (directory-bound) uid; /tmp/buzz-host-<uid>
// would reach 105 there.

import { execFile } from "node:child_process";
import nodeFs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const HEX64 = /^[0-9a-f]{64}$/;
const defaultRun = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const SUPPORTED_PLATFORMS = new Set(["linux", "darwin"]);
export const AGENT_LABEL_PREFIX = "com.buzz-host.agent.";
export const SERVER_LABEL = "com.buzz-host.server";
/** Seconds launchd waits before respawning a crashed agent (systemd's RestartSec=10). */
export const LAUNCHD_THROTTLE_SECONDS = 10;
/** Cap on how much of a log file `logs` reads from its end. */
const MAX_LOG_TAIL_BYTES = 4 << 20;

function checkPubkey(pubkey) {
  if (typeof pubkey !== "string" || !HEX64.test(pubkey)) throw new Error("Invalid agent pubkey");
  return pubkey;
}

function clampLines(lines) {
  return Math.min(Math.max(Number(lines) || 80, 1), 500);
}

/** The directory that holds buzz-host/ (sockets): XDG_RUNTIME_DIR, or a short per-user /tmp dir on macOS. */
export function runtimeBase({ platform = process.platform, env = process.env, uid = process.getuid() } = {}) {
  if (env.XDG_RUNTIME_DIR) return env.XDG_RUNTIME_DIR;
  if (platform === "darwin") return `/tmp/bh-${uid}`;
  return `/run/user/${uid}`;
}

/** buzz-host's run dir: `<runtimeBase>/buzz-host`. */
export function runDir(options = {}) {
  return path.join(runtimeBase(options), "buzz-host");
}

/**
 * Create `dir` mode 0700 if missing and make sure it is ours: a real directory
 * (not a symlink), owned by `uid`, with no group/other access. /tmp is shared,
 * so a directory another user planted there must never be trusted.
 */
export async function ensurePrivateDir(dir, { fs = nodeFs, uid = process.getuid() } = {}) {
  try {
    await fs.mkdir(dir, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const st = await fs.lstat(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${dir} is not a directory`);
  if (st.uid !== uid) throw new Error(`${dir} is owned by uid ${st.uid}, not ${uid}`);
  if ((st.mode & 0o077) !== 0) await fs.chmod(dir, 0o700);
  return dir;
}

// ---------- plist (XML property list) ----------

export function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function plistValue(value, indent) {
  const pad = "  ".repeat(indent);
  if (typeof value === "boolean") return `${pad}<${value}/>`;
  if (typeof value === "number") {
    if (!Number.isInteger(value)) throw new Error("plist numbers must be integers");
    return `${pad}<integer>${value}</integer>`;
  }
  if (typeof value === "string") return `${pad}<string>${xmlEscape(value)}</string>`;
  if (Array.isArray(value)) {
    if (!value.length) return `${pad}<array/>`;
    return [`${pad}<array>`, ...value.map((v) => plistValue(v, indent + 1)), `${pad}</array>`].join("\n");
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    if (!entries.length) return `${pad}<dict/>`;
    const inner = entries.flatMap(([k, v]) => [`${pad}  <key>${xmlEscape(k)}</key>`, plistValue(v, indent + 1)]);
    return [`${pad}<dict>`, ...inner, `${pad}</dict>`].join("\n");
  }
  throw new Error(`Unsupported plist value: ${typeof value}`);
}

/** A complete XML plist document for `dict`. */
export function renderPlist(dict) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    plistValue(dict, 0),
    "</plist>",
    "",
  ].join("\n");
}

/** The LaunchAgent for one agent: agent-run <pubkey>, respawned on crash only. */
export function agentPlist({ pubkey, libDir, home, runtimeDir, logPath, pathEnv }) {
  checkPubkey(pubkey);
  return renderPlist({
    Label: `${AGENT_LABEL_PREFIX}${pubkey}`,
    ProgramArguments: [path.join(libDir, "agent-run"), pubkey],
    EnvironmentVariables: {
      PATH: pathEnv,
      HOME: home,
      BUZZ_HOST_AGENT: pubkey,
      XDG_RUNTIME_DIR: runtimeDir,
    },
    WorkingDirectory: home,
    RunAtLoad: true,
    // A clean exit (0) stays down; any other exit is respawned after
    // ThrottleInterval. Not identical to buzz-agent@.service (Restart=always,
    // RestartPreventExitStatus=78): launchd cannot exempt one exit code, so
    // agent-run's "not activated" exit 78 is retried every 10 s here.
    KeepAlive: { SuccessfulExit: false },
    ThrottleInterval: LAUNCHD_THROTTLE_SECONDS,
    Umask: 0o077,
    StandardOutPath: logPath,
    StandardErrorPath: logPath,
  });
}

/** Map `launchctl print` output to systemd's is-active words. */
export function parseLaunchctlState(text) {
  const state = /^\s*state = (.+)$/m.exec(text)?.[1]?.trim() ?? "";
  if (state === "running") return "active";
  if (/spawn scheduled|spawning|waiting/i.test(state)) {
    const code = /^\s*last exit code = (-?\d+)/m.exec(text)?.[1];
    return code && code !== "0" ? "activating" : "inactive";
  }
  if (state) {
    const code = /^\s*last exit code = (-?\d+)/m.exec(text)?.[1];
    return code && code !== "0" ? "failed" : "inactive";
  }
  return "unknown";
}

/** The last `lines` lines of a file, reading at most MAX_LOG_TAIL_BYTES from its end. */
export async function tailFile(file, lines, { fs = nodeFs } = {}) {
  let handle;
  try {
    handle = await fs.open(file, "r");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, MAX_LOG_TAIL_BYTES);
    if (!length) return "";
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, size - length);
    let text = buf.toString("utf8");
    // A read that started mid-file starts mid-line: drop that partial line.
    if (length < size) text = text.slice(text.indexOf("\n") + 1);
    const all = text.split("\n");
    if (all.at(-1) === "") all.pop();
    const out = all.slice(-lines).join("\n");
    return out ? `${out}\n` : "";
  } finally {
    await handle.close();
  }
}

// ---------- backends ----------

function systemdBackend({ run }) {
  const systemctl = (...args) => run("systemctl", ["--user", ...args], { timeout: 60_000 });
  const unit = (pubkey) => `buzz-agent@${checkPubkey(pubkey)}.service`;
  return {
    platform: "linux",
    unit,
    async enableAndStart(pubkey) {
      await systemctl("enable", "--now", unit(pubkey));
    },
    async restart(pubkey) {
      await systemctl("restart", unit(pubkey));
    },
    async disableAndStop(pubkey) {
      await systemctl("disable", "--now", unit(pubkey));
    },
    async status(pubkey) {
      try {
        const { stdout } = await systemctl("is-active", unit(pubkey));
        return stdout.trim();
      } catch (error) {
        return (error.stdout ?? "").trim() || "unknown";
      }
    },
    async logs(pubkey, lines = 80) {
      const n = clampLines(lines);
      const { stdout } = await run(
        "journalctl",
        ["--user", "-u", unit(pubkey), "-n", String(n), "--no-pager", "-o", "short-iso"],
        { timeout: 30_000, maxBuffer: 4 << 20 },
      ).catch((error) => ({ stdout: error.stdout ?? "" }));
      return stdout;
    },
  };
}

function launchdBackend({ run, fs, home, libDir, uid, runtimeDir, launchAgentsDir, logDir, pathEnv, unloadPolls, unloadPollMs }) {
  const domain = `gui/${uid}`;
  const label = (pubkey) => `${AGENT_LABEL_PREFIX}${checkPubkey(pubkey)}`;
  const target = (pubkey) => `${domain}/${label(pubkey)}`;
  const plistPath = (pubkey) => path.join(launchAgentsDir, `${label(pubkey)}.plist`);
  const logPath = (pubkey) => path.join(logDir, `agent-${checkPubkey(pubkey)}.log`);
  const launchctl = (...args) => run("launchctl", args, { timeout: 60_000 });

  async function loaded(pubkey) {
    try {
      await launchctl("print", target(pubkey));
      return true;
    } catch {
      return false;
    }
  }

  /** Write the plist; returns whether its content changed. */
  async function writePlist(pubkey) {
    await fs.mkdir(launchAgentsDir, { recursive: true, mode: 0o700 });
    await fs.mkdir(logDir, { recursive: true, mode: 0o700 });
    const file = plistPath(pubkey);
    const body = agentPlist({ pubkey, libDir, home, runtimeDir, logPath: logPath(pubkey), pathEnv });
    const current = await fs.readFile(file, "utf8").catch(() => null);
    if (current === body) return false;
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, body, { mode: 0o600 });
    await fs.rename(tmp, file);
    return true;
  }

  /** bootout returns before the job is gone; wait so a bootstrap or rm that follows is safe. */
  async function unload(pubkey) {
    await launchctl("bootout", target(pubkey)).catch(() => {});
    for (let i = 0; i < unloadPolls && (await loaded(pubkey)); i++) await sleep(unloadPollMs);
  }

  return {
    platform: "darwin",
    unit: label,
    plistPath,
    logPath,
    // systemd's `enable --now`: install the plist and load it (RunAtLoad starts it).
    // A loaded job whose plist changed is reloaded so the change applies.
    async enableAndStart(pubkey) {
      const changed = await writePlist(pubkey);
      if (await loaded(pubkey)) {
        if (!changed) return;
        await unload(pubkey);
      }
      await launchctl("bootstrap", domain, plistPath(pubkey));
    },
    // Kill and start again; loads the agent first if it is not loaded yet.
    async restart(pubkey) {
      if (!(await loaded(pubkey))) {
        await writePlist(pubkey);
        await launchctl("bootstrap", domain, plistPath(pubkey));
        return;
      }
      await launchctl("kickstart", "-k", target(pubkey));
    },
    // systemd's `disable --now`: unload (stops it) and remove the plist.
    async disableAndStop(pubkey) {
      if (await loaded(pubkey)) await unload(pubkey);
      await fs.rm(plistPath(pubkey), { force: true });
    },
    async status(pubkey) {
      try {
        const { stdout } = await launchctl("print", target(pubkey));
        return parseLaunchctlState(stdout);
      } catch (error) {
        // Not loaded: launchctl prints "Could not find service" and exits 113.
        if (error?.code === 113 || /could not find service/i.test(`${error?.stderr ?? ""}${error?.stdout ?? ""}`))
          return "inactive";
        return "unknown";
      }
    },
    async logs(pubkey, lines = 80) {
      return tailFile(logPath(pubkey), clampLines(lines), { fs });
    },
  };
}

/**
 * The service manager for `platform`. `run` is promisified execFile (injected
 * in tests); `fs` is node:fs/promises.
 */
export function createServiceManager({
  platform = process.platform,
  run = defaultRun,
  fs = nodeFs,
  home = os.homedir(),
  libDir = path.join(home, ".local/lib/buzz-host"),
  uid = process.getuid(),
  env = process.env,
  launchAgentsDir = path.join(home, "Library/LaunchAgents"),
  logDir = path.join(home, "Library/Logs/buzz-host"),
  unloadPolls = 20,
  unloadPollMs = 250,
} = {}) {
  if (platform === "linux") return systemdBackend({ run });
  if (platform === "darwin") {
    const runtimeDir = runtimeBase({ platform, env, uid });
    const pathEnv = [
      path.join(libDir, "bin"),
      path.join(home, ".local/bin"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ].join(":");
    return launchdBackend({
      run,
      fs,
      home,
      libDir,
      uid,
      runtimeDir,
      launchAgentsDir,
      logDir,
      pathEnv,
      unloadPolls,
      unloadPollMs,
    });
  }
  throw new Error(`buzz-host does not support ${platform} hosts (only linux and darwin)`);
}
