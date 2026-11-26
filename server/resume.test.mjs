import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createLimitResume, isLimitText, limitStopOf } from "./resume.mjs";

const CHANNEL = "123e4567-e89b-42d3-a456-426614174000";
const CHANNEL2 = "123e4567-e89b-42d3-a456-426614174001";
const ROOT = "a".repeat(64);
const PK = "d".repeat(64);
const ERROR = "You've hit your 5-hour limit · resets 2:10am (America/New_York)";

async function setup() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "resume-test-"));
  const dataDir = path.join(home, "agents");
  await fs.mkdir(dataDir, { recursive: true });
  const agentDir = path.join(dataDir, PK);
  await fs.mkdir(agentDir, { recursive: true });
  const logs = [];
  const resume = createLimitResume({ dataDir, runDir: path.join(home, "run"), log: { log: (...a) => logs.push(a.join(" ")), warn: () => {} } });
  const wakeDir = path.join(agentDir, "wake");
  return { home, dataDir, agentDir, wakeDir, logs, resume };
}

async function pending(resume) {
  return (await resume.state(PK)).pending;
}

async function readWake(resume, wakeDir) {
  const names = (await fs.readdir(wakeDir)).filter((n) => n.endsWith(".json"));
  assert.equal(names.length, 1, `expected exactly one wake file, got ${names.length}`);
  return { request: JSON.parse(await fs.readFile(path.join(wakeDir, names[0]), "utf8")), name: names[0] };
}

test("limit detection: structured kinds and limit text, not tool output", () => {
  assert.equal(isLimitText("tool call failed: api rate limit exceeded"), true); // called only with runtime errors
  assert.equal(isLimitText("pushed 429 commits"), true); // substring false positive accepted upstream; narrow callers avoid it
  assert.equal(isLimitText("network error"), false);
  assert.deepEqual(limitStopOf({ errorKind: "rate_limit", resetsAt: "2026-11-26T07:10:00Z" }),
    { matched: true, errorKind: "rate_limit", resetsAt: "2026-11-26T07:10:00Z" });
  assert.deepEqual(limitStopOf({ stopReason: "usage_limit" }), { matched: true, errorKind: "usage_limit", resetsAt: "" });
  assert.deepEqual(limitStopOf({ error: "429 Too Many Requests" }), { matched: true, errorKind: "limit", resetsAt: "" });
  assert.deepEqual(limitStopOf({ error: "invalid request" }), { matched: false, errorKind: "", resetsAt: "" });
  assert.equal(limitStopOf({}).matched, false);
});

test("a limit stop schedules a resume at the reset time plus buffer", async () => {
  const { resume } = await setup();
  const resetsAt = new Date(Date.now() + 3600_000).toISOString();
  const out = await resume.call(PK, "_acp_limit_stop", { channel: CHANNEL, root: "", runtime: "claude", error: ERROR, errorKind: "rate_limit", resetsAt });
  assert.equal(out.ok, true);
  const key = `${CHANNEL}_`;
  const entry = (await pending(resume))[key];
  assert.ok(entry, "entry scheduled");
  assert.equal(entry.attempts, 1);
  assert.equal(entry.channel, CHANNEL);
  assert.equal(entry.lastError, ERROR);
  const expected = Date.parse(resetsAt) + 5 * 60_000;
  assert.ok(Math.abs(entry.nextAt - expected) < 5000, `nextAt ${entry.nextAt} ≈ reset+buffer ${expected}`);
});

test("without a reset time the backoff grows per attempt", async () => {
  const { resume } = await setup();
  const t0 = Date.now();
  await resume.call(PK, "_acp_limit_stop", { channel: CHANNEL, root: "", error: "429 Too Many Requests" });
  let key = `${CHANNEL}_`;
  let entry = (await pending(resume))[key];
  assert.ok(entry.nextAt >= t0 + 15 * 60_000 && entry.nextAt <= t0 + 15 * 60_000 + 2000);
  await resume.call(PK, "_acp_limit_stop", { channel: CHANNEL, root: "", error: "Usage limit exceeded again" });
  entry = (await pending(resume))[key];
  assert.equal(entry.attempts, 2);
  assert.ok(entry.nextAt >= t0 + 30 * 60_000 && entry.nextAt <= t0 + 30 * 60_000 + 2000);
});

test("the same stop reported twice counts once", async () => {
  const { resume } = await setup();
  await resume.call(PK, "_acp_limit_stop", { channel: CHANNEL, root: ROOT, error: ERROR });
  await resume.call(PK, "_acp_limit_stop", { channel: CHANNEL, root: ROOT, error: ERROR });
  const entry = (await pending(resume))[`${CHANNEL}_${ROOT}`];
  assert.equal(entry.attempts, 1);
});

test("a fourth consecutive stop gives up", async () => {
  const { resume } = await setup();
  for (const e of ["e1 rate limit", "e2 usage limit", "e3 too many requests"]) {
    await resume.call(PK, "_acp_limit_stop", { channel: CHANNEL, root: "", error: e });
  }
  assert.equal((await pending(resume))[`${CHANNEL}_`].attempts, 3);
  const out = await resume.call(PK, "_acp_limit_stop", { channel: CHANNEL, root: "", error: "e4 limit exceeded" });
  assert.equal(out.scheduled.dropped, true);
  assert.equal((await pending(resume))[`${CHANNEL}_`], undefined);
});

test("a normal turn end clears the pending resume and cancels an un-started wake file", async () => {
  const { resume, wakeDir } = await setup();
  await resume.call(PK, "_acp_limit_stop", { channel: CHANNEL, root: "", error: ERROR });
  const key = `${CHANNEL}_`;
  // Fire it, then un-drop it again as if buzz-acp hadn't picked it up yet.
  assert.equal(await resume._test.fire(PK, key, (await pending(resume))[key]), true);
  const entry = (await pending(resume))[key];
  assert.ok(entry.fired.startsWith("res-"));
  const fired = entry.fired;
  // Un-take the file: clear should remove it, not leave a stray wake.
  const out = await resume.call(PK, "_acp_limit_clear", { channel: CHANNEL, root: "" });
  assert.equal(out.cleared, true);
  assert.equal((await pending(resume))[key], undefined);
  const names = await fs.readdir(wakeDir);
  assert.ok(!names.some((n) => n.endsWith(`-${fired}.json`)), "wake file cancelled");
});

test("firing drops a buzz-acp wake request for the chat", async () => {
  const { resume, wakeDir } = await setup();
  await resume.call(PK, "_acp_limit_stop", { channel: CHANNEL, root: ROOT, error: ERROR, runtime: "claude" });
  const key = `${CHANNEL}_${ROOT}`;
  assert.equal(await resume._test.fire(PK, key, (await pending(resume))[key]), true);
  const { request } = await readWake(resume, wakeDir);
  assert.match(request.id, /^res-/);
  assert.equal(request.channel, CHANNEL);
  assert.equal(request.root, ROOT);
  assert.match(request.prompt, /<buzz-limit-resume>/);
  assert.match(request.prompt, /5-hour limit/);
});

test("a fired resume wake settling on ok clears its entry", async () => {
  const { resume } = await setup();
  await resume.call(PK, "_acp_limit_stop", { channel: CHANNEL, root: "", error: ERROR });
  const key = `${CHANNEL}_`;
  await resume._test.fire(PK, key, (await pending(resume))[key]);
  const fired = (await pending(resume))[key].fired;
  await resume.onWakeResult(PK, { id: fired, channel: CHANNEL, root: "" }, { outcome: "ok", detail: "end_turn" });
  assert.equal((await pending(resume))[key], undefined);
});

test("a fired resume wake hitting the limit again schedules the next attempt", async () => {
  const { resume } = await setup();
  await resume.call(PK, "_acp_limit_stop", { channel: CHANNEL, root: "", error: ERROR });
  const key = `${CHANNEL}_`;
  await resume._test.fire(PK, key, (await pending(resume))[key]);
  const fired = (await pending(resume))[key].fired;
  await resume.onWakeResult(PK, { id: fired, channel: CHANNEL, root: "" }, { outcome: "error", detail: ERROR });
  const entry = (await pending(resume))[key];
  assert.equal(entry.attempts, 2, "stop count carries over");
  assert.equal(entry.fired, "");
});

test("an Attention wake that stopped on a limit is retried with its own prompt", async () => {
  const { resume, wakeDir } = await setup();
  const wake = { id: "att-abc123-xyz", channel: CHANNEL, root: "", prompt: "CI finished for PR #12; fix the failures." };
  await resume.onWakeResult(PK, wake, { outcome: "error", detail: ERROR });
  const key = `${CHANNEL}_`;
  const entry = (await pending(resume))[key];
  assert.equal(entry.origin, "wake");
  assert.equal(entry.prompt, wake.prompt);
  assert.equal(await resume._test.fire(PK, key, entry), true);
  const { request } = await readWake(resume, wakeDir);
  assert.match(request.prompt, /CI finished for PR #12/);
  assert.match(request.prompt, /Retry what that wake asked/);
  assert.equal(request.channel, CHANNEL);
});

test("a res- wake whose entry the proxy already handled is not resurrected", async () => {
  const { resume } = await setup();
  await resume.call(PK, "_acp_limit_stop", { channel: CHANNEL, root: "", error: ERROR });
  const key = `${CHANNEL}_`;
  await resume._test.fire(PK, key, (await pending(resume))[key]);
  const fired = (await pending(resume))[key].fired;
  // The proxy path: the chat's turn ended normally first (clear), then the
  // wake result arrives late.
  await resume.call(PK, "_acp_limit_clear", { channel: CHANNEL, root: "" });
  await resume.onWakeResult(PK, { id: fired, channel: CHANNEL, root: "" }, { outcome: "error", detail: ERROR });
  assert.equal((await pending(resume))[key], undefined);
});

test("an opted-out agent schedules nothing and its due fires are dropped", async () => {
  const { resume, agentDir } = await setup();
  await fs.writeFile(path.join(agentDir, "meta.json"), JSON.stringify({ limitResume: false }));
  const out = await resume.call(PK, "_acp_limit_stop", { channel: CHANNEL, root: "", error: ERROR });
  assert.equal(out.skipped, "opted out");
  assert.deepEqual(await pending(resume), {});
});

test("a settled entry with three stops behind it is given up, not resurrected", async () => {
  const { resume } = await setup();
  for (const e of ["e1 rate limit", "e2 usage limit", "e3 too many requests"]) {
    await resume.call(PK, "_acp_limit_stop", { channel: CHANNEL, root: "", error: e });
  }
  const key = `${CHANNEL}_`;
  await resume._test.fire(PK, key, (await pending(resume))[key]);
  const fired = (await pending(resume))[key].fired;
  await resume.onWakeResult(PK, { id: fired, channel: CHANNEL, root: "" }, { outcome: "error", detail: "e4 limit exceeded" });
  assert.equal((await pending(resume))[key], undefined);
});

test("the tick settles a fired wake from its result file (channel-less path)", async () => {
  const { resume, wakeDir, agentDir } = await setup();
  const wake = { id: "att-ind-2", channel: "", root: "", prompt: "One-off: verify the deploy." };
  await resume.onWakeResult(PK, wake, { outcome: "error", detail: "429 Too Many Requests" });
  const key = "wake:att-ind-2";
  await resume._test.fire(PK, key, (await pending(resume))[key]);
  const fired = (await pending(resume))[key].fired;
  const resultsDir = path.join(wakeDir, "results");
  await fs.mkdir(resultsDir, { recursive: true });
  await fs.writeFile(path.join(resultsDir, `${fired}.json`), JSON.stringify({ outcome: "ok", detail: "end_turn", finished_at: 1 }));
  await resume._test.runTick();
  assert.equal((await pending(resume))[key], undefined);
});

test("a fired wake whose result is another limit schedules the next attempt via the tick", async () => {
  const { resume, wakeDir } = await setup();
  await resume.call(PK, "_acp_limit_stop", { channel: CHANNEL, root: "", error: ERROR });
  const key = `${CHANNEL}_`;
  await resume._test.fire(PK, key, (await pending(resume))[key]);
  const fired = (await pending(resume))[key].fired;
  const resultsDir = path.join(wakeDir, "results");
  await fs.mkdir(resultsDir, { recursive: true });
  await fs.writeFile(path.join(resultsDir, `${fired}.json`), JSON.stringify({ outcome: "error", detail: ERROR, finished_at: 1 }));
  await resume._test.runTick();
  const entry = (await pending(resume))[key];
  assert.equal(entry.attempts, 2, "stop count carries over");
  assert.equal(entry.fired, "");
});

test("invalid chat scopes are refused", async () => {
  const { resume } = await setup();
  await assert.rejects(resume.call(PK, "_acp_limit_stop", { channel: "not-a-channel", root: "", error: ERROR }), /Invalid chat scope/);
  await assert.rejects(resume.call(PK, "_acp_limit_stop", { channel: CHANNEL, root: "zz", error: ERROR }), /Invalid chat scope/);
});

test("independent wakes retry under their own key with no channel in the request", async () => {
  const { resume, wakeDir } = await setup();
  const wake = { id: "att-ind-1", channel: "", root: "", prompt: "One-off: verify the deploy." };
  await resume.onWakeResult(PK, wake, { outcome: "error", detail: "429 Too Many Requests" });
  const key = "wake:att-ind-1";
  const entry = (await pending(resume))[key];
  assert.ok(entry);
  assert.equal(await resume._test.fire(PK, key, entry), true);
  const { request } = await readWake(resume, wakeDir);
  assert.equal(request.channel, undefined);
  assert.equal(request.root, undefined);
  assert.match(request.prompt, /verify the deploy/);
});
