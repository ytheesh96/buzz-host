import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as L from "./lease.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lease-"));

test("fresh desktop: the agent holds", () => {
  const d = tmp();
  assert.equal(L.readLease(d).holder, L.AGENT);
  assert.doesNotThrow(() => L.assertAgentMayAct(d));
});

test("take over refuses the agent; hand back restores it", () => {
  const d = tmp();
  const a = L.acquire(d, "v1", "log in please");
  assert.equal(a.holder, L.HUMAN);
  assert.equal(a.epoch, 1);
  assert.throws(() => L.assertAgentMayAct(d), L.HumanHasControl);
  assert.ok(L.viewerMaySendInput(d, "v1"));
  assert.ok(!L.viewerMaySendInput(d, "v2"));
  assert.equal(L.release(d, { viewerId: "v2" }).holder, L.HUMAN, "another viewer cannot release");
  assert.equal(L.release(d, { viewerId: "v1" }).holder, L.AGENT);
  assert.equal(L.readLease(d).epoch, 2);
});

test("re-acquire by the holder does not bump the epoch; a second viewer evicts", () => {
  const d = tmp();
  L.acquire(d, "v1");
  assert.equal(L.acquire(d, "v1").epoch, 1);
  const l = L.acquire(d, "v2");
  assert.equal(l.viewer_id, "v2");
  assert.equal(l.epoch, 2);
});

test("release with a stale epoch is ignored", () => {
  const d = tmp();
  const { epoch } = L.acquire(d, "v1");
  L.release(d);
  L.acquire(d, "v1");
  assert.equal(L.release(d, { epoch }).holder, L.HUMAN);
});

test("corrupt or unreadable lease fails closed", () => {
  const d = tmp();
  fs.writeFileSync(L.leasePath(d), "{not json");
  assert.equal(L.readLease(d).holder, L.HUMAN);
  fs.writeFileSync(L.leasePath(d), JSON.stringify({ holder: "robot", epoch: 1 }));
  assert.equal(L.readLease(d).holder, L.HUMAN);
  assert.throws(() => L.assertAgentMayAct(d), L.HumanHasControl);
  // The next write repairs it.
  assert.equal(L.release(d).holder, L.AGENT);
  assert.equal(L.readLease(d).holder, L.AGENT);
});

test("public view hides the viewer id", () => {
  const v = L.publicView(L.acquire(tmp(), "secret-viewer"));
  assert.equal(v.viewer_id, undefined);
  assert.match(v.viewer_hash, /^[0-9a-f]{12}$/);
});

test("a stale lock from a crashed writer is broken", () => {
  const d = tmp();
  const lock = path.join(d, "lease.lock");
  fs.writeFileSync(lock, "");
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lock, old, old);
  assert.equal(L.acquire(d, "v1").holder, L.HUMAN);
});
