// Orchestrator v1 — ephemeral ACP workers for an opted-in Omarchy agent.
//
// Contract: docs/orchestrator-contract.md.
// Spawns ephemeral ACP v1 worker sessions via shims/*, persists task records
// under ~/.local/share/buzz-host/orchestrator/, enforces guardrails (opt-in,
// owner-initiated chats, concurrency cap 4 + FIFO queue 16, per-prompt
// wall-clock timeout, MAX_DEPTH = 1 with scrubbed worker env & Hermes workspace
// isolation, process-group termination), and serves orch_* MCP tools + host RPCs.

import { spawn as nodeSpawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
const MAX_PROMPT_BYTES = 64 * 1024;
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
const DEFAULT_IDLE_DRAIN_MS = 200;
const MAX_IDLE_DRAIN_MS = 2_500;
const DEFAULT_CANCEL_GRACE_MS = 5_000;
const DEFAULT_AUTH_FAIL_TTL_MS = 15 * 60_000;
const DEFAULT_CATALOG_BUDGET_MS = 2_500;

const EFFORT_KEYS = new Set(["thought_level", "effort", "reasoning_effort", "reasoning", "thinking"]);
const LIVE_STATUSES = new Set(["starting", "running"]);
const ACTIVE_STATUSES = new Set(["queued", "starting", "running"]);
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "timed_out", "interrupted"]);
const HEX64 = /^[0-9a-f]{64}$/i;

const optId = (o) => o?.id ?? o?.configId ?? "";
const isModelOpt = (o) => o?.category === "model" || optId(o) === "model";
const isEffortOpt = (o) => EFFORT_KEYS.has(o?.category) || EFFORT_KEYS.has(optId(o));

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
  tool("orch_capabilities", "Runtimes, models and effort levels available to your workers, and the tasks running now.", {
    retry: { type: "boolean" },
  }),
  tool(
    "orch_delegate",
    "Start a worker on another runtime (claude, codex, hermes, antigravity). Use it when another harness fits the work better than yours, then orch_wait for the answer.",
    {
      runtime: str,
      prompt: str,
      model: str,
      effort: str,
      workspace: str,
      label: str,
      timeoutMs: { type: "number" },
    },
    ["runtime", "prompt"],
  ),
  tool("orch_wait", "Wait for a worker task to finish (up to 10 minutes).", {
    taskId: str,
    timeoutMs: { type: "number" },
  }, ["taskId"]),
  tool("orch_status", "One task with its latest step and transcript.", { taskId: str }, ["taskId"]),
  tool("orch_list", "Your recent tasks, newest first.", {
    chat: str,
    status: str,
    limit: { type: "number" },
  }),
  tool("orch_steer", "Queue a follow-up prompt on a running worker. It runs after the current turn.", {
    taskId: str,
    prompt: str,
  }, ["taskId", "prompt"]),
  tool("orch_cancel", "Stop a worker task.", { taskId: str }, ["taskId"]),
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
  const { prompt: _prompt, transcript: _transcript, ...rest } = task;
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

function buildWorkerEnv(baseEnv = process.env) {
  const env = {};
  for (const [k, v] of Object.entries(baseEnv)) {
    if (v === undefined) continue;
    if (/^BUZZ/i.test(k)) continue;
    if (k === "WAYLAND_DISPLAY") continue;
    env[k] = v;
  }
  return env;
}

function expandWorkspace(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return "";
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

async function isInsideAgentWorkspace(dirPath, agentWorkRoot) {
  const resolved = await fs.realpath(dirPath).catch(() => path.resolve(dirPath));
  const root = await fs.realpath(agentWorkRoot).catch(() => path.resolve(agentWorkRoot));
  const rel = path.relative(root, resolved);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return false;
  const firstSegment = rel.split(path.sep)[0];
  return HEX64.test(firstSegment);
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

function extractText(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (typeof content.text === "string") return content.text;
  if (Array.isArray(content)) return content.map(extractText).join("");
  if (content.content) return extractText(content.content);
  return "";
}

function choosePermissionOption(options) {
  if (!Array.isArray(options) || options.length === 0) return null;
  const allowOnce = options.find((o) => o?.kind === "allow_once" && o.optionId);
  if (allowOnce) return allowOnce.optionId;
  const allowAlways = options.find((o) => o?.kind === "allow_always" && o.optionId);
  if (allowAlways) return allowAlways.optionId;
  const first = options.find((o) => o?.optionId);
  return first ? first.optionId : null;
}

// ---------- factory ----------

/**
 * @param {object} options
 * @param {string} options.dataDir   agents dir (~/.local/share/buzz-host/agents)
 * @param {string} options.stateDir  orchestrator state (~/.local/share/buzz-host/orchestrator)
 * @param {string} [options.shimsDir] runtime shims (default sibling ./shims)
 * @param {(runtime: string) => Promise<object>} [options.catalog] cached models per runtime
 * @param {object} [options.log] console-like
 * @param {Function} [options.spawn] child_process.spawn-compatible (tests)
 * @param {object} [options.limits] test overrides
 */
export function createOrchestrator({
  dataDir,
  stateDir = path.join(os.homedir(), ".local/share/buzz-host/orchestrator"),
  shimsDir = path.join(HERE, "shims"),
  catalog,
  log = console,
  spawn = nodeSpawn,
  limits = {},
} = {}) {
  if (!dataDir) throw new Error("createOrchestrator: dataDir is required");

  const maxLive = limits.maxLive ?? MAX_LIVE;
  const maxQueue = limits.maxQueue ?? MAX_QUEUE;
  const maxSteers = limits.maxSteers ?? MAX_STEERS;
  const defaultTimeoutMs = limits.defaultTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
  const minTimeoutMs = limits.minTimeoutMs ?? MIN_TASK_TIMEOUT_MS;
  const maxTimeoutMs = limits.maxTimeoutMs ?? MAX_TASK_TIMEOUT_MS;
  const idleDrainMs = limits.idleDrainMs ?? DEFAULT_IDLE_DRAIN_MS;
  const maxIdleDrainMs = limits.maxIdleDrainMs ?? MAX_IDLE_DRAIN_MS;
  const cancelGraceMs = limits.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;
  const authFailTtlMs = limits.authFailTtlMs ?? DEFAULT_AUTH_FAIL_TTL_MS;
  const catalogBudgetMs = limits.catalogBudgetMs ?? DEFAULT_CATALOG_BUDGET_MS;
  const agentWorkRoot = limits.agentWorkRoot ?? path.join(os.homedir(), "buzz-agents");
  const checkShimAccess = limits.checkShimAccess ?? spawn === nodeSpawn;

  // Per-agent loaded state: pubkey -> Promise<{ tasks: Map<taskId, record>, order: string[], queue: string[] }>
  const loaded = new Map();
  // Serialized disk write chain per pubkey
  const saveChains = new Map();
  const saveTimers = new Map();
  // Per-task wall-clock timeout budgets (kept out of persisted task records)
  const taskTimeouts = new Map();
  // Live worker drivers: taskId -> driver handle
  const drivers = new Map();
  // Waiters for task completion: taskId -> Set<(outcome: { closed?: boolean }) => void>
  const waiters = new Map();
  // Agents currently being forgotten/removed (must not promote queued tasks)
  const forgetting = new Set();
  // Cached runtime auth failures
  const runtimesFile = path.join(stateDir, "runtimes.json");
  let runtimeFailures = null;
  let closed = false;

  const agentFile = (pubkey) => path.join(stateDir, `${pubkey}.json`);
  const agentMetaFile = (pubkey) => path.join(dataDir, pubkey, "meta.json");
  const turnAuthorsFile = (pubkey) => path.join(dataDir, pubkey, "turn-authors.json");

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
    await writePrivateAtomic(runtimesFile, map).catch((e) => log.error?.(`orchestrator: save runtimes.json failed: ${e.message}`));
  }

  async function clearRuntimeFailure(runtime) {
    const map = await loadRuntimeFailures();
    if (runtime) {
      if (!Object.hasOwn(map, runtime)) return;
      delete map[runtime];
    } else {
      for (const k of Object.keys(map)) delete map[k];
    }
    await writePrivateAtomic(runtimesFile, map).catch((e) => log.error?.(`orchestrator: save runtimes.json failed: ${e.message}`));
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

  async function loadAgent(pubkey) {
    if (loaded.has(pubkey)) return loaded.get(pubkey);
    const p = (async () => {
      const saved = await readJson(agentFile(pubkey), null);
      const tasks = new Map();
      const order = [];
      let dirty = false;
      const now = Date.now();
      for (const raw of Array.isArray(saved?.tasks) ? saved.tasks : []) {
        if (!raw || typeof raw.taskId !== "string") continue;
        const rec = {
          ...raw,
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
          dirty = true;
        }
        tasks.set(rec.taskId, rec);
        order.push(rec.taskId);
      }
      const state = { tasks, order, queue: [] };
      if (dirty) await persistNow(pubkey, state);
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

  async function requireOwnerChat(pubkey, chat) {
    const meta = await requireOptIn(pubkey);
    const owner = String(meta.owner ?? "").toLowerCase();
    if (!HEX64.test(owner)) throw new Error("Agent has no verified owner.");
    const key = typeof chat === "string" ? chat.trim() : "";
    if (!key) throw new Error("Orchestration is only allowed in owner-initiated chats (missing chat context).");
    const authors = await readJson(turnAuthorsFile(pubkey), {});
    const entry = authors && typeof authors === "object" ? authors[key] : null;
    if (!entry || typeof entry !== "object" || String(entry.author ?? "").toLowerCase() !== owner) {
      throw new Error("Orchestration is only allowed in owner-initiated chats.");
    }
    const originEventId = HEX64.test(String(entry.eventId ?? "")) ? String(entry.eventId).toLowerCase() : "";
    return { meta, originEventId };
  }

  // ---------- worker driver ----------

  function liveCount(state) {
    let n = 0;
    for (const t of state.tasks.values()) {
      if (LIVE_STATUSES.has(t.status)) n++;
    }
    return n;
  }

  async function pumpQueue(pubkey) {
    if (closed || forgetting.has(pubkey)) return;
    const state = await loadAgent(pubkey);
    while (state.queue.length > 0 && liveCount(state) < maxLive) {
      if (closed || forgetting.has(pubkey)) return;
      const nextId = state.queue.shift();
      const task = state.tasks.get(nextId);
      if (!task || task.status !== "queued") continue;
      startWorker(pubkey, state, task);
    }
  }

  function startWorker(pubkey, state, task) {
    task.status = "starting";
    task.updatedAt = Date.now();
    appendTranscript(task, "status", `Starting ${RUNTIMES[task.runtime]?.title ?? task.runtime} worker.`);
    void persistNow(pubkey, state);

    const shimPath = path.join(shimsDir, RUNTIMES[task.runtime].shim);
    const workerEnv = buildWorkerEnv(process.env);
    let child;
    try {
      child = spawn(shimPath, [], {
        cwd: task.workspace,
        env: workerEnv,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      void finishTask(pubkey, state, task, {
        status: "failed",
        error: `Failed to spawn worker: ${error.message ?? error}`,
      });
      return;
    }

    const pending = new Map();
    let nextRpcId = 0;
    let stdoutBuf = "";
    let stderrTail = "";
    let sessionId = "";
    let exited = null;
    let cancelling = false;
    let shuttingDown = false;
    let timedOut = false;
    let finished = false;
    let sigtermSent = false;
    let sigkillSent = false;
    let killTimer = null;
    let turnTimer = null;
    let hardTimer = null;
    let drainTimer = null;
    let drainMaxTimer = null;
    let resolveDrain = null;
    let activePromptId = null;
    let currentOutput = "";
    let currentOutputBytes = 0;
    const promptQueue = [task.prompt];
    let firstPrompt = true;
    let exitResolve = null;
    const exitDone = new Promise((resolve) => {
      exitResolve = resolve;
    });

    const signalTree = (sig) => {
      if (!child || child.exitCode !== null) return;
      if (typeof child.pid === "number" && child.pid > 0) {
        try {
          process.kill(-child.pid, sig);
          return;
        } catch {}
      }
      try {
        child.kill(sig);
      } catch {}
    };

    const killChild = (graceMs = cancelGraceMs) => {
      if (!child || child.exitCode !== null) return;
      try {
        child.stdin?.end();
      } catch {}
      if (!sigtermSent) {
        sigtermSent = true;
        signalTree("SIGTERM");
      }
      if (!sigkillSent) {
        if (killTimer) clearTimeout(killTimer);
        killTimer = setTimeout(() => {
          killTimer = null;
          if (child.exitCode === null && !sigkillSent) {
            sigkillSent = true;
            signalTree("SIGKILL");
          }
        }, Math.min(graceMs, 2_000));
        killTimer.unref?.();
      }
    };

    const clearAllTimers = () => {
      if (turnTimer) {
        clearTimeout(turnTimer);
        turnTimer = null;
      }
      if (hardTimer) {
        clearTimeout(hardTimer);
        hardTimer = null;
      }
      if (drainTimer) {
        clearTimeout(drainTimer);
        drainTimer = null;
      }
      if (drainMaxTimer) {
        clearTimeout(drainMaxTimer);
        drainMaxTimer = null;
      }
    };

    const clearTurnTimer = () => {
      if (turnTimer) {
        clearTimeout(turnTimer);
        turnTimer = null;
      }
    };

    const resetTurnTimer = () => {
      clearTurnTimer();
      const budget = taskTimeouts.get(task.taskId) ?? defaultTimeoutMs;
      turnTimer = setTimeout(() => {
        if (finished || shuttingDown) return;
        timedOut = true;
        cancelling = true;
        promptQueue.length = 0;
        task.steerQueued = 0;
        appendTranscript(task, "status", `Timed out after ${Math.round(budget / 1000)}s; cancelling worker.`);
        sendCancelNotification();
        hardTimer = setTimeout(() => {
          hardTimer = null;
          killChild(500);
          void finishTask(pubkey, state, task, {
            status: "timed_out",
            stopReason: task.stopReason || "cancelled",
            error: `Worker timed out after ${budget}ms`,
            output: currentOutput,
            outputBytes: currentOutputBytes,
          });
        }, cancelGraceMs);
        hardTimer.unref?.();
      }, budget);
      turnTimer.unref?.();
    };

    const sendLine = (obj) => {
      if (exited || !child.stdin || child.stdin.destroyed) return false;
      try {
        child.stdin.write(`${JSON.stringify(obj)}\n`);
        return true;
      } catch {
        return false;
      }
    };

    const sendCancelNotification = () => {
      if (!sessionId) return;
      sendLine({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
    };

    const rpc = (method, params, timeoutMs = 60_000) =>
      new Promise((resolve, reject) => {
        if (exited) return reject(exited);
        const id = ++nextRpcId;
        const timer =
          timeoutMs > 0
            ? setTimeout(() => {
                pending.delete(id);
                reject(new Error(`${method} timed out`));
              }, timeoutMs)
            : null;
        timer?.unref?.();
        pending.set(id, {
          resolve: (v) => {
            if (timer) clearTimeout(timer);
            resolve(v);
          },
          reject: (e) => {
            if (timer) clearTimeout(timer);
            reject(e);
          },
        });
        if (method === "session/prompt") activePromptId = id;
        if (!sendLine({ jsonrpc: "2.0", id, method, params })) {
          pending.delete(id);
          if (timer) clearTimeout(timer);
          reject(new Error("worker stdin closed"));
        }
      });

    const bumpDrain = () => {
      if (!resolveDrain) return;
      if (drainTimer) clearTimeout(drainTimer);
      drainTimer = setTimeout(() => {
        const done = resolveDrain;
        resolveDrain = null;
        if (drainMaxTimer) clearTimeout(drainMaxTimer);
        drainTimer = null;
        drainMaxTimer = null;
        done?.();
      }, idleDrainMs);
      drainTimer.unref?.();
    };

    const waitStreamIdle = () =>
      new Promise((resolve) => {
        if (exited || cancelling) return resolve();
        resolveDrain = resolve;
        bumpDrain();
        drainMaxTimer = setTimeout(() => {
          const done = resolveDrain;
          resolveDrain = null;
          if (drainTimer) clearTimeout(drainTimer);
          drainTimer = null;
          drainMaxTimer = null;
          done?.();
        }, maxIdleDrainMs);
        drainMaxTimer.unref?.();
      });

    const appendOutput = (text) => {
      const piece = String(text ?? "");
      if (!piece) return;
      const pieceBytes = Buffer.byteLength(piece, "utf8");
      currentOutputBytes += pieceBytes;
      const existingBytes = Buffer.byteLength(currentOutput, "utf8");
      if (existingBytes < MAX_RESULT_BYTES) {
        const remaining = MAX_RESULT_BYTES - existingBytes;
        currentOutput += pieceBytes <= remaining ? piece : clipBytes(piece, remaining);
      }
    };

    const handleUpdate = (params) => {
      const update = params?.update ?? params;
      if (!update || typeof update !== "object") return;
      const kind = update.sessionUpdate ?? update.type ?? "";
      const now = Date.now();
      if (kind === "agent_message_chunk") {
        const text = extractText(update.content ?? update.delta ?? update.text);
        if (text) {
          appendOutput(text);
          appendTranscript(task, "message", text, { coalesce: true });
          task.latestStep = { kind: "message", title: snippet(currentOutput.slice(-200)), at: now };
          task.updatedAt = now;
          persistSoon(pubkey, state);
        }
      } else if (kind === "agent_thought_chunk") {
        const text = extractText(update.content ?? update.delta ?? update.text);
        if (text) {
          appendTranscript(task, "thought", text, { coalesce: true });
          task.latestStep = { kind: "thought", title: snippet(text), at: now };
          task.updatedAt = now;
          persistSoon(pubkey, state);
        }
      } else if (kind === "tool_call" || kind === "tool_call_update") {
        const title = snippet(update.title || update.name || update.kind || update.toolCallId || "tool");
        const statusSuffix = update.status ? ` (${update.status})` : "";
        if (title) {
          appendTranscript(task, "tool", `${title}${statusSuffix}`);
          task.latestStep = { kind: "tool", title, at: now };
          task.updatedAt = now;
          persistSoon(pubkey, state);
        }
      }
      bumpDrain();
    };

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      stderrTail = (stderrTail + chunk).slice(-4096);
    });

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdoutBuf += chunk;
      let idx;
      while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, idx).trim();
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.method && msg.id !== undefined) {
          if (msg.method === "session/request_permission") {
            const optionId = choosePermissionOption(msg.params?.options);
            const outcome = optionId ? { outcome: "selected", optionId } : { outcome: "cancelled" };
            sendLine({ jsonrpc: "2.0", id: msg.id, result: { outcome } });
          } else {
            sendLine({
              jsonrpc: "2.0",
              id: msg.id,
              error: { code: -32601, message: "not supported" },
            });
          }
        } else if (msg.method === "session/update") {
          handleUpdate(msg.params);
        } else if (!msg.method && pending.has(msg.id)) {
          const w = pending.get(msg.id);
          pending.delete(msg.id);
          if (msg.id === activePromptId) activePromptId = null;
          if (msg.error) {
            const errMsg = msg.error.data?.details ?? msg.error.message ?? "ACP error";
            w.reject(Object.assign(new Error(errMsg), { code: msg.error.code }));
          } else {
            w.resolve(msg.result ?? {});
          }
        }
      }
    });

    const onProcessGone = (err) => {
      if (exited) return;
      exited = err;
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
      for (const [, w] of pending) w.reject(err);
      pending.clear();
      if (resolveDrain) {
        const done = resolveDrain;
        resolveDrain = null;
        if (drainTimer) clearTimeout(drainTimer);
        if (drainMaxTimer) clearTimeout(drainMaxTimer);
        drainTimer = null;
        drainMaxTimer = null;
        done();
      }
    };

    child.on("error", (err) => {
      onProcessGone(err);
      exitResolve?.();
    });
    child.on("exit", (code, signal) => {
      const detail = stderrTail.trim() ? `: ${stderrTail.trim().slice(-240)}` : "";
      onProcessGone(new Error(`worker exited (${signal ?? code ?? "unknown"})${detail}`));
      exitResolve?.();
    });

    const pendingSteerCount = () => (firstPrompt ? Math.max(0, promptQueue.length - 1) : promptQueue.length);

    const driver = {
      steer(nextPrompt) {
        if (finished || cancelling) throw new Error("Cannot steer a task that is ending or finished.");
        if (pendingSteerCount() >= maxSteers) {
          throw new Error(`Steer queue is full (max ${maxSteers} follow-ups per task).`);
        }
        promptQueue.push(nextPrompt);
        task.steerQueued = pendingSteerCount();
        task.updatedAt = Date.now();
        void persistNow(pubkey, state);
      },
      async cancel() {
        if (finished) return;
        cancelling = true;
        promptQueue.length = 0;
        task.steerQueued = 0;
        appendTranscript(task, "status", "Cancellation requested.");
        sendCancelNotification();
        await new Promise((resolve) => {
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
            killChild(500);
            void finishTask(pubkey, state, task, {
              status: "cancelled",
              stopReason: "cancelled",
              output: currentOutput,
              outputBytes: currentOutputBytes,
            }).then(resolve);
          }, cancelGraceMs);
          grace.unref?.();
        });
      },
      async forceClose() {
        shuttingDown = true;
        cancelling = true;
        clearAllTimers();
        killChild(200);
        await Promise.race([
          exitDone,
          new Promise((r) => {
            const t = setTimeout(r, 600);
            t.unref?.();
          }),
        ]);
      },
    };
    drivers.set(task.taskId, driver);

    // Run lifecycle asynchronously
    (async () => {
      try {
        await rpc("initialize", { protocolVersion: 1, clientCapabilities: {} }, 60_000);
        const session = await rpc("session/new", { cwd: task.workspace, mcpServers: [] }, 60_000);
        sessionId = session.sessionId || "";
        if (!sessionId) throw new Error("ACP adapter returned no sessionId");
        await clearRuntimeFailure(task.runtime);

        const opts = session.configOptions ?? [];
        const modelOpt = opts.find(isModelOpt);
        let activeEffortOpt = opts.find(isEffortOpt);

        if (task.model && modelOpt) {
          const updated = await rpc(
            "session/set_config_option",
            { sessionId, configId: optId(modelOpt) || "model", value: task.model },
            30_000,
          );
          const nextEffort = (updated.configOptions ?? []).find(isEffortOpt);
          if (nextEffort) activeEffortOpt = nextEffort;
          if (!task.effort && activeEffortOpt?.currentValue) task.effort = String(activeEffortOpt.currentValue);
        } else if (!task.model) {
          task.model = String(modelOpt?.currentValue ?? session.models?.currentModelId ?? "");
        }

        if (task.effort && activeEffortOpt) {
          await rpc(
            "session/set_config_option",
            { sessionId, configId: optId(activeEffortOpt) || "thought_level", value: task.effort },
            30_000,
          );
        } else if (!task.effort && activeEffortOpt?.currentValue) {
          task.effort = String(activeEffortOpt.currentValue);
        }

        if (shuttingDown || closed) return;
        if (cancelling) {
          await finishTask(pubkey, state, task, {
            status: timedOut ? "timed_out" : "cancelled",
            stopReason: "cancelled",
            error: timedOut ? `Worker timed out after ${taskTimeouts.get(task.taskId) ?? defaultTimeoutMs}ms` : "",
            output: currentOutput,
            outputBytes: currentOutputBytes,
          });
          return;
        }

        task.status = "running";
        task.startedAt = Date.now();
        task.updatedAt = task.startedAt;
        void persistNow(pubkey, state);

        while (promptQueue.length > 0 && !cancelling) {
          const text = promptQueue.shift();
          const wasFirst = firstPrompt;
          firstPrompt = false;
          task.steerQueued = promptQueue.length;
          if (!wasFirst && currentOutput && !currentOutput.endsWith("\n")) {
            appendOutput("\n");
          }
          appendTranscript(task, "user", text);
          task.updatedAt = Date.now();
          void persistNow(pubkey, state);

          resetTurnTimer();
          const res = await rpc(
            "session/prompt",
            { sessionId, prompt: [{ type: "text", text }] },
            0,
          );
          clearTurnTimer();
          await waitStreamIdle();
          task.stopReason = String(res?.stopReason ?? "");
          if (cancelling || task.stopReason === "cancelled") break;
        }

        if (shuttingDown || closed) return;
        if (timedOut) {
          await finishTask(pubkey, state, task, {
            status: "timed_out",
            stopReason: task.stopReason || "cancelled",
            error: `Worker timed out after ${taskTimeouts.get(task.taskId) ?? defaultTimeoutMs}ms`,
            output: currentOutput,
            outputBytes: currentOutputBytes,
          });
        } else if (cancelling || task.stopReason === "cancelled") {
          await finishTask(pubkey, state, task, {
            status: "cancelled",
            stopReason: "cancelled",
            output: currentOutput,
            outputBytes: currentOutputBytes,
          });
        } else if (runtimeRefusal(currentOutput)) {
          await finishTask(pubkey, state, task, {
            status: "failed",
            stopReason: task.stopReason || "end_turn",
            error: runtimeRefusal(currentOutput),
            output: currentOutput,
            outputBytes: currentOutputBytes,
          });
        } else {
          await finishTask(pubkey, state, task, {
            status: "completed",
            stopReason: task.stopReason || "end_turn",
            output: currentOutput,
            outputBytes: currentOutputBytes,
          });
        }
      } catch (error) {
        clearTurnTimer();
        if (shuttingDown || closed) return;
        if (timedOut) {
          await finishTask(pubkey, state, task, {
            status: "timed_out",
            stopReason: "cancelled",
            error: `Worker timed out after ${taskTimeouts.get(task.taskId) ?? defaultTimeoutMs}ms`,
            output: currentOutput,
            outputBytes: currentOutputBytes,
          });
        } else if (cancelling) {
          await finishTask(pubkey, state, task, {
            status: "cancelled",
            stopReason: "cancelled",
            output: currentOutput,
            outputBytes: currentOutputBytes,
          });
        } else {
          if (isAuthError(error)) await recordRuntimeFailure(task.runtime, error.message);
          await finishTask(pubkey, state, task, {
            status: "failed",
            error: String(error?.message ?? error),
            output: currentOutput,
            outputBytes: currentOutputBytes,
          });
        }
      } finally {
        clearAllTimers();
        finished = true;
        killChild(500);
      }
    })();
  }

  async function finishTask(pubkey, state, task, { status, stopReason, error, output, outputBytes }) {
    if (TERMINAL_STATUSES.has(task.status)) return;
    drivers.delete(task.taskId);
    taskTimeouts.delete(task.taskId);
    const now = Date.now();
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

  // ---------- tool implementations ----------

  async function capabilities(rawPubkey, { retry = false } = {}) {
    const pubkey = checkPubkey(rawPubkey);
    await requireOptIn(pubkey);
    if (retry === true) await clearRuntimeFailure();
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
              return { id, title: info.title, available: false, reason: String(res.__error.message ?? res.__error), models: null, current: "" };
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
    return {
      runtimes,
      limit: maxLive,
      maxDepth: MAX_DEPTH,
      active,
      queued,
      tasks: activeTasks.map(toSummaryView),
    };
  }

  async function delegate(rawPubkey, args = {}) {
    const pubkey = checkPubkey(rawPubkey);
    const { originEventId } = await requireOwnerChat(pubkey, args.chat);
    const runtime = String(args.runtime ?? "").trim();
    if (!Object.hasOwn(RUNTIMES, runtime)) {
      throw new Error(`Unknown runtime "${runtime}". Expected one of: ${Object.keys(RUNTIMES).join(", ")}.`);
    }
    const prompt = typeof args.prompt === "string" ? args.prompt : "";
    if (!prompt.trim()) throw new Error("prompt is required");
    if (Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES) {
      throw new Error("prompt exceeds 64 KiB limit");
    }
    const fail = await activeAuthFailure(runtime);
    if (fail) {
      throw new Error(`Runtime ${runtime} is unavailable (${fail.reason}). Run orch_capabilities with retry:true to retry.`);
    }
    if (checkShimAccess) {
      const shimPath = path.join(shimsDir, RUNTIMES[runtime].shim);
      const ok = await fs.access(shimPath, fs.constants.X_OK).then(() => true, () => false);
      if (!ok) throw new Error(`Runtime shim not installed: ${RUNTIMES[runtime].shim}`);
    }

    const explicitWorkspace = typeof args.workspace === "string" && args.workspace.trim().length > 0;
    let ws = expandWorkspace(explicitWorkspace ? args.workspace : args.cwd || "");
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

    // Hermes executes tools in a shared gateway whose buzz-host-session-env
    // plugin grants BUZZHOST_AGENT=<pubkey> whenever cwd is inside
    // ~/buzz-agents/<pubkey>. Isolate Hermes workers from agent workspaces so
    // they can never inherit a Buzz identity.
    if (runtime === "hermes" && (await isInsideAgentWorkspace(ws, agentWorkRoot))) {
      if (explicitWorkspace) {
        throw new Error(
          "Hermes workers cannot run inside an agent workspace (~/buzz-agents/<pubkey>) to preserve worker identity isolation; specify a project workspace.",
        );
      }
      ws = path.join(stateDir, "work", taskId);
      await fs.mkdir(ws, { recursive: true, mode: 0o700 });
    }

    const chatInfo = parseChat(args.chat);
    const reqTimeout = Number(args.timeoutMs);
    const timeoutMs = Number.isFinite(reqTimeout)
      ? Math.min(Math.max(Math.round(reqTimeout), minTimeoutMs), maxTimeoutMs)
      : defaultTimeoutMs;
    const labelRaw = typeof args.label === "string" ? args.label.trim().slice(0, 120) : "";

    const task = {
      taskId,
      agentPubkey: pubkey,
      chat: chatInfo.chat,
      channelId: chatInfo.channelId,
      threadRootId: chatInfo.threadRootId,
      originEventId,
      runtime,
      model: typeof args.model === "string" ? args.model.trim() : "",
      effort: typeof args.effort === "string" ? args.effort.trim() : "",
      label: labelRaw || defaultLabel(prompt),
      prompt,
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
      startWorker(pubkey, state, task);
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
    if (Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES) throw new Error("prompt exceeds 64 KiB limit");
    const state = await loadAgent(pubkey);
    const task = state.tasks.get(taskId);
    if (!task) throw new Error(`Unknown taskId: ${taskId}`);
    if (task.status === "queued") throw new Error("Cannot steer a queued task (worker session has not started yet).");
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
      const timer = saveTimers.get(pubkey);
      if (timer) {
        clearTimeout(timer);
        saveTimers.delete(pubkey);
      }
      if (loaded.has(pubkey)) {
        const state = await loaded.get(pubkey).catch(() => null);
        if (state) {
          // Clear queued tasks first so cancelling live ones never promotes them.
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
    await Promise.all(closingDrivers.map((d) => d.forceClose().catch(() => {})));
    for (const taskId of [...waiters.keys()]) {
      notifyWaiters(taskId, { closed: true });
    }
    await Promise.all([...saveChains.values()].map((p) => p.catch(() => {})));
  }

  return {
    handles: (name) => /^orch_/.test(String(name ?? "")),
    async call(rawPubkey, name, args = {}) {
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
    capabilities,
    tasks,
    cancel,
    forget,
    close,
  };
}
