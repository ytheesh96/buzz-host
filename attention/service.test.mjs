// node --test attention/  — buzz-host's Attention service and MCP server,
// through the bundled Buzz code, against a temporary agent directory.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { createAttention } from "../server/attention.mjs";

// Temp dirs made by this file, removed when it finishes.
const tmpDirs = [];
after(() => Promise.all(tmpDirs.map((d) => fs.rm(d, { recursive: true, force: true }))));

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "../server");
const AGENT = "a".repeat(64);
const OWNER = "b".repeat(64);
const CHANNEL = "0b4e2c1a-5d6f-4a8b-9c0d-1e2f3a4b5c6d";
const ABSENT = "object-v1:absent";

const realNow = Date.now;
let offset = 0;
Date.now = () => realNow() + offset;
const advance = (secs) => (offset += secs * 1000);
const quiet = { log() {}, warn() {} };

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bh-attention-"));
  tmpDirs.push(root);
  const dataDir = path.join(root, "agents");
  const xdg = path.join(root, "xdg");
  const runDir = path.join(xdg, "buzz-host");
  await fs.mkdir(path.join(dataDir, AGENT), { recursive: true });
  await fs.writeFile(path.join(dataDir, AGENT, "meta.json"), JSON.stringify({ pubkey: AGENT }));
  const attention = createAttention({ dataDir, runDir, log: quiet });
  await attention.start();
  const agentDir = path.join(dataDir, AGENT);
  const tool = async (name, args) => JSON.parse(await attention.callTool(AGENT, name, args));
  const wakes = async () =>
    (await fs.readdir(path.join(agentDir, "wake")).catch(() => [])).filter((n) => n.endsWith(".json"));
  const takeWake = async () => {
    const [name] = await wakes();
    assert.ok(name, "a wake request was written");
    const file = path.join(agentDir, "wake", name);
    const request = JSON.parse(await fs.readFile(file, "utf8"));
    await fs.rm(file);
    return request;
  };
  const finish = (id, outcome = "ok") =>
    fs.writeFile(
      path.join(agentDir, "wake", "results", `${id}.json`),
      JSON.stringify({ id, outcome, detail: "EndTurn", finished_at: Math.floor(Date.now() / 1000) }),
    );
  return { root, xdg, agentDir, attention, tool, wakes, takeWake, finish };
}

test("timers run on Buzz's schedule, one wake per Interest, and a spent timer is removed", async (t) => {
  const s = await setup();
  t.after(() => s.attention.stop());

  await assert.rejects(s.tool("interest_list", {}), /Attention is off/);
  await s.attention.setEnabled(AGENT, true);

  const interest = await s.tool("interest_set", {
    id: "standup",
    title: "Standup",
    instructions: "Remind the owner about standup.",
    expected_state: ABSENT,
  });
  assert.equal(interest.result, "found");
  assert.match(await fs.readFile(path.join(s.agentDir, "attention-note.txt"), "utf8"), /review your Interests/);

  await assert.rejects(
    s.tool("watch_add", { interest: "standup", id: "fast", type: "timer", prompt: "x", interval_secs: 30, expected_state: ABSENT }),
    /at least 60/,
  );
  const added = await s.tool("watch_add", {
    interest: "standup",
    id: "remind",
    type: "timer",
    prompt: "Post the standup reminder.",
    interval_secs: 60,
    max_occurrences: 2,
    channel: CHANNEL,
    expected_state: ABSENT,
  });
  assert.equal(added.object.status, "armed");
  await s.tool("watch_add", { interest: "standup", id: "once", type: "timer", prompt: "x", interval_secs: 3600, expected_state: ABSENT });
  const listed = await s.attention.get(AGENT);
  assert.equal(listed.watches.find((w) => w.id === "once").summary, "Once", "a one-time timer is not 'Every …'");
  assert.equal(listed.watches.find((w) => w.id === "remind").summary, "Every minute");
  await s.attention.ownerEdit(AGENT, { op: "removeWatch", id: "once" });

  await s.attention.tick();
  assert.equal((await s.wakes()).length, 0, "not due yet");

  advance(61);
  await s.attention.tick();
  const first = await s.takeWake();
  assert.equal(first.channel, CHANNEL);
  assert.match(first.prompt, /<buzz-timer>/);
  assert.match(first.prompt, /Prompt: Post the standup reminder\./);
  assert.match(first.prompt, /<interest id="standup">/);
  assert.doesNotMatch(first.prompt, /spent: true/);

  advance(61);
  await s.attention.tick();
  assert.equal((await s.wakes()).length, 0, "its Interest is busy until the first wake ends");

  await s.finish(first.id);
  await s.attention.tick(); // collects the result, then the overdue run starts
  let state = await s.attention.get(AGENT);
  assert.equal(state.history.find((h) => h.id === first.id)?.outcome, "ok");
  const second = await s.takeWake();
  assert.match(second.prompt, /spent: true/);
  assert.ok(state.watches.some((w) => w.id === "remind"));

  await s.finish(second.id);
  await s.attention.tick();
  state = await s.attention.get(AGENT);
  assert.ok(!state.watches.some((w) => w.id === "remind"), "spent timer removed after its last successful wake");

  // Its wakes stay in the agent's list, but a new watch under the same id
  // starts with no Activity of its own (Buzz drops a removed watch's history).
  assert.ok(state.history.some((h) => h.slug === "watch/remind"));
  await s.tool("watch_add", { interest: "standup", id: "remind", type: "timer", prompt: "again", interval_secs: 3600, expected_state: ABSENT });
  const again = (await s.attention.get(AGENT)).watches.find((w) => w.id === "remind");
  assert.deepEqual(again.activity, []);
  assert.equal(again.lastWokeAt, undefined);
  assert.equal(state.inFlight.length, 0);
});

test("event watches wake on matching messages, never on the agent's own or on mentions", async (t) => {
  const s = await setup();
  t.after(() => s.attention.stop());
  await s.attention.setEnabled(AGENT, true);
  await s.tool("interest_set", { id: "support", instructions: "Answer questions.", expected_state: ABSENT });
  await s.tool("watch_add", {
    interest: "support",
    id: "questions",
    type: "event",
    since: "now",
    channels: [CHANNEL],
    kinds: [9],
    expected_state: ABSENT,
  });
  const event = (over) => ({
    id: "e".repeat(64),
    pubkey: OWNER,
    kind: 9,
    created_at: Math.floor(Date.now() / 1000) + 1,
    content: "how do I reset my password?",
    tags: [["h", CHANNEL]],
    sig: "f".repeat(128),
    ...over,
  });

  await s.attention.watchEvent(AGENT, event({ pubkey: AGENT }));
  await s.attention.watchEvent(AGENT, event({ tags: [["h", CHANNEL], ["p", AGENT]] }));
  await s.attention.watchEvent(AGENT, event({ tags: [["h", "11111111-2222-4333-8444-555555555555"]] }));
  assert.equal((await s.wakes()).length, 0);

  await s.attention.watchEvent(AGENT, event());
  const wake = await s.takeWake();
  assert.equal(wake.channel, undefined, "no delivery address: an independent turn");
  assert.match(wake.prompt, /<watch-task>/);
  assert.match(wake.prompt, /reset my password/);
  assert.match(wake.prompt, /buzz messages send --channel/);

  await s.attention.watchEvent(AGENT, event({ id: "d".repeat(64) }));
  assert.equal((await s.wakes()).length, 0, "its Interest is busy");

  const paused = await s.attention.ownerEdit(AGENT, { op: "pause", id: "support", paused: true });
  assert.equal(paused.interests[0].paused, true);
});

test("the buzz MCP server lists Buzz's tools and calls the service", async (t) => {
  const s = await setup();
  t.after(() => s.attention.stop());
  await s.attention.setEnabled(AGENT, true);
  const child = spawn(process.execPath, [path.join(SERVER, "buzz-mcp.mjs"), AGENT, "--attention"], {
    env: { ...process.env, XDG_RUNTIME_DIR: s.xdg },
    stdio: ["pipe", "pipe", "inherit"],
  });
  t.after(() => child.kill());
  const replies = readline.createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const rpc = async (id, method, params) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return JSON.parse((await replies.next()).value);
  };
  const init = await rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
  assert.equal(init.result.serverInfo.name, "buzz");
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const list = await rpc(2, "tools/list", {});
  const names = list.result.tools.map((tool) => tool.name);
  assert.equal(names.length, 15);
  assert.deepEqual(names.slice(0, 3), ["mem_get", "mem_set", "mem_rm"]);
  const set = await rpc(3, "tools/call", {
    name: "interest_set",
    arguments: { id: "x", instructions: "y", expected_state: ABSENT },
  });
  assert.equal(set.result.isError, undefined);
  assert.equal(JSON.parse(set.result.content[0].text).result, "found");
  const conflict = await rpc(4, "tools/call", {
    name: "interest_set",
    arguments: { id: "x", instructions: "z", expected_state: ABSENT },
  });
  assert.equal(conflict.result.isError, true);
  assert.match(conflict.result.content[0].text, /conflict/);
});

test("without Attention the buzz MCP server offers only memory", async (t) => {
  const child = spawn(process.execPath, [path.join(SERVER, "buzz-mcp.mjs"), AGENT], {
    env: { ...process.env, XDG_RUNTIME_DIR: path.join(os.tmpdir(), "buzz-host-none") },
    stdio: ["pipe", "pipe", "inherit"],
  });
  t.after(() => child.kill());
  const replies = readline.createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const rpc = async (id, method, params) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return JSON.parse((await replies.next()).value);
  };
  const list = await rpc(1, "tools/list", {});
  assert.deepEqual(list.result.tools.map((tool) => tool.name), ["mem_get", "mem_set", "mem_rm"]);
  const refused = await rpc(2, "tools/call", { name: "watch_add", arguments: {} });
  assert.equal(refused.result.isError, true);
  assert.match(refused.result.content[0].text, /No tool watch_add/);
  const offline = await rpc(3, "tools/call", { name: "mem_get", arguments: {} });
  assert.match(offline.result.content[0].text, /buzz-host is not running/);
});

test("Buzz's own Attention tab: the record in Buzz's shape, Buzz's edits and per-watch history", async (t) => {
  const s = await setup();
  t.after(() => s.attention.stop());
  await s.attention.setEnabled(AGENT, true);
  await s.tool("interest_set", { id: "news", instructions: "Watch the news.", expected_state: ABSENT });
  await s.tool("watch_add", { interest: "news", id: "tick", type: "timer", prompt: "Check the news.", interval_secs: 60, max_occurrences: 10, expected_state: ABSENT });
  let view = await s.attention.view(AGENT);
  const interest = view.record.attention["interest/news"];
  const timer = view.record.attention["watch/tick"];
  assert.equal(interest.value.type, "interest");
  assert.deepEqual(view.record.skipped, {});
  assert.equal(view.record.attentionHistory, undefined);

  // A timer's wake is kept as Buzz keeps it: when, and what it was asked.
  advance(61);
  await s.attention.tick();
  const wake = await s.takeWake();
  view = await s.attention.view(AGENT);
  const history = view.record.attentionHistory["watch/tick"];
  assert.ok(history.lastWokeAt > 0);
  assert.deepEqual(history.events.map((e) => e.text), ["Check the news."]);
  await s.finish(wake.id);
  await s.attention.tick();

  // A stale `expected` is refused, as in Buzz.
  await assert.rejects(
    s.attention.ownerChange(AGENT, {
      attentionExpected: { "interest/news": { ...interest, modifiedAt: 1 } },
      attention: { "interest/news": { ...interest.value, paused: true } },
    }),
    /Attention changed/,
  );
  // Pause the Interest, as Buzz's tab does.
  view = await s.attention.ownerChange(AGENT, {
    attentionExpected: { "interest/news": interest },
    attention: { "interest/news": { ...interest.value, paused: true } },
  });
  assert.equal(view.record.attention["interest/news"].value.paused, true);
  // Turn the watch off with its current object; history stays.
  const current = view.record.attention["watch/tick"];
  view = await s.attention.ownerChange(AGENT, { watchEnabled: { "watch/tick": { enabled: false, expected: current } } });
  assert.equal(view.record.attention["watch/tick"].value.enabled, false);
  assert.ok(view.record.attentionHistory["watch/tick"].lastWokeAt);
  await assert.rejects(
    s.attention.ownerChange(AGENT, { watchEnabled: { "watch/tick": { enabled: true, expected: timer } } }),
    /This watch changed/,
  );
  // An Interest with watches can't be deleted alone; with them it can.
  await assert.rejects(s.attention.ownerChange(AGENT, { attention: { "interest/news": null } }), /Remove or move the watches/);
  view = await s.attention.ownerChange(AGENT, { attention: { "watch/tick": null, "interest/news": null } });
  assert.deepEqual(view.record.attention, {});
});

test("attention-note.txt and wake prompts carry the no-runtime-scheduler guardrail both on and off", async (t) => {
  const s = await setup();
  t.after(() => s.attention.stop());

  // Syncing notes while Attention is off writes an Attention-off guardrail note.
  await s.attention.syncNotes([AGENT]);
  const offNote = await fs.readFile(path.join(s.agentDir, "attention-note.txt"), "utf8");
  assert.match(offNote, /Attention is off/);
  assert.match(offNote, /built-in timer, cron, or background scheduler/);
  assert.match(offNote, /Tell your owner that Attention is off instead/);

  // Turning Attention on switches to the active guardrail note.
  await s.attention.setEnabled(AGENT, true);
  const onNote = await fs.readFile(path.join(s.agentDir, "attention-note.txt"), "utf8");
  assert.match(onNote, /Always use Buzz Attention/);
  assert.match(onNote, /built-in timer, cron, or background scheduler/);

  // Timer wake prompt also includes the guardrail.
  await s.tool("interest_set", { id: "ci", instructions: "Watch CI.", expected_state: ABSENT });
  await s.tool("watch_add", { interest: "ci", id: "poll", type: "timer", prompt: "Check CI.", interval_secs: 60, expected_state: ABSENT });
  advance(61);
  await s.attention.tick();
  const wake = await s.takeWake();
  assert.match(wake.prompt, /built-in timer, cron, or background scheduler/);

  // Turning Attention back off restores the Attention-off guardrail note (instead of deleting it).
  await s.attention.setEnabled(AGENT, false);
  const offAgain = await fs.readFile(path.join(s.agentDir, "attention-note.txt"), "utf8");
  assert.match(offAgain, /Attention is off/);
  assert.match(offAgain, /Tell your owner that Attention is off instead/);
});
