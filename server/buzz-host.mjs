#!/usr/bin/env node
// buzz-host: a self-hosted provider for Buzz "remote" agents.
//
// Buzz's remote agent type (the same contract Builderlab uses) calls
// provision → activate → profile / instructions / remove. This server keeps
// each agent's key on this machine and runs it with `buzz-acp` as a systemd
// user unit (buzz-agent@<pubkey>.service), so agents answer while the owner's
// laptop is closed.
//
// Transport: JSON over WebSocket on 127.0.0.1, published to the tailnet with
// `tailscale serve`, which adds the caller's Tailscale-User-Login header. Only
// logins listed in config.json are served. No dependencies beyond Node.

import { createServer } from "node:http";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createAttention } from "./attention.mjs";
import { createMemory } from "./memory.mjs";
import { createOrchestrator } from "./orchestrator.mjs";
import { createRelayWatcher } from "./attention-relay.mjs";
import { catalogs, toModels, withRuntimes } from "./catalog.mjs";
import { proxyControl as routeControl } from "./control.mjs";
import * as desktop from "./desktop/desktop.mjs";
import { acquire as leaseAcquire, release as leaseRelease, publicView } from "./desktop/lease.mjs";
import { acceptUpgrade, bridge as rfbBridge } from "./desktop/rfb-bridge.mjs";
import { snapshot as desktopSnapshot } from "./desktop/snapshot.mjs";

const run = promisify(execFile);
const HOME = os.homedir();
const LIB = path.join(HOME, ".local/lib/buzz-host");
const DATA = path.join(HOME, ".local/share/buzz-host/agents");
const WORK = path.join(HOME, "buzz-agents");
const CONFIG = path.join(HOME, ".config/buzz-host/config.json");
const BIN = path.join(LIB, "bin");
const VERSION = 2;
const RUN_DIR = path.join(process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`, "buzz-host");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DEFAULT_CONCURRENCY = 4;
const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 16;

// Route one control request across all live acp-proxy workers for `pubkey`.
function proxyControl(pubkey, request, timeoutMs = 10_000, notRunning = { cancelled: false }) {
  return routeControl(RUN_DIR, pubkey, request, timeoutMs, notRunning);
}

// Shims keep the adapters' names (buzz-acp keys runtime defaults on the
// basename) and negotiate ACP v1 through acp-v1-shim.
const SHIMS = path.join(LIB, "shims");
const RUNTIMES = {
  claude: { title: "Claude Code", command: path.join(SHIMS, "claude-agent-acp") },
  codex: { title: "Codex", command: path.join(SHIMS, "codex-acp") },
  hermes: { title: "Hermes", command: path.join(SHIMS, "hermes-acp") },
  antigravity: { title: "Antigravity", command: path.join(SHIMS, "antigravity-acp") },
};

const HEX64 = /^[0-9a-f]{64}$/;
const MODEL = /^[A-Za-z0-9._:/@+-]{0,200}$/;
const MAX_INSTRUCTIONS = 64 * 1024;

// ---------- Hermes profiles ----------
// A Hermes agent runs on one profile: a Hermes home with its own config,
// memory, skills, sessions and provider sign-ins. "" is the default profile
// (~/.hermes); others are ~/.hermes/profiles/<name>, chosen with HERMES_HOME as
// Buzz's own Hermes plugin does. The profile's gateway runs the agent's tools,
// so the profile needs the buzz-host-session-env plugin (see ensureSessionEnv).
const HERMES = path.join(HOME, ".local/bin/hermes");
const HERMES_ROOT = path.join(HOME, ".hermes");
const PROFILE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const SESSION_ENV = "buzz-host-session-env";
const hermesHome = (profile) => (profile ? path.join(HERMES_ROOT, "profiles", profile) : HERMES_ROOT);
const profileArgs = (profile) => (profile ? ["-p", profile] : []);

/** `hermes profile list`'s table: name, default model, gateway state. */
function parseProfiles(text) {
  const rows = [];
  for (const raw of text.split("\n")) {
    const cells = raw.replace(/\x1b\[[0-9;]*m/g, "").replace(/^\s*◆?/, "").trim().split(/\s{2,}/);
    if (cells.length < 3 || cells[0] === "Profile" || !PROFILE.test(cells[0])) continue;
    rows.push({ name: cells[0], model: cells[1] === "—" ? "" : cells[1], gateway: cells[2] });
  }
  return rows;
}
let profileCache;
async function hermesProfiles(fresh = false) {
  if (!fresh && profileCache && Date.now() - profileCache.at < 30_000) return profileCache.rows;
  const { stdout } = await run(HERMES, ["profile", "list"], { timeout: 60_000, maxBuffer: 1 << 20 });
  profileCache = { at: Date.now(), rows: parseProfiles(stdout) };
  return profileCache.rows;
}
async function checkProfile(profile) {
  if (!profile) return;
  const known = async (fresh) => (await hermesProfiles(fresh)).some((row) => row.name === profile);
  if (!(await known(false)) && !(await known(true)))
    throw new Error(`There is no Hermes profile "${profile}" on this server`);
}

/** Puts buzz-host's Hermes plugin in the profile and enables it there. Hermes
 * runs an agent's commands in the profile's gateway, outside agent-run's env;
 * the plugin gives each buzz-host session its agent (BUZZHOST_AGENT), which
 * the `buzz` CLI needs to post. Plugins are per profile and opt-in. Enabling
 * reloads the gateway's plugins in place; sessions keep running. */
const sessionEnvReady = new Set();
async function ensureSessionEnv(profile) {
  if (sessionEnvReady.has(profile)) return;
  const source = path.join(LIB, "hermes-plugin", SESSION_ENV);
  const target = path.join(hermesHome(profile), "plugins", SESSION_ENV);
  const files = (await fs.readdir(source, { withFileTypes: true }).catch(() => []))
    .filter((e) => e.isFile())
    .map((e) => e.name);
  if (!files.length) throw new Error(`buzz-host's Hermes plugin is missing (${source}); run deploy.sh`);
  const same = await Promise.all(
    files.map(async (name) => {
      const [a, b] = await Promise.all([
        fs.readFile(path.join(source, name)),
        fs.readFile(path.join(target, name)).catch(() => undefined),
      ]);
      return b !== undefined && a.equals(b);
    }),
  );
  if (!same.every(Boolean)) {
    await fs.rm(target, { recursive: true, force: true });
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.cp(source, target, { recursive: true, filter: (from) => !from.includes("__pycache__") });
  }
  const { stdout } = await run(HERMES, [...profileArgs(profile), "config", "get", "plugins.enabled"], {
    timeout: 60_000,
  }).catch(() => ({ stdout: "" }));
  if (!stdout.split("\n").some((line) => line.replace(/^[\s-]+/, "").trim() === SESSION_ENV))
    await run(HERMES, [...profileArgs(profile), "plugins", "enable", SESSION_ENV, "--no-allow-tool-override"], {
      timeout: 120_000,
    }).catch((error) => {
      throw new Error(
        `Could not enable ${SESSION_ENV} in Hermes profile ${profile || "default"}: ${(error.stderr || error.message).trim().slice(0, 300)}`,
      );
    });
  sessionEnvReady.add(profile);
}

async function loadConfig() {
  const raw = JSON.parse(await fs.readFile(CONFIG, "utf8"));
  if (!Array.isArray(raw.allowLogins) || raw.allowLogins.length === 0)
    throw new Error(`${CONFIG}: allowLogins must list Tailscale logins`);
  return {
    port: raw.port ?? 8457,
    allowLogins: new Set(raw.allowLogins),
    allowOrigins: new Set(
      raw.allowOrigins ?? ["tauri://localhost", "http://tauri.localhost"],
    ),
    // Communities agents may join; empty means any wss:// URL.
    allowCommunities: new Set(raw.allowCommunities ?? []),
  };
}

// ---------- agent storage ----------

const dir = (pubkey) => path.join(DATA, pubkey);
function checkPubkey(pubkey) {
  if (typeof pubkey !== "string" || !HEX64.test(pubkey))
    throw new Error("Invalid agent pubkey");
  return pubkey;
}
async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}
async function writePrivate(file, text) {
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(tmp, text, { mode: 0o600 });
  await fs.rename(tmp, file);
}
async function meta(pubkey) {
  const value = await readJson(path.join(dir(pubkey), "meta.json"), undefined);
  if (!value) throw new Error("Agent not found on this host");
  return value;
}
async function saveMeta(pubkey, value) {
  await writePrivate(
    path.join(dir(pubkey), "meta.json"),
    JSON.stringify(value, null, 2),
  );
}

function checkCommunity(config, community) {
  let url;
  try {
    url = new URL(community);
  } catch {
    throw new Error("Invalid community URL");
  }
  if (url.protocol !== "wss:" && url.protocol !== "ws:")
    throw new Error("Community must be a ws(s):// URL");
  if (config.allowCommunities.size && !config.allowCommunities.has(community))
    throw new Error(`This host does not serve the community ${community}`);
  return community;
}

function checkConcurrency(value, fallback = DEFAULT_CONCURRENCY) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < MIN_CONCURRENCY || n > MAX_CONCURRENCY) {
    throw new Error(`Concurrency must be an integer between ${MIN_CONCURRENCY} and ${MAX_CONCURRENCY}`);
  }
  return n;
}

function settingsFrom(input, previous = {}) {
  const runtime = input?.runtime ?? previous.runtime ?? "claude";
  if (!Object.hasOwn(RUNTIMES, runtime)) throw new Error("Unknown runtime");
  const model = String(input?.model ?? previous.model ?? "").trim();
  if (!MODEL.test(model)) throw new Error("Invalid model id");
  // Only Hermes has profiles; another runtime drops it.
  const kept = runtime === previous.runtime ? previous.profile : "";
  let profile = runtime === "hermes" ? String(input?.profile ?? kept ?? "").trim() : "";
  if (profile === "default") profile = "";
  if (profile && !PROFILE.test(profile)) throw new Error("Invalid Hermes profile name");
  const concurrency = checkConcurrency(input?.concurrency, previous.concurrency ?? DEFAULT_CONCURRENCY);
  return { runtime, model, profile, concurrency };
}
function checkInstructions(text) {
  if (typeof text !== "string") throw new Error("Instructions must be text");
  if (Buffer.byteLength(text) > MAX_INSTRUCTIONS)
    throw new Error("Instructions are longer than 64 KiB");
  return text;
}

// Single-quoted for bash `source`; values are validated, quoting is defense.
const sq = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`;

async function writeRuntimeEnv(pubkey, m) {
  const runtime = RUNTIMES[m.runtime];
  const profile = m.runtime === "hermes" ? m.profile || "" : "";
  if (m.runtime === "hermes") await ensureSessionEnv(profile);
  const concurrency = checkConcurrency(m.concurrency, DEFAULT_CONCURRENCY);
  const lines = {
    BUZZ_RELAY_URL: m.community,
    BUZZ_ACP_AGENT_OWNER: m.owner,
    BUZZ_ACP_AGENT_COMMAND: runtime.command,
    BUZZ_ACP_AGENTS: String(concurrency),
    BUZZ_ACP_MODEL: m.model || undefined,
    // The Hermes profile: hermes-acp and its gateway session use this home.
    HERMES_HOME: profile ? hermesHome(profile) : undefined,
    BUZZ_ACP_SYSTEM_PROMPT_FILE: m.hasInstructions
      ? path.join(dir(pubkey), "instructions.md")
      : undefined,
    // Buzz's tools: memory always, Attention while the owner has it on.
    BUZZ_ACP_MCP_COMMAND: await writeBuzzMcp(pubkey),
  };
  const text = Object.entries(lines)
    .filter(([, value]) => value)
    .map(([key, value]) => `export ${key}=${sq(value)}`)
    .join("\n");
  await writePrivate(path.join(dir(pubkey), "runtime.env"), `${text}\n`);
}

// The agent's Buzz MCP server: a per-agent wrapper, because buzz-acp starts
// BUZZ_ACP_MCP_COMMAND without arguments and names the server after the file
// ("buzz", as Buzz's own). Memory tools always; Attention tools while the
// owner has Attention on; computer tools while the agent has a desktop;
// orchestrator tools while the owner has Orchestrator on (turning any on or
// off restarts the agent).
async function writeBuzzMcp(pubkey) {
  const mcp = path.join(dir(pubkey), "mcp");
  const file = path.join(mcp, "buzz");
  const withAttention = (await attention.load(pubkey)).record.attentionEnabled;
  const m = await meta(pubkey).catch(() => ({}));
  const withComputer = m.desktop === true;
  const withOrchestrate = m.orchestrate === true;
  await fs.mkdir(mcp, { recursive: true, mode: 0o700 });
  await fs.rm(path.join(mcp, "attention"), { force: true }); // before 2026-11-17
  await writePrivate(
    file,
    `#!/bin/sh\n# Buzz tools for buzz-host agent ${pubkey} (written by buzz-host).\n` +
      `exec ${sq(process.execPath)} ${sq(path.join(LIB, "buzz-mcp.mjs"))} ${pubkey}${withAttention ? " --attention" : ""}${withComputer ? " --computer" : ""}${withOrchestrate ? " --orchestrate" : ""}\n`,
  );
  await fs.chmod(file, 0o700);
  return file;
}

async function systemctl(...args) {
  return run("systemctl", ["--user", ...args], { timeout: 60_000 });
}
const unit = (pubkey) => `buzz-agent@${pubkey}.service`;
async function active(pubkey) {
  try {
    const { stdout } = await systemctl("is-active", unit(pubkey));
    return stdout.trim();
  } catch (error) {
    return (error.stdout ?? "").trim() || "unknown";
  }
}

async function buzzCli(pubkey, args) {
  const m = await meta(pubkey);
  const env = {
    PATH: process.env.PATH,
    HOME,
    BUZZ_RELAY_URL: m.community.replace(/^ws/, "http"),
    BUZZ_PRIVATE_KEY: (await fs.readFile(path.join(dir(pubkey), "key"), "utf8")).trim(),
    BUZZ_AUTH_TAG: await fs.readFile(path.join(dir(pubkey), "auth.json"), "utf8"),
  };
  try {
    const { stdout } = await run(path.join(BIN, "buzz"), args, {
      env,
      timeout: 60_000,
    });
    return stdout;
  } catch (error) {
    throw new Error(
      `buzz ${args.slice(0, 2).join(" ")} failed: ${(error.stderr || error.message).trim().slice(0, 500)}`,
    );
  }
}
async function publishProfile(pubkey, name, picture) {
  const args = ["users", "set-profile", "--name", name];
  if (picture) args.push("--avatar", picture);
  await buzzCli(pubkey, args);
}
function checkPicture(picture) {
  if (picture === undefined || picture === "") return undefined;
  const url = new URL(picture);
  if (url.protocol !== "https:") throw new Error("Picture must be an https URL");
  return picture;
}
function checkName(name) {
  if (typeof name !== "string" || !name.trim() || name.length > 128)
    throw new Error("Invalid agent name");
  return name.trim();
}

// ---------- methods ----------

// Each runtime's (and Hermes profile's) models and effort levels, probed
// with an unprompted session and kept for six hours (catalog.mjs).
const PROBE_DIR = path.join(LIB, "probe");
const catalog = catalogs({ dir: path.join(HOME, ".local/share/buzz-host/catalog") });

async function runtimeCatalog(runtime, profile = "", configured = "", { wait = true } = {}) {
  if (!Object.hasOwn(RUNTIMES, runtime)) throw new Error("Unknown runtime");
  const home = runtime === "hermes" && profile ? hermesHome(profile) : "";
  await fs.mkdir(PROBE_DIR, { recursive: true });
  const probed = await catalog(
    `${runtime}:${profile}`,
    {
      command: RUNTIMES[runtime].command,
      env: { ...process.env, ...(home ? { HERMES_HOME: home } : {}) },
      cwd: PROBE_DIR,
      // hermes-acp lists one set of levels (reasoning_effort) for every model.
      perModel: runtime !== "hermes",
    },
    { wait },
  );
  return probed && toModels(probed, configured);
}

const installed = (command) => fs.access(command, fs.constants.X_OK).then(() => true, () => false);

/** The agent's own runtime's models, and every other installed runtime's
 * that has answered a probe (one not signed in never does; it's left out).
 * Only the agent's own is waited for: the others are probed in the
 * background and join a later answer (`runtimesPending` until then). */
async function chatCatalog(runtime, profile, configured) {
  const own = await runtimeCatalog(runtime, profile, configured);
  let pending = false;
  const others = await Promise.all(
    Object.entries(RUNTIMES)
      .filter(([id]) => id !== runtime)
      .map(async ([id, r]) => {
        if (!(await installed(r.command))) return null;
        const models = await runtimeCatalog(id, "", "", { wait: false }).catch(() => null);
        if (models === undefined) pending = true;
        return models?.models?.length ? { runtime: id, title: r.title, ...models } : null;
      }),
  );
  const all = withRuntimes({ runtime, title: RUNTIMES[runtime].title, ...own }, others.filter(Boolean));
  return pending ? { ...all, runtimesPending: true } : all;
}

function checkPlace(channelId, threadRootId) {
  if (typeof channelId !== "string" || !UUID.test(channelId)) throw new Error("Invalid channel id");
  if (threadRootId != null && (typeof threadRootId !== "string" || !HEX64.test(threadRootId)))
    throw new Error("Invalid thread root");
}

// Calls that only read, or only reach the agent's runtime, and must not wait
// behind a slow call for the same agent (a compaction runs for minutes).
const UNSERIALIZED = new Set([
  "catalog",
  "session.state",
  "session.control",
  "interrupt",
  "desktop.status",
  "desktop.view",
  "desktop.lease",
  "desktop.snapshot",
  "orchestrator.tasks",
  "orchestrator.cancel",
]);

// ---------- agent desktops (desktop/) ----------
// One headless Xfce desktop per agent that the owner gives one, driven by the
// agent through its computer tools and watched (or taken over) from the
// plugin's full-screen view over /desktop. A view ticket is single-use and short-
// lived; its viewer id is the lease capability for that viewing session.
const VIEW_TICKET_MS = 60_000;
const viewTickets = new Map(); // ticket -> { pubkey, viewer, expires }
function desktopView(pubkey) {
  const st = desktop.status(pubkey);
  return { ...st, rfbSocket: undefined, cuaSocket: undefined, lastUse: desktop.lastUse(pubkey) };
}

// Stills for the in-chat preview. Several cards (and Buzz windows) may poll the
// same agent: one capture serves every request within SNAPSHOT_REUSE_MS.
const SNAPSHOT_REUSE_MS = 700;
const snapshots = new Map(); // `${pubkey}:${width}` -> { at, promise }
function sharedSnapshot(pubkey, socketPath, width) {
  const key = `${pubkey}:${width}`;
  const hit = snapshots.get(key);
  if (hit && Date.now() - hit.at < SNAPSHOT_REUSE_MS) return hit.promise;
  const promise = desktopSnapshot(socketPath, { width });
  snapshots.set(key, { at: Date.now(), promise });
  promise.catch(() => snapshots.delete(key));
  return promise;
}

const methods = {
  async hello() {
    const runtimes = await Promise.all(
      Object.entries(RUNTIMES).map(async ([id, r]) => ({
        id,
        title: r.title,
        available: await installed(r.command),
      })),
    );
    return { version: VERSION, host: os.hostname(), runtimes };
  },

  // A new key, not yet anyone's. Kept until activate or remove.
  async provision(config, { name, picture, community, config: settings }) {
    checkName(name);
    checkCommunity(config, community);
    const s = settingsFrom(settings);
    await checkProfile(s.profile);
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "secp256k1" });
    const jwk = privateKey.export({ format: "jwk" });
    const secret = Buffer.from(jwk.d, "base64url").toString("hex").padStart(64, "0");
    const pubkey = Buffer.from(jwk.x, "base64url").toString("hex").padStart(64, "0");
    await fs.mkdir(dir(pubkey), { recursive: true, mode: 0o700 });
    await writePrivate(path.join(dir(pubkey), "key"), `${secret}\n`);
    const instructions =
      typeof settings?.instructions === "string" ? settings.instructions : "";
    checkInstructions(instructions);
    await writePrivate(path.join(dir(pubkey), "instructions.md"), instructions);
    await saveMeta(pubkey, {
      pubkey,
      name: name.trim(),
      picture: checkPicture(picture),
      community,
      ...s,
      hasInstructions: instructions.trim().length > 0,
      createdAt: new Date().toISOString(),
      activated: false,
    });
    return { pubkey, ...(picture ? { picture } : {}) };
  },

  async activate(config, { pubkey, name, community, auth, config: settings }) {
    checkPubkey(pubkey);
    checkCommunity(config, community);
    if (
      !Array.isArray(auth) ||
      auth.length !== 4 ||
      auth[0] !== "auth" ||
      !HEX64.test(auth[1]) ||
      typeof auth[2] !== "string" ||
      !/^[0-9a-f]{128}$/.test(auth[3])
    )
      throw new Error("Invalid owner attestation");
    const m = await meta(pubkey);
    if (m.owner && m.owner !== auth[1])
      throw new Error("This agent already belongs to another owner");
    const next = {
      ...m,
      name: checkName(name ?? m.name),
      community,
      owner: auth[1],
      ...(settings ? settingsFrom(settings, m) : {}),
    };
    await checkProfile(next.profile);
    if (typeof settings?.instructions === "string") {
      checkInstructions(settings.instructions);
      await writePrivate(path.join(dir(pubkey), "instructions.md"), settings.instructions);
      next.hasInstructions = settings.instructions.trim().length > 0;
    }
    await writePrivate(path.join(dir(pubkey), "auth.json"), JSON.stringify(auth));
    await writeRuntimeEnv(pubkey, next);
    await fs.mkdir(path.join(WORK, pubkey), { recursive: true });
    await publishProfile(pubkey, next.name, next.picture);
    next.activated = true;
    await saveMeta(pubkey, next);
    await systemctl("enable", "--now", unit(pubkey));
    await systemctl("restart", unit(pubkey));
    return { status: await active(pubkey) };
  },

  async profile(config, { pubkey, name, picture }) {
    checkPubkey(pubkey);
    const m = await meta(pubkey);
    const next = { ...m, name: checkName(name), picture: checkPicture(picture) };
    if (m.activated) await publishProfile(pubkey, next.name, next.picture);
    await saveMeta(pubkey, next);
    return {};
  },

  async "instructions.get"(config, { pubkey }) {
    checkPubkey(pubkey);
    await meta(pubkey);
    return {
      instructions: await fs
        .readFile(path.join(dir(pubkey), "instructions.md"), "utf8")
        .catch(() => ""),
    };
  },

  // `base` is the copy the editor last read: refuse when it changed since.
  async "instructions.set"(config, { pubkey, instructions, base }) {
    checkPubkey(pubkey);
    checkInstructions(instructions);
    const m = await meta(pubkey);
    const file = path.join(dir(pubkey), "instructions.md");
    if (typeof base === "string") {
      const current = await fs.readFile(file, "utf8").catch(() => "");
      if (current !== base) throw new Error("CHANGED: Its instructions were changed elsewhere.");
    }
    await writePrivate(file, instructions);
    const next = { ...m, hasInstructions: instructions.trim().length > 0 };
    await saveMeta(pubkey, next);
    if (m.activated) {
      await writeRuntimeEnv(pubkey, next);
      await systemctl("restart", unit(pubkey));
    }
    return {};
  },

  async "settings.get"(config, { pubkey }) {
    checkPubkey(pubkey);
    const m = await meta(pubkey);
    return {
      runtime: m.runtime,
      model: m.model,
      profile: m.profile || "",
      concurrency: checkConcurrency(m.concurrency, DEFAULT_CONCURRENCY),
      status: await active(pubkey),
    };
  },

  async "settings.set"(config, { pubkey, runtime, model, profile, concurrency }) {
    checkPubkey(pubkey);
    const m = await meta(pubkey);
    const next = { ...m, ...settingsFrom({ runtime, model, profile, concurrency }, m) };
    await checkProfile(next.profile);
    await saveMeta(pubkey, next);
    if (m.activated) {
      await writeRuntimeEnv(pubkey, next);
      await systemctl("restart", unit(pubkey));
    }
    return { status: await active(pubkey) };
  },

  // Attention (the agent's Interests, watches and timers) for the plugin's tab.
  async "attention.get"(config, { pubkey }) {
    checkPubkey(pubkey);
    await meta(pubkey);
    return attention.get(pubkey);
  },

  // Buzz's own Attention tab (Buzz patch 0005): the record in Buzz's shape,
  // and the owner's edits in Buzz's AgentChange shape.
  async "attention.view"(config, { pubkey }) {
    checkPubkey(pubkey);
    await meta(pubkey);
    return attention.view(pubkey);
  },
  async "attention.change"(config, { pubkey, change }) {
    checkPubkey(pubkey);
    await meta(pubkey);
    if (!change || typeof change !== "object") throw new Error("change is required");
    return attention.ownerChange(pubkey, change);
  },

  // On or off. The agent restarts so its sessions gain or lose the tools.
  async "attention.set"(config, { pubkey, enabled }) {
    checkPubkey(pubkey);
    const m = await meta(pubkey);
    const result = await attention.setEnabled(pubkey, enabled === true);
    if (m.activated) {
      await writeRuntimeEnv(pubkey, m);
      await systemctl("restart", unit(pubkey));
    }
    return result;
  },

  // The owner's edits: pause/resume an Interest, remove it with its watches,
  // turn a watch on or off, remove a watch.
  async "attention.edit"(config, { pubkey, op, id, paused, enabled }) {
    checkPubkey(pubkey);
    await meta(pubkey);
    return attention.ownerEdit(pubkey, { op, id, paused, enabled });
  },

  async restart(config, { pubkey }) {
    checkPubkey(pubkey);
    const m = await meta(pubkey);
    if (!m.activated) throw new Error("Agent is not activated yet");
    await systemctl("restart", unit(pubkey));
    return { status: await active(pubkey) };
  },

  async logs(config, { pubkey, lines = 80 }) {
    checkPubkey(pubkey);
    await meta(pubkey);
    const n = Math.min(Math.max(Number(lines) || 80, 1), 500);
    const { stdout } = await run(
      "journalctl",
      ["--user", "-u", unit(pubkey), "-n", String(n), "--no-pager", "-o", "short-iso"],
      { timeout: 30_000, maxBuffer: 4 << 20 },
    ).catch((error) => ({ stdout: error.stdout ?? "" }));
    return { text: stdout };
  },

  // Model ids the runtime offers, from `buzz-acp models --json`.
  // For Hermes, the profile's: each profile has its own providers and sign-ins.
  async models(config, { runtime, profile }) {
    if (!Object.hasOwn(RUNTIMES, runtime)) throw new Error("Unknown runtime");
    const { profile: home } = settingsFrom({ runtime, profile });
    await checkProfile(home);
    const { stdout } = await run(path.join(BIN, "buzz-acp"), ["models", "--json"], {
      env: {
        ...process.env,
        BUZZ_ACP_AGENT_COMMAND: RUNTIMES[runtime].command,
        BUZZ_PRIVATE_KEY: "0".repeat(63) + "1",
        ...(home ? { HERMES_HOME: hermesHome(home) } : {}),
      },
      cwd: WORK,
      timeout: 45_000,
      maxBuffer: 4 << 20,
    });
    const parsed = JSON.parse(stdout);
    const seen = new Map();
    const add = (id, name) => {
      if (typeof id === "string" && id && !seen.has(id)) seen.set(id, name || id);
    };
    const flatOptions = (option) =>
      (option.options ?? []).flatMap((v) => (Array.isArray(v?.options) ? v.options : [v]));
    const groups = [parsed, parsed.stable ?? {}, parsed.unstable ?? {}];
    const efforts = [];
    const EFFORT = new Set(["thought_level", "effort", "reasoning_effort", "reasoning", "thinking"]);
    for (const option of groups.flatMap((g) => g.configOptions ?? [])) {
      if (option.category === "model" || option.id === "model")
        for (const o of flatOptions(option)) add(o.value, o.name);
      else if (EFFORT.has(option.category) || EFFORT.has(option.id))
        for (const o of flatOptions(option))
          if (!efforts.some((e) => e.value === o.value)) efforts.push({ value: o.value, name: o.name ?? o.value });
    }
    // Fall back to legacy availableModels only when the adapter omits a model configOption
    // (some adapters, like agy acp, list flattened model+effort pairs in availableModels
    // alongside clean base models + thought_level in configOptions).
    if (seen.size === 0) {
      for (const g of groups)
        for (const m of g.availableModels ?? g.models?.availableModels ?? [])
          add(m.modelId ?? m.id, m.name);
    }
    return { models: [...seen].map(([id, name]) => ({ id, name })), efforts };
  },

  // The Hermes profiles an agent can run on, for the plugin's picker.
  async "hermes.profiles"() {
    return { profiles: await hermesProfiles(true) };
  },

  async list() {
    const names = await fs.readdir(DATA).catch(() => []);
    const agents = [];
    for (const name of names.filter((n) => HEX64.test(n))) {
      const m = await meta(name).catch(() => undefined);
      if (m)
        agents.push({
          pubkey: m.pubkey,
          name: m.name,
          runtime: m.runtime,
          model: m.model,
          profile: m.profile || "",
          concurrency: checkConcurrency(m.concurrency, DEFAULT_CONCURRENCY),
          activated: m.activated,
          desktop: m.desktop === true,
          orchestrate: m.orchestrate === true,
          status: m.activated ? await active(name) : "provisioned",
        });
    }
    return { agents };
  },

  // Buzz's Stop: cancel the turn running in one conversation (channel, and the
  // thread root Buzz names it by). False when nothing there was running.
  async interrupt(config, { pubkey, channelId, threadRootId }) {
    checkPubkey(pubkey);
    await meta(pubkey);
    if (typeof channelId !== "string" || !UUID.test(channelId)) throw new Error("Invalid channel id");
    if (threadRootId != null && (typeof threadRootId !== "string" || !HEX64.test(threadRootId)))
      throw new Error("Invalid thread root");
    const reply = await proxyControl(pubkey, { op: "cancel", channel: channelId, root: threadRootId || undefined });
    if (reply.error) throw new Error(reply.error);
    return { cancelled: !!reply.cancelled };
  },

  // The models and effort levels Buzz's composer offers for this agent's next
  // turn (Buzz's `Models`): its own runtime's, then other runtimes'
  // ("codex::<id>"). acp-proxy applies a pick from the message tags; one on
  // another runtime moves the chat there.
  async catalog(config, { pubkey }) {
    checkPubkey(pubkey);
    const m = await meta(pubkey);
    const { runtime, profile } = settingsFrom(m);
    return chatCatalog(runtime, profile, m.model || "");
  },

  // Buzz's session controls for one conversation (channel + thread root).
  async "session.state"(config, { pubkey, channelId, threadRootId }) {
    checkPubkey(pubkey);
    checkPlace(channelId, threadRootId);
    await meta(pubkey);
    const reply = await proxyControl(
      pubkey,
      { op: "state", channel: channelId, root: threadRootId || undefined },
      5_000,
      { state: "unavailable" },
    ).catch(() => ({ state: "unavailable" }));
    return { state: reply.state ?? "unavailable" };
  },
  async "session.control"(config, { pubkey, channelId, threadRootId, action }) {
    checkPubkey(pubkey);
    checkPlace(channelId, threadRootId);
    await meta(pubkey);
    const op = { interrupt: "cancel", new: "new", compact: "compact" }[action];
    if (!op) throw new Error("Unknown session action");
    const reply = await proxyControl(
      pubkey,
      { op, channel: channelId, root: threadRootId || undefined },
      op === "compact" ? 16 * 60_000 : 10_000,
      { error: "The agent isn't running on the server right now." },
    );
    if (reply.error) throw new Error(reply.error);
    return reply;
  },

  // Stops it and deletes its key. Already gone counts as removed.
  // The agent's desktop. `enabled` is the owner's choice (computer tools in
  // the agent's sessions); the desktop itself starts on first use.
  async "desktop.status"(config, { pubkey }) {
    checkPubkey(pubkey);
    const m = await meta(pubkey);
    return { enabled: m.desktop === true, ...desktopView(pubkey) };
  },
  async "desktop.set"(config, { pubkey, enabled }) {
    checkPubkey(pubkey);
    const m = await meta(pubkey);
    const next = { ...m, desktop: enabled === true };
    await saveMeta(pubkey, next);
    if (!next.desktop) await desktop.stop(pubkey);
    if (m.activated && next.desktop !== (m.desktop === true)) {
      await writeRuntimeEnv(pubkey, next);
      await systemctl("restart", unit(pubkey));
    }
    return { enabled: next.desktop, ...desktopView(pubkey) };
  },
  async "desktop.start"(config, { pubkey }) {
    checkPubkey(pubkey);
    if ((await meta(pubkey)).desktop !== true) throw new Error("This agent has no desktop; turn it on first");
    await desktop.start(pubkey);
    return { enabled: true, ...desktopView(pubkey) };
  },
  async "desktop.stop"(config, { pubkey }) {
    checkPubkey(pubkey);
    await meta(pubkey);
    await desktop.stop(pubkey);
    return desktopView(pubkey);
  },
  // A small PNG of the agent's screen for the owner's in-chat preview, with
  // when the agent last used a computer tool (scoped to the chat when given).
  // Never starts the desktop.
  // `since` (ms): no picture unless a computer tool was used since then.
  // `etag`: no picture when it has not changed since that one.
  async "desktop.snapshot"(config, { pubkey, width, since, etag, channelId, threadRootId }) {
    checkPubkey(pubkey);
    if (channelId != null) checkPlace(channelId, threadRootId);
    const m = await meta(pubkey);
    if (m.desktop !== true) return { enabled: false };
    const st = desktop.status(pubkey);
    const place = channelId ? { channelId, threadRootId: threadRootId || undefined } : undefined;
    const base = { enabled: true, running: st.running, lastUse: desktop.lastUse(pubkey, place), lease: st.lease };
    if (!st.running) return base;
    if (Number.isFinite(since) && !(base.lastUse && base.lastUse.at >= since)) return base;
    const w = Math.max(160, Math.min(Number.isFinite(width) ? Math.round(width) : 480, 1280));
    const shot = await sharedSnapshot(pubkey, st.rfbSocket, w);
    const out = { ...base, at: Date.now(), etag: shot.etag, width: shot.width, height: shot.height };
    if (etag === shot.etag) return { ...out, same: true };
    return { ...out, image: `data:image/png;base64,${shot.png.toString("base64")}` };
  },
  // A ticket for one /desktop connection, and the viewer id that connection
  // takes over with. Starts the desktop if it is not running.
  async "desktop.view"(config, { pubkey }) {
    checkPubkey(pubkey);
    if ((await meta(pubkey)).desktop !== true) throw new Error("This agent has no desktop; turn it on first");
    await desktop.start(pubkey);
    const now = Date.now();
    for (const [t, v] of viewTickets) if (v.expires < now) viewTickets.delete(t);
    const ticket = randomBytes(24).toString("base64url");
    const viewer = randomBytes(24).toString("base64url");
    viewTickets.set(ticket, { pubkey, viewer, expires: now + VIEW_TICKET_MS });
    return { ticket, viewer, path: `/desktop?ticket=${ticket}`, ...desktopView(pubkey) };
  },
  // take: true = Take over (this viewer drives; the agent is refused),
  // false = Hand back. Only the viewer that holds it can hand it back.
  async "desktop.lease"(config, { pubkey, viewer, take, reason }) {
    checkPubkey(pubkey);
    if (typeof viewer !== "string" || viewer.length < 16) throw new Error("viewer is required");
    const leaseDir = desktop.desktopDir(pubkey);
    const lease = take
      ? leaseAcquire(leaseDir, viewer, typeof reason === "string" ? reason.slice(0, 200) : "")
      : leaseRelease(leaseDir, { viewerId: viewer });
    return { lease: publicView(lease), mine: lease.holder === "human" && lease.viewer_id === viewer };
  },

  // Cross-harness worker orchestration (orchestrator.mjs). Off by default;
  // turning it on or off rewrites the agent's MCP wrapper and restarts it.
  async "orchestrator.set"(config, { pubkey, enabled }) {
    checkPubkey(pubkey);
    const m = await meta(pubkey);
    const nextEnabled = enabled === true;
    if (nextEnabled) {
      // Best-effort: prepare Hermes plugin so Hermes Solo-chat workers work.
      await ensureSessionEnv(m.profile || "").catch(() => {});
    }
    const next = { ...m, orchestrate: nextEnabled };
    await saveMeta(pubkey, next);
    if (m.activated && next.orchestrate !== (m.orchestrate === true)) {
      await writeRuntimeEnv(pubkey, next);
      await systemctl("restart", unit(pubkey));
    }
    return { enabled: next.orchestrate };
  },
  async "orchestrator.tasks"(config, { pubkey, channelId, threadRootId, taskId, since, full }) {
    checkPubkey(pubkey);
    if (channelId != null) checkPlace(channelId, threadRootId);
    if (taskId != null && (typeof taskId !== "string" || !taskId)) throw new Error("Invalid taskId");
    const parsedSince = since != null ? Number(since) : undefined;
    if (since != null && !Number.isFinite(parsedSince)) throw new Error("Invalid since timestamp");
    const m = await meta(pubkey);
    const view = await orchestrator.tasks({
      pubkey,
      channelId: channelId || undefined,
      threadRootId: threadRootId || undefined,
      taskId: taskId || undefined,
      since: parsedSince,
      full: full === true,
    });
    return {
      enabled: m.orchestrate === true,
      tasks: view?.tasks ?? [],
      ...(view?.task !== undefined ? { task: view.task } : {}),
    };
  },
  async "orchestrator.cancel"(config, { pubkey, taskId }) {
    checkPubkey(pubkey);
    await meta(pubkey);
    if (typeof taskId !== "string" || !taskId) throw new Error("taskId is required");
    return orchestrator.cancel({ pubkey, taskId });
  },

  async remove(config, { pubkey }) {
    checkPubkey(pubkey);
    await systemctl("disable", "--now", unit(pubkey)).catch(() => {});
    await orchestrator.forget(pubkey).catch(() => {});
    await desktop.stop(pubkey).catch(() => {});
    await fs.rm(dir(pubkey), { recursive: true, force: true });
    watcher.sync(pubkey, null);
    attention.forget(pubkey);
    return {};
  },
};

// ---------- minimal WebSocket (RFC 6455) ----------

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_FRAME = 1 << 20;

function frame(opcode, payload) {
  const len = payload.length;
  const head =
    len < 126
      ? Buffer.from([0x80 | opcode, len])
      : len < 65536
        ? Buffer.from([0x80 | opcode, 126, len >> 8, len & 255])
        : (() => {
            const b = Buffer.alloc(10);
            b[0] = 0x80 | opcode;
            b[1] = 127;
            b.writeBigUInt64BE(BigInt(len), 2);
            return b;
          })();
  return Buffer.concat([head, payload]);
}

function serveSocket(socket, onText) {
  let buffer = Buffer.alloc(0);
  let fragments = [];
  const send = (text) => socket.write(frame(1, Buffer.from(text)));
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const fin = buffer[0] & 0x80;
      const opcode = buffer[0] & 0x0f;
      const masked = buffer[1] & 0x80;
      let len = buffer[1] & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buffer.length < 4) return;
        len = buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buffer.length < 10) return;
        len = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (!masked || len > MAX_FRAME) return socket.destroy();
      if (buffer.length < offset + 4 + len) return;
      const mask = buffer.subarray(offset, offset + 4);
      const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      buffer = buffer.subarray(offset + 4 + len);
      if (opcode === 8) {
        socket.end(frame(8, Buffer.alloc(0)));
        return;
      }
      if (opcode === 9) {
        socket.write(frame(10, payload));
        continue;
      }
      if (opcode === 10) continue;
      if (opcode === 1 || opcode === 0) {
        fragments.push(payload);
        if (fin) {
          const text = Buffer.concat(fragments).toString("utf8");
          fragments = [];
          onText(text, send);
        }
      }
    }
  });
  socket.on("error", () => {});
}

// ---------- server ----------

const config = await loadConfig();
const memory = createMemory({ dataDir: DATA });
const orchestrator = createOrchestrator({
  dataDir: DATA,
  stateDir: path.join(HOME, ".local/share/buzz-host/orchestrator"),
  shimsDir: SHIMS,
  runDir: RUN_DIR,
  catalog: (runtime) => runtimeCatalog(runtime),
  ensureHermes: (profile) => ensureSessionEnv(profile || ""),
});
const attention = createAttention({ dataDir: DATA, runDir: RUN_DIR, extra: [memory, orchestrator] });
// Event watches: one relay connection per agent that has any, fed to Attention.
const watcher = createRelayWatcher({
  dataDir: DATA,
  onEvent: (pubkey, event) => attention.watchEvent(pubkey, event),
  // Each (re)connect: catch the agent's watches up to it.
  onReady: (pubkey) => attention.connected(pubkey),
});
attention.onChange = (pubkey, record) => watcher.sync(pubkey, record);
attention.relay = watcher;
await attention.start();
for (const pubkey of await attention.enabledAgents())
  watcher.sync(pubkey, (await attention.load(pubkey)).record);
// Agents set up before the "buzz" MCP server (memory, 2026-11-17) still name
// mcp/attention, or nothing: rewrite their runtime.env once and restart them.
for (const name of (await fs.readdir(DATA).catch(() => [])).filter((n) => HEX64.test(n))) {
  const m = await meta(name).catch(() => undefined);
  if (!m?.activated) continue;
  const env = await fs.readFile(path.join(dir(name), "runtime.env"), "utf8").catch(() => "");
  if (env.includes(path.join(dir(name), "mcp", "buzz"))) continue;
  try {
    await writeRuntimeEnv(name, m);
    if ((await active(name)) === "active") await systemctl("restart", unit(name));
    console.log(`agent ${name.slice(0, 8)}: now has the buzz MCP server (memory)`);
  } catch (error) {
    console.error(`agent ${name.slice(0, 8)}: buzz MCP server not set up: ${error.message}`);
  }
}
// One request at a time per agent, so retries and edits never interleave.
const locks = new Map();
function serialized(key, task) {
  const previous = locks.get(key) ?? Promise.resolve();
  const next = previous.then(task, task);
  locks.set(key, next.catch(() => {}));
  return next;
}

const server = createServer((req, res) => {
  res.writeHead(req.url === "/health" ? 200 : 404, { "content-type": "text/plain" });
  res.end(req.url === "/health" ? "ok\n" : "not found\n");
});

server.on("upgrade", (req, socket) => {
  const login = req.headers["tailscale-user-login"];
  const origin = req.headers.origin;
  const refuse = (code, why) => {
    console.warn(`refused ${code}: ${why} (login=${login ?? "-"} origin=${origin ?? "-"})`);
    socket.end(`HTTP/1.1 ${code}\r\nConnection: close\r\n\r\n`);
  };
  if (!login || !config.allowLogins.has(login)) return refuse("403 Forbidden", "login");
  if (origin && !config.allowOrigins.has(origin)) return refuse("403 Forbidden", "origin");
  const key = req.headers["sec-websocket-key"];
  if (!key || req.headers.upgrade?.toLowerCase() !== "websocket")
    return refuse("400 Bad Request", "not a websocket");
  // A desktop view: RFB over binary frames, for the ticket desktop.view issued.
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/desktop") {
    const ticket = url.searchParams.get("ticket") ?? "";
    const view = viewTickets.get(ticket);
    viewTickets.delete(ticket);
    if (!view || view.expires < Date.now()) return refuse("403 Forbidden", "desktop ticket");
    const st = desktop.status(view.pubkey);
    if (!st.running) return refuse("409 Conflict", "desktop not running");
    acceptUpgrade(req, socket);
    console.log(`desktop view: ${login} agent=${view.pubkey.slice(0, 8)}`);
    const leaseDir = desktop.desktopDir(view.pubkey);
    rfbBridge(socket, { rfbSocket: st.rfbSocket, leaseDir, viewerId: view.viewer });
    // A viewer that goes away while in control hands it back, so a closed tab
    // never leaves the agent locked out.
    socket.on("close", () => {
      try {
        leaseRelease(leaseDir, { viewerId: view.viewer });
      } catch {}
    });
    return;
  }
  const accept = createHash("sha1").update(key + GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  console.log(`connected: ${login} origin=${origin ?? "-"}`);
  serveSocket(socket, async (text, send) => {
    let id;
    try {
      const message = JSON.parse(text);
      id = message.id;
      const method = methods[message.method];
      if (!method) throw new Error(`Unknown method ${message.method}`);
      const params = message.params ?? {};
      const result = UNSERIALIZED.has(message.method)
        ? await method(config, params)
        : await serialized(params.pubkey ?? message.method, () => method(config, params));
      send(JSON.stringify({ id, result }));
    } catch (error) {
      console.error(`error: ${error.message}`);
      send(JSON.stringify({ id, error: String(error.message ?? error) }));
    }
  });
});

server.listen(config.port, "127.0.0.1", () =>
  console.log(`buzz-host listening on 127.0.0.1:${config.port}`),
);

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`buzz-host shutting down (${signal})`);
  server.close();
  await orchestrator.close().catch(() => {});
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
