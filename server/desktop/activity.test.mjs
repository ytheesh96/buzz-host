// node --test server/desktop/
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "buzz-desktop-activity-"));
process.env.BUZZHOST_DESKTOP_ROOT = root;
const desktop = await import("./desktop.mjs");

const PUBKEY = "a".repeat(64);
const CH1 = "123e4567-e89b-42d3-a456-426614174000";
const CH2 = "223e4567-e89b-42d3-a456-426614174000";
const ROOT1 = "1".repeat(64);
const ROOT2 = "2".repeat(64);

test("tracks computer use per chat without leaking across chats or threads", () => {
  desktop.recordUse(PUBKEY, "get_desktop_state", CH1);
  assert.equal(desktop.lastUse(PUBKEY)?.tool, "get_desktop_state");
  assert.equal(desktop.lastUse(PUBKEY)?.chat, CH1);
  // Solo chat (session keyed by bare channelId) matches with or without threadRootId.
  assert.equal(desktop.lastUse(PUBKEY, { channelId: CH1 })?.tool, "get_desktop_state");
  assert.equal(desktop.lastUse(PUBKEY, { channelId: CH1, threadRootId: ROOT1 })?.tool, "get_desktop_state");
  // Different channel gets nothing.
  assert.equal(desktop.lastUse(PUBKEY, { channelId: CH2 }), null);
  assert.equal(desktop.lastUse(PUBKEY, { channelId: CH2, threadRootId: ROOT2 }), null);

  // Thread-scoped use in CH2 does not leak to another thread in CH2.
  desktop.recordUse(PUBKEY, "click", `${CH2}_${ROOT1}`);
  assert.equal(desktop.lastUse(PUBKEY, { channelId: CH2, threadRootId: ROOT1 })?.tool, "click");
  assert.equal(desktop.lastUse(PUBKEY, { channelId: CH2, threadRootId: ROOT2 }), null);
  assert.equal(desktop.lastUse(PUBKEY, { channelId: CH2 }), null);
  // CH1's own record is still preserved.
  assert.equal(desktop.lastUse(PUBKEY, { channelId: CH1 })?.tool, "get_desktop_state");
});

test("falls back to unscoped record when BUZZHOST_CHAT was not provided", () => {
  const pk = "b".repeat(64);
  desktop.recordUse(pk, "screenshot", "");
  assert.equal(desktop.lastUse(pk)?.tool, "screenshot");
  assert.equal(desktop.lastUse(pk, { channelId: CH1 })?.tool, "screenshot");
  assert.equal(desktop.lastUse(pk, { channelId: CH2, threadRootId: ROOT1 })?.tool, "screenshot");
});
