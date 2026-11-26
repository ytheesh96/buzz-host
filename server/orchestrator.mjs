// Orchestrator v1.5 — Solo-chat workers for an opted-in Omarchy agent.
//
// Contract: docs/orchestrator-contract.md.
// Runs delegated workers as real Buzz Solo chats on any Omarchy agent on this
// host — defaulting to the orchestrator agent itself (e.g. Conductor) — using
// parallel conversations (BUZZ_ACP_AGENTS >= 4), operator wake files
// ($BUZZ_ACP_WAKE_DIR), and per-chat runtime dispatch in acp-proxy.
//
// Preserves every v1 guardrail: opt-in (meta.orchestrate === true),
// owner-initiated chats (turn-authors.json), concurrency cap 4 + FIFO queue 16,
// per-prompt wall-clock timeout, MAX_DEPTH = 1 (enforced per worker Solo chat
// via noOrchestrate: true -> BUZZHOST_NO_ORCHESTRATE=1 + server-side gate),
// auth failure cache (runtimes.json), quota-banner refusal detection, and
// restart persistence.

import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { signEvent } from "./attention-relay.mjs";
import { proxyControl } from "./control.mjs";
import { buildDelegateAuthEvent } from "./delegate-executor.mjs";
import { updateJsonLocked } from "./file-lock.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const RUNTIMES = {
  claude: { title: "Claude Code", shim: "claude-agent-acp" },
  codex: { title: "Codex", shim: "codex-acp" },
  hermes: { title: "Hermes", shim: "hermes-acp" },
  antigravity: { title: "Antigravity", shim: "antigravity-acp" },
};
export const MAX_LIVE = 4;
export const MAX_QUEUE = 16;
export const MAX_STEERS = 16;
export const MAX_DEPTH = 1;

const MAX_TASKS_SAVED = 200;
const MAX_PROMPT_BYTES = 60 * 1024;
const MAX_RESULT_BYTES = 256 * 1024;
const MAX_TRANSCRIPT_ENTRIES = 300;
const MAX_TRANSCRIPT_ENTRY_BYTES = 8 * 1024;
const MAX_TRANSCRIPT_TOTAL_BYTES = 128 * 1024;
const SUMMARY_RESULT_CHARS = 2_000;

const DEFAULT_TASK_TIMEOUT_MS = 20 * 60_000;
const MIN_TASK_TIMEOUT_MS = 10_000;
const MAX_TASK_TIMEOUT_MS = 2 * 3600_000;
const DEFAULT_WAIT_MS = 120_000;
const MAX_WAIT_MS = 600_000;
const DEFAULT_CANCEL_GRACE_MS = 5_000;
const DEFAULT_AUTH_FAIL_TTL_MS = 15 * 60_000;
const DEFAULT_CATALOG_BUDGET_MS = 2_500;
const DEFAULT_SOLO_TTL_SECS = 24 * 3600;
const RELAY_OP_TIMEOUT_MS = 20_000;
const RELAY_AUTH_WAIT_MS = 5_000;
const RELAY_RECONNECT_MIN_MS = 1_000;
const RELAY_RECONNECT_MAX_MS = 30_000;

const LIVE_STATUSES = new Set(["starting", "running"]);
const ACTIVE_STATUSES = new Set(["queued", "starting", "running"]);
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "timed_out", "interrupted"]);
const HEX64 = /^[0-9a-f]{64}$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const str = { type: "string" };
const tool = (name, description, properties, required = []) => ({
  name,
  description,
  inputSchema: {
    type: "object",
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  },
});

/** MCP `tools/list` entries for `buzz-mcp.mjs --orchestrate`. */
export const ORCHESTRATOR_TOOLS = [
  tool(
    "orch_capabilities",
    "Runtimes, models, effort levels, local Omarchy agents (including yourself), paired remote hosts (`hosts`), and active tasks available for Solo-chat workers.",
    {
      retry: { type: "boolean" },
    },
  ),
  tool(
    "orch_delegate",
    "Delegate work to a real Solo-chat worker on another runtime (claude, codex, hermes, antigravity). Runs on yourself by default, on any other local Omarchy agent named by `agent`, or on a paired remote machine named by `host` (name, machineId, or linkId from orch_capabilities.hosts). The worker sees no parent chat history: `prompt` must be a self-contained brief, and `context` (optional) carries background such as decisions, constraints, or findings so far. The worker chat links back to the owner's message here. Returns workerChannelId and a buzz://message link you can share in chat, then call orch_wait for the answer.",
    {
      runtime: str,
      prompt: str,
      context: str,
      host: str,
      agent: str,
      model: str,
      effort: str,
      workspace: str,
      label: str,
      timeoutMs: { type: "number" },
    },
    ["runtime", "prompt"],
  ),
  tool(
    "orch_wait",
    "Wait for a worker task to finish (up to 10 minutes).",
    {
      taskId: str,
      timeoutMs: { type: "number" },
    },
    ["taskId"],
  ),
  tool("orch_status", "One task with its Solo chat link, latest step, and transcript.", { taskId: str }, ["taskId"]),
  tool("orch_list", "Your recent tasks, newest first.", {
    chat: str,
    status: str,
    limit: { type: "number" },
  }),
  tool(
    "orch_steer",
    "Queue a follow-up prompt in the worker's Solo chat. It is posted after the current turn completes.",
    {
      taskId: str,
      prompt: str,
    },
    ["taskId", "prompt"],
  ),
  tool("orch_cancel", "Stop a running or queued worker task.", { taskId: str }, ["taskId"]),
];

// ---------- helpers ----------

function checkPubkey(pubkey) {
  if (typeof pubkey !== "string" || !HEX64.test(pubkey)) {
    throw new Error("Invalid agent pubkey");
  }
  return pubkey.toLowerCase();
}

function parseChat(chat) {
  const raw = typeof chat === "string" ? chat.trim() : "";
  if (!raw) return { chat: "", channelId: "", threadRootId: "" };
  const idx = raw.indexOf("_");
  if (idx > 0) return { chat: raw, channelId: raw.slice(0, idx), threadRootId: raw.slice(idx + 1) };
  return { chat: raw, channelId: raw, threadRootId: "" };
}

function defaultLabel(prompt) {
  const first = String(prompt ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean);
  if (!first) return "Worker task";
  return first.length > 72 ? `${first.slice(0, 71)}…` : first;
}

function soloChatName(label, runtime) {
  const rtTitle = RUNTIMES[runtime]?.title ?? runtime;
  const cleanLabel = String(label || "Worker task").replace(/\s+/g, " ").trim();
  const suffix = ` · ${rtTitle}`;
  const maxLabel = Math.max(12, 80 - suffix.length);
  const shortLabel = cleanLabel.length > maxLabel ? `${cleanLabel.slice(0, maxLabel - 1)}…` : cleanLabel;
  return `${shortLabel}${suffix}`;
}

function buzzMessageLink(channelId, eventId) {
  if (!channelId || !eventId) return "";
  return `buzz://message?channel=${channelId}&id=${eventId}`;
}

/**
 * First message posted in a worker Solo chat: the brief, an optional
 * context section, and a backlink to the owner's message in the parent chat.
 * Workers get no parent history (like t3code's delegate_task); the backlink
 * is navigation for the owner, not an instruction to read the parent chat.
 */
function composeWorkerBrief({ prompt, context, parentLink }) {
  const parts = [String(prompt ?? "").trim()];
  const ctx = String(context ?? "").trim();
  if (ctx) parts.push(`**Context**\n${ctx}`);
  if (parentLink) parts.push(`↩ Delegated from: ${parentLink}`);
  return parts.join("\n\n");
}

function clipBytes(text, maxBytes) {
  const s = String(text ?? "");
  if (Buffer.byteLength(s, "utf8") <= maxBytes) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (Buffer.byteLength(s.slice(0, mid), "utf8") <= maxBytes - 3) lo = mid;
    else hi = mid - 1;
  }
  return `${s.slice(0, lo)}…`;
}

function appendTranscript(task, kind, text, { coalesce = false } = {}) {
  const piece = String(text ?? "");
  if (!piece) return;
  const now = Date.now();
  const list = task.transcript;
  if (coalesce && list.length > 0 && list[list.length - 1].kind === kind) {
    const last = list[list.length - 1];
    const combined = last.text + piece;
    if (Buffer.byteLength(combined, "utf8") <= MAX_TRANSCRIPT_ENTRY_BYTES) {
      last.text = combined;
      last.at = now;
      trimTranscript(task);
      return;
    }
  }
  list.push({ at: now, kind, text: clipBytes(piece, MAX_TRANSCRIPT_ENTRY_BYTES) });
  trimTranscript(task);
}

function trimTranscript(task) {
  const list = task.transcript;
  while (list.length > MAX_TRANSCRIPT_ENTRIES) list.shift();
  let total = list.reduce((sum, e) => sum + Buffer.byteLength(e.text ?? "", "utf8"), 0);
  while (total > MAX_TRANSCRIPT_TOTAL_BYTES && list.length > 1) {
    const removed = list.shift();
    total -= Buffer.byteLength(removed.text ?? "", "utf8");
  }
}

function snippet(text, max = 120) {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function elapsedOf(task) {
  if (!task.startedAt) return 0;
  const end = task.endedAt || Date.now();
  return Math.max(0, end - task.startedAt);
}

function toFullView(task, { includeTranscript = false } = {}) {
  const { transcript, ...rest } = task;
  return {
    ...rest,
    elapsedMs: elapsedOf(task),
    latestStep: task.latestStep ? { ...task.latestStep } : null,
    result: task.result ? { ...task.result } : null,
    ...(includeTranscript ? { transcript: transcript.map((e) => ({ ...e })) } : {}),
  };
}

function toSummaryView(task) {
  const { prompt: _prompt, context: _context, transcript: _transcript, ...rest } = task;
  let result = null;
  let resultTruncated;
  if (task.result) {
    const text = String(task.result.text ?? "");
    if (text.length > SUMMARY_RESULT_CHARS) {
      result = { text: text.slice(0, SUMMARY_RESULT_CHARS), bytes: task.result.bytes };
      resultTruncated = true;
    } else {
      result = { text, bytes: task.result.bytes };
    }
  }
  return {
    ...rest,
    elapsedMs: elapsedOf(task),
    latestStep: task.latestStep ? { ...task.latestStep } : null,
    result,
    ...(resultTruncated ? { resultTruncated: true } : {}),
  };
}

function isAuthError(error) {
  if (!error) return false;
  const msg = String(error.message ?? error);
  return /auth(?:entication|orization)?\s+required|not\s+authenticated|login\s+required|unauthorized/i.test(msg);
}

// Some adapters report a refused turn (quota, rate limit) as ordinary reply
// text with stopReason "end_turn" — e.g. Antigravity's
// "⚠ Individual quota reached. …". Treat a short reply that is only such a
// banner as a failure so the task isn't shown as Done. Long replies are left
// alone: a worker may legitimately write about quotas.
const LIMIT_RE =
  /\b(?:quota\s+(?:reached|exceeded)|rate[- ]limit(?:ed|\s+(?:reached|exceeded))|usage\s+limit\s+(?:reached|exceeded)|credit\s+balance\s+is\s+too\s+low|insufficient\s+(?:credits|quota))\b/i;
const MAX_BANNER_CHARS = 400;

export function runtimeRefusal(output) {
  const text = String(output ?? "").trim();
  if (!text || text.length > MAX_BANNER_CHARS) return "";
  if (/^[\u26a0\u203c]/.test(text) || LIMIT_RE.test(text)) {
    return text.replace(/^[\u26a0\u203c]\ufe0f?\s*/, "").replace(/\s+/g, " ");
  }
  return "";
}

function expandWorkspace(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return "";
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

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

function sleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

// ---------- relay transport (Nostr WebSocket, NIP-42 + NIP-OA) ----------

function createRelayTransport({ dataDir, log = console }) {
  // pubkey -> connection object
  const conns = new Map();

  async function loadCreds(pubkey) {
    const dir = path.join(dataDir, pubkey);
    const meta = JSON.parse(await fs.readFile(path.join(dir, "meta.json"), "utf8"));
    const key = (await fs.readFile(path.join(dir, "key"), "utf8")).trim();
    let authTag;
    try {
      authTag = JSON.parse(await fs.readFile(path.join(dir, "auth.json"), "utf8"));
    } catch {
      authTag = undefined;
    }
    return { relay: meta.community, key, authTag };
  }

  function getOrCreateConn(pubkey) {
    let c = conns.get(pubkey);
    if (!c) {
      c = {
        pubkey,
        ws: null,
        ready: false,
        connecting: null,
        closed: false,
        creds: null,
        authId: "",
        backoff: RELAY_RECONNECT_MIN_MS,
        retry: null,
        pendingOk: new Map(),     // eventId -> { resolve, reject, timer }
        pendingQueries: new Map(), // subId -> { events, finish }
        watches: new Map(),       // subId -> { filter, onEvent, seen }
      };
      conns.set(pubkey, c);
    }
    return c;
  }

  function ensureConnected(pubkey) {
    const c = getOrCreateConn(pubkey);
    if (c.ready && c.ws?.readyState === WebSocket.OPEN) return Promise.resolve(c);
    if (c.connecting) return c.connecting;
    c.closed = false;
    c.connecting = new Promise((resolve, reject) => {
      void (async () => {
        try {
          c.creds = await loadCreds(pubkey);
        } catch (error) {
          c.connecting = null;
          reject(new Error(`Cannot load credentials for ${pubkey.slice(0, 8)}: ${error.message}`));
          return;
        }
        if (c.closed) {
          c.connecting = null;
          reject(new Error("Relay connection closed"));
          return;
        }
        let ws;
        try {
          ws = new WebSocket(c.creds.relay);
        } catch (error) {
          c.connecting = null;
          reject(new Error(`Invalid relay URL (${c.creds.relay}): ${error.message ?? error}`));
          return;
        }
        c.ws = ws;
        c.ready = false;
        let authTimer = null;
        let settled = false;
        const connectTimer = setTimeout(() => {
          if (!settled) {
            settled = true;
            c.connecting = null;
            if (c.ws === ws) {
              c.ws = null;
              c.ready = false;
            }
            try {
              ws.close();
            } catch {}
            reject(new Error("Timed out connecting to relay"));
          }
        }, RELAY_OP_TIMEOUT_MS);
        connectTimer.unref?.();

        const markReady = () => {
          clearTimeout(authTimer);
          clearTimeout(connectTimer);
          if (c.ws !== ws || c.ready) return;
          c.ready = true;
          c.backoff = RELAY_RECONNECT_MIN_MS;
          c.connecting = null;
          // Re-establish any live channel watches after reconnect.
          for (const [subId, w] of c.watches) {
            try {
              ws.send(JSON.stringify(["REQ", subId, w.filter]));
            } catch {}
          }
          if (!settled) {
            settled = true;
            resolve(c);
          }
        };

        ws.addEventListener("open", () => {
          authTimer = setTimeout(markReady, RELAY_AUTH_WAIT_MS);
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
            const tags = [
              ["relay", c.creds.relay],
              ["challenge", data[1]],
            ];
            if (Array.isArray(c.creds.authTag)) tags.push(c.creds.authTag);
            const ev = signEvent(c.creds.key, { kind: 22242, tags, content: "" });
            c.authId = ev.id;
            ws.send(JSON.stringify(["AUTH", ev]));
          } else if (type === "OK" && data[1] === c.authId) {
            if (data[2] === true) markReady();
            else {
              const reason = data[3] || "relay auth refused";
              clearTimeout(authTimer);
              clearTimeout(connectTimer);
              if (!settled) {
                settled = true;
                c.connecting = null;
                reject(new Error(`Relay login refused: ${reason}`));
              }
              ws.close();
            }
          } else if (type === "OK" && c.pendingOk.has(data[1])) {
            const p = c.pendingOk.get(data[1]);
            c.pendingOk.delete(data[1]);
            clearTimeout(p.timer);
            if (data[2] === true) p.resolve();
            else p.reject(new Error(data[3] || "Relay rejected event"));
          } else if ((type === "EVENT" || type === "EOSE" || type === "CLOSED") && c.pendingQueries.has(data[1])) {
            const q = c.pendingQueries.get(data[1]);
            if (type === "EVENT" && data[2]?.id) q.events.push(data[2]);
            else if (type === "EOSE") q.finish();
            else if (type === "CLOSED") q.finish(new Error(data[2] || "Relay closed query"));
          } else if (type === "EVENT" && c.watches.has(data[1]) && data[2]?.id) {
            const w = c.watches.get(data[1]);
            const ev = data[2];
            if (w.seen.has(ev.id)) return;
            w.seen.add(ev.id);
            if (w.seen.size > 500) w.seen.delete(w.seen.values().next().value);
            try {
              w.onEvent(ev);
            } catch (err) {
              log.warn?.(`orchestrator relay watch handler error: ${err.message}`);
            }
          }
        });

        ws.addEventListener("close", () => {
          clearTimeout(authTimer);
          clearTimeout(connectTimer);
          const isCurrent = c.ws === ws;
          if (isCurrent) {
            c.ws = null;
            c.ready = false;
          }
          if (!settled) {
            settled = true;
            if (isCurrent) c.connecting = null;
            reject(new Error("Relay connection closed"));
          }
          if (!isCurrent) return;
          for (const [id, p] of c.pendingOk) {
            clearTimeout(p.timer);
            p.reject(new Error("Relay connection closed"));
            c.pendingOk.delete(id);
          }
          for (const [, q] of [...c.pendingQueries]) q.finish(new Error("Relay connection closed"));
          if (!c.closed && c.watches.size > 0) {
            const wait = Math.min(c.backoff, RELAY_RECONNECT_MAX_MS);
            c.backoff = Math.min(c.backoff * 2, RELAY_RECONNECT_MAX_MS);
            c.retry = setTimeout(() => {
              c.retry = null;
              if (!c.closed && c.watches.size > 0) {
                ensureConnected(pubkey).catch(() => {});
              }
            }, wait);
            c.retry.unref?.();
          }
        });

        ws.addEventListener("error", () => {});
      })();
    });
    return c.connecting;
  }

  async function publish(pubkey, { kind, tags, content }) {
    const c = await ensureConnected(pubkey);
    const fullTags = [...tags];
    if (Array.isArray(c.creds?.authTag)) fullTags.push(c.creds.authTag);
    const event = signEvent(c.creds.key, { kind, tags: fullTags, content });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        c.pendingOk.delete(event.id);
        reject(new Error("Timed out waiting for relay OK"));
      }, RELAY_OP_TIMEOUT_MS);
      timer.unref?.();
      c.pendingOk.set(event.id, { resolve, reject, timer });
      try {
        c.ws.send(JSON.stringify(["EVENT", event]));
      } catch (error) {
        clearTimeout(timer);
        c.pendingOk.delete(event.id);
        reject(error);
      }
    });
    return event;
  }

  async function query(pubkey, filter, timeoutMs = RELAY_OP_TIMEOUT_MS) {
    const c = await ensureConnected(pubkey);
    const subId = `oq-${randomBytes(4).toString("hex")}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error("Relay query timed out")), timeoutMs);
      timer.unref?.();
      const entry = {
        events: [],
        finish(err) {
          clearTimeout(timer);
          c.pendingQueries.delete(subId);
          try {
            c.ws?.send(JSON.stringify(["CLOSE", subId]));
          } catch {}
          if (err) reject(err);
          else resolve(entry.events);
        },
      };
      c.pendingQueries.set(subId, entry);
      try {
        c.ws.send(JSON.stringify(["REQ", subId, filter]));
      } catch (error) {
        entry.finish(error);
      }
    });
  }

  return {
    async createSoloChat({ pubkey, ownerPubkey, workerPubkey, channelId, name, ttlSeconds }) {
      const tags = [
        ["h", channelId],
        ["name", name],
        ["visibility", "private"],
        ["channel_type", "stream"],
        ["t", "buzz.solo"],
        ["p", ownerPubkey],
      ];
      if (workerPubkey && workerPubkey !== pubkey && workerPubkey !== ownerPubkey) {
        tags.push(["p", workerPubkey]);
      }
      if (Number.isInteger(ttlSeconds) && ttlSeconds > 0) {
        tags.push(["ttl", String(ttlSeconds)]);
      }
      const ev = await publish(pubkey, { kind: 9007, tags, content: "" });
      return { channelId, eventId: ev.id };
    },

    async postMessage({ pubkey, channelId, mentionPubkey, content, extraTags = [] }) {
      const tags = [["h", channelId]];
      if (mentionPubkey) tags.push(["p", mentionPubkey]);
      for (const t of extraTags) {
        if (Array.isArray(t) && t.length > 0) tags.push(t);
      }
      const ev = await publish(pubkey, { kind: 9, tags, content });
      return { eventId: ev.id, createdAt: ev.created_at };
    },

    async getMessages({ pubkey, channelId, authorPubkey, since }) {
      const filter = {
        kinds: [9],
        "#h": [channelId],
        authors: [authorPubkey],
        ...(Number.isFinite(since) ? { since: Math.max(0, Math.floor(since)) } : {}),
        limit: 100,
      };
      const events = await query(pubkey, filter);
      return events.sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
    },

    async watchChannel({ pubkey, channelId, authorPubkey, onMessage }) {
      const c = await ensureConnected(pubkey);
      const subId = `ow-${randomBytes(4).toString("hex")}`;
      const filter = {
        kinds: [9],
        "#h": [channelId],
        authors: [authorPubkey],
        since: Math.max(0, Math.floor(Date.now() / 1000) - 5),
      };
      c.watches.set(subId, { filter, onEvent: onMessage, seen: new Set() });
      try {
        c.ws?.send(JSON.stringify(["REQ", subId, filter]));
      } catch {}
      return () => {
        c.watches.delete(subId);
        try {
          c.ws?.send(JSON.stringify(["CLOSE", subId]));
        } catch {}
      };
    },

    async close() {
      for (const c of conns.values()) {
        c.closed = true;
        if (c.retry) clearTimeout(c.retry);
        c.watches.clear();
        try {
          c.ws?.close();
        } catch {}
      }
      conns.clear();
    },
  };
}

// ---------- factory ----------

/**
 * @param {object} options
 * @param {string} options.dataDir   agents dir (~/.local/share/buzz-host/agents)
 * @param {string} [options.stateDir] orchestrator state (~/.local/share/buzz-host/orchestrator)
 * @param {string} [options.shimsDir] runtime shims (default sibling ./shims)
 * @param {string} [options.runDir]  control-socket dir ($XDG_RUNTIME_DIR/buzz-host)
 * @param {(runtime: string) => Promise<object>} [options.catalog] cached models per runtime
 * @param {(profile: string) => Promise<void>} [options.ensureHermes] prepares Hermes plugin
 * @param {object} [options.relay]   relay transport override (tests)
 * @param {(req: { workerPubkey: string, wakeId: string, channelId: string, prompt: string }) => Promise<{ id?: string, path?: string }>} [options.wakeWorker] override (tests)
 * @param {(workerPubkey: string, channelId: string) => Promise<object>} [options.cancelWorker] override (tests)
 * @param {object} [options.log]     console-like
 * @param {object} [options.limits]  test overrides
 */
export function createOrchestrator({
  dataDir,
  stateDir = path.join(os.homedir(), ".local/share/buzz-host/orchestrator"),
  shimsDir = path.join(HERE, "shims"),
  runDir = path.join(process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`, "buzz-host"),
  machineId = "",
  links = null,
  signDelegateAuth = null,
  catalog,
  ensureHermes,
  relay: customRelay,
  wakeWorker: customWakeWorker,
  cancelWorker: customCancelWorker,
  log = console,
  limits = {},
} = {}) {
  if (!dataDir) throw new Error("createOrchestrator: dataDir is required");

  const maxLive = limits.maxLive ?? MAX_LIVE;
  const maxQueue = limits.maxQueue ?? MAX_QUEUE;
  const maxSteers = limits.maxSteers ?? MAX_STEERS;
  const defaultTimeoutMs = limits.defaultTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
  const minTimeoutMs = limits.minTimeoutMs ?? MIN_TASK_TIMEOUT_MS;
  const maxTimeoutMs = limits.maxTimeoutMs ?? MAX_TASK_TIMEOUT_MS;
  const cancelGraceMs = limits.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;
  const authFailTtlMs = limits.authFailTtlMs ?? DEFAULT_AUTH_FAIL_TTL_MS;
  const catalogBudgetMs = limits.catalogBudgetMs ?? DEFAULT_CATALOG_BUDGET_MS;
  const soloTtlSecs = limits.soloTtlSecs ?? DEFAULT_SOLO_TTL_SECS;
  const checkShimAccess = limits.checkShimAccess ?? !customRelay;

  const relay = customRelay ?? createRelayTransport({ dataDir, log });
  const wakeWorker =
    customWakeWorker ??
    (async ({ workerPubkey, wakeId, channelId, prompt }) => {
      const wakeDir = path.join(dataDir, workerPubkey, "wake");
      await fs.mkdir(path.join(wakeDir, "results"), { recursive: true, mode: 0o700 });
      const cleanId = String(wakeId || "orch-wake")
        .replace(/[^A-Za-z0-9._-]/g, "-")
        .slice(0, 128);
      const finalPath = path.join(wakeDir, `${cleanId}.json`);
      const tmpPath = path.join(wakeDir, `.${cleanId}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
      await fs.writeFile(tmpPath, `${JSON.stringify({ id: cleanId, channel: channelId, prompt })}\n`, {
        mode: 0o600,
      });
      await fs.chmod(tmpPath, 0o600);
      await fs.rename(tmpPath, finalPath);
      return { id: cleanId, path: finalPath };
    });
  const cancelWorker =
    customCancelWorker ??
    ((workerPubkey, channelId) =>
      proxyControl(runDir, workerPubkey, { op: "cancel", channel: channelId, all: true }, 10_000, { cancelled: false }));

  // Per-agent loaded state: pubkey -> Promise<{ tasks: Map<taskId, record>, order: string[], queue: string[] }>
  const loaded = new Map();
  const saveChains = new Map();
  const saveTimers = new Map();
  const pumpChains = new Map();
  // Per-task wall-clock timeout budgets
  const taskTimeouts = new Map();
  // Live worker drivers: taskId -> driver handle
  const drivers = new Map();
  // Active solo-chat tasks keyed by workerChannelId -> driver handle
  const soloByChannel = new Map();
  // Active remote tasks keyed by remoteRef -> driver handle
  const remoteByRef = new Map();
  // Queued remote cancels/releases when a peer link was down: linkId -> Set<ref>
  const pendingRemoteCancels = new Map();
  const pendingRemoteReleases = new Map();
  // Tasks currently inside async startSoloWorker setup (before driver registers)
  const startingCancelled = new Set();
  // Waiters for task completion: taskId -> Set<(outcome: { closed?: boolean }) => void>
  const waiters = new Map();
  const forgetting = new Set();
  const runtimesFile = path.join(stateDir, "runtimes.json");
  let runtimeFailures = null;
  let closed = false;

  const agentFile = (pubkey) => path.join(stateDir, `${pubkey}.json`);
  const agentMetaFile = (pubkey) => path.join(dataDir, pubkey, "meta.json");
  const turnAuthorsFile = (pubkey) => path.join(dataDir, pubkey, "turn-authors.json");
  const chatSettingsFile = (pubkey) => path.join(dataDir, pubkey, "chat-settings.json");

  // ---------- persistence ----------

  async function loadRuntimeFailures() {
    if (runtimeFailures) return runtimeFailures;
    const raw = await readJson(runtimesFile, {});
    runtimeFailures = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    return runtimeFailures;
  }

  async function recordRuntimeFailure(runtime, reason) {
    const map = await loadRuntimeFailures();
    map[runtime] = { reason: String(reason || "authentication required").slice(0, 300), at: Date.now() };
    await writePrivateAtomic(runtimesFile, map).catch((e) =>
      log.error?.(`orchestrator: save runtimes.json failed: ${e.message}`),
    );
  }

  async function clearRuntimeFailure(runtime) {
    const map = await loadRuntimeFailures();
    if (runtime) {
      if (!Object.hasOwn(map, runtime)) return;
      delete map[runtime];
    } else {
      for (const k of Object.keys(map)) delete map[k];
    }
    await writePrivateAtomic(runtimesFile, map).catch((e) =>
      log.error?.(`orchestrator: save runtimes.json failed: ${e.message}`),
    );
  }

  async function activeAuthFailure(runtime) {
    const map = await loadRuntimeFailures();
    const rec = map[runtime];
    if (!rec || typeof rec.at !== "number") return null;
    if (Date.now() - rec.at >= authFailTtlMs) {
      delete map[runtime];
      await writePrivateAtomic(runtimesFile, map).catch(() => {});
      return null;
    }
    return rec;
  }

  function runtimeFailKey(runtime, hostMachineId = "") {
    return hostMachineId ? `${hostMachineId}:${runtime}` : runtime;
  }

  function queuePendingRemoteOp(map, linkId, ref) {
    if (!linkId || !ref) return;
    let set = map.get(linkId);
    if (!set) {
      set = new Set();
      map.set(linkId, set);
    }
    set.add(ref);
  }

  async function releaseRemoteRef(linkId, ref) {
    if (!links || !linkId || !ref) return;
    links.untrackRef(linkId, ref);
    try {
      await links.call(linkId, "delegate.release", { ref });
      pumpAllLoaded();
    } catch {
      queuePendingRemoteOp(pendingRemoteReleases, linkId, ref);
    }
  }

  async function createSignedStartAuth({ pubkey, targetMachineId, ref, channelId, workerPubkey }) {
    if (typeof signDelegateAuth === "function") {
      return signDelegateAuth({ pubkey, targetMachineId, ref, channelId, workerPubkey });
    }
    const dir = path.join(dataDir, pubkey);
    const key = (await fs.readFile(path.join(dir, "key"), "utf8")).trim();
    const authTag = JSON.parse(await fs.readFile(path.join(dir, "auth.json"), "utf8"));
    return buildDelegateAuthEvent({
      secretKey: key,
      authTag,
      targetMachineId,
      ref,
      channelId,
      workerPubkey,
    });
  }

  async function loadAgent(pubkey) {
    if (loaded.has(pubkey)) return loaded.get(pubkey);
    const p = (async () => {
      const saved = await readJson(agentFile(pubkey), null);
      const tasks = new Map();
      const order = [];
      let dirty = false;
      const interruptedRemote = [];
      const now = Date.now();
      for (const raw of Array.isArray(saved?.tasks) ? saved.tasks : []) {
        if (!raw || typeof raw.taskId !== "string") continue;
        const rec = {
          ...raw,
          host: raw.host ?? null,
          remoteRef: raw.remoteRef ?? "",
          transcript: Array.isArray(raw.transcript) ? raw.transcript : [],
          steerQueued: Number(raw.steerQueued) || 0,
        };
        if (ACTIVE_STATUSES.has(rec.status)) {
          rec.status = "interrupted";
          rec.endedAt = rec.updatedAt || now;
          rec.updatedAt = now;
          rec.steerQueued = 0;
          rec.error = rec.error || "host restarted";
          appendTranscript(rec, "status", "Interrupted: buzz-host restarted while task was active.");
          if (rec.host?.linkId && rec.remoteRef) {
            interruptedRemote.push({ linkId: rec.host.linkId, ref: rec.remoteRef });
          }
          dirty = true;
        }
        tasks.set(rec.taskId, rec);
        order.push(rec.taskId);
      }
      const state = { tasks, order, queue: [] };
      if (dirty) await persistNow(pubkey, state);
      for (const item of interruptedRemote) {
        void releaseRemoteRef(item.linkId, item.ref);
      }
      return state;
    })().catch((err) => {
      loaded.delete(pubkey);
      throw err;
    });
    loaded.set(pubkey, p);
    return p;
  }

  function persistNow(pubkey, state) {
    if (closed || forgetting.has(pubkey)) return saveChains.get(pubkey) ?? Promise.resolve();
    const timer = saveTimers.get(pubkey);
    if (timer) {
      clearTimeout(timer);
      saveTimers.delete(pubkey);
    }
    const prev = saveChains.get(pubkey) ?? Promise.resolve();
    const next = prev.then(async () => {
      if (forgetting.has(pubkey)) return;
      const all = [...state.tasks.values()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      const kept = all.slice(0, MAX_TASKS_SAVED);
      if (all.length > MAX_TASKS_SAVED) {
        const keepIds = new Set(kept.map((t) => t.taskId));
        for (const t of all.slice(MAX_TASKS_SAVED)) {
          if (!ACTIVE_STATUSES.has(t.status)) state.tasks.delete(t.taskId);
        }
        state.order = state.order.filter((id) => keepIds.has(id) || state.tasks.has(id));
      }
      const payload = { version: 1, tasks: kept };
      await writePrivateAtomic(agentFile(pubkey), payload);
    });
    const safe = next.catch((e) => log.error?.(`orchestrator: persist ${pubkey.slice(0, 8)} failed: ${e.message}`));
    saveChains.set(pubkey, safe);
    return safe;
  }

  function persistSoon(pubkey, state) {
    if (closed || forgetting.has(pubkey) || saveTimers.has(pubkey)) return;
    const t = setTimeout(() => {
      saveTimers.delete(pubkey);
      void persistNow(pubkey, state);
    }, 250);
    t.unref?.();
    saveTimers.set(pubkey, t);
  }

  function notifyWaiters(taskId, outcome = {}) {
    const set = waiters.get(taskId);
    if (!set) return;
    waiters.delete(taskId);
    for (const wake of set) wake(outcome);
  }

  // ---------- guards ----------

  async function requireOptIn(pubkey) {
    const meta = await readJson(agentMetaFile(pubkey), null);
    if (!meta) throw new Error("Agent not found on this host");
    if (meta.orchestrate !== true) {
      throw new Error("Orchestration is off for this agent; the owner can turn it on in the agent's Settings.");
    }
    return meta;
  }

  async function listEligibleAgents(orchPubkey, orchMeta) {
    const orchOwner = String(orchMeta.owner ?? "").toLowerCase();
    const entries = await fs.readdir(dataDir, { withFileTypes: true }).catch(() => []);
    const out = [];
    for (const ent of entries) {
      if (!ent.isDirectory() || !HEX64.test(ent.name)) continue;
      const pk = ent.name.toLowerCase();
      const m = await readJson(agentMetaFile(pk), null);
      if (!m || !m.activated) continue;
      const owner = String(m.owner ?? "").toLowerCase();
      if (orchOwner && owner && owner !== orchOwner) continue;
      out.push({
        pubkey: pk,
        name: m.name || pk.slice(0, 8),
        runtime: m.runtime || "claude",
        profile: m.profile || "",
        concurrency: Number.isInteger(m.concurrency) ? m.concurrency : 4,
        self: pk === orchPubkey,
      });
    }
    out.sort((a, b) => (a.self === b.self ? a.name.localeCompare(b.name) : a.self ? -1 : 1));
    return out;
  }

  async function resolveTargetAgent(orchPubkey, orchMeta, targetSpec = "") {
    const spec = typeof targetSpec === "string" ? targetSpec.trim() : "";
    const agents = await listEligibleAgents(orchPubkey, orchMeta);
    if (!spec) {
      const self = agents.find((a) => a.self);
      if (!self) {
        return {
          worker: null,
          error: "Orchestrator agent is not activated yet; activate it before delegating workers.",
        };
      }
      return { worker: self, error: "" };
    }
    const lower = spec.toLowerCase();
    if (HEX64.test(lower)) {
      const hit = agents.find((a) => a.pubkey === lower);
      if (!hit) {
        return {
          worker: null,
          error: `Target agent ${lower.slice(0, 8)} was not found, is not activated, or belongs to a different owner.`,
        };
      }
      return { worker: hit, error: "" };
    }
    const cleanName = lower.replace(/^@/, "");
    const matches = agents.filter((a) => a.name.toLowerCase() === cleanName);
    if (matches.length === 1) return { worker: matches[0], error: "" };
    if (matches.length > 1) {
      return {
        worker: null,
        error: `Multiple Omarchy agents are named "${spec}". Pass the agent's 64-hex pubkey instead.`,
      };
    }
    const available = agents.map((a) => a.name).join(", ") || "none";
    return {
      worker: null,
      error: `Unknown target agent "${spec}". Available Omarchy agents: ${available}.`,
    };
  }

  async function requireOwnerChat(pubkey, chat) {
    const meta = await requireOptIn(pubkey);
    const owner = String(meta.owner ?? "").toLowerCase();
    if (!HEX64.test(owner)) throw new Error("Agent has no verified owner.");
    const key = typeof chat === "string" ? chat.trim() : "";
    if (!key) throw new Error("Orchestration is only allowed in owner-initiated chats (missing chat context).");
    // Defense-in-depth MAX_DEPTH = 1: never allow orchestration from inside a
    // delegated worker Solo chat, even if the owner later steered it directly.
    const { channelId } = parseChat(key);
    if (soloByChannel.has(channelId) || soloByChannel.has(key)) {
      throw new Error("Workers inside a delegated Solo chat cannot delegate further (MAX_DEPTH = 1).");
    }
    const chatSettings = await readJson(chatSettingsFile(pubkey), {});
    if (chatSettings?.[channelId]?.noOrchestrate === true || chatSettings?.[key]?.noOrchestrate === true) {
      throw new Error("Workers inside a delegated Solo chat cannot delegate further (MAX_DEPTH = 1).");
    }
    const authors = await readJson(turnAuthorsFile(pubkey), {});
    const entry = authors && typeof authors === "object" ? authors[key] : null;
    if (!entry || typeof entry !== "object" || String(entry.author ?? "").toLowerCase() !== owner) {
      throw new Error("Orchestration is only allowed in owner-initiated chats.");
    }
    const originEventId = HEX64.test(String(entry.eventId ?? "")) ? String(entry.eventId).toLowerCase() : "";
    return { meta, owner, originEventId };
  }

  // ---------- Solo-chat worker driver ----------

  function liveCount(state) {
    let n = 0;
    for (const t of state.tasks.values()) {
      if (LIVE_STATUSES.has(t.status)) n++;
    }
    return n;
  }

  function pumpQueue(pubkey) {
    if (closed || forgetting.has(pubkey)) return Promise.resolve();
    const prev = pumpChains.get(pubkey) ?? Promise.resolve();
    const next = prev.then(async () => {
      if (closed || forgetting.has(pubkey)) return;
      const state = await loadAgent(pubkey);
      const deferred = [];
      const busyRemoteLinks = new Set();
      while (state.queue.length > 0 && liveCount(state) < maxLive) {
        if (closed || forgetting.has(pubkey)) return;
        const nextId = state.queue.shift();
        const task = state.tasks.get(nextId);
        if (!task || task.status !== "queued") continue;
        if (task.host?.linkId && busyRemoteLinks.has(task.host.linkId)) {
          deferred.push(nextId);
          continue;
        }
        // Claim the live slot synchronously before any await so concurrent
        // delegate/pumpQueue calls never overshoot maxLive or race with cancel.
        task.status = "starting";
        task.updatedAt = Date.now();
        const orchMeta = await readJson(agentMetaFile(pubkey), null);
        if (closed || forgetting.has(pubkey) || startingCancelled.has(task.taskId) || task.status !== "starting") {
          startingCancelled.delete(task.taskId);
          if (!TERMINAL_STATUSES.has(task.status)) {
            await finishTask(pubkey, state, task, { status: "cancelled", stopReason: "cancelled" });
          }
          continue;
        }
        if (!orchMeta) {
          await finishTask(pubkey, state, task, { status: "failed", error: "Orchestrator agent metadata missing." });
          continue;
        }
        if (task.host?.linkId) {
          const link = links ? await links.resolveHost(task.host.linkId) : null;
          if (!link) {
            await finishTask(pubkey, state, task, {
              status: "failed",
              error: `Peer link "${task.host.name}" was removed.`,
            });
            continue;
          }
          if (link.status === "revoked" || link.status === "expired") {
            await finishTask(pubkey, state, task, {
              status: "failed",
              error: `Host ${link.name} delegate token ${link.status}.`,
            });
            continue;
          }
          try {
            const outcome = await startRemoteWorker(
              pubkey,
              orchMeta,
              link,
              { pubkey: task.workerPubkey, name: task.workerName },
              state,
              task,
            );
            if (outcome?.requeued) {
              busyRemoteLinks.add(link.id);
              deferred.push(nextId);
            }
          } catch (err) {
            await finishTask(pubkey, state, task, {
              status: "failed",
              error: String(err?.message ?? err),
            });
          }
          continue;
        }
        const { worker, error } = await resolveTargetAgent(pubkey, orchMeta, task.workerPubkey || "");
        if (closed || forgetting.has(pubkey) || startingCancelled.has(task.taskId) || task.status !== "starting") {
          startingCancelled.delete(task.taskId);
          if (!TERMINAL_STATUSES.has(task.status)) {
            await finishTask(pubkey, state, task, { status: "cancelled", stopReason: "cancelled" });
          }
          continue;
        }
        if (!worker) {
          await finishTask(pubkey, state, task, { status: "failed", error });
          continue;
        }
        try {
          await startSoloWorker(pubkey, orchMeta, worker, state, task);
        } catch (err) {
          await finishTask(pubkey, state, task, {
            status: "failed",
            error: String(err?.message ?? err),
          });
        }
      }
      if (deferred.length > 0) {
        state.queue.unshift(...deferred);
      }
    });
    const safe = next.catch((e) => log.error?.(`orchestrator: pumpQueue ${pubkey.slice(0, 8)} failed: ${e.message}`));
    pumpChains.set(pubkey, safe);
    return safe;
  }

  async function startSoloWorker(pubkey, orchMeta, worker, state, task) {
    const owner = String(orchMeta.owner ?? "").toLowerCase();
    const channelId = randomUUID();
    const chatTitle = soloChatName(task.label, task.runtime);
    const isAbortedBeforeStart = () =>
      closed || forgetting.has(pubkey) || startingCancelled.has(task.taskId) || TERMINAL_STATUSES.has(task.status);

    if (task.runtime === "hermes" && typeof ensureHermes === "function") {
      await ensureHermes(worker.profile || "").catch((e) =>
        log.warn?.(`orchestrator: ensureHermes failed: ${e.message}`),
      );
      if (isAbortedBeforeStart()) {
        startingCancelled.delete(task.taskId);
        await finishTask(pubkey, state, task, { status: "cancelled", stopReason: "cancelled" });
        return;
      }
    }

    // 1. Pre-configure the worker agent's per-chat settings BEFORE creating the
    //    channel or posting the prompt so acp-proxy routes session/new cleanly.
    //    Tag orchestrated entries with expiresAt and prune expired ones so
    //    chat-settings.json does not grow unbounded over time.
    const nowMs = Date.now();
    const expiresAt = soloTtlSecs > 0 ? nowMs + soloTtlSecs * 1000 : 0;
    await updateJsonLocked(chatSettingsFile(worker.pubkey), (data) => {
      for (const [k, v] of Object.entries(data)) {
        if (v && typeof v === "object" && typeof v.expiresAt === "number" && v.expiresAt > 0 && v.expiresAt < nowMs) {
          delete data[k];
        }
      }
      const entry = {
        runtime: task.runtime,
        workspace: [task.workspace],
        noOrchestrate: true,
        ...(expiresAt ? { expiresAt } : {}),
      };
      if (task.model) entry.model = task.model;
      if (task.effort) entry.effort = task.effort;
      data[channelId] = entry;
      return data;
    });

    if (isAbortedBeforeStart()) {
      startingCancelled.delete(task.taskId);
      await finishTask(pubkey, state, task, { status: "cancelled", stopReason: "cancelled" });
      return;
    }

    // 2. Create the private ephemeral Buzz Solo chat with owner + worker agent.
    await relay.createSoloChat({
      pubkey,
      ownerPubkey: owner,
      workerPubkey: worker.pubkey,
      channelId,
      name: chatTitle,
      ttlSeconds: soloTtlSecs,
    });

    if (isAbortedBeforeStart()) {
      startingCancelled.delete(task.taskId);
      await finishTask(pubkey, state, task, { status: "cancelled", stopReason: "cancelled" });
      return;
    }

    task.mode = "solo";
    task.workerPubkey = worker.pubkey;
    task.workerName = worker.name;
    task.workerChannelId = channelId;
    task.status = "starting";
    task.updatedAt = Date.now();
    appendTranscript(task, "status", `Opened Solo chat "${chatTitle}" with ${worker.name}.`);

    const promptQueue = [];
    const seenMessageIds = new Set();
    let turnTimer = null;
    let cancelTimer = null;
    let cancelling = false;
    let timedOut = false;
    let finished = false;
    let settlePromise = null;
    let turnStartedSec = Math.floor(Date.now() / 1000);
    let turnMessages = [];
    let allOutputs = [];
    let unwatch = () => {};
    let pendingWakePath = "";
    let wakeSeq = 0;

    const clearPendingWake = () => {
      if (!pendingWakePath) return;
      const p = pendingWakePath;
      pendingWakePath = "";
      void fs.unlink(p).catch(() => {});
    };

    const buildWakePrompt = (promptText, isFollowUp = false) => {
      const header = isFollowUp
        ? `<delegated-worker-followup channel="${channelId}" runtime="${task.runtime}">\n` +
          `Follow-up instruction for your active delegated worker task in Solo chat #${channelId}.\n` +
          `Complete the follow-up and post your reply directly in channel ${channelId} (use \`buzz messages send --channel ${channelId} --content -\` or a plain final answer). Do not delegate further tasks.\n` +
          `</delegated-worker-followup>`
        : `<delegated-worker-task channel="${channelId}" runtime="${task.runtime}">\n` +
          `You are running as a Solo-chat worker for "${task.label}" in channel #${channelId} (workspace: ${task.workspace}).\n` +
          `Complete the task below and post your final answer directly in channel ${channelId} (use \`buzz messages send --channel ${channelId} --content -\` or a plain final answer). Do not delegate further tasks.\n` +
          `The brief below is self-contained. The "Delegated from" link is for the owner; do not read the parent chat unless the brief is missing something essential.\n` +
          `</delegated-worker-task>`;
      return `${header}\n\n${promptText}`;
    };

    const dropWake = async (promptText, isFollowUp = false) => {
      const wake = await wakeWorker({
        workerPubkey: worker.pubkey,
        wakeId: `orch-${task.taskId}-${++wakeSeq}`,
        channelId,
        prompt: buildWakePrompt(promptText, isFollowUp),
      });
      pendingWakePath = wake?.path || "";
      if (finished || cancelling || timedOut) clearPendingWake();
      return wake;
    };

    const clearTimers = () => {
      if (turnTimer) {
        clearTimeout(turnTimer);
        turnTimer = null;
      }
      if (cancelTimer) {
        clearTimeout(cancelTimer);
        cancelTimer = null;
      }
    };

    const resetTurnTimer = () => {
      if (turnTimer) clearTimeout(turnTimer);
      const budget = taskTimeouts.get(task.taskId) ?? defaultTimeoutMs;
      turnTimer = setTimeout(() => {
        if (finished || closed) return;
        timedOut = true;
        cancelling = true;
        promptQueue.length = 0;
        task.steerQueued = 0;
        clearPendingWake();
        appendTranscript(task, "status", `Timed out after ${Math.round(budget / 1000)}s; stopping worker.`);
        void cancelWorker(worker.pubkey, channelId).catch(() => {});
        cancelTimer = setTimeout(() => {
          cancelTimer = null;
          void settle({
            status: "timed_out",
            stopReason: task.stopReason || "cancelled",
            error: `Worker timed out after ${budget}ms`,
          });
        }, cancelGraceMs);
        cancelTimer.unref?.();
      }, budget);
      turnTimer.unref?.();
    };

    const combinedOutput = (extraFallback = "") => {
      const chunks = [...allOutputs];
      if (turnMessages.length > 0) {
        chunks.push(turnMessages.map((m) => m.content).filter(Boolean).join("\n\n"));
      } else if (extraFallback) {
        chunks.push(extraFallback);
      }
      const joined = chunks.filter(Boolean).join("\n\n");
      const bytes = Buffer.byteLength(joined, "utf8");
      const text = bytes > MAX_RESULT_BYTES ? clipBytes(joined, MAX_RESULT_BYTES) : joined;
      return { text, bytes };
    };

    const settle = ({ status, stopReason, error, output, outputBytes }) => {
      if (settlePromise) return settlePromise;
      finished = true;
      clearTimers();
      clearPendingWake();
      soloByChannel.delete(channelId);
      try {
        unwatch();
      } catch {}
      const out = output !== undefined ? { text: output, bytes: outputBytes } : combinedOutput();
      settlePromise = finishTask(pubkey, state, task, {
        status,
        stopReason,
        error,
        output: out.text,
        outputBytes: out.bytes,
      });
      return settlePromise;
    };

    const isPromptEvent = (ev) =>
      Array.isArray(ev?.tags) &&
      ev.tags.some((t) => Array.isArray(t) && t.length >= 2 && t[0] === "t" && t[1] === "buzz.orch.prompt");

    const recordWorkerMessage = (ev) => {
      if (finished || !ev || !ev.id) return;
      if (isPromptEvent(ev)) return;
      if (seenMessageIds.has(ev.id)) return;
      seenMessageIds.add(ev.id);
      const content = String(ev.content ?? "");
      turnMessages.push({ id: ev.id, content, createdAt: ev.created_at || 0 });
      task.replyEventId = ev.id;
      task.link = buzzMessageLink(channelId, ev.id);
      const now = Date.now();
      task.latestStep = { kind: "message", title: snippet(content), at: now };
      task.updatedAt = now;
      appendTranscript(task, "message", content);
      persistSoon(pubkey, state);
    };

    const postVisiblePrompt = async (promptText) => {
      turnStartedSec = Math.floor(Date.now() / 1000);
      turnMessages = [];
      const sent = await relay.postMessage({
        pubkey,
        channelId,
        content: promptText,
        extraTags: [["t", "buzz.orch.prompt"]],
      });
      if (sent?.eventId) {
        seenMessageIds.add(sent.eventId);
        if (!task.promptEventId) {
          task.promptEventId = sent.eventId;
          task.link = buzzMessageLink(channelId, sent.eventId);
        }
      }
      appendTranscript(task, "user", promptText);
      task.updatedAt = Date.now();
      void persistNow(pubkey, state);
      return sent;
    };

    const postFollowUp = async (promptText) => {
      const sent = await postVisiblePrompt(promptText);
      if (finished || cancelling || timedOut) return sent;
      await dropWake(promptText, true);
      if (!finished && !cancelling && !timedOut) resetTurnTimer();
      return sent;
    };

    const driver = {
      channelId,
      orchestratorPubkey: pubkey,
      workerPubkey: worker.pubkey,
      task,

      onTurnStart({ model, effort } = {}) {
        if (finished) return;
        pendingWakePath = "";
        const now = Date.now();
        if (task.status === "starting") {
          task.status = "running";
          task.startedAt = now;
        }
        if (model && !task.model) task.model = String(model);
        if (effort && !task.effort) task.effort = String(effort);
        task.updatedAt = now;
        persistSoon(pubkey, state);
      },

      async onTurnDone({ stopReason = "", error = "", model = "", effort = "", finalText = "", fallbackPosted = false } = {}) {
        if (finished || closed) return;
        pendingWakePath = "";
        if (turnTimer) {
          clearTimeout(turnTimer);
          turnTimer = null;
        }
        if (model && !task.model) task.model = String(model);
        if (effort && !task.effort) task.effort = String(effort);
        if (stopReason) task.stopReason = String(stopReason);

        if (error) {
          if (isAuthError(error)) await recordRuntimeFailure(task.runtime, error);
          await settle({ status: "failed", stopReason: task.stopReason || "", error });
          return;
        }
        if (timedOut) {
          await settle({
            status: "timed_out",
            stopReason: task.stopReason || "cancelled",
            error: `Worker timed out after ${taskTimeouts.get(task.taskId) ?? defaultTimeoutMs}ms`,
          });
          return;
        }
        if (cancelling || stopReason === "cancelled") {
          await settle({ status: "cancelled", stopReason: "cancelled" });
          return;
        }

        // Pull any reply messages from the relay if WebSocket watch hasn't delivered them yet.
        if (turnMessages.length === 0) {
          const fetchReply = async () => {
            try {
              const msgs = await relay.getMessages({
                pubkey,
                channelId,
                authorPubkey: worker.pubkey,
                since: Math.max(0, turnStartedSec - 2),
              });
              for (const m of msgs) {
                if ((m.created_at || 0) >= turnStartedSec - 2) recordWorkerMessage(m);
              }
            } catch {}
          };
          await fetchReply();
          if (finished || closed) return;
          if (timedOut) {
            await settle({
              status: "timed_out",
              stopReason: task.stopReason || "cancelled",
              error: `Worker timed out after ${taskTimeouts.get(task.taskId) ?? defaultTimeoutMs}ms`,
            });
            return;
          }
          if (cancelling) {
            await settle({ status: "cancelled", stopReason: "cancelled" });
            return;
          }
          if (turnMessages.length === 0 && fallbackPosted) {
            await sleep(150);
            if (finished || closed) return;
            if (timedOut || cancelling) {
              await settle({
                status: timedOut ? "timed_out" : "cancelled",
                stopReason: "cancelled",
                ...(timedOut ? { error: `Worker timed out after ${taskTimeouts.get(task.taskId) ?? defaultTimeoutMs}ms` } : {}),
              });
              return;
            }
            await fetchReply();
          }
        }

        if (finished || closed) return;
        if (timedOut || cancelling) {
          await settle({
            status: timedOut ? "timed_out" : "cancelled",
            stopReason: "cancelled",
            ...(timedOut ? { error: `Worker timed out after ${taskTimeouts.get(task.taskId) ?? defaultTimeoutMs}ms` } : {}),
          });
          return;
        }

        const turnText =
          turnMessages.length > 0
            ? turnMessages.map((m) => m.content).filter(Boolean).join("\n\n")
            : String(finalText || "").trim();

        const refusal = runtimeRefusal(turnText);
        if (refusal) {
          await settle({
            status: "failed",
            stopReason: task.stopReason || "end_turn",
            error: refusal,
            output: turnText,
            outputBytes: Buffer.byteLength(turnText, "utf8"),
          });
          return;
        }

        if (turnText) allOutputs.push(turnText);
        turnMessages = [];

        // If follow-up steer prompts are queued, post + wake the next one in the same Solo chat.
        if (promptQueue.length > 0) {
          const nextPrompt = promptQueue.shift();
          task.steerQueued = promptQueue.length;
          try {
            await postFollowUp(nextPrompt);
            if (timedOut || cancelling) {
              await settle({
                status: timedOut ? "timed_out" : "cancelled",
                stopReason: "cancelled",
                ...(timedOut ? { error: `Worker timed out after ${taskTimeouts.get(task.taskId) ?? defaultTimeoutMs}ms` } : {}),
              });
            }
          } catch (err) {
            await settle({ status: "failed", error: `Failed to post follow-up prompt: ${err.message ?? err}` });
          }
          return;
        }

        await clearRuntimeFailure(task.runtime);
        const finalOut = combinedOutput();
        await settle({
          status: "completed",
          stopReason: task.stopReason || "end_turn",
          output: finalOut.text,
          outputBytes: finalOut.bytes,
        });
      },

      steer(nextPrompt) {
        if (finished || cancelling) throw new Error("Cannot steer a task that is ending or finished.");
        if (promptQueue.length >= maxSteers) {
          throw new Error(`Steer queue is full (max ${maxSteers} follow-ups per task).`);
        }
        promptQueue.push(nextPrompt);
        task.steerQueued = promptQueue.length;
        task.updatedAt = Date.now();
        void persistNow(pubkey, state);
      },

      async cancel() {
        if (settlePromise) return settlePromise;
        if (finished) return;
        cancelling = true;
        promptQueue.length = 0;
        task.steerQueued = 0;
        clearPendingWake();
        appendTranscript(task, "status", "Cancellation requested.");
        void cancelWorker(worker.pubkey, channelId).catch(() => {});
        await new Promise((resolve) => {
          if (settlePromise) return void settlePromise.then(resolve);
          if (finished) return resolve();
          const done = () => {
            clearTimeout(grace);
            resolve();
          };
          let set = waiters.get(task.taskId);
          if (!set) waiters.set(task.taskId, (set = new Set()));
          set.add(done);
          const grace = setTimeout(() => {
            set.delete(done);
            if (set.size === 0) waiters.delete(task.taskId);
            void settle({ status: "cancelled", stopReason: "cancelled" }).then(resolve);
          }, cancelGraceMs);
          grace.unref?.();
        });
      },

      async failWorkerRemoved() {
        await settle({ status: "failed", error: "Worker agent was removed." });
      },

      async forceClose() {
        finished = true;
        cancelling = true;
        clearTimers();
        clearPendingWake();
        soloByChannel.delete(channelId);
        try {
          unwatch();
        } catch {}
      },
    };

    drivers.set(task.taskId, driver);
    soloByChannel.set(channelId, driver);

    try {
      // 3. Post the visible task prompt in the Solo chat (no p-tag, so buzz-acp
      //    does not double-trigger) and record its eventId in seenMessageIds
      //    before watching — critical when worker === self.
      const brief = composeWorkerBrief({
        prompt: task.prompt,
        context: task.context,
        parentLink: buzzMessageLink(task.channelId, task.originEventId),
      });
      await postVisiblePrompt(brief);

      if (isAbortedBeforeStart()) {
        startingCancelled.delete(task.taskId);
        await settle({ status: "cancelled", stopReason: "cancelled" });
        return;
      }

      // 4. Watch the Solo chat for worker replies BEFORE writing the wake file.
      unwatch = await relay.watchChannel({
        pubkey,
        channelId,
        authorPubkey: worker.pubkey,
        onMessage: recordWorkerMessage,
      });

      if (isAbortedBeforeStart()) {
        startingCancelled.delete(task.taskId);
        await settle({ status: "cancelled", stopReason: "cancelled" });
        return;
      }

      // 5. Trigger the worker turn via its operator wake directory ($BUZZ_ACP_WAKE_DIR).
      await dropWake(brief, false);
      if (!finished && !cancelling && !timedOut) resetTurnTimer();
    } catch (error) {
      soloByChannel.delete(channelId);
      drivers.delete(task.taskId);
      clearTimers();
      clearPendingWake();
      try {
        unwatch();
      } catch {}
      throw error;
    }
  }

  async function startRemoteWorker(pubkey, orchMeta, link, worker, state, task) {
    const owner = String(orchMeta.owner ?? "").toLowerCase();
    const channelId = task.workerChannelId || randomUUID();
    const chatTitle = soloChatName(task.label, task.runtime);
    const ref = task.remoteRef;
    const failKey = runtimeFailKey(task.runtime, link.machineId);
    const isAbortedBeforeStart = () =>
      closed || forgetting.has(pubkey) || startingCancelled.has(task.taskId) || TERMINAL_STATUSES.has(task.status);

    // 1. Create the private ephemeral Buzz Solo chat (only once per task, so retries
    //    after MAX_CONCURRENCY never create duplicate Solo chats).
    const alreadyCreatedChat = Boolean(task.workerChannelId);
    if (!alreadyCreatedChat) {
      await relay.createSoloChat({
        pubkey,
        ownerPubkey: owner,
        workerPubkey: worker.pubkey,
        channelId,
        name: chatTitle,
        ttlSeconds: soloTtlSecs,
      });

      if (isAbortedBeforeStart()) {
        startingCancelled.delete(task.taskId);
        await finishTask(pubkey, state, task, { status: "cancelled", stopReason: "cancelled" });
        return { requeued: false };
      }

      task.mode = "solo";
      task.workerPubkey = worker.pubkey;
      task.workerName = worker.name;
      task.workerChannelId = channelId;
      task.status = "starting";
      task.updatedAt = Date.now();
      appendTranscript(task, "status", `Opened Solo chat "${chatTitle}" with ${worker.name} on ${link.name}.`);
    }

    const promptQueue = [];
    const seenMessageIds = new Set();
    if (task.promptEventId) seenMessageIds.add(task.promptEventId);
    let turnTimer = null;
    let cancelTimer = null;
    let cancelling = false;
    let timedOut = false;
    let finished = false;
    let settlePromise = null;
    let turnStartedSec = Math.floor(Date.now() / 1000);
    let turnMessages = [];
    let allOutputs = [];
    let unwatch = () => {};
    let followSeq = 0;

    const clearTimers = () => {
      if (turnTimer) {
        clearTimeout(turnTimer);
        turnTimer = null;
      }
      if (cancelTimer) {
        clearTimeout(cancelTimer);
        cancelTimer = null;
      }
    };

    const resetTurnTimer = () => {
      if (turnTimer) clearTimeout(turnTimer);
      const budget = taskTimeouts.get(task.taskId) ?? defaultTimeoutMs;
      turnTimer = setTimeout(() => {
        if (finished || closed) return;
        timedOut = true;
        cancelling = true;
        promptQueue.length = 0;
        task.steerQueued = 0;
        if (!links.isConnected(link.id)) {
          queuePendingRemoteOp(pendingRemoteCancels, link.id, ref);
          const msg = `${link.name} unreachable; ${link.name} stops the worker within 10 min`;
          appendTranscript(task, "status", `Timed out while ${link.name} was unreachable.`);
          void settle({ status: "timed_out", stopReason: task.stopReason || "cancelled", error: msg });
          return;
        }
        appendTranscript(task, "status", `Timed out after ${Math.round(budget / 1000)}s; stopping remote worker on ${link.name}.`);
        void links.call(link.id, "delegate.cancel", { ref }).catch(() => {
          queuePendingRemoteOp(pendingRemoteCancels, link.id, ref);
        });
        cancelTimer = setTimeout(() => {
          cancelTimer = null;
          void settle({
            status: "timed_out",
            stopReason: task.stopReason || "cancelled",
            error: `Worker timed out after ${budget}ms`,
          });
        }, cancelGraceMs);
        cancelTimer.unref?.();
      }, budget);
      turnTimer.unref?.();
    };

    const combinedOutput = (extraFallback = "") => {
      const chunks = [...allOutputs];
      if (turnMessages.length > 0) {
        chunks.push(turnMessages.map((m) => m.content).filter(Boolean).join("\n\n"));
      } else if (extraFallback) {
        chunks.push(extraFallback);
      }
      const joined = chunks.filter(Boolean).join("\n\n");
      const bytes = Buffer.byteLength(joined, "utf8");
      const text = bytes > MAX_RESULT_BYTES ? clipBytes(joined, MAX_RESULT_BYTES) : joined;
      return { text, bytes };
    };

    const settle = ({ status, stopReason, error, output, outputBytes, skipRelease = false }) => {
      if (settlePromise) return settlePromise;
      finished = true;
      clearTimers();
      remoteByRef.delete(ref);
      soloByChannel.delete(channelId);
      try {
        unwatch();
      } catch {}
      const out = output !== undefined ? { text: output, bytes: outputBytes } : combinedOutput();
      settlePromise = (async () => {
        if (!skipRelease) {
          await releaseRemoteRef(link.id, ref);
        } else {
          links.untrackRef(link.id, ref);
        }
        await finishTask(pubkey, state, task, {
          status,
          stopReason,
          error,
          output: out.text,
          outputBytes: out.bytes,
        });
      })();
      return settlePromise;
    };

    const isPromptEvent = (ev) =>
      Array.isArray(ev?.tags) &&
      ev.tags.some((t) => Array.isArray(t) && t.length >= 2 && t[0] === "t" && t[1] === "buzz.orch.prompt");

    const recordWorkerMessage = (ev) => {
      if (finished || !ev || !ev.id) return;
      if (isPromptEvent(ev)) return;
      if (seenMessageIds.has(ev.id)) return;
      seenMessageIds.add(ev.id);
      const content = String(ev.content ?? "");
      turnMessages.push({ id: ev.id, content, createdAt: ev.created_at || 0 });
      task.replyEventId = ev.id;
      task.link = buzzMessageLink(channelId, ev.id);
      const now = Date.now();
      task.latestStep = { kind: "message", title: snippet(content), at: now };
      task.updatedAt = now;
      appendTranscript(task, "message", content);
      persistSoon(pubkey, state);
    };

    const postVisiblePrompt = async (promptText) => {
      turnStartedSec = Math.floor(Date.now() / 1000);
      turnMessages = [];
      const sent = await relay.postMessage({
        pubkey,
        channelId,
        content: promptText,
        extraTags: [["t", "buzz.orch.prompt"]],
      });
      if (sent?.eventId) {
        seenMessageIds.add(sent.eventId);
        if (!task.promptEventId) {
          task.promptEventId = sent.eventId;
          task.link = buzzMessageLink(channelId, sent.eventId);
        }
      }
      appendTranscript(task, "user", promptText);
      task.updatedAt = Date.now();
      void persistNow(pubkey, state);
      return sent;
    };

    const driver = {
      channelId,
      orchestratorPubkey: pubkey,
      workerPubkey: worker.pubkey,
      linkId: link.id,
      remoteRef: ref,
      task,

      onTurnStart({ model, effort } = {}) {
        if (finished) return;
        const now = Date.now();
        if (task.status === "starting") {
          task.status = "running";
          task.startedAt = now;
        }
        if (model && !task.model) task.model = String(model);
        if (effort && !task.effort) task.effort = String(effort);
        task.updatedAt = now;
        persistSoon(pubkey, state);
      },

      async onTurnDone({ stopReason = "", error = "", model = "", effort = "", finalText = "", fallbackPosted = false } = {}) {
        if (finished || closed) return;
        if (turnTimer) {
          clearTimeout(turnTimer);
          turnTimer = null;
        }
        if (model && !task.model) task.model = String(model);
        if (effort && !task.effort) task.effort = String(effort);
        if (stopReason) task.stopReason = String(stopReason);

        if (error) {
          if (isAuthError(error)) await recordRuntimeFailure(failKey, error);
          await settle({ status: "failed", stopReason: task.stopReason || "", error });
          return;
        }
        if (timedOut) {
          await settle({
            status: "timed_out",
            stopReason: task.stopReason || "cancelled",
            error: `Worker timed out after ${taskTimeouts.get(task.taskId) ?? defaultTimeoutMs}ms`,
          });
          return;
        }
        if (cancelling || stopReason === "cancelled") {
          await settle({ status: "cancelled", stopReason: "cancelled" });
          return;
        }

        if (turnMessages.length === 0) {
          const fetchReply = async () => {
            try {
              const msgs = await relay.getMessages({
                pubkey,
                channelId,
                authorPubkey: worker.pubkey,
                since: Math.max(0, turnStartedSec - 2),
              });
              for (const m of msgs) {
                if ((m.created_at || 0) >= turnStartedSec - 2) recordWorkerMessage(m);
              }
            } catch {}
          };
          await fetchReply();
          if (finished || closed) return;
          if (turnMessages.length === 0 && fallbackPosted) {
            await sleep(150);
            if (finished || closed) return;
            await fetchReply();
          }
        }
        if (finished || closed) return;
        if (timedOut || cancelling) {
          await settle({
            status: timedOut ? "timed_out" : "cancelled",
            stopReason: "cancelled",
            ...(timedOut ? { error: `Worker timed out after ${taskTimeouts.get(task.taskId) ?? defaultTimeoutMs}ms` } : {}),
          });
          return;
        }

        const turnText =
          turnMessages.length > 0
            ? turnMessages.map((m) => m.content).filter(Boolean).join("\n\n")
            : String(finalText || "").trim();

        const refusal = runtimeRefusal(turnText);
        if (refusal) {
          await settle({
            status: "failed",
            stopReason: task.stopReason || "end_turn",
            error: refusal,
            output: turnText,
            outputBytes: Buffer.byteLength(turnText, "utf8"),
          });
          return;
        }

        if (turnText) allOutputs.push(turnText);
        turnMessages = [];

        if (promptQueue.length > 0) {
          const nextPrompt = promptQueue.shift();
          task.steerQueued = promptQueue.length;
          try {
            await postVisiblePrompt(nextPrompt);
            if (finished || cancelling || timedOut) return;
            await links.call(link.id, "delegate.followup", { ref, prompt: nextPrompt, seq: ++followSeq });
            if (!finished && !cancelling && !timedOut) resetTurnTimer();
          } catch (err) {
            await settle({ status: "failed", error: `Failed to send remote follow-up: ${err.message ?? err}` });
          }
          return;
        }

        await clearRuntimeFailure(failKey);
        const finalOut = combinedOutput();
        await settle({
          status: "completed",
          stopReason: task.stopReason || "end_turn",
          output: finalOut.text,
          outputBytes: finalOut.bytes,
        });
      },

      async onRemoteEnded({ reason = "ended", error = "" } = {}) {
        if (finished || closed) return;
        if (reason === "interrupted") {
          await settle({
            status: "interrupted",
            stopReason: "",
            error: error || `${link.name} restarted`,
            skipRelease: true,
          });
          return;
        }
        if (reason === "max_task_timeout") {
          await settle({
            status: "timed_out",
            stopReason: "cancelled",
            error: error || `${link.name} hit maxTaskMs ceiling`,
            skipRelease: true,
          });
          return;
        }
        await settle({
          status: "failed",
          stopReason: "",
          error: error || `Remote host ${link.name} ended task (${reason})`,
          skipRelease: true,
        });
      },

      onLinkDisconnect() {
        if (finished) return;
        appendTranscript(task, "status", `link to ${link.name} lost; reconnecting`);
        task.updatedAt = Date.now();
        persistSoon(pubkey, state);
      },

      steer(nextPrompt) {
        if (finished || cancelling) throw new Error("Cannot steer a task that is ending or finished.");
        if (promptQueue.length >= maxSteers) {
          throw new Error(`Steer queue is full (max ${maxSteers} follow-ups per task).`);
        }
        promptQueue.push(nextPrompt);
        task.steerQueued = promptQueue.length;
        task.updatedAt = Date.now();
        void persistNow(pubkey, state);
      },

      async cancel() {
        if (settlePromise) return settlePromise;
        if (finished) return;
        cancelling = true;
        promptQueue.length = 0;
        task.steerQueued = 0;
        appendTranscript(task, "status", "Cancellation requested.");
        if (links.isConnected(link.id)) {
          void links.call(link.id, "delegate.cancel", { ref }).catch(() => {
            queuePendingRemoteOp(pendingRemoteCancels, link.id, ref);
          });
        } else {
          queuePendingRemoteOp(pendingRemoteCancels, link.id, ref);
        }
        await new Promise((resolve) => {
          if (settlePromise) return void settlePromise.then(resolve);
          if (finished) return resolve();
          const done = () => {
            clearTimeout(grace);
            resolve();
          };
          let set = waiters.get(task.taskId);
          if (!set) waiters.set(task.taskId, (set = new Set()));
          set.add(done);
          const grace = setTimeout(() => {
            set.delete(done);
            if (set.size === 0) waiters.delete(task.taskId);
            void settle({ status: "cancelled", stopReason: "cancelled" }).then(resolve);
          }, cancelGraceMs);
          grace.unref?.();
        });
      },

      async forceClose() {
        finished = true;
        cancelling = true;
        clearTimers();
        remoteByRef.delete(ref);
        soloByChannel.delete(channelId);
        links.untrackRef(link.id, ref);
        try {
          unwatch();
        } catch {}
      },
    };

    drivers.set(task.taskId, driver);
    remoteByRef.set(ref, driver);
    soloByChannel.set(channelId, driver);

    try {
      const brief = composeWorkerBrief({
        prompt: task.prompt,
        context: task.context,
        parentLink: buzzMessageLink(task.channelId, task.originEventId),
      });
      if (!alreadyCreatedChat) {
        await postVisiblePrompt(brief);
        if (isAbortedBeforeStart()) {
          startingCancelled.delete(task.taskId);
          await settle({ status: "cancelled", stopReason: "cancelled", skipRelease: true });
          return { requeued: false };
        }
      }

      unwatch = await relay.watchChannel({
        pubkey,
        channelId,
        authorPubkey: worker.pubkey,
        onMessage: recordWorkerMessage,
      });

      if (isAbortedBeforeStart()) {
        startingCancelled.delete(task.taskId);
        await settle({ status: "cancelled", stopReason: "cancelled", skipRelease: true });
        return { requeued: false };
      }

      const auth = await createSignedStartAuth({
        pubkey,
        targetMachineId: link.machineId,
        ref,
        channelId,
        workerPubkey: worker.pubkey,
      });

      links.trackRef(link.id, ref, 0);
      const started = await links.call(link.id, "delegate.start", {
        ref,
        auth,
        workerPubkey: worker.pubkey,
        channelId,
        runtime: task.runtime,
        ...(task.model ? { model: task.model } : {}),
        ...(task.effort ? { effort: task.effort } : {}),
        ...(task.workspace ? { workspace: task.workspace } : {}),
        label: task.label,
        prompt: brief,
      });
      if (started?.workspace) {
        task.workspace = started.workspace;
        persistSoon(pubkey, state);
      }
      if (!finished && !cancelling && !timedOut) resetTurnTimer();
      return { requeued: false };
    } catch (error) {
      soloByChannel.delete(channelId);
      remoteByRef.delete(ref);
      drivers.delete(task.taskId);
      links.untrackRef(link.id, ref);
      clearTimers();
      try {
        unwatch();
      } catch {}
      if (/MAX_CONCURRENCY/i.test(String(error?.message ?? error))) {
        task.status = "queued";
        task.updatedAt = Date.now();
        appendTranscript(task, "status", `Queued waiting for a free slot on ${link.name}.`);
        await persistNow(pubkey, state);
        return { requeued: true };
      }
      throw error;
    }
  }

  async function finishTask(pubkey, state, task, { status, stopReason, error, output, outputBytes }) {
    if (TERMINAL_STATUSES.has(task.status)) return;
    drivers.delete(task.taskId);
    if (task.workerChannelId) soloByChannel.delete(task.workerChannelId);
    taskTimeouts.delete(task.taskId);
    const now = Date.now();
    if (!task.startedAt && task.status !== "queued") task.startedAt = task.createdAt || now;
    task.status = status;
    if (stopReason !== undefined) task.stopReason = stopReason;
    if (error) task.error = String(error);
    task.steerQueued = 0;
    task.endedAt = now;
    task.updatedAt = now;
    if (typeof output === "string" && (output.length > 0 || status === "completed")) {
      const bytes = Number.isFinite(outputBytes) ? outputBytes : Buffer.byteLength(output, "utf8");
      task.result = { text: output, bytes };
    }
    appendTranscript(
      task,
      "status",
      status === "completed"
        ? `Completed (${task.stopReason || "end_turn"}).`
        : error
          ? `${status}: ${error}`
          : `Ended (${status}).`,
    );
    await persistNow(pubkey, state);
    notifyWaiters(task.taskId, { closed: false });
    void pumpQueue(pubkey);
  }

  // ---------- internal acp-proxy lifecycle hooks ----------

  function handleProxyTurnEvent(rawWorkerPubkey, name, args = {}) {
    const workerPubkey = checkPubkey(rawWorkerPubkey);
    const channelId = typeof args.channel === "string" ? args.channel.trim() : "";
    if (!UUID_RE.test(channelId)) return JSON.stringify({ ok: false });
    const driver = soloByChannel.get(channelId);
    if (!driver || driver.workerPubkey !== workerPubkey) {
      return JSON.stringify({ ok: false });
    }
    if (name === "_acp_turn_start") {
      driver.onTurnStart(args);
      return JSON.stringify({ ok: true });
    }
    if (name === "_acp_turn_done") {
      void driver.onTurnDone(args);
      return JSON.stringify({ ok: true });
    }
    return JSON.stringify({ ok: false });
  }

  // ---------- tool implementations ----------

  async function capabilities(rawPubkey, { retry = false } = {}) {
    const pubkey = checkPubkey(rawPubkey);
    const orchMeta = await requireOptIn(pubkey);
    if (retry === true) await clearRuntimeFailure();
    const agents = await listEligibleAgents(pubkey, orchMeta);
    const defaultAgent = agents.find((a) => a.self) || null;
    const state = await loadAgent(pubkey);
    const runtimes = await Promise.all(
      Object.entries(RUNTIMES).map(async ([id, info]) => {
        const shimPath = path.join(shimsDir, info.shim);
        if (checkShimAccess) {
          const ok = await fs.access(shimPath, fs.constants.X_OK).then(() => true, () => false);
          if (!ok) {
            return { id, title: info.title, available: false, reason: "shim not installed", models: null, current: "" };
          }
        }
        const fail = await activeAuthFailure(id);
        if (fail) {
          return { id, title: info.title, available: false, reason: fail.reason, models: null, current: "" };
        }
        let models = null;
        let current = "";
        if (typeof catalog === "function") {
          const probePromise = Promise.resolve()
            .then(() => catalog(id))
            .catch(async (error) => {
              if (isAuthError(error)) await recordRuntimeFailure(id, error.message);
              return { __error: error };
            });
          let timer;
          const res = await Promise.race([
            probePromise,
            new Promise((resolve) => {
              timer = setTimeout(() => resolve(null), catalogBudgetMs);
              timer.unref?.();
            }),
          ]);
          if (timer) clearTimeout(timer);
          if (res?.__error) {
            if (isAuthError(res.__error)) {
              return {
                id,
                title: info.title,
                available: false,
                reason: String(res.__error.message ?? res.__error),
                models: null,
                current: "",
              };
            }
          } else if (res && typeof res === "object") {
            models = Array.isArray(res.models) ? res.models : null;
            current = String(res.current ?? "");
          }
        }
        return { id, title: info.title, available: true, reason: "", models, current };
      }),
    );
    const all = [...state.tasks.values()];
    const activeTasks = all
      .filter((t) => ACTIVE_STATUSES.has(t.status))
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const active = activeTasks.filter((t) => LIVE_STATUSES.has(t.status)).length;
    const queued = activeTasks.filter((t) => t.status === "queued").length;

    let hosts = [];
    if (links) {
      const { links: savedLinks } = await links.list();
      hosts = await Promise.all(
        savedLinks.map(async (link) => {
          const applyHostFailures = async (rawRuntimes) => {
            if (!Array.isArray(rawRuntimes)) return [];
            return Promise.all(
              rawRuntimes.map(async (rt) => {
                const fail = await activeAuthFailure(runtimeFailKey(rt.id, link.machineId));
                if (fail) {
                  return { ...rt, available: false, reason: fail.reason };
                }
                return rt;
              }),
            );
          };
          if (link.status === "revoked" || link.status === "expired" || link.status === "identity_mismatch") {
            const cached = link.lastCapabilities;
            return {
              host: link.name,
              machineId: link.machineId,
              linkId: link.id,
              online: false,
              lastSeenAt: link.lastSeenAt,
              limits: cached?.limits ?? null,
              agents: cached?.agents ?? [],
              runtimes: await applyHostFailures(cached?.runtimes),
              error: link.status,
            };
          }
          try {
            let timer;
            const res = await Promise.race([
              links.hello(link.id, { timeoutMs: catalogBudgetMs }),
              new Promise((_, reject) => {
                timer = setTimeout(() => reject(Object.assign(new Error("timeout"), { code: "TIMEOUT" })), catalogBudgetMs);
                timer.unref?.();
              }),
            ]).finally(() => {
              if (timer) clearTimeout(timer);
            });
            return {
              host: link.name,
              machineId: link.machineId,
              linkId: link.id,
              online: true,
              lastSeenAt: new Date().toISOString(),
              limits: res.limits ?? null,
              agents: Array.isArray(res.agents) ? res.agents : [],
              runtimes: await applyHostFailures(res.runtimes),
            };
          } catch (err) {
            const freshLink = (await links.resolveHost(link.id)) ?? link;
            const cached = freshLink.lastCapabilities;
            const errCode =
              err?.code === "TOKEN_REVOKED" || freshLink.status === "revoked"
                ? "revoked"
                : err?.code === "TOKEN_EXPIRED" || freshLink.status === "expired"
                  ? "expired"
                  : "unreachable";
            return {
              host: freshLink.name,
              machineId: freshLink.machineId,
              linkId: freshLink.id,
              online: false,
              lastSeenAt: freshLink.lastSeenAt,
              limits: cached?.limits ?? null,
              agents: cached?.agents ?? [],
              runtimes: await applyHostFailures(cached?.runtimes),
              error: errCode,
            };
          }
        }),
      );
    }

    return {
      mode: "solo",
      defaultAgent: defaultAgent
        ? {
            pubkey: defaultAgent.pubkey,
            name: defaultAgent.name,
            concurrency: defaultAgent.concurrency,
            runtime: defaultAgent.runtime,
          }
        : null,
      agents: agents.map((a) => ({
        pubkey: a.pubkey,
        name: a.name,
        concurrency: a.concurrency,
        runtime: a.runtime,
        self: a.self,
      })),
      runtimes,
      hosts,
      limit: maxLive,
      maxDepth: MAX_DEPTH,
      active,
      queued,
      tasks: activeTasks.map(toSummaryView),
    };
  }

  function resolveRemoteAgent(linkName, agents, specRaw) {
    const list = Array.isArray(agents) ? agents : [];
    const spec = typeof specRaw === "string" ? specRaw.trim() : "";
    if (!spec) {
      if (list.length === 1) return list[0];
      if (list.length === 0) throw new Error(`Host ${linkName} has no eligible agents for this delegate token.`);
      throw new Error(
        `Host ${linkName} has multiple eligible agents (${list.map((a) => a.name).join(", ")}); specify \`agent\`.`,
      );
    }
    const lower = spec.toLowerCase();
    if (HEX64.test(lower)) {
      const hit = list.find((a) => a.pubkey.toLowerCase() === lower);
      if (!hit) throw new Error(`Agent ${lower.slice(0, 8)} is not eligible on host ${linkName}.`);
      return hit;
    }
    const cleanName = lower.replace(/^@/, "");
    const matches = list.filter((a) => String(a.name || "").toLowerCase() === cleanName);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new Error(`Multiple eligible agents on ${linkName} are named "${spec}". Pass the agent's 64-hex pubkey.`);
    }
    throw new Error(
      `Unknown agent "${spec}" on host ${linkName}. Eligible agents: ${list.map((a) => a.name).join(", ") || "none"}.`,
    );
  }

  async function delegate(rawPubkey, args = {}) {
    const pubkey = checkPubkey(rawPubkey);
    const { meta: orchMeta, originEventId } = await requireOwnerChat(pubkey, args.chat);

    const runtime = String(args.runtime ?? "").trim();
    if (!Object.hasOwn(RUNTIMES, runtime)) {
      throw new Error(`Unknown runtime "${runtime}". Expected one of: ${Object.keys(RUNTIMES).join(", ")}.`);
    }
    const prompt = typeof args.prompt === "string" ? args.prompt : "";
    if (!prompt.trim()) throw new Error("prompt is required");
    const context = typeof args.context === "string" ? args.context.trim() : "";
    if (Buffer.byteLength(prompt, "utf8") + Buffer.byteLength(context, "utf8") > MAX_PROMPT_BYTES) {
      throw new Error("prompt + context exceed 60 KiB limit");
    }

    const hostSpec = typeof args.host === "string" ? args.host.trim() : "";
    const isRemote = Boolean(hostSpec) && hostSpec.toLowerCase() !== "local";

    if (isRemote) {
      if (!links) throw new Error("Cross-machine delegation is not configured on this host.");
      const link = await links.resolveHost(hostSpec);
      if (!link) {
        const { links: allLinks } = await links.list();
        const names = allLinks.map((l) => l.name).join(", ") || "none";
        throw new Error(`Unknown host "${hostSpec}". Paired hosts: ${names}.`);
      }
      if (link.status === "revoked" || link.status === "expired") {
        throw new Error(`Host ${link.name} delegate token is ${link.status}; pair again.`);
      }
      if (link.status === "identity_mismatch") {
        throw new Error(`${link.name}'s identity changed; pair again.`);
      }

      const fail = await activeAuthFailure(runtimeFailKey(runtime, link.machineId));
      if (fail) {
        throw new Error(
          `Runtime ${runtime} on ${link.name} is unavailable (${fail.reason}). Run orch_capabilities with retry:true to retry.`,
        );
      }

      // Fail fast when B is unreachable (do not queue remotely).
      const hello = await links.hello(link.id);
      const worker = resolveRemoteAgent(link.name, hello.agents, args.agent);
      const rtEntry = Array.isArray(hello.runtimes) ? hello.runtimes.find((r) => r.id === runtime) : null;
      if (!rtEntry) {
        throw new Error(`Runtime "${runtime}" is not permitted on host ${link.name}.`);
      }
      if (rtEntry.available === false) {
        throw new Error(`Runtime "${runtime}" is unavailable on host ${link.name}: ${rtEntry.reason || "unavailable"}`);
      }

      const state = await loadAgent(pubkey);
      const live = liveCount(state);
      if (live >= maxLive && state.queue.length >= maxQueue) {
        throw new Error(`Worker queue is full (${maxLive} active, ${maxQueue} queued).`);
      }

      const now = Date.now();
      const taskId = `task-${now.toString(36)}-${randomBytes(3).toString("hex")}`;
      const remoteRef = `${machineId || "local"}:${taskId}`;
      const chatInfo = parseChat(args.chat);
      const reqTimeout = Number(args.timeoutMs);
      const timeoutMs = Number.isFinite(reqTimeout)
        ? Math.min(Math.max(Math.round(reqTimeout), minTimeoutMs), maxTimeoutMs)
        : defaultTimeoutMs;
      const labelRaw = typeof args.label === "string" ? args.label.trim().slice(0, 120) : "";
      const remoteWs = typeof args.workspace === "string" ? args.workspace.trim() : "";

      const task = {
        taskId,
        mode: "solo",
        host: { machineId: link.machineId, name: link.name, linkId: link.id },
        remoteRef,
        agentPubkey: pubkey,
        workerPubkey: worker.pubkey,
        workerName: worker.name,
        workerChannelId: "",
        promptEventId: "",
        replyEventId: "",
        link: "",
        chat: chatInfo.chat,
        channelId: chatInfo.channelId,
        threadRootId: chatInfo.threadRootId,
        originEventId,
        runtime,
        model: typeof args.model === "string" ? args.model.trim() : "",
        effort: typeof args.effort === "string" ? args.effort.trim() : "",
        label: labelRaw || defaultLabel(prompt),
        prompt,
        context,
        workspace: remoteWs,
        status: "queued",
        createdAt: now,
        startedAt: 0,
        updatedAt: now,
        endedAt: 0,
        latestStep: null,
        stopReason: "",
        steerQueued: 0,
        error: "",
        result: null,
        transcript: [],
      };

      taskTimeouts.set(taskId, timeoutMs);
      state.tasks.set(taskId, task);
      state.order.push(taskId);
      const remoteAtCap =
        hello.limits && Number.isInteger(hello.limits.maxConcurrency) && hello.limits.live >= hello.limits.maxConcurrency;
      if (live < maxLive && !remoteAtCap) {
        task.status = "starting";
        try {
          const outcome = await startRemoteWorker(pubkey, orchMeta, link, worker, state, task);
          if (outcome?.requeued) {
            state.queue.push(taskId);
          }
        } catch (err) {
          startingCancelled.delete(taskId);
          await finishTask(pubkey, state, task, {
            status: "failed",
            error: String(err?.message ?? err),
          });
          throw err;
        }
      } else {
        state.queue.push(taskId);
        appendTranscript(
          task,
          "status",
          remoteAtCap
            ? `Queued waiting for a free slot on ${link.name}.`
            : "Queued waiting for an available worker slot.",
        );
        await persistNow(pubkey, state);
      }
      return toFullView(task, { includeTranscript: false });
    }

    const { worker, error: workerError } = await resolveTargetAgent(pubkey, orchMeta, args.agent);
    if (!worker) throw new Error(workerError);

    const fail = await activeAuthFailure(runtime);
    if (fail) {
      throw new Error(
        `Runtime ${runtime} is unavailable (${fail.reason}). Run orch_capabilities with retry:true to retry.`,
      );
    }
    if (checkShimAccess) {
      const shimPath = path.join(shimsDir, RUNTIMES[runtime].shim);
      const ok = await fs.access(shimPath, fs.constants.X_OK).then(() => true, () => false);
      if (!ok) throw new Error(`Runtime shim not installed: ${RUNTIMES[runtime].shim}`);
    }

    const explicitWorkspace = typeof args.workspace === "string" && args.workspace.trim().length > 0;
    const ws = expandWorkspace(explicitWorkspace ? args.workspace : args.cwd || "");
    if (!ws || !path.isAbsolute(ws)) throw new Error("workspace must be an absolute path");
    const stat = await fs.stat(ws).catch(() => null);
    if (!stat?.isDirectory()) throw new Error(`workspace directory does not exist: ${ws}`);

    const state = await loadAgent(pubkey);
    const live = liveCount(state);
    if (live >= maxLive && state.queue.length >= maxQueue) {
      throw new Error(`Worker queue is full (${maxLive} active, ${maxQueue} queued).`);
    }

    const now = Date.now();
    const taskId = `task-${now.toString(36)}-${randomBytes(3).toString("hex")}`;
    const chatInfo = parseChat(args.chat);
    const reqTimeout = Number(args.timeoutMs);
    const timeoutMs = Number.isFinite(reqTimeout)
      ? Math.min(Math.max(Math.round(reqTimeout), minTimeoutMs), maxTimeoutMs)
      : defaultTimeoutMs;
    const labelRaw = typeof args.label === "string" ? args.label.trim().slice(0, 120) : "";

    const task = {
      taskId,
      mode: "solo",
      host: null,
      remoteRef: "",
      agentPubkey: pubkey,
      workerPubkey: worker.pubkey,
      workerName: worker.name,
      workerChannelId: "",
      promptEventId: "",
      replyEventId: "",
      link: "",
      chat: chatInfo.chat,
      channelId: chatInfo.channelId,
      threadRootId: chatInfo.threadRootId,
      originEventId,
      runtime,
      model: typeof args.model === "string" ? args.model.trim() : "",
      effort: typeof args.effort === "string" ? args.effort.trim() : "",
      label: labelRaw || defaultLabel(prompt),
      prompt,
      context,
      workspace: ws,
      status: "queued",
      createdAt: now,
      startedAt: 0,
      updatedAt: now,
      endedAt: 0,
      latestStep: null,
      stopReason: "",
      steerQueued: 0,
      error: "",
      result: null,
      transcript: [],
    };

    taskTimeouts.set(taskId, timeoutMs);
    state.tasks.set(taskId, task);
    state.order.push(taskId);
    if (live < maxLive) {
      // Reserve the live slot synchronously before any await so concurrent
      // orch_delegate calls cannot overshoot maxLive or race with cancel.
      task.status = "starting";
      try {
        await startSoloWorker(pubkey, orchMeta, worker, state, task);
      } catch (err) {
        startingCancelled.delete(taskId);
        await finishTask(pubkey, state, task, {
          status: "failed",
          error: String(err?.message ?? err),
        });
        throw err;
      }
    } else {
      state.queue.push(taskId);
      appendTranscript(task, "status", "Queued waiting for an available worker slot.");
      await persistNow(pubkey, state);
    }
    return toFullView(task, { includeTranscript: false });
  }

  async function wait(rawPubkey, { taskId, timeoutMs } = {}) {
    const pubkey = checkPubkey(rawPubkey);
    await requireOptIn(pubkey);
    if (typeof taskId !== "string" || !taskId) throw new Error("taskId is required");
    const state = await loadAgent(pubkey);
    const task = state.tasks.get(taskId);
    if (!task) throw new Error(`Unknown taskId: ${taskId}`);
    if (TERMINAL_STATUSES.has(task.status)) {
      return { task: toFullView(task, { includeTranscript: false }), timedOut: false };
    }
    if (closed) {
      return { task: toFullView(task, { includeTranscript: false }), timedOut: false, closed: true };
    }

    const budget = Number.isFinite(Number(timeoutMs))
      ? Math.min(Math.max(Math.round(Number(timeoutMs)), 100), MAX_WAIT_MS)
      : DEFAULT_WAIT_MS;

    const outcome = await new Promise((resolve) => {
      let set = waiters.get(taskId);
      if (!set) waiters.set(taskId, (set = new Set()));
      const onDone = (info = {}) => {
        clearTimeout(timer);
        resolve({ timedOut: false, closed: info.closed === true });
      };
      const timer = setTimeout(() => {
        set.delete(onDone);
        if (set.size === 0) waiters.delete(taskId);
        resolve({ timedOut: true, closed: false });
      }, budget);
      timer.unref?.();
      set.add(onDone);
    });
    return {
      task: toFullView(task, { includeTranscript: false }),
      timedOut: outcome.timedOut,
      ...(outcome.closed ? { closed: true } : {}),
    };
  }

  async function status(rawPubkey, { taskId } = {}) {
    const pubkey = checkPubkey(rawPubkey);
    await requireOptIn(pubkey);
    if (typeof taskId !== "string" || !taskId) throw new Error("taskId is required");
    const state = await loadAgent(pubkey);
    const task = state.tasks.get(taskId);
    if (!task) throw new Error(`Unknown taskId: ${taskId}`);
    return { task: toFullView(task, { includeTranscript: true }) };
  }

  async function list(rawPubkey, { chat, status: wantStatus, limit } = {}) {
    const pubkey = checkPubkey(rawPubkey);
    await requireOptIn(pubkey);
    const state = await loadAgent(pubkey);
    const max = Number.isFinite(Number(limit)) ? Math.min(Math.max(Math.round(Number(limit)), 1), MAX_TASKS_SAVED) : 50;
    let items = [...state.tasks.values()];
    if (typeof chat === "string" && chat.trim()) {
      const target = chat.trim();
      items = items.filter((t) => t.chat === target);
    }
    if (typeof wantStatus === "string" && wantStatus.trim()) {
      const st = wantStatus.trim();
      items = items.filter((t) => t.status === st);
    }
    items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return { tasks: items.slice(0, max).map(toSummaryView) };
  }

  async function steer(rawPubkey, { taskId, prompt, chat } = {}) {
    const pubkey = checkPubkey(rawPubkey);
    await requireOwnerChat(pubkey, chat);
    if (typeof taskId !== "string" || !taskId) throw new Error("taskId is required");
    if (typeof prompt !== "string" || !prompt.trim()) throw new Error("prompt is required");
    if (Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES) throw new Error("prompt exceeds 60 KiB limit");
    const state = await loadAgent(pubkey);
    const task = state.tasks.get(taskId);
    if (!task) throw new Error(`Unknown taskId: ${taskId}`);
    if (task.status === "queued") throw new Error("Cannot steer a queued task (worker Solo chat has not started yet).");
    if (TERMINAL_STATUSES.has(task.status)) throw new Error(`Cannot steer a ${task.status} task.`);
    const driver = drivers.get(taskId);
    if (!driver) throw new Error("Worker driver is not active.");
    driver.steer(prompt);
    return toFullView(task, { includeTranscript: false });
  }

  async function cancelInternal(pubkey, taskId) {
    if (typeof taskId !== "string" || !taskId) throw new Error("taskId is required");
    const state = await loadAgent(pubkey);
    const task = state.tasks.get(taskId);
    if (!task) throw new Error(`Unknown taskId: ${taskId}`);
    if (TERMINAL_STATUSES.has(task.status)) return toFullView(task, { includeTranscript: false });
    if (task.status === "queued") {
      const idx = state.queue.indexOf(taskId);
      if (idx >= 0) state.queue.splice(idx, 1);
      await finishTask(pubkey, state, task, { status: "cancelled", stopReason: "cancelled" });
      return toFullView(task, { includeTranscript: false });
    }
    const driver = drivers.get(taskId);
    if (driver) {
      await driver.cancel();
    } else {
      // Task is mid-setup inside startSoloWorker (before driver registration).
      startingCancelled.add(taskId);
      await finishTask(pubkey, state, task, { status: "cancelled", stopReason: "cancelled" });
    }
    return toFullView(task, { includeTranscript: false });
  }

  async function cancelTool(rawPubkey, { taskId, chat } = {}) {
    const pubkey = checkPubkey(rawPubkey);
    await requireOwnerChat(pubkey, chat);
    return cancelInternal(pubkey, taskId);
  }

  // ---------- host RPCs ----------

  async function tasks({ pubkey: rawPubkey, channelId, threadRootId, taskId, since, full = false } = {}) {
    const pubkey = checkPubkey(rawPubkey);
    const state = await loadAgent(pubkey);
    const format = full ? (t) => toFullView(t, { includeTranscript: true }) : toSummaryView;
    if (taskId) {
      const found = state.tasks.get(taskId);
      if (!found) return { tasks: [], task: null };
      const view = format(found);
      return { tasks: [view], task: view };
    }
    let items = [...state.tasks.values()];
    if (channelId) {
      const wantChat = threadRootId ? `${channelId}_${threadRootId}` : channelId;
      items = items.filter((t) => t.chat === wantChat);
    }
    const sinceNum = since != null ? Number(since) : NaN;
    if (Number.isFinite(sinceNum)) {
      items = items.filter((t) => (t.createdAt || 0) >= sinceNum);
    }
    items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return { tasks: items.map(format) };
  }

  async function cancel({ pubkey: rawPubkey, taskId } = {}) {
    const pubkey = checkPubkey(rawPubkey);
    const task = await cancelInternal(pubkey, taskId);
    return { task };
  }

  async function forget(rawPubkey) {
    const pubkey = checkPubkey(rawPubkey);
    forgetting.add(pubkey);
    try {
      // Fail any active tasks on other orchestrators whose worker target is this removed agent.
      const affected = [...soloByChannel.values()].filter(
        (d) => d.workerPubkey === pubkey && d.orchestratorPubkey !== pubkey,
      );
      await Promise.all(affected.map((d) => d.failWorkerRemoved?.().catch(() => {})));

      const timer = saveTimers.get(pubkey);
      if (timer) {
        clearTimeout(timer);
        saveTimers.delete(pubkey);
      }
      if (loaded.has(pubkey)) {
        const state = await loaded.get(pubkey).catch(() => null);
        if (state) {
          const queuedIds = state.queue.splice(0, state.queue.length);
          for (const tid of queuedIds) {
            const t = state.tasks.get(tid);
            if (t && t.status === "queued") {
              await finishTask(pubkey, state, t, { status: "cancelled", stopReason: "cancelled" });
            }
          }
          const liveIds = [...state.tasks.values()].filter((t) => LIVE_STATUSES.has(t.status)).map((t) => t.taskId);
          await Promise.all(
            liveIds.map(async (tid) => {
              const d = drivers.get(tid);
              if (d) await d.forceClose().catch(() => {});
              drivers.delete(tid);
              taskTimeouts.delete(tid);
              notifyWaiters(tid, { closed: true });
            }),
          );
        }
      }
      await (saveChains.get(pubkey) ?? Promise.resolve()).catch(() => {});
      loaded.delete(pubkey);
      saveChains.delete(pubkey);
      await fs.rm(agentFile(pubkey), { force: true }).catch(() => {});
    } finally {
      forgetting.delete(pubkey);
    }
  }

  async function close() {
    closed = true;
    for (const t of saveTimers.values()) clearTimeout(t);
    saveTimers.clear();
    const closingDrivers = [...drivers.values()];
    drivers.clear();
    soloByChannel.clear();
    await Promise.all(closingDrivers.map((d) => d.forceClose().catch(() => {})));
    for (const taskId of [...waiters.keys()]) {
      notifyWaiters(taskId, { closed: true });
    }
    await relay.close?.().catch(() => {});
    await Promise.all([...saveChains.values()].map((p) => p.catch(() => {})));
  }

  // ---------- peer link event handlers ----------

  function pumpAllLoaded() {
    for (const pk of loaded.keys()) {
      void pumpQueue(pk);
    }
  }

  function handleDelegateEvent(linkId, evt) {
    if (!evt || typeof evt.ref !== "string") return;
    const driver = remoteByRef.get(evt.ref);
    if (!driver || driver.linkId !== linkId) {
      if (evt.type === "turn_done" || evt.type === "ended") pumpAllLoaded();
      return;
    }
    if (evt.type === "turn_start") {
      driver.onTurnStart(evt);
    } else if (evt.type === "turn_done") {
      void driver.onTurnDone(evt).finally(() => pumpAllLoaded());
    } else if (evt.type === "ended") {
      void driver.onRemoteEnded(evt).finally(() => pumpAllLoaded());
    }
  }

  function handleLinkDisconnect(linkId) {
    for (const driver of remoteByRef.values()) {
      if (driver.linkId === linkId) driver.onLinkDisconnect?.();
    }
  }

  async function handleLinkReconnect(linkId) {
    if (!links) return;
    const cancels = pendingRemoteCancels.get(linkId);
    if (cancels) {
      pendingRemoteCancels.delete(linkId);
      for (const ref of cancels) {
        await links.call(linkId, "delegate.cancel", { ref }).catch(() => {
          queuePendingRemoteOp(pendingRemoteCancels, linkId, ref);
        });
      }
    }
    const releases = pendingRemoteReleases.get(linkId);
    if (releases) {
      pendingRemoteReleases.delete(linkId);
      for (const ref of releases) {
        await links.call(linkId, "delegate.release", { ref }).catch(() => {
          queuePendingRemoteOp(pendingRemoteReleases, linkId, ref);
        });
      }
    }
    pumpAllLoaded();
  }

  async function handleLinkRevoked(link, reason = "revoked") {
    const linkId = link?.id;
    if (!linkId) return;
    const msg = `Host ${link.name || linkId} delegate token ${reason}.`;
    for (const [pk, statePromise] of loaded) {
      const state = await statePromise.catch(() => null);
      if (!state) continue;
      for (const tid of [...state.queue]) {
        const t = state.tasks.get(tid);
        if (t && t.status === "queued" && t.host?.linkId === linkId) {
          const idx = state.queue.indexOf(tid);
          if (idx >= 0) state.queue.splice(idx, 1);
          await finishTask(pk, state, t, { status: "failed", error: msg });
        }
      }
    }
    for (const driver of [...remoteByRef.values()]) {
      if (driver.linkId === linkId) {
        await driver.onRemoteEnded?.({ reason, error: msg });
      }
    }
  }

  return {
    handles: (name) => /^orch_/.test(String(name ?? "")) || name === "_acp_turn_start" || name === "_acp_turn_done",
    async call(rawPubkey, name, args = {}) {
      if (name === "_acp_turn_start" || name === "_acp_turn_done") {
        return handleProxyTurnEvent(rawPubkey, name, args);
      }
      const pubkey = checkPubkey(rawPubkey);
      const table = {
        orch_capabilities: () => capabilities(pubkey, args),
        orch_delegate: () => delegate(pubkey, args),
        orch_wait: () => wait(pubkey, args),
        orch_status: () => status(pubkey, args),
        orch_list: () => list(pubkey, args),
        orch_steer: () => steer(pubkey, args),
        orch_cancel: () => cancelTool(pubkey, args),
      };
      if (!Object.hasOwn(table, name)) throw new Error(`No tool ${name}`);
      return JSON.stringify(await table[name]());
    },
    handleDelegateEvent,
    handleLinkDisconnect,
    handleLinkReconnect,
    handleLinkRevoked,
    capabilities,
    tasks,
    cancel,
    forget,
    close,
  };
}
