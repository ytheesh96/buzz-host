// Cross-machine delegation: host B's narrow executor (`delegate.*` RPCs),
// per-token lease management, thin persistence, workspace realpath gating,
// NIP-98/NIP-OA start-auth verification, and turn-signal forwarding.
//
// Design: docs/cross-machine-delegation.md §§2, 3, 4, 5.

import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { signEvent } from "./attention-relay.mjs";
import { isTokenExpired, tokenRole } from "./auth.mjs";
import { proxyControl } from "./control.mjs";
import { machineName as resolveMachineName, readRoutes, validAuthTag } from "./discovery.mjs";
import { updateJsonLocked } from "./file-lock.mjs";
import { bytesToHex, hexToBytes, schnorr, sha256 } from "./noble.mjs";
import { isSandboxed } from "./sandbox/index.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const DELEGATE_AUTH_KIND = 27235;
const AUTH_SKEW_SECS = 120;
const REPLAY_WINDOW_MS = 10 * 60_000;
const DEFAULT_LEASE_MS = 10 * 60_000;
const DEFAULT_SOLO_TTL_SECS = 24 * 3600;
const MAX_PROMPT_BYTES = 60 * 1024;
const MAX_EVENTS_PER_TASK = 200;
const RELAY_QUERY_TIMEOUT_MS = 15_000;
const RELAY_AUTH_WAIT_MS = 5_000;

const HEX64 = /^[0-9a-f]{64}$/;
const SIG128 = /^[0-9a-f]{128}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const RUNTIMES = {
  claude: { title: "Claude Code", shim: "claude-agent-acp" },
  codex: { title: "Codex", shim: "codex-acp" },
  hermes: { title: "Hermes", shim: "hermes-acp" },
  antigravity: { title: "Antigravity", shim: "antigravity-acp" },
};

// ---------- Nostr event verification + start-auth event ----------

/** Verify a NIP-01 event's id and BIP-340 schnorr signature. */
export function verifySignedEvent(ev) {
  if (!ev || typeof ev !== "object") return false;
  if (typeof ev.id !== "string" || !HEX64.test(ev.id)) return false;
  if (typeof ev.pubkey !== "string" || !HEX64.test(ev.pubkey)) return false;
  if (typeof ev.sig !== "string" || !SIG128.test(ev.sig)) return false;
  if (!Number.isInteger(ev.kind) || !Number.isInteger(ev.created_at)) return false;
  if (!Array.isArray(ev.tags) || typeof ev.content !== "string") return false;
  try {
    const serialized = JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content]);
    const expectedId = bytesToHex(sha256(new TextEncoder().encode(serialized)));
    if (expectedId !== ev.id) return false;
    return schnorr.verify(hexToBytes(ev.sig), hexToBytes(ev.id), hexToBytes(ev.pubkey));
  } catch {
    return false;
  }
}

/** Build the signed kind 27235 `auth` event host A sends in `delegate.start`. */
export function buildDelegateAuthEvent({
  secretKey,
  authTag,
  targetMachineId,
  ref,
  channelId,
  workerPubkey,
  created_at = Math.floor(Date.now() / 1000),
}) {
  if (!Array.isArray(authTag) || authTag[0] !== "auth") {
    throw new Error("Orchestrator NIP-OA auth tag is required for cross-machine delegation");
  }
  const tags = [
    ["u", `buzz-host:delegate.start:${String(targetMachineId).toLowerCase()}`],
    ["ref", String(ref)],
    ["h", String(channelId)],
    ["p", String(workerPubkey).toLowerCase()],
    ["nonce", randomBytes(8).toString("hex")],
    authTag,
  ];
  return signEvent(secretKey, { kind: DELEGATE_AUTH_KIND, tags, content: "", created_at });
}

/**
 * Validate `delegate.start`'s signed kind 27235 event on host B.
 * Checks NIP-01 signature, ±120s timestamp window, replay protection (10 min),
 * required tags, and NIP-OA owner attestation matching `expectedOwnerPubkey`.
 */
export function verifyDelegateAuthEvent({
  event,
  targetMachineId,
  expectedOwnerPubkey,
  ref,
  channelId,
  workerPubkey,
  nowMs = Date.now(),
  replayCache = null,
}) {
  if (!verifySignedEvent(event)) {
    throw new Error("Invalid delegate start auth event signature");
  }
  if (event.kind !== DELEGATE_AUTH_KIND) {
    throw new Error(`Expected delegate auth kind ${DELEGATE_AUTH_KIND}, got ${event.kind}`);
  }
  const nowSec = Math.floor(nowMs / 1000);
  if (Math.abs(nowSec - event.created_at) > AUTH_SKEW_SECS) {
    throw new Error("Delegate start auth event timestamp is outside ±120s window");
  }

  const findTag = (name) => event.tags.find((t) => Array.isArray(t) && t[0] === name);
  const expectedU = `buzz-host:delegate.start:${String(targetMachineId).toLowerCase()}`;
  if (findTag("u")?.[1] !== expectedU) {
    throw new Error("Delegate start auth event target machine mismatch");
  }
  if (findTag("ref")?.[1] !== ref) {
    throw new Error("Delegate start auth event ref mismatch");
  }
  if (findTag("h")?.[1] !== channelId) {
    throw new Error("Delegate start auth event channel mismatch");
  }
  if (String(findTag("p")?.[1] || "").toLowerCase() !== String(workerPubkey).toLowerCase()) {
    throw new Error("Delegate start auth event worker mismatch");
  }

  const authTag = findTag("auth");
  if (!validAuthTag(event.pubkey, authTag)) {
    throw new Error("Delegate start auth event has invalid NIP-OA owner attestation");
  }
  if (authTag[1] !== String(expectedOwnerPubkey).toLowerCase()) {
    throw new Error("Delegate start auth event owner does not match token owner");
  }

  if (replayCache) {
    for (const [id, exp] of replayCache) {
      if (exp <= nowMs) replayCache.delete(id);
    }
    if (replayCache.has(event.id)) {
      throw new Error("Replayed delegate start auth event");
    }
    replayCache.set(event.id, nowMs + REPLAY_WINDOW_MS);
  }

  return { orchestratorPubkey: event.pubkey, ownerPubkey: authTag[1] };
}

// ---------- workspace path validation ----------

function expandHome(raw, homeDir) {
  const value = String(raw ?? "").trim();
  if (!value) return "";
  if (value === "~") return homeDir;
  if (value.startsWith("~/")) return path.join(homeDir, value.slice(2));
  return value;
}

function isInsideDir(parentReal, childReal) {
  const rel = path.relative(parentReal, childReal);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

async function resolveRealIfExists(p) {
  try {
    return await fs.realpath(p);
  } catch {
    return path.resolve(p);
  }
}

export async function resolveDelegateWorkspace({
  requested,
  workerPubkey,
  workDir,
  allowedPrefixes = [],
  forbiddenDirs = [],
  homeDir = os.homedir(),
}) {
  const workerDir = path.join(workDir, workerPubkey);
  await fs.mkdir(workerDir, { recursive: true, mode: 0o700 });
  const workerReal = await fs.realpath(workerDir);

  const forbiddenReals = [];
  for (const dir of forbiddenDirs) {
    if (!dir) continue;
    forbiddenReals.push(await resolveRealIfExists(dir));
  }

  const checkNotForbidden = (candidateReal) => {
    for (const bad of forbiddenReals) {
      if (isInsideDir(bad, candidateReal)) {
        throw new Error("Workspace path is inside a forbidden host directory");
      }
    }
  };

  if (!requested || !String(requested).trim()) {
    checkNotForbidden(workerReal);
    return workerReal;
  }

  const expanded = expandHome(requested, homeDir);
  if (!path.isAbsolute(expanded)) {
    throw new Error("Workspace must be an absolute path on the remote host");
  }
  const st = await fs.stat(expanded).catch(() => null);
  if (!st?.isDirectory()) {
    throw new Error(`Workspace directory does not exist on remote host: ${expanded}`);
  }
  const candidateReal = await fs.realpath(expanded);
  checkNotForbidden(candidateReal);

  const allowedReals = [workerReal];
  for (const rawPrefix of allowedPrefixes) {
    const exp = expandHome(rawPrefix, homeDir);
    if (!exp || !path.isAbsolute(exp)) continue;
    const real = await fs.realpath(exp).catch(() => null);
    if (real) allowedReals.push(real);
  }

  const permitted = allowedReals.some((root) => isInsideDir(root, candidateReal));
  if (!permitted) {
    throw new Error(`Workspace "${expanded}" is outside the allowed directories for this delegate token`);
  }
  return candidateReal;
}

// ---------- relay Solo-chat verification ----------

async function defaultVerifySoloChat({
  dataDir,
  workerPubkey,
  channelId,
  orchestratorPubkey,
  ownerPubkey,
  WebSocketImpl = globalThis.WebSocket,
}) {
  const dir = path.join(dataDir, workerPubkey);
  const meta = JSON.parse(await fs.readFile(path.join(dir, "meta.json"), "utf8"));
  const key = (await fs.readFile(path.join(dir, "key"), "utf8")).trim();
  let authTag;
  try {
    authTag = JSON.parse(await fs.readFile(path.join(dir, "auth.json"), "utf8"));
  } catch {
    authTag = undefined;
  }
  const relayUrl = meta.community;
  if (!relayUrl) throw new Error("Worker agent has no configured community relay");

  const events = await new Promise((resolve, reject) => {
    let ws;
    try {
      ws = new WebSocketImpl(relayUrl);
    } catch (err) {
      return reject(err);
    }
    const subId = `dv-${randomBytes(4).toString("hex")}`;
    const found = [];
    let authId = "";
    let queried = false;
    let settled = false;
    let authTimer = null;

    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(authTimer);
      try {
        ws.send(JSON.stringify(["CLOSE", subId]));
      } catch {}
      try {
        ws.close();
      } catch {}
      if (err) reject(err);
      else resolve(found);
    };

    const sendQuery = () => {
      if (queried || settled) return;
      queried = true;
      clearTimeout(authTimer);
      try {
        ws.send(
          JSON.stringify([
            "REQ",
            subId,
            { kinds: [9007], "#h": [channelId], authors: [orchestratorPubkey], limit: 10 },
          ]),
        );
      } catch (err) {
        finish(err);
      }
    };

    const timeout = setTimeout(() => finish(new Error("Timed out verifying Solo chat on relay")), RELAY_QUERY_TIMEOUT_MS);
    timeout.unref?.();

    ws.addEventListener("open", () => {
      authTimer = setTimeout(sendQuery, RELAY_AUTH_WAIT_MS);
      authTimer.unref?.();
    });
    ws.addEventListener("message", (message) => {
      let data;
      try {
        data = JSON.parse(String(message.data));
      } catch {
        return;
      }
      const [type] = data;
      if (type === "AUTH" && typeof data[1] === "string") {
        clearTimeout(authTimer);
        const tags = [["relay", relayUrl], ["challenge", data[1]]];
        if (Array.isArray(authTag)) tags.push(authTag);
        const ev = signEvent(key, { kind: 22242, tags, content: "" });
        authId = ev.id;
        ws.send(JSON.stringify(["AUTH", ev]));
      } else if (type === "OK" && data[1] === authId) {
        if (data[2] === true) sendQuery();
        else finish(new Error(`Worker relay login refused: ${data[3] || "unknown"}`));
      } else if (type === "EVENT" && data[1] === subId && data[2]?.id) {
        found.push(data[2]);
      } else if (type === "EOSE" && data[1] === subId) {
        finish(null);
      } else if (type === "CLOSED" && data[1] === subId) {
        finish(new Error(`Relay closed Solo chat check: ${data[2] || "closed"}`));
      }
    });
    ws.addEventListener("close", () => finish(new Error("Relay closed before verifying Solo chat")));
    ws.addEventListener("error", () => {});
  });

  const valid = events.some((ev) => {
    if (!verifySignedEvent(ev)) return false;
    if (ev.kind !== 9007) return false;
    if (ev.pubkey !== orchestratorPubkey) return false;
    const hasH = ev.tags.some((t) => Array.isArray(t) && t[0] === "h" && t[1] === channelId);
    const hasSolo = ev.tags.some((t) => Array.isArray(t) && t[0] === "t" && t[1] === "buzz.solo");
    const hasOwner = ev.tags.some((t) => Array.isArray(t) && t[0] === "p" && t[1] === ownerPubkey);
    const hasWorker =
      workerPubkey === orchestratorPubkey ||
      ev.tags.some((t) => Array.isArray(t) && t[0] === "p" && t[1] === workerPubkey);
    return hasH && hasSolo && hasOwner && hasWorker;
  });

  if (!valid) {
    throw new Error("Solo chat could not be verified on this worker's community relay");
  }
  return true;
}

// ---------- helpers ----------

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function writePrivateAtomic(file, obj) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(obj, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(tmp, 0o600);
  await fs.rename(tmp, file);
}

// ---------- factory ----------

export function createDelegateExecutor({
  dataDir,
  stateDir = path.join(os.homedir(), ".local/share/buzz-host/delegate"),
  workDir = path.join(os.homedir(), "buzz-agents"),
  runDir = path.join(process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`, "buzz-host"),
  configDir = path.join(os.homedir(), ".config/buzz-host"),
  homeDir = os.homedir(),
  shimsDir = path.join(HERE, "shims"),
  machineId,
  config = () => ({}),
  hostname = os.hostname(),
  platform = process.platform,
  tokenStore,
  catalog,
  ensureHermes,
  readRoutesFn,
  verifySoloChat,
  wakeWorker: customWakeWorker,
  cancelWorker: customCancelWorker,
  leaseMs = DEFAULT_LEASE_MS,
  soloTtlSecs = DEFAULT_SOLO_TTL_SECS,
  checkShimAccess = !verifySoloChat,
  now = () => Date.now(),
  log = console,
} = {}) {
  if (!dataDir) throw new Error("createDelegateExecutor: dataDir is required");
  if (!machineId) throw new Error("createDelegateExecutor: machineId is required");
  if (!tokenStore) throw new Error("createDelegateExecutor: tokenStore is required");

  const forbiddenDirs = [
    path.join(homeDir, "buzz-sandboxes"),
    path.join(homeDir, ".local/share/buzz-host"),
    dataDir,
    stateDir,
    configDir,
  ];

  // tokenId -> Map<ref, taskRecord>
  const byToken = new Map();
  // channelId -> taskRecord (for routing _acp_turn_start / _acp_turn_done)
  const byChannel = new Map();
  // tokenId -> Set<sendFn> (live authenticated delegate sockets)
  const tokenSockets = new Map();
  // tokenId -> timeout handle (disconnect lease timer)
  const leaseTimers = new Map();
  // `${tokenId}:${ref}` -> timeout handle (per-prompt maxTaskMs ceiling)
  const promptTimers = new Map();
  // Per-token serialized disk persistence chains
  const saveChains = new Map();
  // Replay cache for delegate.start auth event ids
  const replayCache = new Map();
  let closed = false;

  const taskKey = (tokenId, ref) => `${tokenId}:${ref}`;
  const tokenFile = (tokenId) => path.join(stateDir, `${tokenId}.json`);
  const agentMetaFile = (pubkey) => path.join(dataDir, pubkey, "meta.json");
  const chatSettingsFile = (pubkey, meta) =>
    isSandboxed(meta)
      ? path.join(runDir, "sandbox", pubkey.slice(0, 16), "agent", "chat-settings.json")
      : path.join(dataDir, pubkey, "chat-settings.json");

  const wakeWorker =
    customWakeWorker ??
    (async ({ workerPubkey, wakeId, channelId, prompt }) => {
      const wakeDir = path.join(dataDir, workerPubkey, "wake");
      await fs.mkdir(path.join(wakeDir, "results"), { recursive: true, mode: 0o700 });
      const cleanId = String(wakeId || "orch-delegate")
        .replace(/[^A-Za-z0-9._-]/g, "-")
        .slice(0, 128);
      const finalPath = path.join(wakeDir, `${cleanId}.json`);
      const tmpPath = path.join(wakeDir, `.${cleanId}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
      await fs.writeFile(tmpPath, `${JSON.stringify({ id: cleanId, channel: channelId, prompt })}\n`, { mode: 0o600 });
      await fs.chmod(tmpPath, 0o600);
      await fs.rename(tmpPath, finalPath);
      return { id: cleanId, path: finalPath };
    });

  const cancelWorker =
    customCancelWorker ??
    ((workerPubkey, channelId) =>
      proxyControl(runDir, workerPubkey, { op: "cancel", channel: channelId, all: true }, 10_000, { cancelled: false }));

  const checkSoloChat =
    verifySoloChat ??
    ((params) => defaultVerifySoloChat({ ...params, dataDir }));

  function isLivePhase(phase) {
    return phase === "starting" || phase === "running" || phase === "idle" || phase === "cancelling";
  }

  function getTokenMap(tokenId) {
    let map = byToken.get(tokenId);
    if (!map) {
      map = new Map();
      byToken.set(tokenId, map);
    }
    return map;
  }

  function liveCount(tokenId) {
    const map = byToken.get(tokenId);
    if (!map) return 0;
    let n = 0;
    for (const rec of map.values()) {
      if (isLivePhase(rec.phase)) n++;
    }
    return n;
  }

  function persistToken(tokenId) {
    if (closed) return saveChains.get(tokenId) ?? Promise.resolve();
    const map = byToken.get(tokenId);
    if (!map) return Promise.resolve();
    const prev = saveChains.get(tokenId) ?? Promise.resolve();
    const next = prev.then(async () => {
      if (closed) return;
      // Keep all live records plus recent 50 ended records for delegate.sync replay.
      const all = [...map.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      const live = all.filter((r) => isLivePhase(r.phase));
      const ended = all.filter((r) => !isLivePhase(r.phase)).slice(0, 50);
      const kept = [...live, ...ended];
      if (kept.length < map.size) {
        const keepRefs = new Set(kept.map((r) => r.ref));
        for (const ref of [...map.keys()]) {
          if (!keepRefs.has(ref)) map.delete(ref);
        }
      }
      await writePrivateAtomic(tokenFile(tokenId), { version: 1, tasks: kept });
    });
    const safe = next.catch((err) => log.error?.(`delegate-executor: persist ${tokenId} failed: ${err.message}`));
    saveChains.set(tokenId, safe);
    return safe;
  }

  function pushEvent(tokenId, rec, type, payload = {}) {
    rec.seq = (rec.seq || 0) + 1;
    const evt = { seq: rec.seq, type, at: now(), ...payload };
    rec.events.push(evt);
    if (rec.events.length > MAX_EVENTS_PER_TASK) rec.events.shift();
    rec.updatedAt = evt.at;
    const sockets = tokenSockets.get(tokenId);
    if (sockets && sockets.size > 0) {
      const frameText = JSON.stringify({
        method: "delegate.event",
        params: { ref: rec.ref, ...evt },
      });
      for (const send of sockets) {
        try {
          send(frameText);
        } catch {}
      }
    }
    return evt;
  }

  function clearPromptTimer(tokenId, ref) {
    const k = taskKey(tokenId, ref);
    const t = promptTimers.get(k);
    if (t) {
      clearTimeout(t);
      promptTimers.delete(k);
    }
  }

  function armPromptTimer(tokenId, rec, maxTaskMs) {
    clearPromptTimer(tokenId, rec.ref);
    if (!Number.isFinite(maxTaskMs) || maxTaskMs <= 0) return;
    const k = taskKey(tokenId, rec.ref);
    const t = setTimeout(() => {
      promptTimers.delete(k);
      void endTask(tokenId, rec, "max_task_timeout", `Exceeded remote maxTaskMs (${maxTaskMs}ms)`);
    }, maxTaskMs);
    t.unref?.();
    promptTimers.set(k, t);
  }

  function clearLeaseTimer(tokenId) {
    const t = leaseTimers.get(tokenId);
    if (t) {
      clearTimeout(t);
      leaseTimers.delete(tokenId);
    }
  }

  function maybeArmLeaseTimer(tokenId) {
    if (closed) return;
    const sockets = tokenSockets.get(tokenId);
    if (sockets && sockets.size > 0) {
      clearLeaseTimer(tokenId);
      return;
    }
    if (liveCount(tokenId) === 0) {
      clearLeaseTimer(tokenId);
      return;
    }
    if (leaseTimers.has(tokenId)) return;
    const t = setTimeout(() => {
      leaseTimers.delete(tokenId);
      void dropToken(tokenId, "lease_expired");
    }, leaseMs);
    t.unref?.();
    leaseTimers.set(tokenId, t);
  }

  async function clearChatSetting(workerPubkey, channelId, tokenId) {
    const m = await readJson(agentMetaFile(workerPubkey), null);
    if (!m) return;
    const file = chatSettingsFile(workerPubkey, m);
    await updateJsonLocked(file, (data) => {
      const entry = data?.[channelId];
      if (entry && entry.delegatedBy === tokenId) {
        delete data[channelId];
      }
      return data;
    }).catch(() => {});
  }

  async function unlinkPendingWake(rec) {
    if (!rec.pendingWakePath) return;
    const p = rec.pendingWakePath;
    rec.pendingWakePath = "";
    await fs.unlink(p).catch(() => {});
  }

  async function endTask(tokenId, rec, reason, error = "") {
    if (!isLivePhase(rec.phase)) return;
    clearPromptTimer(tokenId, rec.ref);
    await unlinkPendingWake(rec);
    byChannel.delete(rec.channelId);
    rec.phase = "ended";
    rec.endedReason = reason;
    await cancelWorker(rec.workerPubkey, rec.channelId).catch(() => {});
    await clearChatSetting(rec.workerPubkey, rec.channelId, tokenId);
    pushEvent(tokenId, rec, "ended", { reason, ...(error ? { error } : {}) });
    await persistToken(tokenId);
    if (liveCount(tokenId) === 0) clearLeaseTimer(tokenId);
  }

  async function dropToken(tokenId, reason = "revoked") {
    clearLeaseTimer(tokenId);
    const map = byToken.get(tokenId);
    if (!map) return;
    const live = [...map.values()].filter((r) => isLivePhase(r.phase));
    for (const rec of live) {
      await endTask(tokenId, rec, reason, `Delegate task stopped: ${reason}`);
    }
  }

  // ---------- token & eligibility checks ----------

  async function requireLiveToken(session) {
    if (!session?.authenticated || session.role !== "delegate" || !session.tokenId) {
      throw new Error("Delegate authentication required");
    }
    const record = await tokenStore.getById(session.tokenId);
    if (!record || tokenRole(record) !== "delegate") {
      throw new Error("Delegate token not found");
    }
    if (record.revokedAt) {
      throw new Error("Delegate token has been revoked");
    }
    if (isTokenExpired(record, now())) {
      throw new Error("Delegate token has expired");
    }
    return record;
  }

  function isAgentEligible(token, m) {
    if (!m || !m.activated || !m.pubkey) return false;
    if (m.createdByTokenId) return false;
    if (String(m.owner || "").toLowerCase() !== String(token.ownerPubkey || "").toLowerCase()) return false;
    const runner = m.runner || "host";
    if (token.access !== "host" && runner !== "docker") return false;
    if (token.agents !== "all") {
      if (!Array.isArray(token.agents) || !token.agents.includes(m.pubkey.toLowerCase())) return false;
    }
    return true;
  }

  async function listEligibleAgentsForToken(token) {
    const entries = await fs.readdir(dataDir, { withFileTypes: true }).catch(() => []);
    const out = [];
    for (const ent of entries) {
      if (!ent.isDirectory() || !HEX64.test(ent.name)) continue;
      const m = await readJson(agentMetaFile(ent.name), null);
      if (!isAgentEligible(token, m)) continue;
      out.push({
        pubkey: m.pubkey.toLowerCase(),
        name: m.name || m.pubkey.slice(0, 8),
        runner: m.runner || "host",
        concurrency: Number.isInteger(m.concurrency) ? m.concurrency : 4,
        relayUrl: m.community || "",
        profile: m.profile || "",
      });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  function buildWorkerWakePrompt({ channelId, runtime, label, workspace, prompt, isFollowUp = false }) {
    const header = isFollowUp
      ? `<delegated-worker-followup channel="${channelId}" runtime="${runtime}">\n` +
        `Follow-up instruction for your active delegated worker task in Solo chat #${channelId}.\n` +
        `Complete the follow-up and post your reply directly in channel ${channelId} (use \`buzz messages send --channel ${channelId} --content -\` or a plain final answer). Do not delegate further tasks.\n` +
        `</delegated-worker-followup>`
      : `<delegated-worker-task channel="${channelId}" runtime="${runtime}">\n` +
        `You are running as a Solo-chat worker for "${label}" in channel #${channelId} (workspace: ${workspace}).\n` +
        `Complete the task below and post your final answer directly in channel ${channelId} (use \`buzz messages send --channel ${channelId} --content -\` or a plain final answer). Do not delegate further tasks.\n` +
        `The brief below is self-contained. The "Delegated from" link is for the owner; do not read the parent chat unless the brief is missing something essential.\n` +
        `</delegated-worker-task>`;
    return `${header}\n\n${prompt}`;
  }

  // ---------- delegate.* RPC methods ----------

  async function handleHello(session) {
    const token = await requireLiveToken(session);
    const cfg = typeof config === "function" ? config() : config;
    const routes =
      typeof readRoutesFn === "function"
        ? await readRoutesFn()
        : await readRoutes(runDir, { publicGuestUrl: cfg.publicGuestUrl, publicUrl: cfg.publicUrl });
    const eligible = await listEligibleAgentsForToken(token);
    const allowedRuntimes = Array.isArray(token.allowedRuntimes) ? token.allowedRuntimes : [];
    const runtimes = await Promise.all(
      allowedRuntimes
        .filter((id) => Object.hasOwn(RUNTIMES, id))
        .map(async (id) => {
          const info = RUNTIMES[id];
          if (checkShimAccess) {
            const shimPath = path.join(shimsDir, info.shim);
            const ok = await fs.access(shimPath, fs.constants.X_OK).then(() => true, () => false);
            if (!ok) {
              return { id, title: info.title, available: false, reason: "shim not installed", models: null, current: "" };
            }
          }
          let models = null;
          let current = "";
          if (typeof catalog === "function") {
            try {
              const res = await Promise.race([
                Promise.resolve(catalog(id)),
                new Promise((resolve) => {
                  const t = setTimeout(() => resolve(null), 2_000);
                  t.unref?.();
                }),
              ]);
              if (res && typeof res === "object") {
                models = Array.isArray(res.models) ? res.models : null;
                current = String(res.current ?? "");
              }
            } catch {}
          }
          return { id, title: info.title, available: true, reason: "", models, current };
        }),
    );

    return {
      machineId,
      name: resolveMachineName(cfg.machineName, hostname),
      platform,
      routes,
      limits: {
        maxConcurrency: token.maxConcurrency,
        live: liveCount(token.id),
        access: token.access,
        expiresAt: token.expiresAt,
        maxTaskMs: token.maxTaskMs,
      },
      // Only expose minimal metadata (never instructions, memory, chat-settings, logs or attention).
      agents: eligible.map(({ pubkey, name, runner, concurrency, relayUrl }) => ({
        pubkey,
        name,
        runner,
        concurrency,
        relayUrl,
      })),
      runtimes,
    };
  }

  async function handleStart(params = {}, session) {
    // 1. Token is live.
    const token = await requireLiveToken(session);

    const ref = typeof params.ref === "string" ? params.ref.trim() : "";
    if (!ref || ref.length > 160) throw new Error("ref is required");
    const workerPubkey = typeof params.workerPubkey === "string" ? params.workerPubkey.trim().toLowerCase() : "";
    if (!HEX64.test(workerPubkey)) throw new Error("Invalid workerPubkey");
    const channelId = typeof params.channelId === "string" ? params.channelId.trim() : "";
    if (!UUID_RE.test(channelId)) throw new Error("Invalid channelId");
    const runtime = typeof params.runtime === "string" ? params.runtime.trim() : "";
    const prompt = typeof params.prompt === "string" ? params.prompt : "";
    if (!prompt.trim()) throw new Error("prompt is required");
    if (Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES) {
      throw new Error("prompt exceeds 60 KiB limit");
    }
    const label = typeof params.label === "string" && params.label.trim() ? params.label.trim().slice(0, 120) : "Worker task";
    const model = typeof params.model === "string" ? params.model.trim() : "";
    const effort = typeof params.effort === "string" ? params.effort.trim() : "";

    // 2. Auth event is valid, fresh, non-replayed, and owner matches token.ownerPubkey.
    const { orchestratorPubkey } = verifyDelegateAuthEvent({
      event: params.auth,
      targetMachineId: machineId,
      expectedOwnerPubkey: token.ownerPubkey,
      ref,
      channelId,
      workerPubkey,
      nowMs: now(),
      replayCache,
    });

    // 3. Worker is eligible.
    const m = await readJson(agentMetaFile(workerPubkey), null);
    if (!isAgentEligible(token, m)) {
      throw new Error("Target worker agent is not eligible for this delegate token");
    }

    // 4. Runtime is allowed and installed.
    if (!Object.hasOwn(RUNTIMES, runtime) || !token.allowedRuntimes.includes(runtime)) {
      throw new Error(`Runtime "${runtime}" is not permitted for this delegate token`);
    }
    if (checkShimAccess) {
      const shimPath = path.join(shimsDir, RUNTIMES[runtime].shim);
      const ok = await fs.access(shimPath, fs.constants.X_OK).then(() => true, () => false);
      if (!ok) throw new Error(`Runtime shim not installed on remote host: ${RUNTIMES[runtime].shim}`);
    }

    // 5. Live tasks < maxConcurrency (and ref not already live).
    const tokenMap = getTokenMap(token.id);
    if (tokenMap.has(ref) && isLivePhase(tokenMap.get(ref).phase)) {
      throw new Error(`Delegated task ref "${ref}" is already active`);
    }
    if (liveCount(token.id) >= token.maxConcurrency) {
      throw new Error(`MAX_CONCURRENCY: delegate token is at its concurrency limit (${token.maxConcurrency})`);
    }

    // 6. Workspace is allowed (realpath checked; forbidden dirs excluded).
    const resolvedWs = await resolveDelegateWorkspace({
      requested: params.workspace,
      workerPubkey,
      workDir,
      allowedPrefixes: token.workspaces || [],
      forbiddenDirs,
      homeDir,
    });

    // 7. Solo chat is genuine on this worker's relay.
    await checkSoloChat({
      workerPubkey,
      channelId,
      orchestratorPubkey,
      ownerPubkey: token.ownerPubkey,
    });

    if (runtime === "hermes" && !isSandboxed(m) && typeof ensureHermes === "function") {
      await ensureHermes(m.profile || "").catch((e) =>
        log.warn?.(`delegate-executor: ensureHermes failed: ${e.message}`),
      );
    }

    // Write chat-settings.json (noOrchestrate: true, delegatedBy: token.id).
    const acceptedAt = now();
    const expiresAt = soloTtlSecs > 0 ? acceptedAt + soloTtlSecs * 1000 : 0;
    await updateJsonLocked(chatSettingsFile(workerPubkey, m), (data) => {
      for (const [k, v] of Object.entries(data)) {
        if (v && typeof v === "object" && typeof v.expiresAt === "number" && v.expiresAt > 0 && v.expiresAt < acceptedAt) {
          delete data[k];
        }
      }
      const entry = {
        runtime,
        workspace: [resolvedWs],
        noOrchestrate: true,
        delegatedBy: token.id,
        ...(expiresAt ? { expiresAt } : {}),
      };
      if (model) entry.model = model;
      if (effort) entry.effort = effort;
      data[channelId] = entry;
      return data;
    });

    const rec = {
      ref,
      tokenId: token.id,
      workerPubkey,
      channelId,
      runtime,
      model,
      effort,
      label,
      workspace: resolvedWs,
      phase: "starting",
      wakeSeq: 1,
      seq: 0,
      events: [],
      pendingWakePath: "",
      acceptedAt,
      updatedAt: acceptedAt,
      endedReason: "",
    };

    tokenMap.set(ref, rec);
    byChannel.set(channelId, rec);

    try {
      const wake = await wakeWorker({
        workerPubkey,
        wakeId: `orch-del-${ref.replace(/[^A-Za-z0-9_-]/g, "-")}-1`,
        channelId,
        prompt: buildWorkerWakePrompt({ channelId, runtime, label, workspace: resolvedWs, prompt, isFollowUp: false }),
      });
      rec.pendingWakePath = wake?.path || "";
    } catch (err) {
      byChannel.delete(channelId);
      tokenMap.delete(ref);
      await clearChatSetting(workerPubkey, channelId, token.id);
      throw err;
    }

    armPromptTimer(token.id, rec, token.maxTaskMs);
    await persistToken(token.id);
    return { ref, workerPubkey, workspace: resolvedWs, acceptedAt };
  }

  async function handleFollowup(params = {}, session) {
    const token = await requireLiveToken(session);
    const ref = typeof params.ref === "string" ? params.ref.trim() : "";
    const prompt = typeof params.prompt === "string" ? params.prompt : "";
    if (!ref) throw new Error("ref is required");
    if (!prompt.trim()) throw new Error("prompt is required");
    if (Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES) {
      throw new Error("prompt exceeds 60 KiB limit");
    }
    const rec = byToken.get(token.id)?.get(ref);
    if (!rec || !isLivePhase(rec.phase)) {
      throw new Error(`Delegated task "${ref}" is not active`);
    }
    rec.wakeSeq = (rec.wakeSeq || 1) + 1;
    rec.phase = "starting";
    const wake = await wakeWorker({
      workerPubkey: rec.workerPubkey,
      wakeId: `orch-del-${ref.replace(/[^A-Za-z0-9_-]/g, "-")}-${rec.wakeSeq}`,
      channelId: rec.channelId,
      prompt: buildWorkerWakePrompt({
        channelId: rec.channelId,
        runtime: rec.runtime,
        label: rec.label,
        workspace: rec.workspace,
        prompt,
        isFollowUp: true,
      }),
    });
    rec.pendingWakePath = wake?.path || "";
    rec.updatedAt = now();
    armPromptTimer(token.id, rec, token.maxTaskMs);
    await persistToken(token.id);
    return { ok: true };
  }

  async function handleCancel(params = {}, session) {
    const token = await requireLiveToken(session);
    const ref = typeof params.ref === "string" ? params.ref.trim() : "";
    if (!ref) throw new Error("ref is required");
    const rec = byToken.get(token.id)?.get(ref);
    if (!rec) throw new Error(`Delegated task "${ref}" not found`);
    if (!isLivePhase(rec.phase)) return { ok: true, phase: rec.phase };
    rec.phase = "cancelling";
    rec.updatedAt = now();
    await unlinkPendingWake(rec);
    await cancelWorker(rec.workerPubkey, rec.channelId).catch(() => {});
    await persistToken(token.id);
    return { ok: true, phase: rec.phase };
  }

  async function handleRelease(params = {}, session) {
    const token = await requireLiveToken(session);
    const ref = typeof params.ref === "string" ? params.ref.trim() : "";
    if (!ref) throw new Error("ref is required");
    const rec = byToken.get(token.id)?.get(ref);
    if (!rec) return { ok: true };
    clearPromptTimer(token.id, ref);
    await unlinkPendingWake(rec);
    if (isLivePhase(rec.phase)) {
      await cancelWorker(rec.workerPubkey, rec.channelId).catch(() => {});
    }
    byChannel.delete(rec.channelId);
    await clearChatSetting(rec.workerPubkey, rec.channelId, token.id);
    rec.phase = "released";
    rec.updatedAt = now();
    await persistToken(token.id);
    if (liveCount(token.id) === 0) clearLeaseTimer(token.id);
    return { ok: true };
  }

  async function handleSync(params = {}, session) {
    const token = await requireLiveToken(session);
    const refs = Array.isArray(params.refs) ? params.refs : [];
    const after = params.after && typeof params.after === "object" ? params.after : {};
    const tokenMap = byToken.get(token.id);
    const tasks = [];
    for (const rawRef of refs) {
      const ref = String(rawRef || "");
      const floor = Number(after[ref]) || 0;
      const rec = tokenMap?.get(ref);
      if (!rec) {
        tasks.push({
          ref,
          phase: "unknown",
          events: [{ seq: floor + 1, type: "ended", at: now(), reason: "interrupted", error: "Remote host has no record of task" }],
        });
        continue;
      }
      const events = rec.events.filter((e) => e.seq > floor);
      if (rec.phase === "ended" && !events.some((e) => e.type === "ended" || e.type === "turn_done")) {
        const lastEnded = [...rec.events].reverse().find((e) => e.type === "ended");
        events.push({
          ...(lastEnded ?? { type: "ended", at: now(), reason: rec.endedReason || "interrupted" }),
          seq: Math.max((lastEnded?.seq ?? rec.seq) || 0, floor + 1),
        });
      }
      tasks.push({ ref, phase: rec.phase, events });
    }
    return { tasks };
  }

  // ---------- turn signal routing from acp-proxy ----------

  function onProxyTurnEvent(rawWorkerPubkey, name, args = {}) {
    if (name !== "_acp_turn_start" && name !== "_acp_turn_done") return null;
    const workerPubkey = String(rawWorkerPubkey || "").toLowerCase();
    const channelId = typeof args.channel === "string" ? args.channel.trim() : "";
    if (!UUID_RE.test(channelId)) return null;
    const rec = byChannel.get(channelId);
    if (!rec || rec.workerPubkey !== workerPubkey) return null;

    if (name === "_acp_turn_start") {
      rec.pendingWakePath = "";
      rec.phase = "running";
      pushEvent(rec.tokenId, rec, "turn_start", {
        runtime: args.runtime || rec.runtime,
        model: args.model || rec.model || "",
        effort: args.effort || rec.effort || "",
      });
      void persistToken(rec.tokenId);
      return JSON.stringify({ ok: true });
    }

    if (name === "_acp_turn_done") {
      rec.pendingWakePath = "";
      clearPromptTimer(rec.tokenId, rec.ref);
      const wasCancelling = rec.phase === "cancelling";
      rec.phase = wasCancelling || args.error || args.stopReason === "cancelled" ? "ended" : "idle";
      pushEvent(rec.tokenId, rec, "turn_done", {
        runtime: args.runtime || rec.runtime,
        model: args.model || rec.model || "",
        effort: args.effort || rec.effort || "",
        stopReason: args.stopReason || "",
        error: args.error || "",
        finalText: args.finalText || "",
        fallbackPosted: args.fallbackPosted === true,
      });
      if (rec.phase === "ended") {
        byChannel.delete(channelId);
        void clearChatSetting(rec.workerPubkey, rec.channelId, rec.tokenId);
      }
      void persistToken(rec.tokenId);
      return JSON.stringify({ ok: true });
    }
    return null;
  }

  // ---------- lifecycle ----------

  function registerSocket(tokenId, sendFn) {
    let set = tokenSockets.get(tokenId);
    if (!set) {
      set = new Set();
      tokenSockets.set(tokenId, set);
    }
    set.add(sendFn);
    clearLeaseTimer(tokenId);
  }

  function unregisterSocket(tokenId, sendFn) {
    const set = tokenSockets.get(tokenId);
    if (set) {
      set.delete(sendFn);
      if (set.size === 0) tokenSockets.delete(tokenId);
    }
    maybeArmLeaseTimer(tokenId);
  }

  async function start() {
    const files = await fs.readdir(stateDir).catch(() => []);
    for (const name of files) {
      if (!name.endsWith(".json")) continue;
      const tokenId = name.slice(0, -5);
      const saved = await readJson(path.join(stateDir, name), null);
      if (!Array.isArray(saved?.tasks)) continue;
      const tokenMap = getTokenMap(tokenId);
      let dirty = false;
      for (const raw of saved.tasks) {
        if (!raw || typeof raw.ref !== "string") continue;
        const rec = {
          ...raw,
          events: Array.isArray(raw.events) ? raw.events : [],
          seq: Number(raw.seq) || 0,
        };
        tokenMap.set(rec.ref, rec);
        if (isLivePhase(rec.phase)) {
          dirty = true;
          rec.phase = "ended";
          rec.endedReason = "interrupted";
          await unlinkPendingWake(rec);
          await cancelWorker(rec.workerPubkey, rec.channelId).catch(() => {});
          await clearChatSetting(rec.workerPubkey, rec.channelId, tokenId);
          pushEvent(tokenId, rec, "ended", { reason: "interrupted", error: "Remote host restarted" });
        }
      }
      if (dirty) await persistToken(tokenId);
    }
  }

  async function close() {
    closed = true;
    for (const t of leaseTimers.values()) clearTimeout(t);
    leaseTimers.clear();
    for (const t of promptTimers.values()) clearTimeout(t);
    promptTimers.clear();
    tokenSockets.clear();
    await Promise.all([...saveChains.values()].map((p) => p.catch(() => {})));
  }

  return {
    start,
    close,
    registerSocket,
    unregisterSocket,
    liveCount,
    dropToken,
    onProxyTurnEvent,
    methods: {
      "delegate.hello": (_cfg, _params, session) => handleHello(session),
      "delegate.start": (_cfg, params, session) => handleStart(params, session),
      "delegate.followup": (_cfg, params, session) => handleFollowup(params, session),
      "delegate.cancel": (_cfg, params, session) => handleCancel(params, session),
      "delegate.release": (_cfg, params, session) => handleRelease(params, session),
      "delegate.sync": (_cfg, params, session) => handleSync(params, session),
    },
  };
}
