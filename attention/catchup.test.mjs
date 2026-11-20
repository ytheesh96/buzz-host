// Phase 2: catch-up, queue and rate limits, against a fake relay that reads
// as the Buzz relay does (newest first, ties by id ascending, before_id).
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAttention } from "../server/attention.mjs";

// Temp dirs made by this file, removed when it finishes.
const tmpDirs = [];
after(() => Promise.all(tmpDirs.map((d) => fs.rm(d, { recursive: true, force: true }))));

const AGENT = "a".repeat(64);
const OTHER = "c".repeat(64);
const A = "0b4e2c1a-5d6f-4a8b-9c0d-1e2f3a4b5c6d";
const B = "11111111-2222-4333-8444-555555555555";
const ABSENT = "object-v1:absent";
const quiet = { log() {}, warn() {} };

const realNow = Date.now;
let offset = 0;
Date.now = () => realNow() + offset;
const now = () => Math.floor(Date.now() / 1000);
const advance = (secs) => (offset += secs * 1000);

let counter = 0;
function event({ at, channel = A, pubkey = OTHER, content, tags = [] }) {
  counter++;
  return {
    id: createHash("sha256").update(`e${counter}`).digest("hex"),
    pubkey,
    kind: 9,
    created_at: at,
    content: content ?? `message ${counter}`,
    tags: [["h", channel], ...tags],
    sig: "f".repeat(128),
  };
}

function fakeRelay() {
  const relay = {
    events: [],
    epoch: 0,
    since: 0,
    members: new Set([A]),
    filter: { kinds: [9], "#h": [A] },
    connected: true,
    reads: 0,
    connect() {
      relay.epoch++;
      relay.since = now();
    },
    status: () => (relay.connected ? { epoch: relay.epoch, since: relay.since, members: relay.members, filter: relay.filter } : undefined),
    async query(_pubkey, f) {
      relay.reads++;
      return relay.events
        .filter(
          (e) =>
            f.kinds.includes(e.kind) &&
            (!f["#h"] || e.tags.some(([k, v]) => k === "h" && f["#h"].includes(v))) &&
            (f.since === undefined || e.created_at >= f.since) &&
            (f.until === undefined ||
              e.created_at < f.until ||
              (e.created_at === f.until && (f.before_id === undefined || e.id > f.before_id))),
        )
        .sort((x, y) => y.created_at - x.created_at || (x.id < y.id ? -1 : 1))
        .slice(0, f.limit ?? 500);
    },
  };
  return relay;
}

async function setup(relay, watch = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bh-catchup-"));
  tmpDirs.push(root);
  const dataDir = path.join(root, "agents");
  const agentDir = path.join(dataDir, AGENT);
  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(path.join(agentDir, "meta.json"), JSON.stringify({ pubkey: AGENT }));
  const make = () => {
    const attention = createAttention({ dataDir, runDir: path.join(root, "run"), log: quiet });
    attention.relay = relay;
    return attention;
  };
  const attention = make();
  await attention.setEnabled(AGENT, true);
  const tool = async (name, args) => JSON.parse(await attention.callTool(AGENT, name, args));
  await tool("interest_set", { id: "support", instructions: "Answer questions.", expected_state: ABSENT });
  await tool("watch_add", {
    interest: "support",
    id: "questions",
    type: "event",
    since: "now",
    channels: [A],
    kinds: [9],
    expected_state: ABSENT,
    ...watch,
  });
  const wakeDir = path.join(agentDir, "wake");
  const wakes = async () => (await fs.readdir(wakeDir).catch(() => [])).filter((n) => n.endsWith(".json")).sort();
  const take = async () => {
    const [name] = await wakes();
    assert.ok(name, "a wake request was written");
    const file = path.join(wakeDir, name);
    const request = JSON.parse(await fs.readFile(file, "utf8"));
    await fs.rm(file);
    return request;
  };
  const finish = async (attention, id) => {
    await fs.writeFile(path.join(wakeDir, "results", `${id}.json`), JSON.stringify({ id, outcome: "ok", finished_at: now() }));
    await attention.tick();
  };
  return { root, agentDir, attention, make, tool, wakes, take, finish };
}

async function until(check, ms = 5000) {
  const end = realNow() + ms;
  for (;;) {
    if (await check()) return;
    if (realNow() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("a restart catches each watch up once, oldest first; what live heard is never given again", async () => {
  const relay = fakeRelay();
  relay.connect();
  const s = await setup(relay);
  await s.attention.catchUp(AGENT, false); // the stream is new: starts now
  const t0 = now();

  // buzz-host is down: three messages arrive, plus the agent's own, a mention,
  // and one in another channel.
  advance(100);
  relay.events.push(
    event({ at: t0 + 30, content: "third" }),
    event({ at: t0 + 10, content: "first" }),
    event({ at: t0 + 20, content: "second" }),
    event({ at: t0 + 25, pubkey: AGENT, content: "my own" }),
    event({ at: t0 + 26, content: "@agent hi", tags: [["p", AGENT]] }),
    event({ at: t0 + 27, channel: B, content: "elsewhere" }),
  );
  const restarted = s.make();
  relay.connect();
  await restarted.catchUp(AGENT, false);
  await until(async () => (await s.wakes()).length === 1);
  const wake = await s.take();
  assert.equal(wake.channel, undefined);
  assert.match(wake.prompt, /You were offline, and this is catch-up: 3 messages/);
  const order = ["first", "second", "third"].map((word) => wake.prompt.indexOf(`"content":"${word}"`));
  assert.ok(order.every((i) => i > 0) && order[0] < order[1] && order[1] < order[2], "oldest first");
  assert.doesNotMatch(wake.prompt, /my own|@agent hi|elsewhere/);

  // Caught up: a later pass reads nothing new.
  await restarted.catchUp(AGENT, true);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await s.wakes()).length, 0);
  await s.finish(restarted, wake.id);

  // Live hears one; after another restart, catch-up does not give it again.
  advance(10);
  const heard = event({ at: now(), content: "heard live" });
  relay.events.push(heard);
  await restarted.watchEvent(AGENT, heard);
  const live = await s.take();
  assert.match(live.prompt, /heard live/);
  await s.finish(restarted, live.id);
  advance(50);
  const again = s.make();
  relay.connect();
  await again.catchUp(AGENT, false);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal((await s.wakes()).length, 0, "nothing is delivered twice");
});

test("long absences go in batches of 64; Attention off and back on replays nothing", async () => {
  const relay = fakeRelay();
  relay.connect();
  const s = await setup(relay);
  await s.attention.catchUp(AGENT, false);
  const t0 = now();
  advance(1000);
  for (let i = 0; i < 100; i++) relay.events.push(event({ at: t0 + 1 + i, content: `n${i}` }));
  const restarted = s.make();
  relay.connect();
  await restarted.catchUp(AGENT, false);
  await until(async () => (await s.wakes()).length === 1);
  const first = await s.take();
  assert.match(first.prompt, /64 messages/);
  await s.finish(restarted, first.id);
  await until(async () => (await s.wakes()).length === 1);
  const second = await s.take();
  assert.match(second.prompt, /36 messages/);
  await s.finish(restarted, second.id);

  // Off: messages while off are never replayed once it is back on.
  await restarted.setEnabled(AGENT, false);
  advance(60);
  relay.events.push(event({ at: now() - 5, content: "while off" }));
  advance(10);
  relay.connect();
  await restarted.setEnabled(AGENT, true);
  await restarted.catchUp(AGENT, false);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal((await s.wakes()).length, 0);
});

test("a burst queues 8 per Interest and drops the rest, recorded as dropped", async () => {
  const relay = fakeRelay();
  relay.connect();
  const s = await setup(relay);
  await s.attention.catchUp(AGENT, false);
  advance(5);
  for (let i = 0; i < 12; i++) await s.attention.watchEvent(AGENT, event({ at: now(), content: `burst ${i}` }));
  assert.equal((await s.wakes()).length, 1, "one wake per Interest at a time");
  const state = await s.attention.get(AGENT);
  assert.equal(state.queued, 8);
  assert.equal(state.history.filter((h) => h.outcome === "dropped").length, 3);
  // Each finished wake starts the next queued one, in order.
  const first = await s.take();
  assert.match(first.prompt, /burst 0/);
  await s.finish(s.attention, first.id);
  const next = await s.take();
  assert.match(next.prompt, /burst 1/);
});

test("a watch on every channel polls the ones live does not cover, without repeats", async () => {
  const relay = fakeRelay();
  relay.filter = { kinds: [9] };
  relay.connect();
  const s = await setup(relay, { channels: "all" });
  await s.attention.catchUp(AGENT, false);
  advance(5);
  // A public channel the agent has not joined: only a read finds it.
  relay.events.push(event({ at: now(), channel: B, content: "public, not joined" }));
  advance(40);
  await s.attention.catchUp(AGENT, true);
  await until(async () => (await s.wakes()).length === 1);
  const wake = await s.take();
  assert.match(wake.prompt, /public, not joined/);
  await s.finish(s.attention, wake.id);
  // Polled again later: the overlap re-reads it, and it is not given twice.
  advance(40);
  await s.attention.catchUp(AGENT, true);
  await new Promise((r) => setTimeout(r, 200));
  advance(40);
  await s.attention.catchUp(AGENT, true);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal((await s.wakes()).length, 0);
});
