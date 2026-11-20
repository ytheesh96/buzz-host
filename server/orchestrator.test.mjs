// node --test server/orchestrator.test.mjs
// Covers Solo-chat worker orchestration: self-worker default and cross-agent
// delegation via operator wake files ($BUZZ_ACP_WAKE_DIR), chat-settings.json
// with per-chat noOrchestrate: true (MAX_DEPTH = 1), kind:9007 Solo chat,
// visible kind:9 prompt without double-trigger, _acp_turn_start/_acp_turn_done,
// relay reply capture + fallback query, concurrency cap + FIFO queue, steer
// queue, cancel + wake-file cleanup + control-socket routing, timeout,
// quota-banner refusal detection, restart persistence, guardrails, summary
// clipping, and spoofing protection.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createOrchestrator, MAX_DEPTH, MAX_LIVE, ORCHESTRATOR_TOOLS, runtimeRefusal } from "./orchestrator.mjs";

const OWNER = "1".repeat(64);
const OTHER = "2".repeat(64);
const CONDUCTOR = "a".repeat(64);
const GIRAFFE = "c".repeat(64);
const FOREIGN = "d".repeat(64);
const CHANNEL = "123e4567-e89b-42d3-a456-426614174000";
const ROOT = "f".repeat(64);
const CHAT = `${CHANNEL}_${ROOT}`;
const ORIGIN = "e".repeat(64);

function makeFakeRelay() {
  let seq = 1;
  const created = [];
  const posted = [];
  const messagesByChannel = new Map(); // channelId -> events[]
  const watches = new Map(); // channelId -> Set<fn>

  const nextId = () => (seq++).toString(16).padStart(64, "0");

  return {
    created,
    posted,
    messagesByChannel,
    deliver(channelId, authorPubkey, content, { id = nextId(), createdAt = Math.floor(Date.now() / 1000), tags = [] } = {}) {
      const ev = { id, pubkey: authorPubkey, created_at: createdAt, content, tags };
      let list = messagesByChannel.get(channelId);
      if (!list) messagesByChannel.set(channelId, (list = []));
      list.push(ev);
      for (const fn of watches.get(channelId) ?? []) fn(ev);
      return ev;
    },
    storeOnly(channelId, authorPubkey, content, { id = nextId(), createdAt = Math.floor(Date.now() / 1000), tags = [] } = {}) {
      const ev = { id, pubkey: authorPubkey, created_at: createdAt, content, tags };
      let list = messagesByChannel.get(channelId);
      if (!list) messagesByChannel.set(channelId, (list = []));
      list.push(ev);
      return ev;
    },
    async createSoloChat(req) {
      const eventId = nextId();
      created.push({ ...req, eventId });
      return { channelId: req.channelId, eventId };
    },
    async postMessage(req) {
      const eventId = nextId();
      const createdAt = Math.floor(Date.now() / 1000);
      const tags = [["h", req.channelId], ...(req.mentionPubkey ? [["p", req.mentionPubkey]] : []), ...(req.extraTags ?? [])];
      const ev = { id: eventId, pubkey: req.pubkey, created_at: createdAt, content: req.content, tags };
      let list = messagesByChannel.get(req.channelId);
      if (!list) messagesByChannel.set(req.channelId, (list = []));
      list.push(ev);
      // Mirror a real relay echoing the posted event to active watches (e.g. on self-worker steer!).
      for (const fn of watches.get(req.channelId) ?? []) fn(ev);
      posted.push({ ...req, eventId, createdAt, tags });
      return { eventId, createdAt };
    },
    async getMessages({ channelId, authorPubkey, since }) {
      const list = messagesByChannel.get(channelId) ?? [];
      return list.filter(
        (e) =>
          (!authorPubkey || e.pubkey === authorPubkey) &&
          (!Number.isFinite(since) || (e.created_at || 0) >= since),
      );
    },
    async watchChannel({ channelId, onMessage }) {
      let set = watches.get(channelId);
      if (!set) watches.set(channelId, (set = new Set()));
      set.add(onMessage);
      return () => {
        set.delete(onMessage);
        if (set.size === 0) watches.delete(channelId);
      };
    },
    async close() {
      watches.clear();
    },
  };
}

async function listWakes(dataDir, pubkey) {
  const dir = path.join(dataDir, pubkey, "wake");
  const files = (await fs.readdir(dir).catch(() => [])).filter((f) => f.endsWith(".json") && !f.startsWith(".")).sort();
  return Promise.all(
    files.map(async (f) => ({
      file: f,
      path: path.join(dir, f),
      data: JSON.parse(await fs.readFile(path.join(dir, f), "utf8")),
    })),
  );
}

async function setupHarness({ orchestrate = true, limits = {} } = {}) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "buzz-orch-solo-"));
  const dataDir = path.join(tmp, "agents");
  const stateDir = path.join(tmp, "orchestrator");
  const workDir = path.join(tmp, "work");
  await fs.mkdir(path.join(dataDir, CONDUCTOR), { recursive: true });
  await fs.mkdir(path.join(dataDir, GIRAFFE), { recursive: true });
  await fs.mkdir(path.join(dataDir, FOREIGN), { recursive: true });
  await fs.mkdir(workDir, { recursive: true });

  await fs.writeFile(
    path.join(dataDir, CONDUCTOR, "meta.json"),
    JSON.stringify({
      pubkey: CONDUCTOR,
      name: "Conductor",
      owner: OWNER,
      runtime: "claude",
      concurrency: 4,
      activated: true,
      orchestrate,
    }),
  );
  await fs.writeFile(
    path.join(dataDir, GIRAFFE, "meta.json"),
    JSON.stringify({
      pubkey: GIRAFFE,
      name: "Giraffe",
      owner: OWNER,
      runtime: "codex",
      concurrency: 4,
      activated: true,
      orchestrate: false,
    }),
  );
  await fs.writeFile(
    path.join(dataDir, FOREIGN, "meta.json"),
    JSON.stringify({
      pubkey: FOREIGN,
      name: "Foreign",
      owner: OTHER,
      runtime: "claude",
      concurrency: 4,
      activated: true,
      orchestrate: false,
    }),
  );
  await fs.writeFile(
    path.join(dataDir, CONDUCTOR, "turn-authors.json"),
    JSON.stringify({
      [CHAT]: { author: OWNER, eventId: ORIGIN, at: Math.floor(Date.now() / 1000) },
      other_chat: { author: OTHER, eventId: "9".repeat(64), at: Math.floor(Date.now() / 1000) },
    }),
  );

  const relay = makeFakeRelay();
  const cancelled = [];
  const hermesEnsured = [];
  const orch = createOrchestrator({
    dataDir,
    stateDir,
    relay,
    ensureHermes: async (profile) => {
      hermesEnsured.push(profile);
    },
    cancelWorker: async (workerPk, chId) => {
      cancelled.push({ workerPk, chId });
      return { cancelled: true };
    },
    catalog: async (rt) => ({
      current: `${rt}-default`,
      models: [{ id: `${rt}-fast`, label: `${rt} Fast`, efforts: [{ id: "high", label: "High" }] }],
    }),
    limits: { checkShimAccess: false, ...limits },
  });

  const call = async (name, args = {}, pubkey = CONDUCTOR) => JSON.parse(await orch.call(pubkey, name, args));
  const cleanup = async () => {
    await orch.close();
    await fs.rm(tmp, { recursive: true, force: true });
  };
  return { tmp, dataDir, stateDir, workDir, relay, cancelled, hermesEnsured, orch, call, cleanup };
}

test("self-worker default lifecycle: capabilities, delegate, chat-settings + noOrchestrate, wake file, wait, status, list", async () => {
  const h = await setupHarness();
  try {
    assert.equal(ORCHESTRATOR_TOOLS.length, 7);
    assert.equal(MAX_DEPTH, 1);
    assert.equal(MAX_LIVE, 4);

    const caps = await h.call("orch_capabilities");
    assert.equal(caps.mode, "solo");
    assert.equal(caps.defaultAgent.pubkey, CONDUCTOR);
    assert.equal(caps.defaultAgent.name, "Conductor");
    assert.equal(caps.defaultAgent.concurrency, 4);
    // Same-owner agents listed (self first), foreign-owner agent excluded.
    assert.deepEqual(
      caps.agents.map((a) => [a.name, a.self]),
      [
        ["Conductor", true],
        ["Giraffe", false],
      ],
    );
    assert.equal(caps.runtimes.length, 4);

    const task = await h.call("orch_delegate", {
      runtime: "hermes",
      model: "hermes-fast",
      effort: "high",
      prompt: "Summarize Nostr NIP-29",
      label: "nostr-facts",
      chat: CHAT,
      cwd: h.workDir,
    });
    assert.equal(task.mode, "solo");
    assert.equal(task.status, "starting");
    assert.equal(task.originEventId, ORIGIN);
    assert.equal(task.workerPubkey, CONDUCTOR);
    assert.equal(task.workerName, "Conductor");
    assert.ok(task.workerChannelId);
    assert.ok(task.promptEventId);
    assert.equal(task.link, `buzz://message?channel=${task.workerChannelId}&id=${task.promptEventId}`);
    assert.equal(h.hermesEnsured.length, 1);

    // Conductor's chat-settings.json was pre-populated with noOrchestrate: true for per-chat runtime dispatch.
    const cs = JSON.parse(await fs.readFile(path.join(h.dataDir, CONDUCTOR, "chat-settings.json"), "utf8"));
    assert.equal(cs[task.workerChannelId].runtime, "hermes");
    assert.equal(cs[task.workerChannelId].model, "hermes-fast");
    assert.equal(cs[task.workerChannelId].effort, "high");
    assert.equal(cs[task.workerChannelId].noOrchestrate, true);
    assert.deepEqual(cs[task.workerChannelId].workspace, [h.workDir]);
    assert.ok(cs[task.workerChannelId].expiresAt > Date.now());

    // Solo chat was created, visible prompt posted WITHOUT mentionPubkey (no double-trigger) and WITH buzz.orch.prompt tag.
    assert.equal(h.relay.created.length, 1);
    assert.equal(h.relay.created[0].name, "nostr-facts · Hermes");
    assert.equal(h.relay.created[0].ownerPubkey, OWNER);
    assert.equal(h.relay.posted.length, 1);
    assert.equal(h.relay.posted[0].mentionPubkey, undefined);
    assert.equal(h.relay.posted[0].content, "Summarize Nostr NIP-29");
    assert.ok(h.relay.posted[0].tags.some((t) => t[0] === "t" && t[1] === "buzz.orch.prompt"));

    // Operator wake file was written atomically to Conductor's wake dir with exact Patch 0004 fields.
    const wakes = await listWakes(h.dataDir, CONDUCTOR);
    assert.equal(wakes.length, 1);
    assert.deepEqual(Object.keys(wakes[0].data).sort(), ["channel", "id", "prompt"]);
    assert.equal(wakes[0].data.channel, task.workerChannelId);
    assert.match(wakes[0].data.prompt, /<delegated-worker-task[\s\S]*Summarize Nostr NIP-29/);

    // Simulate turn start -> self-worker reply -> turn done.
    const waiting = h.call("orch_wait", { taskId: task.taskId, timeoutMs: 5000 });
    await h.call("_acp_turn_start", { channel: task.workerChannelId, runtime: "hermes", model: "hermes-fast" }, CONDUCTOR);
    const replyEv = h.relay.deliver(task.workerChannelId, CONDUCTOR, "NIP-29 defines relay-based groups.");
    await h.call(
      "_acp_turn_done",
      { channel: task.workerChannelId, runtime: "hermes", stopReason: "end_turn", finalText: "NIP-29 defines relay-based groups." },
      CONDUCTOR,
    );

    const waited = await waiting;
    assert.equal(waited.timedOut, false);
    assert.equal(waited.task.status, "completed");
    assert.equal(waited.task.result.text, "NIP-29 defines relay-based groups.");
    assert.equal(waited.task.replyEventId, replyEv.id);
    assert.equal(waited.task.link, `buzz://message?channel=${task.workerChannelId}&id=${replyEv.id}`);

    const st = await h.call("orch_status", { taskId: task.taskId });
    assert.ok(Array.isArray(st.task.transcript));
    assert.ok(st.task.transcript.some((e) => e.kind === "message" && e.text.includes("NIP-29")));

    const listed = await h.call("orch_list", { chat: CHAT });
    assert.equal(listed.tasks.length, 1);
    assert.equal(listed.tasks[0].taskId, task.taskId);
    assert.equal(listed.tasks[0].prompt, undefined);
  } finally {
    await h.cleanup();
  }
});

test("cross-agent delegation by name, @name, or pubkey routes settings and wake file to target agent", async () => {
  const h = await setupHarness();
  try {
    const t1 = await h.call("orch_delegate", {
      runtime: "codex",
      agent: "@giraffe",
      prompt: "Check repo",
      chat: CHAT,
      cwd: h.workDir,
    });
    assert.equal(t1.workerPubkey, GIRAFFE);
    assert.equal(t1.workerName, "Giraffe");

    const cs = JSON.parse(await fs.readFile(path.join(h.dataDir, GIRAFFE, "chat-settings.json"), "utf8"));
    assert.equal(cs[t1.workerChannelId].runtime, "codex");
    assert.equal(cs[t1.workerChannelId].noOrchestrate, true);
    const wakes = await listWakes(h.dataDir, GIRAFFE);
    assert.equal(wakes.length, 1);
    assert.equal(wakes[0].data.channel, t1.workerChannelId);

    // Unknown or foreign-owner agent is refused clearly.
    await assert.rejects(
      () => h.call("orch_delegate", { runtime: "claude", agent: "NoSuchAgent", prompt: "hi", chat: CHAT, cwd: h.workDir }),
      /Unknown target agent "NoSuchAgent"/,
    );
    await assert.rejects(
      () => h.call("orch_delegate", { runtime: "claude", agent: FOREIGN, prompt: "hi", chat: CHAT, cwd: h.workDir }),
      /not found, is not activated, or belongs to a different owner/,
    );

    // Complete Giraffe's turn.
    const waitP = h.call("orch_wait", { taskId: t1.taskId, timeoutMs: 5000 });
    h.relay.deliver(t1.workerChannelId, GIRAFFE, "Repo looks clean.");
    await h.call("_acp_turn_done", { channel: t1.workerChannelId, stopReason: "end_turn" }, GIRAFFE);
    const res = await waitP;
    assert.equal(res.task.status, "completed");
    assert.equal(res.task.result.text, "Repo looks clean.");
  } finally {
    await h.cleanup();
  }
});

test("concurrency cap queues overflow FIFO, preserves target agent on promotion, and rejects beyond queue cap", async () => {
  const h = await setupHarness({ limits: { maxLive: 2, maxQueue: 2 } });
  try {
    const t1 = await h.call("orch_delegate", { runtime: "claude", prompt: "one", chat: CHAT, cwd: h.workDir });
    const t2 = await h.call("orch_delegate", { runtime: "codex", prompt: "two", chat: CHAT, cwd: h.workDir });
    const t3 = await h.call("orch_delegate", { runtime: "hermes", agent: "Giraffe", prompt: "three", chat: CHAT, cwd: h.workDir });
    const t4 = await h.call("orch_delegate", { runtime: "antigravity", prompt: "four", chat: CHAT, cwd: h.workDir });
    assert.equal(t1.status, "starting");
    assert.equal(t2.status, "starting");
    assert.equal(t3.status, "queued");
    assert.equal(t3.workerPubkey, GIRAFFE);
    assert.equal(t4.status, "queued");
    assert.equal(h.relay.created.length, 2);

    await assert.rejects(
      () => h.call("orch_delegate", { runtime: "claude", prompt: "five", chat: CHAT, cwd: h.workDir }),
      /Worker queue is full/,
    );

    // Finish t1 -> t3 promotes and opens its Solo chat on Giraffe!
    h.relay.deliver(t1.workerChannelId, CONDUCTOR, "done-1");
    await h.call("_acp_turn_done", { channel: t1.workerChannelId, stopReason: "end_turn" }, CONDUCTOR);
    await new Promise((r) => setTimeout(r, 30));

    const t3Status = await h.call("orch_status", { taskId: t3.taskId });
    assert.equal(t3Status.task.status, "starting");
    assert.equal(t3Status.task.workerPubkey, GIRAFFE);
    assert.ok(t3Status.task.workerChannelId);
    assert.equal(h.relay.created.length, 3);
    assert.equal((await listWakes(h.dataDir, GIRAFFE)).length, 1);
  } finally {
    await h.cleanup();
  }
});

test("orch_steer queues follow-up, posts visible message + second wake file, and ignores prompt echo on self-worker", async () => {
  const h = await setupHarness();
  try {
    const t = await h.call("orch_delegate", { runtime: "claude", prompt: "step 1", chat: CHAT, cwd: h.workDir });
    const steered = await h.call("orch_steer", { taskId: t.taskId, prompt: "step 2", chat: CHAT });
    assert.equal(steered.steerQueued, 1);

    // Complete turn 1 -> orchestrator posts step 2 + writes wake #2 in the SAME workerChannelId!
    h.relay.deliver(t.workerChannelId, CONDUCTOR, "answer 1");
    await h.call("_acp_turn_done", { channel: t.workerChannelId, stopReason: "end_turn" }, CONDUCTOR);
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(h.relay.posted.length, 2);
    assert.equal(h.relay.posted[1].channelId, t.workerChannelId);
    assert.equal(h.relay.posted[1].content, "step 2");
    const wakes = await listWakes(h.dataDir, CONDUCTOR);
    assert.equal(wakes.length, 2);
    assert.match(wakes[1].data.prompt, /<delegated-worker-followup[\s\S]*step 2/);

    // Complete turn 2 -> result contains ONLY the worker's two answers, never the echoed prompt!
    const waitP = h.call("orch_wait", { taskId: t.taskId, timeoutMs: 5000 });
    h.relay.deliver(t.workerChannelId, CONDUCTOR, "answer 2");
    await h.call("_acp_turn_done", { channel: t.workerChannelId, stopReason: "end_turn" }, CONDUCTOR);

    const res = await waitP;
    assert.equal(res.task.status, "completed");
    assert.equal(res.task.result.text, "answer 1\n\nanswer 2");
  } finally {
    await h.cleanup();
  }
});

test("orch_cancel unlinks unclaimed wake file, routes cancel to worker control socket, and settles cleanly", async () => {
  const h = await setupHarness({ limits: { cancelGraceMs: 80 } });
  try {
    const t = await h.call("orch_delegate", { runtime: "claude", prompt: "long", chat: CHAT, cwd: h.workDir });
    assert.equal((await listWakes(h.dataDir, CONDUCTOR)).length, 1);
    const cancelledTask = await h.call("orch_cancel", { taskId: t.taskId, chat: CHAT });
    assert.equal(cancelledTask.status, "cancelled");
    assert.equal(h.cancelled.length, 1);
    assert.deepEqual(h.cancelled[0], { workerPk: CONDUCTOR, chId: t.workerChannelId });
    assert.equal((await listWakes(h.dataDir, CONDUCTOR)).length, 0, "unclaimed wake file removed on cancel");
  } finally {
    await h.cleanup();
  }
});

test("per-task timeout unlinks unclaimed wake file, sends cancel to worker, and marks task timed_out", async () => {
  const h = await setupHarness({ limits: { minTimeoutMs: 50, cancelGraceMs: 50 } });
  try {
    const t = await h.call("orch_delegate", {
      runtime: "claude",
      prompt: "hang",
      timeoutMs: 60,
      chat: CHAT,
      cwd: h.workDir,
    });
    const waited = await h.call("orch_wait", { taskId: t.taskId, timeoutMs: 5000 });
    assert.equal(waited.timedOut, false);
    assert.equal(waited.task.status, "timed_out");
    assert.match(waited.task.error, /timed out/i);
    assert.equal(h.cancelled.length, 1);
    assert.equal((await listWakes(h.dataDir, CONDUCTOR)).length, 0);
  } finally {
    await h.cleanup();
  }
});

test("quota-banner reply and auth errors mark task failed (and auth error blacklists runtime)", async () => {
  const h = await setupHarness();
  try {
    assert.ok(runtimeRefusal("⚠ Individual quota reached. Resets in 48m."));
    assert.equal(runtimeRefusal("Normal answer"), "");

    // Quota banner -> failed (not completed), runtime not auth-blacklisted.
    const t1 = await h.call("orch_delegate", { runtime: "antigravity", prompt: "hi", chat: CHAT, cwd: h.workDir });
    const w1 = h.call("orch_wait", { taskId: t1.taskId, timeoutMs: 5000 });
    h.relay.deliver(t1.workerChannelId, CONDUCTOR, "⚠ Individual quota reached. Resets in 48m.");
    await h.call("_acp_turn_done", { channel: t1.workerChannelId, stopReason: "end_turn" }, CONDUCTOR);
    const r1 = await w1;
    assert.equal(r1.task.status, "failed");
    assert.match(r1.task.error, /Individual quota reached/);

    // Auth error from acp-proxy -> failed + codex marked unavailable in capabilities.
    const t2 = await h.call("orch_delegate", { runtime: "codex", prompt: "hi", chat: CHAT, cwd: h.workDir });
    const w2 = h.call("orch_wait", { taskId: t2.taskId, timeoutMs: 5000 });
    await h.call(
      "_acp_turn_done",
      { channel: t2.workerChannelId, error: "Authentication required", errorCode: -32000 },
      CONDUCTOR,
    );
    const r2 = await w2;
    assert.equal(r2.task.status, "failed");
    const caps = await h.call("orch_capabilities");
    const codex = caps.runtimes.find((r) => r.id === "codex");
    assert.equal(codex.available, false);
    assert.match(codex.reason, /Authentication required/);
  } finally {
    await h.cleanup();
  }
});

test("relay getMessages fallback captures self-worker reply and ignores Conductor's own prompt event", async () => {
  const h = await setupHarness();
  try {
    const t = await h.call("orch_delegate", { runtime: "claude", prompt: "hello prompt", chat: CHAT, cwd: h.workDir });
    const waitP = h.call("orch_wait", { taskId: t.taskId, timeoutMs: 5000 });
    // Store reply in relay WITHOUT firing watchChannel callback.
    const ev = h.relay.storeOnly(t.workerChannelId, CONDUCTOR, "fetched-via-query");
    await h.call(
      "_acp_turn_done",
      { channel: t.workerChannelId, stopReason: "end_turn", fallbackPosted: true },
      CONDUCTOR,
    );
    const res = await waitP;
    assert.equal(res.task.status, "completed");
    assert.equal(res.task.result.text, "fetched-via-query");
    assert.equal(res.task.replyEventId, ev.id);
  } finally {
    await h.cleanup();
  }
});

test("guardrails: opt-in, owner-initiated chat, per-chat MAX_DEPTH=1 even after owner steer, and spoofed turn-done ignored", async () => {
  // Orchestrator off is refused.
  const hOff = await setupHarness({ orchestrate: false });
  try {
    await assert.rejects(
      () => hOff.call("orch_capabilities"),
      /Orchestration is off/,
    );
  } finally {
    await hOff.cleanup();
  }

  const h = await setupHarness();
  try {
    // Non-owner chat is refused.
    await assert.rejects(
      () => h.call("orch_delegate", { runtime: "claude", prompt: "hi", chat: "other_chat", cwd: h.workDir }),
      /owner-initiated chats/,
    );

    const t = await h.call("orch_delegate", { runtime: "claude", prompt: "hi", chat: CHAT, cwd: h.workDir });

    // Even if the owner later posts in the worker Solo chat (recording OWNER in turn-authors.json),
    // calling orch_delegate from inside that worker Solo chat MUST be refused (MAX_DEPTH = 1).
    const authors = JSON.parse(await fs.readFile(path.join(h.dataDir, CONDUCTOR, "turn-authors.json"), "utf8"));
    authors[t.workerChannelId] = { author: OWNER, eventId: ORIGIN, at: Math.floor(Date.now() / 1000) };
    await fs.writeFile(path.join(h.dataDir, CONDUCTOR, "turn-authors.json"), JSON.stringify(authors));

    await assert.rejects(
      () => h.call("orch_delegate", { runtime: "claude", prompt: "recurse!", chat: t.workerChannelId, cwd: h.workDir }),
      /MAX_DEPTH = 1/,
    );

    // Spoofed _acp_turn_done from another pubkey is ignored.
    const spoofed = await h.call("_acp_turn_done", { channel: t.workerChannelId, stopReason: "end_turn" }, OTHER);
    assert.equal(spoofed.ok, false);
    const st = await h.call("orch_status", { taskId: t.taskId });
    assert.equal(st.task.status, "starting");

    // Finish task so it leaves soloByChannel, then verify chat-settings.json noOrchestrate STILL blocks recursion!
    h.relay.deliver(t.workerChannelId, CONDUCTOR, "done");
    await h.call("_acp_turn_done", { channel: t.workerChannelId, stopReason: "end_turn" }, CONDUCTOR);
    await h.call("orch_wait", { taskId: t.taskId, timeoutMs: 5000 });
    await assert.rejects(
      () => h.call("orch_delegate", { runtime: "claude", prompt: "recurse after finish!", chat: t.workerChannelId, cwd: h.workDir }),
      /MAX_DEPTH = 1/,
    );
  } finally {
    await h.cleanup();
  }
});

test("persistence across restart marks active tasks interrupted and keeps completed tasks", async () => {
  const h = await setupHarness();
  try {
    const t1 = await h.call("orch_delegate", { runtime: "claude", prompt: "finish me", chat: CHAT, cwd: h.workDir });
    h.relay.deliver(t1.workerChannelId, CONDUCTOR, "finished-ok");
    await h.call("_acp_turn_done", { channel: t1.workerChannelId, stopReason: "end_turn" }, CONDUCTOR);
    await h.call("orch_wait", { taskId: t1.taskId, timeoutMs: 5000 });

    const t2 = await h.call("orch_delegate", { runtime: "claude", prompt: "leave running", chat: CHAT, cwd: h.workDir });
    await h.orch.close();

    // Re-open orchestrator pointing at same stateDir.
    const orch2 = createOrchestrator({
      dataDir: h.dataDir,
      stateDir: h.stateDir,
      relay: makeFakeRelay(),
      limits: { checkShimAccess: false },
    });
    try {
      const view = await orch2.tasks({ pubkey: CONDUCTOR });
      const byId = new Map(view.tasks.map((t) => [t.taskId, t]));
      assert.equal(byId.get(t1.taskId).status, "completed");
      assert.equal(byId.get(t2.taskId).status, "interrupted");
    } finally {
      await orch2.close();
    }
  } finally {
    await h.cleanup();
  }
});

test("summary view clips long result text to 2000 chars with resultTruncated flag", async () => {
  const h = await setupHarness();
  try {
    const t = await h.call("orch_delegate", { runtime: "claude", prompt: "long output", chat: CHAT, cwd: h.workDir });
    const big = "x".repeat(3000);
    h.relay.deliver(t.workerChannelId, CONDUCTOR, big);
    await h.call("_acp_turn_done", { channel: t.workerChannelId, stopReason: "end_turn" }, CONDUCTOR);
    await h.call("orch_wait", { taskId: t.taskId, timeoutMs: 5000 });

    const listed = await h.call("orch_list", { chat: CHAT });
    assert.equal(listed.tasks[0].result.text.length, 2000);
    assert.equal(listed.tasks[0].resultTruncated, true);
  } finally {
    await h.cleanup();
  }
});

test("review regressions: concurrent delegate respects maxLive, expired chat-settings pruned, turn-2 dedup, forget target fails tasks", async () => {
  const h = await setupHarness({ limits: { maxLive: 2, maxQueue: 4 } });
  try {
    // Seed an expired orchestrated entry and a user-owned entry (no expiresAt) in Conductor's chat-settings.json.
    await fs.writeFile(
      path.join(h.dataDir, CONDUCTOR, "chat-settings.json"),
      JSON.stringify({
        "expired-chat": { runtime: "claude", noOrchestrate: true, expiresAt: Date.now() - 10_000 },
        "user-chat": { runtime: "claude", model: "opus" },
      }),
    );

    // Fire 4 concurrent orch_delegate calls simultaneously -> at most 2 may become "starting", 2 must be "queued".
    const results = await Promise.all([
      h.call("orch_delegate", { runtime: "claude", prompt: "c1", chat: CHAT, cwd: h.workDir }),
      h.call("orch_delegate", { runtime: "claude", agent: "Giraffe", prompt: "c2", chat: CHAT, cwd: h.workDir }),
      h.call("orch_delegate", { runtime: "claude", prompt: "c3", chat: CHAT, cwd: h.workDir }),
      h.call("orch_delegate", { runtime: "claude", prompt: "c4", chat: CHAT, cwd: h.workDir }),
    ]);
    const starting = results.filter((t) => t.status === "starting");
    const queued = results.filter((t) => t.status === "queued");
    assert.equal(starting.length, 2, "concurrent delegates never overshoot maxLive");
    assert.equal(queued.length, 2);

    // Expired entry was pruned while user-owned entry survived.
    const cs = JSON.parse(await fs.readFile(path.join(h.dataDir, CONDUCTOR, "chat-settings.json"), "utf8"));
    assert.equal(cs["expired-chat"], undefined);
    assert.deepEqual(cs["user-chat"], { runtime: "claude", model: "opus" });

    // Turn-2 relay query fallback must NOT re-ingest Turn 1's already-seen message ID.
    const tSelf = starting.find((t) => t.workerPubkey === CONDUCTOR);
    const tGiraffe = starting.find((t) => t.workerPubkey === GIRAFFE);
    assert.ok(tSelf && tGiraffe);
    await h.call("orch_steer", { taskId: tSelf.taskId, prompt: "follow-up", chat: CHAT });
    h.relay.deliver(tSelf.workerChannelId, CONDUCTOR, "turn-1-reply");
    await h.call("_acp_turn_done", { channel: tSelf.workerChannelId, stopReason: "end_turn" }, CONDUCTOR);
    await new Promise((r) => setTimeout(r, 20));
    // Turn 2 completes without delivering a new WS message -> falls back to finalText, not duplicated turn-1-reply.
    const waitT = h.call("orch_wait", { taskId: tSelf.taskId, timeoutMs: 5000 });
    await h.call("_acp_turn_done", { channel: tSelf.workerChannelId, stopReason: "end_turn", finalText: "turn-2-reply" }, CONDUCTOR);
    const doneT = await waitT;
    assert.equal(doneT.task.result.text, "turn-1-reply\n\nturn-2-reply");

    // Removing Giraffe fails active tasks delegated to Giraffe instead of orphaning them.
    const waitGiraffe = h.call("orch_wait", { taskId: tGiraffe.taskId, timeoutMs: 5000 });
    await h.orch.forget(GIRAFFE);
    const failedGiraffe = await waitGiraffe;
    assert.equal(failedGiraffe.task.status, "failed");
    assert.match(failedGiraffe.task.error, /Worker agent was removed/);
  } finally {
    await h.cleanup();
  }
});
