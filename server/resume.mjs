// buzz-host limit resume: agents resume on their own after a turn stops
// because of a rate or usage limit on their runtime.
//
// acp-proxy detects limit stops on chat turns and reports them here as
// `_acp_limit_stop` (structured `errorKind: "rate_limit"` from the adapter,
// or a limit's tell-tale text in the turn's error), and reports every turn
// that ends without one as `_acp_limit_clear`. Attention passes failed wake
// results here through `onWakeResult`. This module schedules one resume wake
// per chat (or per wake) at the limit's reset time — or on a backoff when
// the reset time is not known — and drops it into the agent's wake dir, the
// same request contract buzz-acp's Attention wakes use (patch 0004): the
// turn runs in the chat's own session, after any turn already running there.
//
// A pending resume is dropped when any later turn in the chat ends normally
// (the owner moved on, or the resume itself worked), and a resume that stops
// with the same limit again is retried, up to MAX_ATTEMPTS consecutive
// stops, so a still-capped account cannot loop forever. Opt out per agent
// with `"limitResume": false` in its meta.json.
//
// state: <agent dir>/resume.json. Prompts and ids follow buzz-acp's wake
// file contract (`{"id", "channel"?, "root"?, "prompt"}`).

import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

const TICK_MS = 5_000;
/** Extra wait after the reported reset time, to let the account actually run again. */
const RESET_BUFFER_MS = 5 * 60_000;
/** A resume never fires sooner than this after the stop, whatever the reset says. */
const MIN_GAP_MS = 60_000;
/** Backoff per consecutive attempt when no reset time is known. */
const BASE_BACKOFF_MS = 15 * 60_000;
const MAX_BACKOFF_MS = 2 * 3600_000;
/** Consecutive limit stops after which a chat's resume is given up on. */
const MAX_ATTEMPTS = 3;
/** Two reports of the same stop (proxy + wake result) arriving this close count once. */
const SAME_STOP_WINDOW_MS = 120_000;
/** A fired resume whose wake result never came back is abandoned after this long. */
const STALE_FIRED_MS = 6 * 3600_000;
const HEX64 = /^[0-9a-f]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_ERROR_CHARS = 500;
const MAX_PROMPT_CHARS = 8_000;
const now = () => Date.now();

/** The text a limit stop carries: runtime error messages, not tool output. */
const LIMIT_RE =
  /rate[-_ ]?limit|usage[-_ ]?limit|5-hour limit|too many requests|429|limit (?:has been )?exceeded|rate[_ ]?limited/i;
const LIMIT_STOP_REASONS = new Set(["rate_limit", "usage_limit"]);

/** Whether `text` reads like a rate/usage-limit stop. Exported for tests. */
export function isLimitText(text) {
  return typeof text === "string" && LIMIT_RE.test(text);
}

/** A turn's limit-stop signal: {matched, errorKind, resetsAt}. Exported for tests. */
export function limitStopOf({ error = "", errorKind = "", stopReason = "", resetsAt = "" } = {}) {
  if (errorKind === "rate_limit" || (stopReason && LIMIT_STOP_REASONS.has(stopReason))) {
    return { matched: true, errorKind: errorKind || stopReason, resetsAt: String(resetsAt || "") };
  }
  if (isLimitText(error)) return { matched: true, errorKind: errorKind || "limit", resetsAt: String(resetsAt || "") };
  return { matched: false, errorKind: "", resetsAt: "" };
}

function entryKey(channel, root) {
  if (channel && root) return `${channel}_${root}`;
  if (channel) return `${channel}_`;
  return `@${root || "heartbeat"}`;
}

function validScope(channel, root) {
  if (!channel && !root) return true; // independent wake retry
  return !!channel && UUID_RE.test(channel) && (root === "" || HEX64.test(root));
}

function resumePrompt(entry) {
  const error = (entry.lastError || "").slice(0, MAX_ERROR_CHARS);
  const reset = entry.resetsAt ? ` It was supposed to reset at ${entry.resetsAt}.` : "";
  if (entry.origin === "wake" && entry.prompt) {
    return [
      `Your previous turn, an Attention wake, was stopped by a rate or usage limit: "${error}".${reset} Retry what that wake asked:`,
      entry.prompt.slice(0, MAX_PROMPT_CHARS),
    ].join("\n\n");
  }
  return [
    "<buzz-limit-resume>",
    `Your previous turn in this chat was stopped by a rate or usage limit: "${error}".${reset}`,
    "The limit should have reset by now. Resume the work you were doing when it stopped, in this chat's own context, and report what you completed. If you had already finished, or your owner has moved on in this chat, post a short status instead of restarting anything.",
    "</buzz-limit-resume>",
  ].join("\n");
}

export function createLimitResume({ dataDir, runDir, log = console }) {
  const agentDir = (pubkey) => path.join(dataDir, pubkey);
  const stateFile = (pubkey) => path.join(agentDir(pubkey), "resume.json");
  const queues = new Map();
  let tickTimer;

  /** Serializes one agent's read-modify-write, as attention.mjs's mutate does. */
  function mutate(pubkey, change) {
    const previous = queues.get(pubkey) ?? Promise.resolve();
    const run = previous.then(async () => {
      const state = await loadState(pubkey);
      return change(state);
    });
    queues.set(pubkey, run.catch(() => {}));
    return run;
  }

  async function loadState(pubkey) {
    try {
      const saved = JSON.parse(await fs.readFile(stateFile(pubkey), "utf8"));
      return { pending: saved?.pending ?? {} };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return { pending: {} };
    }
  }

  async function saveState(pubkey, state) {
    const file = stateFile(pubkey);
    const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(state), { mode: 0o600 });
    await fs.rename(tmp, file);
  }

  async function optedOut(pubkey) {
    try {
      const meta = JSON.parse(await fs.readFile(path.join(agentDir(pubkey), "meta.json"), "utf8"));
      return meta?.limitResume === false;
    } catch (error) {
      if (error.code !== "ENOENT") log.warn(`limit-resume: ${pubkey.slice(0, 8)} meta: ${error.message}`);
      return false;
    }
  }

  /** Removes a pending entry; a fired-but-not-yet-started wake file is un-dropped. */
  async function removeEntry(pubkey, key, entry, why) {
    if (entry?.fired) {
      try {
        const dir = path.join(agentDir(pubkey), "wake");
        for (const name of await fs.readdir(dir).catch(() => []))
          if (name.endsWith(`-${entry.fired}.json`)) await fs.rm(path.join(dir, name), { force: true });
      } catch (error) {
        log.warn(`limit-resume: ${pubkey.slice(0, 8)} cancel wake ${entry.fired}: ${error.message}`);
      }
    }
    log.log(`limit-resume: ${pubkey.slice(0, 8)} ${key} ${why}`);
  }

  /** Resets the per-chat attempt chain: the chat moved on without a limit. */
  function clear(pubkey, channel, root) {
    return mutate(pubkey, async (state) => {
      const key = entryKey(channel, root);
      const entry = state.pending[key];
      if (!entry) return { ok: true, cleared: false };
      delete state.pending[key];
      await saveState(pubkey, state);
      await removeEntry(pubkey, key, entry, "cleared");
      return { ok: true, cleared: true };
    });
  }

  /**
   * Records a limit stop for a chat/wake. The same stop arriving through both
   * the proxy signal and the wake result is counted once (same error, within
   * SAME_STOP_WINDOW_MS). `after` carries a settled entry's stop count when the
   * caller already removed it. Returns the scheduled entry summary.
   */
  function schedule(pubkey, { channel, root, origin = "chat", prompt = "", wakeId = "", error = "", errorKind = "", resetsAt = "", runtime = "", after = 0 }) {
    return mutate(pubkey, async (state) => {
      if (!validScope(channel, root)) throw new Error(`Invalid chat scope ${channel || ""} ${root || ""}`);
      const key = origin === "wake" && !channel ? `wake:${wakeId || "?"}` : entryKey(channel, root);
      const entry = state.pending[key];
      const same = entry && error && entry.lastError === error && now() - entry.lastAt < SAME_STOP_WINDOW_MS;
      const prev = entry && !same ? entry.attempts : Math.max(after, 0);
      if (prev >= MAX_ATTEMPTS && (!entry || !same)) {
        if (entry) {
          delete state.pending[key];
          await saveState(pubkey, state);
          await removeEntry(pubkey, key, entry, `gave up after ${prev} stops`);
        }
        return { key, dropped: true };
      }
      const resets = typeof resetsAt === "string" ? Date.parse(resetsAt) : NaN;
      let nextAt;
      if (Number.isFinite(resets) && resets > now()) {
        nextAt = Math.max(now() + MIN_GAP_MS, resets + RESET_BUFFER_MS);
      } else {
        nextAt = now() + Math.max(MIN_GAP_MS, Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** prev));
      }
      if (same) {
        // The other report of this same stop already scheduled it.
        state.pending[key] = { ...entry, lastAt: now() };
        await saveState(pubkey, state);
        return { key, nextAt: entry.nextAt, attempts: entry.attempts };
      }
      state.pending[key] = {
        origin: entry?.origin === "wake" ? "wake" : origin,
        channel: channel || "",
        root: root || "",
        wakeId: entry?.wakeId || wakeId || "",
        prompt: entry?.prompt || prompt || "",
        attempts: prev + 1,
        nextAt,
        resetsAt: resetsAt || entry?.resetsAt || "",
        lastError: error || entry?.lastError || "",
        lastAt: now(),
        runtime: runtime || entry?.runtime || "",
        fired: "",
        firedAt: 0,
      };
      await saveState(pubkey, state);
      log.log(
        `limit-resume: ${pubkey.slice(0, 8)} ${key} scheduled (attempt ${state.pending[key].attempts}, ${errorKind || "limit"}, in ${Math.round((nextAt - now()) / 60_000)} min)`,
      );
      return { key, nextAt, attempts: state.pending[key].attempts };
    });
  }

  /** Drops the wake request for one due entry. */
  function fire(pubkey, key, entry) {
    return mutate(pubkey, async (state) => {
      const current = state.pending[key];
      if (!current || current.fired) return false;
      if (await optedOut(pubkey)) {
        delete state.pending[key];
        await saveState(pubkey, state);
        await removeEntry(pubkey, key, current, "dropped: agent opted out");
        return false;
      }
      const wakeDir = path.join(agentDir(pubkey), "wake");
      await fs.mkdir(path.join(wakeDir, "results"), { recursive: true, mode: 0o700 });
      const id = `res-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
      const request = {
        id,
        prompt: resumePrompt(current),
        ...(current.channel ? { channel: current.channel } : {}),
        ...(current.channel && current.root ? { root: current.root } : {}),
      };
      const tmp = path.join(wakeDir, `.${id}.tmp`);
      await fs.writeFile(tmp, JSON.stringify(request), { mode: 0o600 });
      await fs.rename(tmp, path.join(wakeDir, `${Date.now()}-${id}.json`));
      current.fired = id;
      current.firedAt = now();
      await saveState(pubkey, state);
      log.log(`limit-resume: ${pubkey.slice(0, 8)} ${key} → wake ${id} (${current.origin})`);
      return true;
    });
  }

  async function tick() {
    const names = await fs.readdir(dataDir).catch(() => []);
    for (const pubkey of names.filter((name) => HEX64.test(name))) {
      try {
        const state = await loadState(pubkey);
        for (const [key, entry] of Object.entries(state.pending)) {
          if (entry.fired) {
            if (now() - entry.firedAt > STALE_FIRED_MS) {
              await mutate(pubkey, async (next) => {
                delete next.pending[key];
                await saveState(pubkey, next);
              });
              log.log(`limit-resume: ${pubkey.slice(0, 8)} ${key} abandoned: wake result never came`);
            }
            continue;
          }
          if (entry.nextAt <= now()) await fire(pubkey, key, entry);
        }
      } catch (error) {
        log.warn(`limit-resume: ${pubkey.slice(0, 8)}: ${error.message}`);
      }
    }
  }

  /** The wake-side signal: a wake turn's recorded outcome (from attention). */
  async function onWakeResult(pubkey, wake, result) {
    const detail = String(result?.detail ?? "").slice(0, MAX_ERROR_CHARS);
    const limited = result?.outcome === "error" && isLimitText(detail);
    const wakeId = String(wake?.id ?? "");
    let fired;
    const settled = await mutate(pubkey, async (state) => {
      for (const [k, entry] of Object.entries(state.pending)) {
        if (entry.fired && entry.fired === wakeId) {
          fired = entry;
          delete state.pending[k];
          await saveState(pubkey, state);
          return true;
        }
      }
      return false;
    });
    if (settled) {
      // The fired resume wake's turn ended: settle its entry and, on another
      // limit stop, schedule the next attempt after its stop count.
      if (!limited) log.log(`limit-resume: ${pubkey.slice(0, 8)} ${wakeId} settled (${result.outcome})`);
      else {
        try {
          await schedule(pubkey, {
            channel: fired.channel || "",
            root: fired.root || "",
            origin: fired.origin || "chat",
            prompt: fired.prompt || "",
            wakeId: fired.wakeId || "",
            error: detail,
            after: fired.attempts ?? 0,
          });
        } catch (error) {
          log.warn(`limit-resume: resume retry for ${pubkey.slice(0, 8)}: ${error.message}`);
        }
      }
      return;
    }
    if (!limited) return;
    // One of our own resume wakes whose entry the proxy's signal already
    // handled (or gave up on): don't resurrect it. Only Attention's own
    // wakes (att-*) are retried here.
    if (wakeId.startsWith("res-")) return;
    try {
      await schedule(pubkey, {
        channel: wake.channel || "",
        root: wake.root || "",
        origin: "wake",
        prompt: wake.prompt || "",
        wakeId,
        error: detail,
      });
    } catch (error) {
      log.warn(`limit-resume: wake retry for ${pubkey.slice(0, 8)}: ${error.message}`);
    }
  }

  return {
    handles: (name) => name === "_acp_limit_stop" || name === "_acp_limit_clear",
    async call(pubkey, name, args = {}) {
      if (!HEX64.test(pubkey)) throw new Error("Invalid agent pubkey");
      if (name === "_acp_limit_clear") return clear(pubkey, args.channel, args.root);
      if (await optedOut(pubkey)) return { ok: true, skipped: "opted out" };
      const scheduled = await schedule(pubkey, {
        channel: typeof args.channel === "string" ? args.channel : "",
        root: typeof args.root === "string" ? args.root : "",
        origin: "chat",
        error: String(args.error ?? "").slice(0, MAX_ERROR_CHARS),
        errorKind: String(args.errorKind ?? ""),
        resetsAt: String(args.resetsAt ?? ""),
        runtime: String(args.runtime ?? ""),
      });
      return { ok: true, scheduled };
    },
    onWakeResult,
    start() {
      tickTimer = setInterval(() => void tick(), TICK_MS);
      tickTimer.unref?.();
      void tick();
    },
    stop() {
      clearInterval(tickTimer);
    },
    async state(pubkey) {
      return loadState(pubkey);
    },
    _test: { fire, schedule, clear, entryKey, resumePrompt, loadState, saveState },
  };
}
