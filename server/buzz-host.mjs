#!/usr/bin/env node
// buzz-host: a self-hosted provider for Buzz "remote" agents.
//
// Buzz's remote agent type (the same contract Builderlab uses) calls
// provision → activate → profile / instructions / remove. This server keeps
// each agent's key on this machine and runs it with `buzz-acp` as a systemd
// user unit (buzz-agent@<pubkey>.service), so agents answer while the owner's
// laptop is closed. On macOS the same agent runs as a launchd LaunchAgent
// (service-manager.mjs).
//
// Transport: JSON over WebSocket on 127.0.0.1, published to the tailnet with
// `tailscale serve`, which adds the caller's Tailscale-User-Login header. Only
// logins listed in config.json are served. A second listener (guestPort) takes
// access tokens instead, for public tunnels (Funnel, zrok, any wss:// proxy):
// guest tokens, and admin tokens for an owner whose devices are not on the
// tailnet. With no allowLogins the tailnet listener is not started at all.
// No dependencies beyond Node.

import { createServer } from "node:http";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createAttention } from "./attention.mjs";
import { createMcpServer } from "./mcp-server.mjs";
import { createMemory } from "./memory.mjs";
import { createOrchestrator } from "./orchestrator.mjs";
import { createRelayWatcher } from "./attention-relay.mjs";
import { createDiscoveryPublisher, loadMachineId } from "./discovery.mjs";
import { catalogs, forComposer, formatTarget, parseTarget, resolveChatSettings, toModelList, toModels } from "./catalog.mjs";
import { proxyControl as routeControl } from "./control.mjs";
import * as desktop from "./desktop/desktop.mjs";
import { acquire as leaseAcquire, release as leaseRelease, publicView } from "./desktop/lease.mjs";
import { acceptUpgrade, bridge as rfbBridge } from "./desktop/rfb-bridge.mjs";
import { snapshot as desktopSnapshot } from "./desktop/snapshot.mjs";
import {
  assertSandboxRestrictions,
  createRunnerManager,
  isSandboxed,
  normalizeAllowlist,
  normalizeRespondTo,
  normalizeRunner,
} from "./sandbox/index.mjs";
import {
  assertAgentAccess,
  assertMethodAllowed,
  buildInviteUrl,
  canAccessAgent,
  createAuthRateLimiter,
  createTokenStore,
  assertGuestDesktop,
  desktopTicketTokenAllowed,
  enforceGuestSettings,
  findIdleGuestDesktops,
  isValidDesktopTicket,
  parseListenerConfig,
  sandboxDesktopAllowed,
} from "./auth.mjs";
import { createServiceManager, ensurePrivateDir, runDir, runtimeBase } from "./service-manager.mjs";
import { createIrohSupervisor } from "./iroh-supervisor.mjs";
import {
  clientIpFromForwardedFor,
  createFragmentBuffer,
  createGuestSocketRegistry,
  createIdleWatch,
  GUEST_IDLE_TIMEOUT_MS,
  MAX_GUEST_SOCKETS,
  MAX_MESSAGE_BYTES,
  MAX_UNAUTHENTICATED_GUEST_SOCKETS,
} from "./ws-security.mjs";

const run = promisify(execFile);
const HOME = os.homedir();
const LIB = path.join(HOME, ".local/lib/buzz-host");
const DATA = path.join(HOME, ".local/share/buzz-host/agents");
const WORK = path.join(HOME, "buzz-agents");
const CONFIG = path.join(HOME, ".config/buzz-host/config.json");
const BIN = path.join(LIB, "bin");
const VERSION = 2;
// macOS has no XDG_RUNTIME_DIR: use the short per-user base service-manager.mjs
// picks, and export it so every child (agent-run, docker-run, …) agrees.
if (process.platform === "darwin" && !process.env.XDG_RUNTIME_DIR) process.env.XDG_RUNTIME_DIR = runtimeBase();
const RUN_DIR = runDir();
// Agent desktops (Xvnc + Xfce + cua-driver, bwrap) exist on Linux hosts only.
const DESKTOP_SUPPORTED = process.platform === "linux";
function assertDesktopSupported() {
  if (!DESKTOP_SUPPORTED)
    throw new Error(`Agent desktops are not supported on ${process.platform === "darwin" ? "macOS" : process.platform} hosts`);
}
const services = createServiceManager();
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

function parseConfig(raw, file = CONFIG) {
  const { allowLogins, guestPort } = parseListenerConfig(raw, file);
  return {
    port: raw.port ?? 8457,
    // Dedicated localhost listener for public tunnel traffic (Tailscale Funnel,
    // zrok, any wss:// proxy). Ignores Tailscale-User-Login headers completely
    // and requires an access token (guest bhg_ or admin bha_).
    guestPort,
    publicGuestUrl: raw.publicGuestUrl ?? "wss://omarchy.tail65c5a9.ts.net/_buzz-host",
    maxGuestDesktops: Number.isInteger(raw.maxGuestDesktops) && raw.maxGuestDesktops >= 0 ? raw.maxGuestDesktops : 1,
    guestDesktopIdleMs:
      Number.isFinite(raw.guestDesktopIdleMs) && raw.guestDesktopIdleMs >= 0
        ? raw.guestDesktopIdleMs
        : 15 * 60_000,
    // A public guest socket that never authenticates is closed after this long.
    guestSocketIdleMs:
      Number.isFinite(raw.guestSocketIdleMs) && raw.guestSocketIdleMs > 0
        ? raw.guestSocketIdleMs
        : GUEST_IDLE_TIMEOUT_MS,
    guestMaxSockets:
      Number.isInteger(raw.guestMaxSockets) && raw.guestMaxSockets > 0
        ? raw.guestMaxSockets
        : MAX_GUEST_SOCKETS,
    guestMaxUnauthenticated:
      Number.isInteger(raw.guestMaxUnauthenticated) && raw.guestMaxUnauthenticated >= 0
        ? raw.guestMaxUnauthenticated
        : MAX_UNAUTHENTICATED_GUEST_SOCKETS,
    allowLogins,
    allowOrigins: new Set(
      raw.allowOrigins ?? [
        "tauri://localhost",
        "http://tauri.localhost",
        "https://tauri.localhost",
      ],
    ),
    // Communities agents may join; empty means any wss:// URL.
    allowCommunities: new Set(raw.allowCommunities ?? []),
    // Machine discovery (discovery.mjs): an encrypted status event per owner
    // on their relay. `discovery: false` turns it off.
    discovery: raw.discovery !== false,
    discoveryIntervalMs:
      Number.isFinite(raw.discoveryIntervalMs) && raw.discoveryIntervalMs >= 5_000 ? raw.discoveryIntervalMs : 45_000,
    machineId: typeof raw.machineId === "string" ? raw.machineId : undefined,
    machineName: typeof raw.machineName === "string" ? raw.machineName : undefined,
    publicUrl: typeof raw.publicUrl === "string" ? raw.publicUrl : undefined,
    // Optional Iroh QUIC -> guestPort sidecar (buzz-host-iroh).
    iroh: raw.iroh !== false,
    irohBin: typeof raw.irohBin === "string" ? raw.irohBin.trim() : "",
    irohMaxStreams:
      Number.isInteger(raw.irohMaxStreams) && raw.irohMaxStreams > 0
        ? raw.irohMaxStreams
        : undefined,
  };
}

async function loadConfig() {
  return parseConfig(JSON.parse(await fs.readFile(CONFIG, "utf8")));
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
  const respondTo = normalizeRespondTo(input?.respondTo, previous.respondTo ?? "owner-only");
  const respondToAllowlist =
    respondTo === "allowlist"
      ? normalizeAllowlist(input?.respondToAllowlist, previous.respondToAllowlist ?? [])
      : [];
  const runner = normalizeRunner(input?.runner, respondTo, previous.runner ?? "host");
  // Only host-native Hermes agents use host Hermes profiles; sandboxed Hermes uses its own container home.
  const kept = runtime === previous.runtime ? previous.profile : "";
  let profile =
    runtime === "hermes" && runner === "host" ? String(input?.profile ?? kept ?? "").trim() : "";
  if (profile === "default") profile = "";
  if (profile && !PROFILE.test(profile)) throw new Error("Invalid Hermes profile name");
  const concurrency = checkConcurrency(input?.concurrency, previous.concurrency ?? DEFAULT_CONCURRENCY);
  return { runtime, model, profile, concurrency, runner, respondTo, respondToAllowlist };
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
  const sandboxed = isSandboxed(m);
  const runner = m.runner || "host";
  const respondTo = normalizeRespondTo(m.respondTo, "owner-only");
  const allowlist = respondTo === "allowlist" ? normalizeAllowlist(m.respondToAllowlist, []) : [];
  if (sandboxed) {
    assertSandboxRestrictions(m);
    await runnerManager.prepareAgent(pubkey, { ...m, runner, respondTo, respondToAllowlist: allowlist });
  } else {
    if (respondTo !== "owner-only") {
      throw new Error('Shared agents (respondTo != "owner-only") must use a sandboxed runner (docker)');
    }
    await runnerManager.cleanupAgent(pubkey).catch(() => {});
  }
  const profile = m.runtime === "hermes" && !sandboxed ? m.profile || "" : "";
  if (m.runtime === "hermes" && !sandboxed) await ensureSessionEnv(profile);
  const concurrency = checkConcurrency(m.concurrency, DEFAULT_CONCURRENCY);
  const lines = {
    BUZZ_HOST_RUNNER: runner,
    BUZZ_RELAY_URL: m.community,
    BUZZ_ACP_AGENT_OWNER: m.owner,
    BUZZ_ACP_AGENT_COMMAND: runtime.command,
    BUZZ_ACP_AGENTS: String(concurrency),
    BUZZ_ACP_MODEL: m.model || undefined,
    BUZZ_ACP_RESPOND_TO: respondTo,
    BUZZ_ACP_RESPOND_TO_ALLOWLIST: allowlist.length ? allowlist.join(",") : undefined,
    BUZZ_ACP_ALLOWED_RESPOND_TO: sandboxed ? undefined : "owner-only",
    // The Hermes profile: hermes-acp and its gateway session use this home.
    HERMES_HOME: profile ? hermesHome(profile) : undefined,
    BUZZ_HOST_HERMES_PROFILE: profile || undefined,
    BUZZ_ACP_SYSTEM_PROMPT_FILE: m.hasInstructions
      ? path.join(dir(pubkey), "instructions.md")
      : undefined,
    // Buzz's tools: memory always, Attention while the owner has it on.
    BUZZ_ACP_MCP_COMMAND: sandboxed ? undefined : await writeBuzzMcp(pubkey),
  };
  const text = Object.entries(lines)
    .filter(([, value]) => value)
    .map(([key, value]) => `export ${key}=${sq(value)}`)
    .join("\n");
  await writePrivate(path.join(dir(pubkey), "runtime.env"), `${text}\n`);
  await attention.syncNotes([pubkey]);
}

// The agent's Buzz MCP server: a per-agent wrapper, because buzz-acp starts
// BUZZ_ACP_MCP_COMMAND without arguments and names the server after the file
// ("buzz", as Buzz's own). Memory tools always; Attention tools while the
// owner has Attention on; computer tools while the agent has a desktop;
// orchestrator tools while the owner has Orchestrator on (turning any on or
// off restarts the agent).
//
// The wrapper starts the compiled stdio bridge (server/buzz-mcp-bridge.c,
// installed as bin/buzz-mcp-bridge) when it is present: that is a few hundred
// KB per session talking to buzz-host's shared mcp.sock server. Without it the
// wrapper falls back to the standalone buzz-mcp.mjs Node server.
const BRIDGE = path.join(BIN, "buzz-mcp-bridge");
async function hasBridge() {
  try {
    await fs.access(BRIDGE, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function writeBuzzMcp(pubkey) {
  const mcp = path.join(dir(pubkey), "mcp");
  const file = path.join(mcp, "buzz");
  const withAttention = (await attention.load(pubkey)).record.attentionEnabled;
  const m = await meta(pubkey).catch(() => ({}));
  const withComputer = m.desktop === true;
  const withOrchestrate = m.orchestrate === true;
  const flags = `${withAttention ? " --attention" : ""}${withComputer ? " --computer" : ""}${withOrchestrate ? " --orchestrate" : ""}`;
  const command = (await hasBridge())
    ? `exec ${sq(BRIDGE)} ${pubkey}${flags}`
    : `exec ${sq(process.execPath)} ${sq(path.join(LIB, "buzz-mcp.mjs"))} ${pubkey}${flags}`;
  await fs.mkdir(mcp, { recursive: true, mode: 0o700 });
  await fs.rm(path.join(mcp, "attention"), { force: true }); // before 2026-11-17
  await writePrivate(
    file,
    `#!/bin/sh\n# Buzz tools for buzz-host agent ${pubkey} (written by buzz-host).\n${command}\n`,
  );
  await fs.chmod(file, 0o700);
  return file;
}

// Agent processes: systemd --user units on Linux, launchd LaunchAgents on macOS.
const active = (pubkey) => services.status(pubkey);

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

async function probeRuntime(runtime, profile = "", { wait = true } = {}) {
  if (!Object.hasOwn(RUNTIMES, runtime)) throw new Error("Unknown runtime");
  const home = runtime === "hermes" && profile ? hermesHome(profile) : "";
  await fs.mkdir(PROBE_DIR, { recursive: true });
  return catalog(
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
}

async function runtimeCatalog(runtime, profile = "", configured = "", { wait = true } = {}) {
  const probed = await probeRuntime(runtime, profile, { wait });
  return probed && toModels(probed, configured);
}

const installed = (command) => fs.access(command, fs.constants.X_OK).then(() => true, () => false);
const RUNTIME_IDS = new Set(Object.keys(RUNTIMES));

async function chatSettingsFor(pubkey, channelId, threadRootId, defaultRuntime, defaultProfile = "", sandboxed = false) {
  const file = sandboxed
    ? path.join(RUN_DIR, "sandbox", pubkey.slice(0, 16), "agent", "chat-settings.json")
    : path.join(dir(pubkey), "chat-settings.json");
  const settings = await readJson(file, {});
  return resolveChatSettings(settings, channelId, threadRootId, defaultRuntime, RUNTIME_IDS, defaultProfile);
}

/** Build the composer catalog for one agent (Option A: separate runtime/profile
 * selector + clean model list for the displayed runtime/profile).
 * Only the displayed runtime/profile is waited for; other non-Hermes runtimes
 * probe in the background (so unsigned-in ones like Codex stay hidden), and
 * other Hermes profiles are listed immediately and probed lazily on demand when
 * selected. */
async function chatCatalog(
  ownRuntime,
  ownProfile,
  configured,
  chat = null,
  requestedRuntime = "",
  { allowedRuntimes = null, allowHermesProfiles = true } = {},
) {
  const allowedSet = allowedRuntimes ? new Set(allowedRuntimes) : null;
  const ownTarget = formatTarget(ownRuntime, allowHermesProfiles ? ownProfile : "");
  const currentTarget = chat?.target || ownTarget;
  let display = parseTarget(currentTarget, RUNTIME_IDS) ?? {
    runtime: ownRuntime,
    profile: ownRuntime === "hermes" && allowHermesProfiles ? ownProfile : "",
    target: ownTarget,
  };
  if (requestedRuntime) {
    const parsed = parseTarget(requestedRuntime, RUNTIME_IDS);
    if (!parsed) throw new Error("Unknown runtime");
    if (allowedSet && !allowedSet.has(parsed.runtime)) {
      throw new Error(`Runtime "${parsed.runtime}" is not enabled for this guest token`);
    }
    if (parsed.runtime === "hermes" && parsed.profile) {
      if (!allowHermesProfiles) throw new Error("Host Hermes profiles are not available for guest agents");
      await checkProfile(parsed.profile);
    }
    display = parsed;
  }

  let pending = false;
  const runtimes = [];
  for (const [id, r] of Object.entries(RUNTIMES)) {
    if (allowedSet && !allowedSet.has(id)) continue;
    if (!(await installed(r.command))) continue;
    if (id === "hermes") {
      if (!allowHermesProfiles) {
        runtimes.push({ id: "hermes", label: "Hermes" });
        continue;
      }
      const rows = await hermesProfiles().catch(() => []);
      const names = [];
      const addName = (n) => {
        const clean = n === "" || n === "default" ? "default" : n;
        if (!names.includes(clean)) names.push(clean);
      };
      addName("default");
      for (const row of rows) addName(row.name);
      if (ownRuntime === "hermes" && ownProfile) addName(ownProfile);
      if (chat?.runtime === "hermes" && chat.profile) addName(chat.profile);
      if (display.runtime === "hermes" && display.profile) addName(display.profile);
      const multi = names.length > 1;
      for (const name of names) {
        const targetId = name === "default" ? "hermes" : `hermes:${name}`;
        runtimes.push({
          id: targetId,
          label: multi ? `Hermes · ${name}` : "Hermes",
          ...(multi ? { group: "Hermes" } : {}),
        });
      }
      continue;
    }
    const mustInclude = id === ownRuntime || id === chat?.runtime || id === display.runtime;
    if (mustInclude) {
      runtimes.push({ id, label: r.title });
      continue;
    }
    const models = await runtimeCatalog(id, "", "", { wait: false }).catch(() => null);
    if (models === undefined) pending = true;
    if (models?.models?.length) runtimes.push({ id, label: r.title });
  }

  const activeConfigured = display.target === ownTarget ? configured : "";
  const activeModels = await runtimeCatalog(display.runtime, display.profile, activeConfigured, { wait: true });
  const result = forComposer({
    active: { ...display, ...activeModels },
    runtimes,
    currentRuntime: currentTarget,
    chat,
  });
  return pending ? { ...result, runtimesPending: true } : result;
}

function checkPlace(channelId, threadRootId) {
  if (typeof channelId !== "string" || !UUID.test(channelId)) throw new Error("Invalid channel id");
  if (threadRootId != null && (typeof threadRootId !== "string" || !HEX64.test(threadRootId)))
    throw new Error("Invalid thread root");
}

// Calls that only read, or only reach the agent's runtime, and must not wait
// behind a slow call for the same agent (a compaction runs for minutes).
const UNSERIALIZED = new Set([
  "auth",
  "hello",
  "tokens.list",
  "catalog",
  "models",
  "hermes.profiles",
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
const viewTickets = new Map(); // ticket -> { pubkey, viewer, expires, role, tokenId }
const activeDesktopViewers = new Map(); // pubkey -> live RFB viewer count
const desktopLastActivity = new Map(); // pubkey -> timestamp ms
function touchDesktop(pubkey) {
  desktopLastActivity.set(pubkey, Date.now());
}
function trackViewer(pubkey, socket) {
  activeDesktopViewers.set(pubkey, (activeDesktopViewers.get(pubkey) ?? 0) + 1);
  touchDesktop(pubkey);
  let closed = false;
  socket.on("close", () => {
    if (closed) return;
    closed = true;
    const next = (activeDesktopViewers.get(pubkey) ?? 1) - 1;
    if (next <= 0) activeDesktopViewers.delete(pubkey);
    else activeDesktopViewers.set(pubkey, next);
    touchDesktop(pubkey);
  });
}
async function assertGuestDesktopCapacity(cfg, pubkey, m) {
  if (!m?.createdByTokenId) return;
  if (desktop.status(pubkey).running) return;
  const max = cfg.maxGuestDesktops ?? 1;
  const metas = await listAllMetas();
  let running = 0;
  for (const item of metas) {
    if (item.createdByTokenId && item.pubkey !== pubkey && desktop.status(item.pubkey).running) {
      running++;
    }
  }
  if (running >= max) {
    throw new Error(
      `The server is at its guest desktop limit (${running}/${max} running). Stop another desktop or try again later.`,
    );
  }
}
async function stopIdleGuestDesktops(cfg) {
  if (!cfg.guestDesktopIdleMs) return;
  const metas = await listAllMetas();
  const idle = findIdleGuestDesktops({
    metas,
    isRunning: (pubkey) => desktop.status(pubkey).running,
    activeViewers: (pubkey) => activeDesktopViewers.get(pubkey) ?? 0,
    lastActivityAt: (pubkey) => Math.max(desktop.lastUse(pubkey)?.at ?? 0, desktopLastActivity.get(pubkey) ?? 0),
    idleMs: cfg.guestDesktopIdleMs,
  });
  for (const pubkey of idle) {
    console.log(`guest desktop idle stop: agent=${pubkey.slice(0, 8)}`);
    desktopLastActivity.delete(pubkey);
    await desktop.stop(pubkey).catch(() => {});
  }
}
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

async function listAllMetas() {
  const names = await fs.readdir(DATA).catch(() => []);
  const out = [];
  for (const name of names.filter((n) => HEX64.test(n))) {
    const m = await meta(name).catch(() => undefined);
    if (m) out.push(m);
  }
  return out;
}

async function ownedMeta(pubkey, session) {
  checkPubkey(pubkey);
  const m = await meta(pubkey);
  assertAgentAccess(session, m);
  return m;
}

const methods = {
  async auth(config, { token }, session) {
    if (session.role === "admin" && session.authenticated) {
      return {
        role: "admin",
        ...(session.login ? { login: session.login } : {}),
        ...(session.tokenId ? { tokenId: session.tokenId, label: session.label, ownerPubkey: session.ownerPubkey } : {}),
      };
    }
    // One identity per socket: a socket already signed in with a guest token
    // cannot switch tokens (reconnect to use another one).
    if (session.authenticated) throw new Error("This connection is already authenticated");
    const key = session.remoteAddress || "unknown";
    if (authRateLimiter.isLimited(key)) {
      throw new Error("Too many failed authentication attempts; try again in a minute");
    }
    const record = await tokenStore.verify(token);
    if (!record) {
      authRateLimiter.recordFailure(key);
      throw new Error("Invalid or revoked access token");
    }
    authRateLimiter.clear(key);
    if (record.role === "admin") {
      // Admin access token: the owner on a device without Tailscale. Full
      // access, like the tailnet listener; revoking it closes this socket.
      session.authenticated = true;
      session.role = "admin";
      session.tokenId = record.id;
      session.label = record.label;
      session.ownerPubkey = record.ownerPubkey;
      session.limits = null;
      session.registerTokenSocket?.(record.id);
      session.onAuthenticated?.();
      console.log(`admin token authenticated: ${record.label} (${record.id})`);
      return { role: "admin", tokenId: record.id, label: record.label, ownerPubkey: record.ownerPubkey };
    }
    session.authenticated = true;
    session.role = "guest";
    session.tokenId = record.id;
    session.label = record.label;
    session.ownerPubkey = record.ownerPubkey;
    session.limits = {
      maxAgents: record.maxAgents,
      maxConcurrency: record.maxConcurrency,
      allowedRuntimes: record.allowedRuntimes,
      allowHostDesktop: record.allowHostDesktop === true,
      allowSandboxDesktop: sandboxDesktopAllowed(record),
    };
    session.registerTokenSocket?.(record.id);
    session.onAuthenticated?.();
    console.log(`guest authenticated: ${record.label} (${record.id})`);
    return {
      role: "guest",
      label: record.label,
      ownerPubkey: record.ownerPubkey,
      limits: session.limits,
    };
  },

  async hello(config, _params, session) {
    const isGuest = session?.role === "guest";
    const allowedSet = isGuest ? new Set(session.limits?.allowedRuntimes ?? []) : null;
    const [allRuntimes, allRunners] = await Promise.all([
      Promise.all(
        Object.entries(RUNTIMES).map(async ([id, r]) => ({
          id,
          title: r.title,
          available: await installed(r.command),
        })),
      ),
      runnerManager.availableRunners(),
    ]);
    const runtimes = allowedSet ? allRuntimes.filter((r) => allowedSet.has(r.id)) : allRuntimes;
    const runners = isGuest
      ? session.limits?.allowHostDesktop
        ? allRunners.filter((r) => r.id === "host" || r.id === "docker")
        : allRunners.filter((r) => r.id === "docker")
      : allRunners;
    return {
      version: VERSION,
      host: os.hostname(),
      // Stable across restarts: clients merge manual and discovered machines on it.
      machineId: MACHINE_ID,
      role: session?.role ?? "admin",
      // Host OS and what it can do, so clients hide what this host lacks.
      platform: process.platform,
      // sandboxDesktop: Docker agents can have a desktop (in a sidecar container).
      capabilities: { desktop: DESKTOP_SUPPORTED, sandboxDesktop: DESKTOP_SUPPORTED },
      // Which access token this connection uses (never the secret).
      ...(session?.tokenId ? { tokenId: session.tokenId } : {}),
      ...(isGuest
        ? {
            label: session.label,
            ownerPubkey: session.ownerPubkey ?? null,
            limits: session.limits,
          }
        : {
            publicGuestUrl: config.publicGuestUrl,
          }),
      runtimes,
      runners,
    };
  },

  // A new key, not yet anyone's. Kept until activate or remove.
  async provision(config, { name, picture, community, config: settings }, session) {
    checkName(name);
    checkCommunity(config, community);
    const isGuest = session?.role === "guest";
    if (isGuest) {
      const existing = (await listAllMetas()).filter((m) => canAccessAgent(session, m));
      const maxAgents = session.limits?.maxAgents ?? 2;
      if (existing.length >= maxAgents) {
        throw new Error(`Agent limit reached (${existing.length}/${maxAgents} agents for this guest token)`);
      }
    }
    const defaultGuestRunner =
      session?.limits?.allowHostDesktop && (settings?.respondTo ?? "owner-only") === "owner-only"
        ? "host"
        : "docker";
    const rawSettings = isGuest
      ? {
          ...settings,
          runner: settings?.runner || defaultGuestRunner,
          concurrency: settings?.concurrency ?? session.limits?.maxConcurrency ?? 2,
        }
      : settings;
    const s = enforceGuestSettings(session, settingsFrom(rawSettings));
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
      ...(isGuest
        ? {
            createdByTokenId: session.tokenId,
            ...(session.ownerPubkey ? { owner: session.ownerPubkey } : {}),
            lazyPool: true,
          }
        : {}),
      hasInstructions: instructions.trim().length > 0,
      createdAt: new Date().toISOString(),
      activated: false,
    });
    return { pubkey, ...(picture ? { picture } : {}) };
  },

  async activate(config, { pubkey, name, community, auth, config: settings }, session) {
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
    const m = await ownedMeta(pubkey, session);
    if (m.owner && m.owner !== auth[1])
      throw new Error("This agent already belongs to another owner");
    if (session?.role === "guest") {
      if (session.ownerPubkey && session.ownerPubkey !== auth[1]) {
        throw new Error("This access token is bound to another user");
      }
      const bound = await tokenStore.bindOwner(session.tokenId, auth[1]);
      session.ownerPubkey = bound.ownerPubkey;
    }
    const mergedSettings = settings
      ? enforceGuestSettings(session, settingsFrom(settings, m))
      : enforceGuestSettings(session, settingsFrom(m, m));
    const next = {
      ...m,
      name: checkName(name ?? m.name),
      community,
      owner: auth[1],
      ...mergedSettings,
    };
    assertSandboxRestrictions(next);
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
    await services.enableAndStart(pubkey);
    await services.restart(pubkey);
    discovery?.notifyChanged();
    return { status: await active(pubkey) };
  },

  async profile(config, { pubkey, name, picture }, session) {
    const m = await ownedMeta(pubkey, session);
    const next = { ...m, name: checkName(name), picture: checkPicture(picture) };
    if (m.activated) await publishProfile(pubkey, next.name, next.picture);
    await saveMeta(pubkey, next);
    discovery?.notifyChanged();
    return {};
  },

  async "instructions.get"(config, { pubkey }, session) {
    await ownedMeta(pubkey, session);
    return {
      instructions: await fs
        .readFile(path.join(dir(pubkey), "instructions.md"), "utf8")
        .catch(() => ""),
    };
  },

  // `base` is the copy the editor last read: refuse when it changed since.
  async "instructions.set"(config, { pubkey, instructions, base }, session) {
    checkInstructions(instructions);
    const m = await ownedMeta(pubkey, session);
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
      await services.restart(pubkey);
    }
    return {};
  },

  async "settings.get"(config, { pubkey }, session) {
    const m = await ownedMeta(pubkey, session);
    return {
      runtime: m.runtime,
      model: m.model,
      profile: m.profile || "",
      concurrency: checkConcurrency(m.concurrency, DEFAULT_CONCURRENCY),
      runner: m.runner || "host",
      respondTo: normalizeRespondTo(m.respondTo, "owner-only"),
      respondToAllowlist: Array.isArray(m.respondToAllowlist) ? m.respondToAllowlist : [],
      status: await active(pubkey),
    };
  },

  async "settings.set"(
    config,
    { pubkey, runtime, model, profile, concurrency, runner, respondTo, respondToAllowlist },
    session,
  ) {
    const m = await ownedMeta(pubkey, session);
    const updated = enforceGuestSettings(
      session,
      settingsFrom({ runtime, model, profile, concurrency, runner, respondTo, respondToAllowlist }, m),
    );
    const next = { ...m, ...updated };
    assertSandboxRestrictions(next);
    await checkProfile(next.profile);
    await saveMeta(pubkey, next);
    if (m.activated) {
      await writeRuntimeEnv(pubkey, next);
      await services.restart(pubkey);
    }
    return { status: await active(pubkey) };
  },

  // Attention (the agent's Interests, watches and timers) for the plugin's tab.
  async "attention.get"(config, { pubkey }, session) {
    await ownedMeta(pubkey, session);
    return attention.get(pubkey);
  },

  // Buzz's own Attention tab (Buzz patch 0005): the record in Buzz's shape,
  // and the owner's edits in Buzz's AgentChange shape.
  async "attention.view"(config, { pubkey }, session) {
    await ownedMeta(pubkey, session);
    return attention.view(pubkey);
  },
  async "attention.change"(config, { pubkey, change }, session) {
    await ownedMeta(pubkey, session);
    if (!change || typeof change !== "object") throw new Error("change is required");
    return attention.ownerChange(pubkey, change);
  },

  // On or off. The agent restarts so its sessions gain or lose the tools.
  async "attention.set"(config, { pubkey, enabled }, session) {
    const m = await ownedMeta(pubkey, session);
    const result = await attention.setEnabled(pubkey, enabled === true);
    if (m.activated) {
      await writeRuntimeEnv(pubkey, m);
      await services.restart(pubkey);
    }
    return result;
  },

  // The owner's edits: pause/resume an Interest, remove it with its watches,
  // turn a watch on or off, remove a watch.
  async "attention.edit"(config, { pubkey, op, id, paused, enabled }, session) {
    await ownedMeta(pubkey, session);
    return attention.ownerEdit(pubkey, { op, id, paused, enabled });
  },

  async restart(config, { pubkey }, session) {
    const m = await ownedMeta(pubkey, session);
    if (!m.activated) throw new Error("Agent is not activated yet");
    await services.restart(pubkey);
    return { status: await active(pubkey) };
  },

  async logs(config, { pubkey, lines = 80 }, session) {
    await ownedMeta(pubkey, session);
    return { text: await services.logs(pubkey, lines) };
  },

  // Model ids the runtime offers, from the cached ACP catalog probe.
  // For Hermes, the profile's: each profile has its own providers and sign-ins.
  async models(config, { runtime, profile }, session) {
    if (!Object.hasOwn(RUNTIMES, runtime)) throw new Error("Unknown runtime");
    if (session?.role === "guest") {
      if (!session.limits?.allowedRuntimes?.includes(runtime)) {
        throw new Error(`Runtime "${runtime}" is not enabled for this guest token`);
      }
      profile = "";
    }
    const { profile: home } = settingsFrom({ runtime, profile });
    await checkProfile(home);
    const probed = await probeRuntime(runtime, home, { wait: true });
    return toModelList(probed);
  },

  // The Hermes profiles an agent can run on, for the plugin's picker.
  async "hermes.profiles"() {
    return { profiles: await hermesProfiles(true) };
  },

  async list(_config, _params, session) {
    const metas = await listAllMetas();
    const agents = [];
    for (const m of metas) {
      if (!canAccessAgent(session, m)) continue;
      const dst = m.desktop === true ? desktop.status(m.pubkey) : null;
      agents.push({
        pubkey: m.pubkey,
        name: m.name,
        runtime: m.runtime,
        model: m.model,
        profile: m.profile || "",
        concurrency: checkConcurrency(m.concurrency, DEFAULT_CONCURRENCY),
        runner: m.runner || "host",
        respondTo: normalizeRespondTo(m.respondTo, "owner-only"),
        activated: m.activated,
        desktop: m.desktop === true,
        desktopRunning: dst ? dst.running === true : false,
        desktopLease: dst ? dst.lease : null,
        orchestrate: m.orchestrate === true,
        status: m.activated ? await active(m.pubkey) : "provisioned",
      });
    }
    return { agents };
  },

  // Buzz's Stop: cancel the turn running in one conversation (channel, and the
  // thread root Buzz names it by). False when nothing there was running.
  async interrupt(config, { pubkey, channelId, threadRootId }, session) {
    await ownedMeta(pubkey, session);
    if (typeof channelId !== "string" || !UUID.test(channelId)) throw new Error("Invalid channel id");
    if (threadRootId != null && (typeof threadRootId !== "string" || !HEX64.test(threadRootId)))
      throw new Error("Invalid thread root");
    const reply = await proxyControl(pubkey, { op: "cancel", channel: channelId, root: threadRootId || undefined });
    if (reply.error) throw new Error(reply.error);
    return { cancelled: !!reply.cancelled };
  },

  // The models and effort levels Buzz's composer offers for this agent's next
  // turn (Buzz's `Models`): its own runtime's, then other runtimes'
  // ("codex::<id>"). When channelId (and optional threadRootId) is given,
  // `current` reflects that conversation's active runtime/model/effort from
  // chat-settings.json. acp-proxy applies a pick from the message tags; one on
  // another runtime moves the chat there.
  async catalog(config, { pubkey, channelId, threadRootId, runtime: requestedRuntime }, session) {
    if (channelId != null) checkPlace(channelId, threadRootId);
    if (requestedRuntime != null && typeof requestedRuntime !== "string")
      throw new Error("Invalid runtime");
    const m = await ownedMeta(pubkey, session);
    const { runtime, profile } = settingsFrom(m);
    const sandboxed = isSandboxed(m);
    const chat = channelId
      ? await chatSettingsFor(pubkey, channelId, threadRootId, runtime, profile, sandboxed)
      : null;
    const isGuest = session?.role === "guest";
    return chatCatalog(runtime, profile, m.model || "", chat, requestedRuntime || "", {
      allowedRuntimes: isGuest ? session.limits?.allowedRuntimes : null,
      allowHermesProfiles: !isGuest && !sandboxed,
    });
  },

  // Buzz's session controls for one conversation (channel + thread root).
  async "session.state"(config, { pubkey, channelId, threadRootId }, session) {
    checkPlace(channelId, threadRootId);
    const m = await ownedMeta(pubkey, session);
    const { runtime, profile } = settingsFrom(m);
    const [reply, chat] = await Promise.all([
      proxyControl(
        pubkey,
        { op: "state", channel: channelId, root: threadRootId || undefined },
        5_000,
        { state: "unavailable" },
      ).catch(() => ({ state: "unavailable" })),
      chatSettingsFor(pubkey, channelId, threadRootId, runtime, profile, isSandboxed(m)),
    ]);
    return { state: reply.state ?? "unavailable", chat };
  },
  async "session.control"(config, { pubkey, channelId, threadRootId, action }, session) {
    checkPlace(channelId, threadRootId);
    await ownedMeta(pubkey, session);
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
  async "desktop.status"(config, { pubkey }, session) {
    const m = await ownedMeta(pubkey, session);
    if (!DESKTOP_SUPPORTED) return { enabled: false, supported: false, running: false };
    return { enabled: m.desktop === true, ...desktopView(pubkey) };
  },
  async "desktop.set"(config, { pubkey, enabled }, session) {
    const m = await ownedMeta(pubkey, session);
    if (enabled === true) assertDesktopSupported();
    const next = { ...m, desktop: enabled === true };
    if (next.desktop) {
      assertGuestDesktop(session, next);
      assertSandboxRestrictions(next);
    }
    await saveMeta(pubkey, next);
    if (!next.desktop) {
      desktopLastActivity.delete(pubkey);
      if (DESKTOP_SUPPORTED) await desktop.stop(pubkey);
    }
    if (m.activated && next.desktop !== (m.desktop === true)) {
      await writeRuntimeEnv(pubkey, next);
      await services.restart(pubkey);
    }
    return { enabled: next.desktop, ...desktopView(pubkey) };
  },
  async "desktop.start"(config, { pubkey }, session) {
    assertDesktopSupported();
    const m = await ownedMeta(pubkey, session);
    if (m.desktop !== true) throw new Error("This agent has no desktop; turn it on first");
    assertGuestDesktop(session, m);
    await assertGuestDesktopCapacity(config, pubkey, m);
    await desktop.start(pubkey, { sandboxed: isSandboxed(m) });
    touchDesktop(pubkey);
    return { enabled: true, ...desktopView(pubkey) };
  },
  async "desktop.stop"(config, { pubkey }, session) {
    assertDesktopSupported();
    await ownedMeta(pubkey, session);
    desktopLastActivity.delete(pubkey);
    await desktop.stop(pubkey);
    return desktopView(pubkey);
  },
  // A small PNG of the agent's screen for the owner's in-chat preview, with
  // when the agent last used a computer tool (scoped to the chat when given).
  // Never starts the desktop.
  // `since` (ms): no picture unless a computer tool was used since then.
  // `etag`: no picture when it has not changed since that one.
  async "desktop.snapshot"(config, { pubkey, width, since, etag, channelId, threadRootId }, session) {
    if (channelId != null) checkPlace(channelId, threadRootId);
    const m = await ownedMeta(pubkey, session);
    if (!DESKTOP_SUPPORTED) return { enabled: false, supported: false };
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
  async "desktop.view"(config, { pubkey }, session) {
    assertDesktopSupported();
    const m = await ownedMeta(pubkey, session);
    if (m.desktop !== true) throw new Error("This agent has no desktop; turn it on first");
    assertGuestDesktop(session, m);
    await assertGuestDesktopCapacity(config, pubkey, m);
    await desktop.start(pubkey, { sandboxed: isSandboxed(m) });
    touchDesktop(pubkey);
    const now = Date.now();
    for (const [t, v] of viewTickets) if (v.expires < now) viewTickets.delete(t);
    const ticket = randomBytes(24).toString("base64url");
    const viewer = randomBytes(24).toString("base64url");
    viewTickets.set(ticket, {
      pubkey,
      viewer,
      expires: now + VIEW_TICKET_MS,
      role: session?.role ?? "admin",
      tokenId: session?.tokenId ?? null,
    });
    return { ticket, viewer, path: `/desktop?ticket=${ticket}`, ...desktopView(pubkey) };
  },
  // take: true = Take over (this viewer drives; the agent is refused),
  // false = Hand back. Only the viewer that holds it can hand it back.
  async "desktop.lease"(config, { pubkey, viewer, take, reason }, session) {
    assertDesktopSupported();
    assertGuestDesktop(session, await ownedMeta(pubkey, session));
    if (typeof viewer !== "string" || viewer.length < 16) throw new Error("viewer is required");
    touchDesktop(pubkey);
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
    const next = { ...m, orchestrate: nextEnabled };
    if (nextEnabled) {
      assertSandboxRestrictions(next);
      // Best-effort: prepare Hermes plugin so Hermes Solo-chat workers work.
      await ensureSessionEnv(m.profile || "").catch(() => {});
    }
    await saveMeta(pubkey, next);
    if (m.activated && next.orchestrate !== (m.orchestrate === true)) {
      await writeRuntimeEnv(pubkey, next);
      await services.restart(pubkey);
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

  // Admin-only guest token management (multi-tenant hosting).
  async "tokens.create"(
    config,
    { label, ownerPubkey, maxAgents, maxConcurrency, allowedRuntimes, allowHostDesktop, allowSandboxDesktop },
  ) {
    const { token, record } = await tokenStore.create({
      label,
      ownerPubkey,
      maxAgents,
      maxConcurrency,
      allowedRuntimes,
      allowHostDesktop: allowHostDesktop === true,
      allowSandboxDesktop: allowSandboxDesktop !== false,
    });
    return {
      token,
      record,
      inviteUrl: buildInviteUrl(config.publicGuestUrl, token),
    };
  },
  async "tokens.list"() {
    const [tokens, metas] = await Promise.all([tokenStore.list(), listAllMetas()]);
    return {
      tokens: tokens.map((t) =>
        t.role === "admin"
          ? t
          : {
              ...t,
              agentCount: metas.filter(
                (m) => (t.ownerPubkey && m.owner === t.ownerPubkey) || (!m.activated && m.createdByTokenId === t.id),
              ).length,
            },
      ),
    };
  },
  async "tokens.revoke"(_config, { id }) {
    const record = await tokenStore.revoke(id);
    await dropTokenAccess(record);
    return { record };
  },

  async remove(config, { pubkey }, session) {
    checkPubkey(pubkey);
    const existing = await meta(pubkey).catch(() => undefined);
    if (!existing) return {};
    assertAgentAccess(session, existing);
    await services.disableAndStop(pubkey).catch(() => {});
    await runnerManager.cleanupAgent(pubkey).catch(() => {});
    await orchestrator.forget(pubkey).catch(() => {});
    if (DESKTOP_SUPPORTED) await desktop.stop(pubkey).catch(() => {});
    await fs.rm(dir(pubkey), { recursive: true, force: true });
    watcher.sync(pubkey, null);
    attention.forget(pubkey);
    discovery?.notifyChanged();
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
  // A fragmented message may not exceed one MAX_FRAME-sized message in total.
  const message = createFragmentBuffer({ maxBytes: MAX_MESSAGE_BYTES });
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
        // Continuation frames used to accumulate without a total cap, letting an
        // unauthenticated Funnel socket grow the server's heap without bound.
        if (!message.push(payload)) return socket.destroy();
        if (fin) onText(message.take().toString("utf8"), send);
      }
    }
  });
  socket.on("error", () => {});
}

// ---------- server ----------

const config = await loadConfig();
const MACHINE_ID = await loadMachineId({
  file: path.join(HOME, ".local/share/buzz-host/machine-id"),
  configured: config.machineId,
});
/** Machine discovery publisher (set once boot reaches it; null when off). */
let discovery = null;
// macOS: the short /tmp base is shared space, so create it 0700 and refuse one
// another user planted. (Linux's /run/user/<uid> is already private.)
if (process.platform === "darwin") {
  await ensurePrivateDir(runtimeBase());
  await fs.mkdir(RUN_DIR, { recursive: true, mode: 0o700 });
}
const tokenStore = createTokenStore({ filePath: path.join(HOME, ".local/share/buzz-host/tokens.json") });
const authRateLimiter = createAuthRateLimiter({ maxFailures: 10, windowMs: 60_000 });
/** tokenId -> Set<Socket> (guest and admin token sockets) for immediate disconnect on revoke. */
const guestSockets = new Map();

/** Tokens revoked while this server runs: their sessions refuse every further call. */
const revokedTokenIds = new Set();

/** Close a revoked token's sockets, drop its desktop tickets, and stop a guest's desktops. */
async function dropTokenAccess(record) {
  revokedTokenIds.add(record.id);
  const sockets = guestSockets.get(record.id);
  if (sockets) {
    for (const sock of sockets) {
      try {
        sock.end(frame(8, Buffer.alloc(0)));
      } catch {}
      // end() only half-closes: a client that ignores the close frame could
      // keep sending. Cut the socket once the close frame has had a moment.
      setTimeout(() => sock.destroy(), 1_000).unref();
    }
    guestSockets.delete(record.id);
  }
  for (const [t, v] of viewTickets) {
    if (v.tokenId === record.id) viewTickets.delete(t);
  }
  // A revoked guest's desktops stop. An admin token's owner keeps theirs:
  // their agents belong to them, not to the token they used to connect.
  if (record.role !== "admin" && DESKTOP_SUPPORTED) {
    const metas = await listAllMetas();
    for (const m of metas) {
      if (m.createdByTokenId === record.id || (record.ownerPubkey && m.owner === record.ownerPubkey)) {
        desktopLastActivity.delete(m.pubkey);
        await desktop.stop(m.pubkey).catch(() => {});
      }
    }
  }
}

// `buzz-host-tokens revoke` only edits tokens.json: catch those revocations
// (and deleted records) for sockets that are still connected.
const REVOKE_SWEEP_MS = 15_000;
const revokeSweepTimer = setInterval(() => {
  void (async () => {
    for (const tokenId of [...guestSockets.keys()]) {
      const record = await tokenStore.getById(tokenId);
      if (record && !record.revokedAt) continue;
      console.log(`token ${tokenId} revoked or removed: closing its connections`);
      // A record deleted by hand: stop what that token created, nothing more.
      await dropTokenAccess(record ?? { id: tokenId, role: "guest", ownerPubkey: null });
    }
  })().catch((error) => console.error(`token revoke sweep failed: ${error.message}`));
}, REVOKE_SWEEP_MS);
revokeSweepTimer.unref();
const memory = createMemory({ dataDir: DATA });
const orchestrator = createOrchestrator({
  dataDir: DATA,
  stateDir: path.join(HOME, ".local/share/buzz-host/orchestrator"),
  shimsDir: SHIMS,
  runDir: RUN_DIR,
  catalog: (runtime) => runtimeCatalog(runtime),
  ensureHermes: (profile) => ensureSessionEnv(profile || ""),
});
const hermesHostExtra = {
  handles: (name) => name === "_ensure_hermes_profile",
  async call(_pubkey, _name, args) {
    const raw = typeof args?.profile === "string" ? args.profile.trim() : "";
    const profile = raw.toLowerCase() === "default" ? "" : raw;
    if (profile && !PROFILE.test(profile)) throw new Error("Invalid Hermes profile name");
    await checkProfile(profile);
    await ensureSessionEnv(profile);
    return { ok: true, profile };
  },
};
const attention = createAttention({
  dataDir: DATA,
  runDir: RUN_DIR,
  extra: [memory, orchestrator, hermesHostExtra],
});
const runnerManager = createRunnerManager({
  dataDir: DATA,
  runDir: RUN_DIR,
  workDir: WORK,
  libDir: LIB,
  homeDir: HOME,
  callTool: (pubkey, name, args) => attention.callTool(pubkey, name, args),
  isAttentionEnabled: async (pubkey) => (await attention.load(pubkey)).record.attentionEnabled,
  // Computer tools for a Docker agent's own sidecar desktop.
  isDesktopEnabled: async (pubkey) => DESKTOP_SUPPORTED && (await meta(pubkey).catch(() => ({}))).desktop === true,
  computerModule: () => import("./desktop/computer.mjs"),
});
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
// Every agent session's MCP bridge talks to this one server on mcp.sock: the
// memory, orchestrator and Attention handlers stay in buzz-host, so a session
// costs the tiny C bridge instead of a Node process per session.
const mcpServer = createMcpServer({
  runDir: RUN_DIR,
  callTool: async (pubkey, name, args) => {
    const handler = [memory, orchestrator, hermesHostExtra].find((h) => h?.handles?.(name));
    return handler ? handler.call(pubkey, name, args ?? {}) : attention.callTool(pubkey, name, args);
  },
  computerModule: () => import("./desktop/computer.mjs"),
});
await mcpServer.start();
for (const pubkey of await attention.enabledAgents())
  watcher.sync(pubkey, (await attention.load(pubkey)).record);
const allAgentMetas = [];
for (const name of (await fs.readdir(DATA).catch(() => [])).filter((n) => HEX64.test(n))) {
  const m = await meta(name).catch(() => undefined);
  if (m) allAgentMetas.push(m);
}
await runnerManager.reconcileOnStartup(allAgentMetas);
// Machine discovery: this host's status, encrypted to each owner, on their relay.
discovery = config.discovery
  ? createDiscoveryPublisher({
      dataDir: DATA,
      runDir: RUN_DIR,
      machineId: MACHINE_ID,
      intervalMs: config.discoveryIntervalMs,
      config: () => config,
      runtimes: async () => {
        const ids = await Promise.all(
          Object.entries(RUNTIMES).map(async ([id, r]) => ((await installed(r.command)) ? id : null)),
        );
        return ids.filter(Boolean);
      },
      capabilities: async () => ({
        desktop: DESKTOP_SUPPORTED,
        docker: (await runnerManager.availableRunners()).some((r) => r.id === "docker" && r.available),
      }),
    })
  : null;
discovery?.start();
await attention.syncNotes(allAgentMetas.map((m) => m.pubkey));
// Sync Antigravity PreToolUse guard plugin (denies `schedule` for Buzz agents)
// into ~/.gemini/config/plugins/buzz-host-guards if bundled under LIB/agy-plugin.
try {
  const agySrc = path.join(LIB, "agy-plugin", "buzz-host-guards");
  const agyDst = path.join(HOME, ".gemini", "config", "plugins", "buzz-host-guards");
  const entries = await fs.readdir(agySrc, { withFileTypes: true }).catch(() => []);
  if (entries.length) {
    await fs.mkdir(agyDst, { recursive: true, mode: 0o700 });
    for (const e of entries) {
      if (!e.isFile()) continue;
      const srcFile = path.join(agySrc, e.name);
      const dstFile = path.join(agyDst, e.name);
      await fs.copyFile(srcFile, dstFile);
      if (e.name.endsWith(".sh")) await fs.chmod(dstFile, 0o755);
    }
  }
} catch (error) {
  console.warn(`agy guard plugin sync skipped: ${error.message}`);
}
// Agents set up before the "buzz" MCP server (memory, 2026-11-17) still name
// mcp/attention, or nothing: rewrite their runtime.env once and restart them.
for (const m of allAgentMetas) {
  const name = m.pubkey;
  if (!m?.activated || isSandboxed(m)) continue;
  const env = await fs.readFile(path.join(dir(name), "runtime.env"), "utf8").catch(() => "");
  if (env.includes(path.join(dir(name), "mcp", "buzz"))) continue;
  try {
    await writeRuntimeEnv(name, m);
    if ((await active(name)) === "active") await services.restart(name);
    console.log(`agent ${name.slice(0, 8)}: now has the buzz MCP server (memory)`);
  } catch (error) {
    console.error(`agent ${name.slice(0, 8)}: buzz MCP server not set up: ${error.message}`);
  }
}
// Agents whose wrapper still starts the Node buzz-mcp.mjs switch to the C
// bridge once it is installed. Running sessions keep the process they have;
// the next session each runtime starts picks the bridge up.
if (await hasBridge()) {
  for (const m of allAgentMetas) {
    if (!m?.activated || isSandboxed(m)) continue;
    const wrapper = await fs.readFile(path.join(dir(m.pubkey), "mcp", "buzz"), "utf8").catch(() => "");
    if (!wrapper.includes("buzz-mcp.mjs")) continue;
    try {
      await writeBuzzMcp(m.pubkey);
      console.log(`agent ${m.pubkey.slice(0, 8)}: buzz MCP wrapper now uses the C bridge`);
    } catch (error) {
      console.error(`agent ${m.pubkey.slice(0, 8)}: buzz MCP wrapper not refreshed: ${error.message}`);
    }
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

function attachRpcSocket(socket, session) {
  serveSocket(socket, async (text, send) => {
    let id;
    try {
      const message = JSON.parse(text);
      id = message.id;
      const methodName = message.method;
      const method = methods[methodName];
      if (!method) throw new Error(`Unknown method ${methodName}`);
      if (session.tokenId && revokedTokenIds.has(session.tokenId)) {
        socket.destroy();
        throw new Error("Access token has been revoked");
      }
      if (methodName !== "auth") assertMethodAllowed(session, methodName);
      const params = message.params ?? {};
      const result = UNSERIALIZED.has(methodName)
        ? await method(config, params, session)
        : await serialized(params.pubkey ?? `${session.tokenId || "admin"}:${methodName}`, () =>
            method(config, params, session),
          );
      send(JSON.stringify({ id, result }));
    } catch (error) {
      console.error(`error (${session.role}${session.tokenId ? `:${session.tokenId}` : ""}): ${error.message}`);
      send(JSON.stringify({ id, error: String(error.message ?? error) }));
    }
  });
}

// Tailnet listener: trusts Tailscale-User-Login from `tailscale serve`. Off
// when allowLogins is empty (token-only hosts): nothing then listens on `port`,
// so no local process can forge that header to get in.
const server =
  config.allowLogins.size > 0
    ? createServer((req, res) => {
        res.writeHead(req.url === "/health" ? 200 : 404, { "content-type": "text/plain" });
        res.end(req.url === "/health" ? "ok\n" : "not found\n");
      })
    : null;

server?.on("upgrade", (req, socket) => {
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
    if (!isValidDesktopTicket(view, "admin")) return refuse("403 Forbidden", "desktop ticket");
    const st = desktop.status(view.pubkey);
    if (!st.running) return refuse("409 Conflict", "desktop not running");
    acceptUpgrade(req, socket);
    trackViewer(view.pubkey, socket);
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
  console.log(`connected (admin): ${login} origin=${origin ?? "-"}`);
  attachRpcSocket(socket, {
    authenticated: true,
    role: "admin",
    login,
    remoteAddress: req.socket.remoteAddress || "127.0.0.1",
  });
});

if (server) {
  server.listen(config.port, "127.0.0.1", () =>
    console.log(`buzz-host admin listening on 127.0.0.1:${config.port}`),
  );
} else {
  console.log("buzz-host: allowLogins is empty; tailnet listener off, access tokens only");
}

// Token listener (Tailscale Funnel /_buzz-host, zrok, any wss:// proxy).
// NEVER trusts Tailscale-User-Login headers: every socket authenticates with a
// guest (bhg_) or admin (bha_) access token. Serves /desktop only for valid,
// single-use tickets minted by an admin token or a trusted guest token.
let guestServer = null;
let irohSupervisor = null;
if (Number.isInteger(config.guestPort) && config.guestPort > 0) {
  const guestSocketRegistry = createGuestSocketRegistry({
    maxSockets: config.guestMaxSockets,
    maxUnauthenticated: config.guestMaxUnauthenticated,
  });
  guestServer = createServer((req, res) => {
    res.writeHead(req.url === "/health" ? 200 : 404, { "content-type": "text/plain" });
    res.end(req.url === "/health" ? "ok\n" : "not found\n");
  });
  guestServer.on("upgrade", async (req, socket) => {
    const origin = req.headers.origin;
    // Tailscale Funnel appends the peer address it saw to X-Forwarded-For, so
    // only the RIGHTMOST entry is trustworthy: everything to its left is
    // client-supplied and spoofable (it keys the auth rate limiter).
    const remoteAddress = clientIpFromForwardedFor(
      req.headers["x-forwarded-for"],
      req.socket.remoteAddress,
    );
    const refuse = (code, why) => {
      console.warn(`guest refused ${code}: ${why} (remote=${remoteAddress} origin=${origin ?? "-"})`);
      socket.end(`HTTP/1.1 ${code}\r\nConnection: close\r\n\r\n`);
    };
    // Charged before the upgrade is accepted: unauthenticated sockets are cheap
    // to open and each one pins memory until it authenticates or times out.
    const slot = guestSocketRegistry.admit();
    if (!slot) return refuse("503 Service Unavailable", "connection cap");
    socket.once("close", () => slot.release());
    const idle = createIdleWatch({
      timeoutMs: config.guestSocketIdleMs,
      onTimeout: () => {
        console.warn(
          `guest socket closed after ${config.guestSocketIdleMs}ms without auth (remote=${remoteAddress})`,
        );
        socket.destroy();
      },
    });
    socket.once("close", () => idle.cancel());
    try {
      if (origin && !config.allowOrigins.has(origin)) return refuse("403 Forbidden", "origin");
      const key = req.headers["sec-websocket-key"];
      if (!key || req.headers.upgrade?.toLowerCase() !== "websocket")
        return refuse("400 Bad Request", "not a websocket");
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/desktop") {
        const ticket = url.searchParams.get("ticket") ?? "";
        const view = viewTickets.get(ticket);
        viewTickets.delete(ticket);
        if (!isValidDesktopTicket(view, "guest")) return refuse("403 Forbidden", "desktop ticket");
        // The ticket's token must still be live and of the ticket's role:
        // admin tokens always may view; guest tokens only when trusted.
        const tokenRecord = await tokenStore.getById(view.tokenId);
        if (!desktopTicketTokenAllowed(view, tokenRecord)) {
          return refuse("403 Forbidden", "desktop not permitted");
        }
        const st = desktop.status(view.pubkey);
        if (!st.running) return refuse("409 Conflict", "desktop not running");
        slot.authenticate(); // the single-use ticket is the credential here
        acceptUpgrade(req, socket);
        let set = guestSockets.get(view.tokenId);
        if (!set) {
          set = new Set();
          guestSockets.set(view.tokenId, set);
        }
        set.add(socket);
        trackViewer(view.pubkey, socket);
        console.log(
          `${view.role === "admin" ? "admin token" : "guest"} desktop view: ${tokenRecord.label} (${view.tokenId}) agent=${view.pubkey.slice(0, 8)}`,
        );
        const leaseDir = desktop.desktopDir(view.pubkey);
        rfbBridge(socket, { rfbSocket: st.rfbSocket, leaseDir, viewerId: view.viewer });
        socket.on("close", () => {
          const activeSet = guestSockets.get(view.tokenId);
          activeSet?.delete(socket);
          if (activeSet && activeSet.size === 0) guestSockets.delete(view.tokenId);
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
      // Public Funnel socket: it must authenticate within the idle window.
      idle.arm();
      let registeredTokenId = null;
      const session = {
        authenticated: false,
        role: "guest",
        tokenId: null,
        label: null,
        ownerPubkey: null,
        limits: null,
        remoteAddress,
        // Called by methods.auth on a successful token exchange: the idle
        // timeout and unauthenticated accounting stop applying.
        onAuthenticated() {
          slot.authenticate();
          idle.cancel();
        },
        registerTokenSocket(tokenId) {
          // A socket that died while the token was being verified must not be
          // tracked: its close event has already fired.
          if (socket.destroyed) return;
          registeredTokenId = tokenId;
          let set = guestSockets.get(tokenId);
          if (!set) {
            set = new Set();
            guestSockets.set(tokenId, set);
          }
          set.add(socket);
        },
      };
      socket.on("close", () => {
        if (registeredTokenId) {
          const set = guestSockets.get(registeredTokenId);
          set?.delete(socket);
          if (set && set.size === 0) guestSockets.delete(registeredTokenId);
        }
      });
      console.log(`guest socket connected: remote=${remoteAddress} origin=${origin ?? "-"}`);
      attachRpcSocket(socket, session);
    } catch (error) {
      console.error(`guest upgrade error: ${error.message}`);
      try {
        refuse("500 Internal Server Error", "upgrade error");
      } catch {}
    }
  });
  guestServer.listen(config.guestPort, "127.0.0.1", () => {
    console.log(`buzz-host guest listening on 127.0.0.1:${config.guestPort}`);
    irohSupervisor = createIrohSupervisor({
      config,
      libDir: LIB,
      configDir: path.dirname(CONFIG),
      runDir: RUN_DIR,
    });
    irohSupervisor.start();
  });
}

const idleSweepTimer =
  config.guestDesktopIdleMs > 0
    ? setInterval(() => {
        void stopIdleGuestDesktops(config).catch((error) =>
          console.error(`guest desktop idle sweep failed: ${error.message}`),
        );
      }, 60_000)
    : null;
idleSweepTimer?.unref();

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`buzz-host shutting down (${signal})`);
  if (idleSweepTimer) clearInterval(idleSweepTimer);
  clearInterval(revokeSweepTimer);
  await discovery?.stop().catch(() => {});
  await irohSupervisor?.stop().catch(() => {});
  server?.close();
  guestServer?.close();
  await mcpServer.stop().catch(() => {});
  await runnerManager.close().catch(() => {});
  await orchestrator.close().catch(() => {});
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
