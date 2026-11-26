// buzz-host Attention: Buzz's Attention (Interests, event watches, timers) for
// remote agents, so they act on their own while the owner's laptop is closed.
//
// The format, validation, object contract, tools, wake prompts and catch-up
// windows are Buzz's own code (attention-core.mjs, bundled from buzz-app).
// This module is the runtime around it, following Buzz's runner:
//
//   - storage: <agent dir>/attention.json: an AgentRecord ({attention, timers,
//     attentionEnabled, ...}), the event watches' catch-up checkpoints, the
//     wakes in flight and recent wake history;
//   - tools: the agent's attention tools, served on $RUN_DIR/attention.sock to
//     buzz-mcp.mjs (one MCP server per agent session);
//   - timers: Buzz's schedule (occurrence k due at armed_at + k × interval, one
//     overdue run, next due an interval after it ran), the longest-waiting first;
//   - event watches: live events from the relay watcher (watchEvent), and
//     catch-up of what they missed while buzz-host or its connection was down:
//     one checkpoint per watch and channel, read on every (re)connect up to
//     it, delivered oldest first in batches. Streams the live connection does
//     not cover (public channels the agent has not joined) are polled;
//   - queue: watch work waits in the agent's queue (32 jobs, 8 per Interest),
//     one wake at a time per Interest, at most 8 Interests at once, at most 60
//     admitted per minute; live work past that is dropped and recorded;
//   - wakes: a JSON file in <agent dir>/wake for the patched buzz-acp, whose
//     outcome comes back in wake/results/<id>.json. A spent timer is removed
//     once its last wake succeeds, unless it changed meanwhile;
//   - attention-note.txt: Buzz's end-of-turn review note, which acp-proxy adds
//     to each of the agent's turns.
//
// As in Buzz: a batch's checkpoint is saved before the batch is delivered (a
// crash can lose it, never deliver it twice); while Attention is off, an
// Interest is paused or a watch is off, its checkpoints move to now, so turning
// it back on replays nothing; queued work is kept in memory only.
// Not yet: classifiers (reported unavailable, events pass unchecked) and source
// watches (saved, never run).

import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import * as core from "./attention-core.mjs";

const TICK_MS = 5_000;
const HISTORY_LIMIT = 100;
/** A wake whose file was taken but has no result after this long is lost. */
const LOST_AFTER_S = 6 * 3600;
const HEX64 = /^[0-9a-f]{64}$/;
const seconds = () => Math.floor(Date.now() / 1000);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Buzz's runner limits (buzz-app src/features/agents/runner.ts).
/** Watch jobs waiting per agent. */
const QUEUE_LIMIT = 32;
/** Watch jobs one Interest can have waiting. */
const INTEREST_LIMIT = 8;
/** Interests whose wakes run at once. */
const INTEREST_LANES = 8;
/** Attention runs admitted per agent per minute. */
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;
/** Missed events one catch-up turn holds at most, and their most JSON characters. */
const CATCH_UP_BATCH = 64;
const CATCH_UP_BATCH_CHARS = 64 * 1024;
/** Live events held per agent while its watches catch up. */
const WAITING_LIMIT = 512;
const WAITING_BYTES = 4 * 1024 * 1024;
const CATCH_UP_WAIT_MS = 1_000;
const CATCH_UP_RETRY_MS = 30_000;
/** How often a stream live does not cover is read again, and how far behind now. */
const CATCH_UP_POLL_MS = 30_000;
const CATCH_UP_POLL_LAG = 10;
/** How often a covered stream's checkpoint is moved up to now while live. What
 * live delivered in between is listed as heard, so a restart never repeats it. */
const TICK_MOVE_S = 30;

/** Said to an independent turn, which Buzz's prompt leaves to its `send` tool. */
const HOST_ONE_OFF =
  "On this host, post with the buzz CLI: `buzz messages send --channel <uuid> --content <text>` (add `--reply-to <event-id>` to reply in a thread).";

const NO_RUNTIME_SCHEDULER_ON =
  "Never use your runtime's built-in timer, cron, or background scheduler (such as `schedule`, `CronCreate`, `ScheduleWakeup`, or `cronjob`) — those wake invisibly outside Buzz without your owner's visibility. Always use Buzz Attention (`interest_set` + `watch_add`) for any delayed check, recurring task, or watch.";

const NO_RUNTIME_SCHEDULER_OFF =
  "Never fall back to your runtime's built-in timer, cron, or background scheduler (such as `schedule`, `CronCreate`, `ScheduleWakeup`, or `cronjob`) — those wake invisibly outside Buzz without your owner's visibility. Tell your owner that Attention is off instead.";

export function withSchedulerGuard(note, enabled) {
  const guard = enabled ? NO_RUNTIME_SCHEDULER_ON : NO_RUNTIME_SCHEDULER_OFF;
  if (!note) return `<attention>\n${guard}\n</attention>`;
  if (note.includes("built-in timer, cron, or background scheduler")) return note;
  const close = "</attention>";
  return note.endsWith(close)
    ? `${note.slice(0, -close.length).trimEnd()}\n${guard}\n${close}`
    : `${note}\n${guard}`;
}

const emptyRecord = (pubkey) => ({
  pubkey,
  attention: {},
  skipped: {},
  config: null,
  attentionEnabled: false,
  timers: {},
});

export function createAttention({ dataDir, runDir, log = console, extra }) {
  const extras = Array.isArray(extra) ? extra.filter(Boolean) : extra ? [extra] : [];
  const agentDir = (pubkey) => path.join(dataDir, pubkey);
  const stateFile = (pubkey) => path.join(agentDir(pubkey), "attention.json");
  /** pubkey → Promise of { record, checkpoints, wakes, history }, as saved. */
  const states = new Map();
  const queues = new Map();
  /** pubkey → in-memory runtime: queue, rate, catch-up pass, held live events. */
  const runtimes = new Map();
  let ticking = false;
  let tickTimer;
  let socketServer;
  /** Called with (pubkey, record) after every saved change (relay watcher). */
  let onChange = () => {};
  /** Called with (pubkey, wake, result) after a wake's outcome is read. */
  let onWakeResult = () => {};
  /** The relay watcher: status(pubkey) and query(pubkey, filter). */
  let relay;

  function checkPubkey(pubkey) {
    if (typeof pubkey !== "string" || !HEX64.test(pubkey)) throw new Error("Invalid agent pubkey");
    return pubkey;
  }

  async function exists(pubkey) {
    try {
      await fs.access(path.join(agentDir(pubkey), "meta.json"));
      return true;
    } catch {
      return false;
    }
  }

  function runtime(pubkey) {
    let rt = runtimes.get(pubkey);
    if (!rt) {
      rt = {
        queue: [],
        rate: { windowStart: 0, admitted: 0 },
        pass: undefined,
        catching: new Set(),
        waiting: [],
        waitingBytes: 0,
        dropped: 0,
      };
      runtimes.set(pubkey, rt);
    }
    return rt;
  }

  /** The agent's state, read once: concurrent first reads share one load, so
   * no change is made to a copy that another load then replaces. */
  function load(pubkey) {
    let loading = states.get(pubkey);
    if (!loading) {
      loading = (async () => {
        let saved;
        try {
          saved = JSON.parse(await fs.readFile(stateFile(pubkey), "utf8"));
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        return {
          record: { ...emptyRecord(pubkey), ...(saved?.record ?? {}), pubkey },
          checkpoints: saved?.checkpoints ?? {},
          wakes: saved?.wakes ?? {},
          history: saved?.history ?? [],
        };
      })();
      states.set(pubkey, loading);
      loading.catch(() => states.delete(pubkey));
    }
    return loading;
  }

  async function save(pubkey, state) {
    const file = stateFile(pubkey);
    const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ schema: core.ATTENTION_SCHEMA, ...state }), { mode: 0o600 });
    await fs.rename(tmp, file);
    await writeNote(pubkey, state.record);
  }

  /** Buzz's end-of-turn note for acp-proxy (both when Attention is on and when it is off). */
  async function writeNote(pubkey, record) {
    const file = path.join(agentDir(pubkey), "attention-note.txt");
    const base = !record.attentionEnabled
      ? core.ATTENTION_OFF
      : core.interestIds(record).length
        ? core.ATTENTION_REVIEW
        : core.ATTENTION_NONE;
    await fs.writeFile(file, withSchedulerGuard(base, record.attentionEnabled === true), { mode: 0o600 });
  }

  /** Runs `change(state)` after the agent's earlier changes; it returns the
   * next record (or the same one) and may edit checkpoints, wakes and history
   * in place. One agent's changes are saved in the order they were made. */
  function mutate(pubkey, change) {
    const previous = queues.get(pubkey) ?? Promise.resolve();
    const run = previous.then(async () => {
      const state = await load(pubkey);
      const before = JSON.stringify(state);
      const record = await change(state);
      if (record) {
        // A removed object's wakes leave its own Activity, as Buzz drops its
        // history: one later created under the same id starts with none. They
        // stay in the agent's list of recent wakes.
        for (const entry of state.history)
          if (!entry.retired && entry.slug && state.record.attention[entry.slug] && !record.attention[entry.slug])
            entry.retired = true;
        state.record = record;
      }
      if (JSON.stringify(state) !== before) {
        await save(pubkey, state);
        onChange(pubkey, state.record);
      }
      return state.record;
    });
    queues.set(pubkey, run.catch(() => {}));
    return run;
  }

  // ---------- the agent's tools ----------

  /** Buzz's AgentAttention handle over this agent's record. */
  function handle(pubkey, state) {
    return {
      enabled: () => state.record.attentionEnabled === true,
      classifier: () => "unavailable",
      show: async (slug, interest) => core.show(state.record, slug, seconds(), interest),
      interests: (search) => core.interestIds(state.record, search),
      watches: (filter = {}) => core.watchSummaries(state.record, filter, seconds()),
      write: async (slug, value, options) => {
        const after = await mutate(pubkey, (current) =>
          core.checkedWrite(current.record, slug, value, options, seconds()),
        );
        return core.show(after, slug, seconds());
      },
    };
  }

  async function callTool(pubkey, name, args) {
    checkPubkey(pubkey);
    if (!core.isAttentionTool(name)) throw new Error(`No tool ${name}`);
    if (!(await exists(pubkey))) throw new Error("This agent is not on this host");
    const state = await load(pubkey);
    if (!state.record.attentionEnabled)
      throw new Error(
        "Attention is off for this agent: its owner can turn it on in the agent's Attention tab. Nothing was changed.",
      );
    return core.callAttentionTool(handle(pubkey, state), name, args ?? {});
  }

  /** JSON lines on attention.sock: {pubkey, name, args} → {result} | {error}.
   * `extra` (memory.mjs, orchestrator.mjs) answers the names it handles, Attention the rest. */
  async function listen() {
    await fs.mkdir(runDir, { recursive: true, mode: 0o700 });
    const sock = path.join(runDir, "attention.sock");
    await fs.rm(sock, { force: true });
    socketServer = createServer((conn) => {
      let buf = "";
      conn.setEncoding("utf8");
      conn.on("data", async (chunk) => {
        buf += chunk;
        if (buf.length > 1 << 20) return conn.destroy();
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          let reply;
          try {
            const { pubkey, name, args } = JSON.parse(line);
            const handler = extras.find((e) => e?.handles?.(name));
            reply = {
              result: handler
                ? await handler.call(pubkey, name, args ?? {})
                : await callTool(pubkey, name, args),
            };
          } catch (error) {
            reply = { error: String(error?.message ?? error) };
          }
          conn.write(`${JSON.stringify(reply)}\n`);
        }
      });
      conn.on("error", () => {});
    });
    await new Promise((resolve, reject) => {
      socketServer.once("error", reject);
      socketServer.listen(sock, resolve);
    });
    await fs.chmod(sock, 0o600);
  }

  // ---------- wakes, lanes and the queue ----------

  const interestBusy = (state, interest) =>
    Object.values(state.wakes).some((wake) => wake.interest === interest);
  const busyInterests = (state) => new Set(Object.values(state.wakes).map((wake) => wake.interest));
  const lanesFull = (state) => busyInterests(state).size >= INTEREST_LANES;

  function rateAdmitted(rt) {
    if (Date.now() - rt.rate.windowStart >= RATE_WINDOW_MS) {
      rt.rate.windowStart = Date.now();
      rt.rate.admitted = 0;
    }
    return rt.rate.admitted;
  }

  /** Whether the agent's queue takes one more job of `interest` now. */
  function fits(rt, interest) {
    const waitingIn = rt.queue.filter((job) => job.interest === interest).length;
    return (
      waitingIn + 1 <= INTEREST_LIMIT &&
      rt.queue.length + 1 <= QUEUE_LIMIT &&
      rateAdmitted(rt) + 1 <= RATE_LIMIT
    );
  }

  function record(state, entry) {
    state.history = [entry, ...state.history].slice(0, HISTORY_LIMIT);
  }

  /** Queues `job` (inside a mutate), or drops it when the agent has no room. */
  function enqueue(pubkey, state, job) {
    const rt = runtime(pubkey);
    if (!fits(rt, job.interest)) {
      rt.dropped++;
      log.log(`attention: ${pubkey.slice(0, 8)} ${job.slug} dropped an event: no room (queue ${rt.queue.length}, rate ${rt.rate.admitted}/min)`);
      record(state, {
        id: `drop-${Date.now().toString(36)}-${randomBytes(2).toString("hex")}`,
        type: job.kind,
        slug: job.slug,
        interest: job.interest,
        at: seconds(),
        outcome: "dropped",
        detail: "busy: the agent's queue or rate limit was full",
        text: String(job.events[0]?.content ?? "").slice(0, 280),
      });
      return false;
    }
    rt.rate.admitted++;
    rt.queue.push(job);
    return true;
  }

  /** Writes the wake request for buzz-acp and records it as in flight. */
  async function startWake(pubkey, state, wake, prompt) {
    const id = `att-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
    const wakeDir = path.join(agentDir(pubkey), "wake");
    await fs.mkdir(path.join(wakeDir, "results"), { recursive: true, mode: 0o700 });
    const request = {
      id,
      prompt,
      ...(wake.channel ? { channel: wake.channel } : {}),
      ...(wake.channel && wake.root ? { root: wake.root } : {}),
    };
    const tmp = path.join(wakeDir, `.${id}.tmp`);
    await fs.writeFile(tmp, JSON.stringify(request), { mode: 0o600 });
    await fs.rename(tmp, path.join(wakeDir, `${Date.now()}-${id}.json`));
    const at = seconds();
    // The prompt is kept on the in-flight wake (not in its history entry) so
    // a limit-resume retry can re-ask it; see resume.mjs's onWakeResult.
    state.wakes[id] = { ...wake, prompt, at };
    record(state, { id, ...wake, at });
    log.log(`attention: ${pubkey.slice(0, 8)} ${wake.type} ${wake.slug} → wake ${id}`);
  }

  function interestFields(record, interestId) {
    const interest = record.attention[core.interestSlug(interestId)]?.value;
    return interest?.type === "interest" ? { instructions: interest.instructions } : {};
  }

  function finishPrompt(text, channel) {
    return [text, channel ? undefined : HOST_ONE_OFF, withSchedulerGuard(core.ATTENTION_REVIEW, true)]
      .filter(Boolean)
      .join("\n\n");
  }

  /** Whether `watch` would hear `event` (Buzz's matching after its step 3: the
   * agent's own events and events addressed to it are not for watches). */
  const hears = (pubkey, watch, event) =>
    event.pubkey !== pubkey && !core.addressedTo(event, pubkey) && core.watchMatches(watch, event);

  /** Starts queued watch jobs whose Interest is free, in order. */
  function drain(pubkey) {
    const rt = runtime(pubkey);
    if (!rt.queue.length) return Promise.resolve();
    return mutate(pubkey, async (state) => {
      let { record } = state;
      for (let i = 0; i < rt.queue.length; ) {
        const job = rt.queue[i];
        const object = record.attention[job.slug];
        const watch = object?.value;
        // Changed meanwhile: removed, off, paused or turned into another watch.
        if (
          !record.attentionEnabled ||
          watch?.type !== "event" ||
          !watch.enabled ||
          watch.interest_id !== job.interest ||
          core.interestPaused(record.attention, job.interest)
        ) {
          rt.queue.splice(i, 1);
          continue;
        }
        if (interestBusy(state, job.interest)) {
          i++;
          continue;
        }
        if (lanesFull(state)) break;
        rt.queue.splice(i, 1);
        const common = {
          id: core.parseSlug(job.slug).id,
          interest: job.interest,
          ...interestFields(record, job.interest),
          conversation: !!watch.channel,
        };
        const text =
          job.kind === "catch-up"
            ? core.catchUpPrompt({ ...common, events: job.events.map((event) => ({ event })), skipped: !!job.skipped })
            : core.watchPrompt({ ...common, event: job.events[0] });
        await startWake(
          pubkey,
          state,
          {
            type: job.kind,
            slug: job.slug,
            interest: job.interest,
            channel: watch.channel,
            root: watch.root,
            modifiedAt: object.modifiedAt,
            events: job.events.map((event) => event.id),
            ...(job.kind === "catch-up" ? { count: job.events.length, skipped: !!job.skipped } : {}),
            text: String(job.events.at(-1)?.content ?? "").slice(0, 280),
          },
          finishPrompt(text, watch.channel),
        );
        record = woke(record, job.slug, job.events.map(entryOf), seconds());
      }
      return record;
    });
  }

  /** Buzz's per-watch history (AgentRecord.attentionHistory), as Buzz keeps it
   * when a watch wakes its agent: when it last woke, and the last 10 entries
   * (the events that woke it; a timer's prompt). Its Attention tab shows it. */
  function woke(record, slug, entries, at) {
    if (!record.attention[slug]) return record;
    const { output, ...prior } = record.attentionHistory?.[slug] ?? {};
    const kept = [...(prior.events ?? []), ...entries]
      .filter((entry) => Number.isFinite(entry.at) && typeof entry.text === "string" && (entry.text || typeof entry.id === "string"))
      .map((entry) => ({ ...entry, text: entry.text.slice(0, 2000) }))
      .slice(-10);
    const entry = { ...prior, lastWokeAt: at, ...(kept.length ? { events: kept } : output !== undefined ? { output } : {}) };
    return { ...record, attentionHistory: { ...record.attentionHistory, [slug]: entry } };
  }
  const entryOf = (event) => {
    const channel = event.tags.find(([name]) => name === "h")?.[1];
    const mentions = event.tags.flatMap(([name, value]) => (name === "p" && value ? [value] : []));
    const references = event.tags.flatMap((tag) => (tag.length === 2 && tag[0] === "mention" && tag[1] ? [tag[1]] : []));
    return {
      id: event.id,
      at: event.created_at,
      author: event.pubkey,
      ...(channel ? { channel } : {}),
      text: String(event.content ?? ""),
      ...(mentions.length ? { mentions } : {}),
      ...(references.length ? { mentionReferences: references } : {}),
    };
  };

  /** One due timer of `pubkey`, as Buzz's runner picks it, started. Returns
   * whether one started. A timer waits for its Interest, a free lane and room
   * in the rate limit; it never piles up (one overdue run). */
  async function timerPass(pubkey) {
    let started = false;
    const rt = runtime(pubkey);
    await mutate(pubkey, async (state) => {
      const { record } = state;
      if (!record.attentionEnabled) return record;
      const now = seconds();
      const changed = {};
      let next;
      const room = !lanesFull(state) && rateAdmitted(rt) + 1 <= RATE_LIMIT;
      for (const object of Object.values(record.attention)) {
        const timer = object.value;
        if (timer.type !== "timer" || !timer.enabled || core.interestPaused(record.attention, timer.interest_id))
          continue;
        const saved = record.timers?.[object.slug];
        const timerState = core.timerState(timer, saved, now);
        if (timerState !== saved) changed[object.slug] = { seen: saved, next: timerState };
        if (now < timerState.nextDue || core.timerSpent(timer, timerState, now)) continue;
        if (!room || interestBusy(state, timer.interest_id)) continue;
        if (!next || timerState.nextDue < next.timerState.nextDue) next = { object, timer, timerState };
      }
      let ran;
      if (next) {
        ran = { ...next.timerState, used: next.timerState.used + 1, nextDue: now + next.timer.interval_secs };
        changed[next.object.slug] = { seen: record.timers?.[next.object.slug], next: ran };
      }
      const after = Object.keys(changed).length ? (core.withProgress(record, changed) ?? record) : record;
      if (!next) return after;
      const { object, timer } = next;
      const spent = core.timerSpent(timer, ran, ran.nextDue);
      const text = core.timerPrompt({
        id: core.parseSlug(object.slug).id,
        interest: timer.interest_id,
        prompt: timer.prompt,
        ...interestFields(after, timer.interest_id),
        spent,
        conversation: !!timer.channel,
      });
      rt.rate.admitted++;
      await startWake(
        pubkey,
        state,
        {
          type: "timer",
          slug: object.slug,
          interest: timer.interest_id,
          channel: timer.channel,
          root: timer.root,
          modifiedAt: object.modifiedAt,
          spent,
          text: timer.prompt,
        },
        finishPrompt(text, timer.channel),
      );
      started = true;
      return woke(after, object.slug, [{ at: now, text: timer.prompt }], now);
    });
    return started;
  }

  // ---------- event watches: live and catch-up ----------

  /** Sets a stream's checkpoint, keeping what it heard live past it as well as
   * what the checkpoint itself lists as heard (Buzz's setCheckpoint). */
  function setCheckpoint(state, key, checkpoint) {
    state.checkpoints[key] = core.heardOf(checkpoint, [
      ...(state.checkpoints[key]?.heard ?? []),
      ...(checkpoint.heard ?? []),
    ]);
  }

  const streamsOf = (pubkey, record) => core.streamsOf({ key: pubkey, attention: record.attention });

  /** Lists `event` as heard by each of the agent's streams it is in and has
   * not passed yet, so catch-up never gives it again. */
  function heardLive(pubkey, state, event) {
    for (const stream of streamsOf(pubkey, state.record)) {
      const checkpoint = state.checkpoints[stream.key];
      if (checkpoint && core.inStream(stream, event) && core.undelivered(checkpoint, event))
        state.checkpoints[stream.key] = core.heardOf(checkpoint, [...(checkpoint.heard ?? []), event]);
    }
  }

  /** A live relay event of `pubkey`'s watcher: each matching watch queues a
   * job, or holds the event while it is catching up. */
  async function watchEvent(pubkey, event) {
    const rt = runtime(pubkey);
    await mutate(pubkey, async (state) => {
      const { record } = state;
      if (!record.attentionEnabled) return record;
      heardLive(pubkey, state, event);
      for (const object of Object.values(record.attention)) {
        const watch = object.value;
        if (watch.type !== "event" || core.interestPaused(record.attention, watch.interest_id)) continue;
        if (!hears(pubkey, watch, event)) continue;
        if (rt.catching.has(object.slug)) {
          const size = JSON.stringify(event).length;
          if (rt.waiting.length >= WAITING_LIMIT || rt.waitingBytes + size > WAITING_BYTES) {
            log.warn(`attention: ${pubkey.slice(0, 8)} ${object.slug}: too many live events while catching up; one dropped`);
            continue;
          }
          rt.waiting.push({ slug: object.slug, event });
          rt.waitingBytes += size;
          continue;
        }
        enqueue(pubkey, state, { kind: "watch", slug: object.slug, interest: watch.interest_id, events: [event] });
      }
      return record;
    });
    await drain(pubkey);
  }

  /** Releases the live events held for `slugs` (all, without), in order. */
  async function release(pubkey, slugs) {
    const rt = runtime(pubkey);
    const out = rt.waiting.filter(({ slug }) => !slugs || slugs.has(slug));
    if (!out.length) return;
    rt.waiting = rt.waiting.filter((item) => !out.includes(item));
    rt.waitingBytes = rt.waiting.reduce((n, { event }) => n + JSON.stringify(event).length, 0);
    await mutate(pubkey, async (state) => {
      for (const { slug, event } of out) {
        const watch = state.record.attention[slug]?.value;
        if (watch?.type === "event" && hears(pubkey, watch, event))
          enqueue(pubkey, state, { kind: "watch", slug, interest: watch.interest_id, events: [event] });
      }
      return state.record;
    });
    await drain(pubkey);
  }

  /** Gives catch-up's `events` of watch `slug` to the queue as one job, once
   * it has room. Returns false when the pass was replaced meanwhile. */
  async function caughtUp(pubkey, pass, slug, events, skipped) {
    const rt = runtime(pubkey);
    const state = await load(pubkey);
    const watch = state.record.attention[slug]?.value;
    if (watch?.type !== "event") return true;
    const matched = events.filter((event) => hears(pubkey, watch, event));
    if (!matched.length) return true;
    while (!fits(rt, watch.interest_id)) {
      if (rt.pass !== pass) return false;
      await sleep(CATCH_UP_WAIT_MS);
    }
    if (rt.pass !== pass) return false;
    await mutate(pubkey, (current) => {
      enqueue(pubkey, current, { kind: "catch-up", slug, interest: watch.interest_id, events: matched, skipped });
      return current.record;
    });
    await drain(pubkey);
    return true;
  }

  /** Reads and delivers what `streams` missed, as Buzz's readMissed does. */
  async function readMissed(pubkey, pass, streams, upper, overlap) {
    const rt = runtime(pubkey);
    const read = async (filter) => {
      const events = await relay.query(pubkey, filter);
      if (rt.pass !== pass) throw new Error("superseded");
      return events.filter((event) => HEX64.test(event?.id ?? "") && typeof event.sig === "string");
    };
    const progress = (key, checkpoint) =>
      mutate(pubkey, (state) => {
        setCheckpoint(state, key, checkpoint);
        return state.record;
      });
    const current = async (key) => (await load(pubkey)).checkpoints[key];
    try {
      for (const slug of [...new Set(streams.map(({ slug }) => slug))]) {
        for (const stream of streams.filter((item) => item.slug === slug))
          for (;;) {
            if (rt.pass !== pass) return;
            const window = await core.readWindow(stream, await current(stream.key), upper(stream), read);
            if (!window) break;
            if (window.skipped)
              log.warn(`attention: ${pubkey.slice(0, 8)} ${slug} skipped the oldest missed events (window bounds)`);
            await progress(stream.key, window.checkpoint);
            const events = window.events.filter((event) => core.inStream(stream, event));
            let skipped = window.skipped;
            for (let index = 0; index < events.length; ) {
              let end = index;
              let chars = 0;
              while (end < events.length && end - index < CATCH_UP_BATCH) {
                const size = JSON.stringify(events[end]).length;
                if (end > index && chars + size > CATCH_UP_BATCH_CHARS) break;
                chars += size;
                end++;
              }
              if (!(await caughtUp(pubkey, pass, slug, events.slice(index, end), skipped))) return;
              skipped = false;
              index = end;
              await progress(
                stream.key,
                core.admitted(window, events.slice(0, index), (await current(stream.key))?.heard, overlap(stream)),
              );
            }
            await progress(stream.key, core.finished(window, (await current(stream.key))?.heard, overlap(stream)));
          }
        rt.catching.delete(slug);
        await release(pubkey, new Set([slug]));
      }
      pass.done = true;
      pass.doneAt = Date.now();
    } catch (error) {
      if (rt.pass !== pass) return;
      pass.failedAt = Date.now();
      // Live events go on rather than wait for the next try.
      rt.catching = new Set();
      await release(pubkey);
      log.warn(`attention: ${pubkey.slice(0, 8)} could not catch up: ${error.message}`);
    }
  }

  /** Keeps `pubkey`'s catch-up going (Buzz's catchUp): on each connect, its
   * event watches read what they missed since their checkpoints, up to the
   * connect; while connected, a covered stream's checkpoint moves to now, and
   * any other stream is polled. */
  async function catchUp(pubkey, tick) {
    const rt = runtime(pubkey);
    const now = seconds();
    const state = await load(pubkey);
    const on = state.record.attentionEnabled === true;
    const streams = streamsOf(pubkey, state.record);
    const reading = [];
    await mutate(pubkey, (st) => {
      const keys = new Set(streams.map(({ key }) => key));
      for (const key of Object.keys(st.checkpoints)) if (!keys.has(key)) delete st.checkpoints[key];
      for (const stream of streams) {
        const checkpoint = st.checkpoints[stream.key];
        if (!on || !stream.enabled) {
          // Off, it starts from when it is turned back on: nothing replayed.
          if (!checkpoint?.off) st.checkpoints[stream.key] = { through: now, off: true };
        } else if (!checkpoint || checkpoint.off) {
          // New, or just turned on: it starts now.
          st.checkpoints[stream.key] = { through: now };
        } else reading.push(stream);
      }
      return st.record;
    });
    const status = relay?.status(pubkey);
    if (!status || !reading.length) {
      if (rt.pass) rt.pass.aborted = true;
      rt.pass = undefined;
      if (rt.catching.size) {
        rt.catching = new Set();
        await release(pubkey);
      }
      return;
    }
    const { epoch, since, members } = status;
    const live = status.filter;
    // Live hears a stream: one member channel, named by (or included in) the
    // live subscription, of kinds it hears. Any other is polled.
    const covered = (stream) =>
      stream.channel !== undefined &&
      !!members?.has(stream.channel) &&
      (!live?.["#h"] || live["#h"].includes(stream.channel)) &&
      stream.kinds.every((kind) => live?.kinds?.includes(kind));
    const overlap = (stream) => (covered(stream) ? 0 : core.POLL_OVERLAP);
    const passKey = JSON.stringify(streams);
    const pass = rt.pass;
    if (
      pass &&
      pass.epoch === epoch &&
      pass.key === passKey &&
      !(pass.failedAt && Date.now() - pass.failedAt >= CATCH_UP_RETRY_MS)
    ) {
      if (!pass.done) return;
      const checkpoints = (await load(pubkey)).checkpoints;
      const through = (stream) => checkpoints[stream.key]?.read ?? checkpoints[stream.key]?.through ?? 0;
      const ticks = (stream) => covered(stream) && through(stream) >= since;
      if (tick) {
        const moving = reading.filter(ticks).filter((stream) => {
          const checkpoint = checkpoints[stream.key];
          return checkpoint && !checkpoint.upper && checkpoint.through < now - TICK_MOVE_S;
        });
        if (moving.length)
          await mutate(pubkey, (st) => {
            for (const stream of moving) setCheckpoint(st, stream.key, { through: now });
            return st.record;
          });
      }
      const behind = reading.filter((stream) => through(stream) < since);
      const polled = reading.filter((stream) => !ticks(stream));
      if (!behind.length && !(polled.length && Date.now() - (pass.doneAt ?? 0) >= CATCH_UP_POLL_MS)) return;
      const next = { epoch, key: passKey };
      rt.pass = next;
      rt.catching = new Set(behind.map(({ slug }) => slug));
      void readMissed(
        pubkey,
        next,
        polled,
        // A stream behind reads up to the connect; one polled stays a little
        // behind now, for events the relay stores late.
        () => Math.max(now - CATCH_UP_POLL_LAG, since),
        overlap,
      );
      return;
    }
    if (pass) pass.aborted = true;
    const next = { epoch, key: passKey };
    rt.pass = next;
    rt.catching = new Set(reading.map(({ slug }) => slug));
    log.log(`attention: ${pubkey.slice(0, 8)} catching up ${reading.length} stream(s) since their checkpoints`);
    void readMissed(
      pubkey,
      next,
      reading,
      (stream) => (covered(stream) ? since : Math.max(since, now - CATCH_UP_POLL_LAG)),
      overlap,
    );
  }

  // ---------- results ----------

  /** Reads the outcomes of `pubkey`'s wakes in flight. */
  async function collect(pubkey) {
    const state = await load(pubkey);
    if (!Object.keys(state.wakes).length) return;
    const results = path.join(agentDir(pubkey), "wake", "results");
    const wakeDir = path.join(agentDir(pubkey), "wake");
    const queued = new Set((await fs.readdir(wakeDir).catch(() => [])).filter((name) => name.endsWith(".json")));
    for (const [id, wake] of Object.entries(state.wakes)) {
      const file = path.join(results, `${id}.json`);
      let result;
      try {
        result = JSON.parse(await fs.readFile(file, "utf8"));
      } catch (error) {
        if (error.code !== "ENOENT") log.warn(`attention: result ${id}: ${error.message}`);
        const waiting = [...queued].some((name) => name.endsWith(`-${id}.json`));
        if (waiting || seconds() - wake.at < LOST_AFTER_S) continue;
        result = { outcome: "lost", detail: "no result" };
      }
      await mutate(pubkey, async (current) => {
        delete current.wakes[id];
        current.history = current.history.map((entry) =>
          entry.id === id
            ? { ...entry, outcome: result.outcome, detail: result.detail || undefined, finishedAt: result.finished_at ?? seconds() }
            : entry,
        );
        let record = current.record;
        // Buzz: a spent timer is removed after its last turn succeeds, unless
        // the agent changed or rearmed it meanwhile.
        if (wake.type === "timer" && wake.spent && result.outcome === "ok") {
          const object = record.attention[wake.slug];
          if (object && object.modifiedAt === wake.modifiedAt) record = core.setAttention(record, wake.slug, null);
        }
        return record;
      });
      // Other services react to a wake's outcome (resume.mjs retries a wake
      // whose turn stopped on a rate/usage limit).
      if (typeof onWakeResult === "function") {
        try {
          await onWakeResult(pubkey, wake, result);
        } catch (error) {
          log.warn(`attention: wake result hook for ${pubkey.slice(0, 8)}: ${error.message}`);
        }
      }
      await fs.rm(file, { force: true });
      log.log(`attention: ${pubkey.slice(0, 8)} wake ${id} ${result.outcome}`);
    }
  }

  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      const names = await fs.readdir(dataDir).catch(() => []);
      for (const pubkey of names.filter((name) => HEX64.test(name))) {
        try {
          const state = await load(pubkey);
          const hasWatches = Object.values(state.record.attention).some((o) => o.value.type === "event");
          if (!state.record.attentionEnabled && !Object.keys(state.wakes).length && !hasWatches) continue;
          await collect(pubkey);
          await drain(pubkey);
          for (let i = 0; i < 10 && (await timerPass(pubkey)); i++);
          await catchUp(pubkey, true);
        } catch (error) {
          log.warn(`attention: ${pubkey.slice(0, 8)}: ${error.message}`);
        }
      }
    } finally {
      ticking = false;
    }
  }

  // ---------- the owner's controls (buzz-host methods) ----------

  function describe(record, slug, object, rt, history = []) {
    const value = object.value;
    if (value.type === "interest") return undefined;
    const shown = core.objectAt(record, slug, seconds());
    // Its wakes, newest first, as Buzz's per-watch Activity lists them.
    const activity = history
      .filter((entry) => entry.slug === slug && !entry.retired)
      .slice(0, 20)
      .map(({ at, type, text, outcome, count, skipped }) => ({ at, type, text, outcome, count, skipped }));
    return {
      lastWokeAt: activity.find((entry) => entry.outcome !== "dropped")?.at,
      activity,
      id: core.parseSlug(slug).id,
      name: value.name,
      interest: value.interest_id,
      type: value.type,
      status: shown?.status,
      // Buzz describes every timer by its interval; a one-time timer reads as "Every …".
      summary: value.type === "timer" && value.max_occurrences === 1 ? "Once" : core.describeWatch(value),
      enabled: value.enabled,
      channel: value.channel,
      root: value.root,
      ...(value.type === "timer"
        ? { prompt: value.prompt, interval: value.interval_secs, used: shown.used, nextDue: shown.next_due, maxOccurrences: value.max_occurrences, expiresAt: value.expires_at }
        : {}),
      ...(value.type === "event"
        ? {
            channels: value.channels,
            kinds: value.kinds,
            authors: value.authors,
            excludeAuthors: value.exclude_authors,
            isReply: value.is_reply,
            since: value.since,
            classifier: !!value.classifier,
            catchingUp: rt.catching.has(slug),
            waiting: rt.queue.filter((job) => job.slug === slug).length,
          }
        : {}),
      modifiedAt: object.modifiedAt,
    };
  }

  async function get(pubkey) {
    checkPubkey(pubkey);
    const state = await load(pubkey);
    const rt = runtime(pubkey);
    const { interests, watches, orphans } = core.attentionOf(state.record.attention);
    return {
      enabled: state.record.attentionEnabled === true,
      interests: interests.map(({ slug, value, modifiedAt }) => ({
        id: core.parseSlug(slug).id,
        title: value.title || core.interestTitle(core.parseSlug(slug).id),
        summary: value.summary,
        instructions: value.instructions,
        paused: value.paused === true,
        modifiedAt,
      })),
      watches: watches.map((object) => describe(state.record, object.slug, object, rt, state.history)),
      orphans: orphans.map((object) => core.parseSlug(object.slug).id),
      inFlight: Object.entries(state.wakes).map(([id, { prompt: _prompt, ...wake }]) => ({ id, ...wake })),
      queued: rt.queue.length,
      history: state.history.slice(0, 30),
    };
  }

  async function setEnabled(pubkey, enabled) {
    checkPubkey(pubkey);
    await mutate(pubkey, (state) => ({ ...state.record, attentionEnabled: !!enabled }));
    if (!enabled) {
      const rt = runtime(pubkey);
      rt.queue = [];
      rt.waiting = [];
      rt.waitingBytes = 0;
    }
    await catchUp(pubkey, false);
    return get(pubkey);
  }

  /** Owner edits skip the agent's expected-state tokens: the owner decides. */
  async function ownerEdit(pubkey, { op, id, paused, enabled }) {
    checkPubkey(pubkey);
    if (typeof id !== "string" || !id) throw new Error("id is required");
    await mutate(pubkey, (state) => {
      let record = state.record;
      const now = seconds();
      if (op === "pause") {
        const slug = core.interestSlug(id);
        const value = record.attention[slug]?.value;
        if (value?.type !== "interest") throw new Error(`No Interest ${id}`);
        return core.setAttention(record, slug, { ...value, paused: !!paused }, now);
      }
      if (op === "removeInterest") {
        for (const object of Object.values(record.attention))
          if (object.value.type !== "interest" && object.value.interest_id === id)
            record = core.setAttention(record, object.slug, null, now);
        return core.setAttention(record, core.interestSlug(id), null, now);
      }
      const slug = core.watchSlug(id);
      const value = record.attention[slug]?.value;
      if (!value || value.type === "interest") throw new Error(`No watch ${id}`);
      if (op === "removeWatch") return core.setAttention(record, slug, null, now);
      if (op === "enableWatch") {
        if (value.type === "timer" && enabled)
          return core.setAttention(record, slug, { ...value, enabled: true, armed_at: now }, now, "rearm");
        return core.setAttention(record, slug, { ...value, enabled: !!enabled }, now);
      }
      throw new Error(`Unknown edit ${op}`);
    });
    await catchUp(pubkey, false);
    return get(pubkey);
  }

  /** The agent's record in Buzz's shape, for Buzz's own Attention tab (local
   * Buzz patch 0005), with this host's summary for the plugin around it. */
  async function view(pubkey) {
    const summary = await get(pubkey);
    const { attention, skipped, timers, attentionHistory, sourceRuns } = (await load(pubkey)).record;
    return {
      ...summary,
      record: {
        attention,
        skipped: skipped ?? {},
        timers: timers ?? {},
        ...(attentionHistory ? { attentionHistory } : {}),
        ...(sourceRuns ? { sourceRuns } : {}),
      },
    };
  }

  /** The owner's edit from Buzz's Attention tab: Buzz's AgentChange
   * (attention, attentionExpected, watchEnabled), applied as Buzz's
   * changed() applies it to a local agent's record. */
  async function ownerChange(pubkey, change = {}) {
    checkPubkey(pubkey);
    await mutate(pubkey, (state) => {
      let record = state.record;
      for (const [slug, expected] of Object.entries(change.attentionExpected ?? {}))
        if (JSON.stringify(record.attention[slug]) !== JSON.stringify(expected))
          throw new Error("Attention changed. Review it and try again.");
      const now = seconds();
      for (const [slug, value] of Object.entries(change.attention ?? {}))
        record = core.setAttention(record, slug, value, now);
      for (const [slug, { enabled, expected } = {}] of Object.entries(change.watchEnabled ?? {})) {
        const current = record.attention[slug];
        if (!current || JSON.stringify(current) !== JSON.stringify(expected))
          throw new Error("This watch changed. Review its current settings and try again.");
        if (current.value.type === "interest") throw new Error("Choose a watch");
        if (enabled && current.value.type === "timer" && !current.value.enabled)
          throw new Error("Ask the agent to rearm this timer.");
        if (current.value.enabled !== enabled) {
          const history = record.attentionHistory;
          record = core.setAttention(record, slug, { ...current.value, enabled: !!enabled }, now);
          if (history) record = { ...record, attentionHistory: history };
        }
      }
      // As the spec's writer: an Interest stays while anything still uses it.
      for (const [slug, value] of Object.entries(change.attention ?? {})) {
        const id = slug.startsWith("interest/") ? core.parseSlug(slug)?.id : undefined;
        if (value !== null || !id) continue;
        if (Object.values(record.attention).some((o) => o.value.type !== "interest" && o.value.interest_id === id))
          throw new Error("Remove or move the watches and timers that use this Interest first");
      }
      return record;
    });
    await catchUp(pubkey, false);
    return view(pubkey);
  }

  /** The agent was removed: forget it (its directory is gone with its files). */
  function forget(pubkey) {
    const rt = runtimes.get(pubkey);
    if (rt?.pass) rt.pass.aborted = true;
    runtimes.delete(pubkey);
    states.delete(pubkey);
    queues.delete(pubkey);
  }

  async function start() {
    await listen();
    tickTimer = setInterval(() => void tick(), TICK_MS);
    void tick();
  }

  async function stop() {
    clearInterval(tickTimer);
    for (const rt of runtimes.values()) if (rt.pass) rt.pass.aborted = true;
    await new Promise((resolve) => (socketServer ? socketServer.close(resolve) : resolve()));
  }

  return {
    start,
    stop,
    tick,
    callTool,
    watchEvent,
    /** The relay watcher connected (or reconnected) `pubkey`: catch up now. */
    connected: (pubkey) => void catchUp(pubkey, false).catch((error) => log.warn(`attention: ${error.message}`)),
    catchUp,
    get,
    view,
    setEnabled,
    ownerEdit,
    ownerChange,
    forget,
    load,
    syncNotes: async (pubkeys) => {
      for (const pubkey of pubkeys) {
        if (!HEX64.test(pubkey)) continue;
        try {
          const state = await load(pubkey);
          await writeNote(pubkey, state.record);
        } catch (error) {
          log.warn(`attention: syncNote ${pubkey.slice(0, 8)} failed: ${error.message}`);
        }
      }
    },
    enabledAgents: async () => {
      const names = await fs.readdir(dataDir).catch(() => []);
      const out = [];
      for (const pubkey of names.filter((name) => HEX64.test(name)))
        if ((await load(pubkey)).record.attentionEnabled) out.push(pubkey);
      return out;
    },
    set onChange(fn) {
      onChange = fn;
    },
    set onWakeResult(fn) {
      onWakeResult = fn;
    },
    set relay(watcher) {
      relay = watcher;
    },
  };
}
