import { test } from "node:test";
import assert from "node:assert/strict";
import { filterFor, signEvent } from "../server/attention-relay.mjs";
import { schnorr, sha256, bytesToHex, hexToBytes } from "../server/noble.mjs";
import { CHANNEL_KINDS } from "../server/attention-core.mjs";

const A = "0b4e2c1a-5d6f-4a8b-9c0d-1e2f3a4b5c6d";
const B = "11111111-2222-4333-8444-555555555555";
const watch = (over) => ({
  value: { type: "event", interest_id: "i", enabled: true, since: 1, channels: [A], kinds: [9], ...over },
});
const record = (attention, enabled = true) => ({
  attentionEnabled: enabled,
  attention: { "interest/i": { value: { type: "interest", instructions: "x" } }, ...attention },
});

test("the subscription covers exactly the live event watches", () => {
  assert.equal(filterFor(record({ "watch/a": watch() }, false)), null, "Attention off");
  assert.equal(filterFor(record({ "watch/a": watch({ enabled: false }) })), null);
  assert.deepEqual(filterFor(record({ "watch/a": watch(), "watch/b": watch({ channels: [B], kinds: [9, 7] }) })), {
    kinds: [7, 9],
    "#h": [A, B].sort(),
  });
  assert.deepEqual(filterFor(record({ "watch/a": watch({ channels: "all", kinds: [] }) })), {
    kinds: [...CHANNEL_KINDS].sort((a, b) => a - b),
  });
  const paused = record({ "watch/a": watch() });
  paused.attention["interest/i"].value.paused = true;
  assert.equal(filterFor(paused), null, "a paused Interest's watches are not heard");
});

test("signed events have the NIP-01 id and a valid BIP-340 signature", () => {
  const secret = "1".repeat(64);
  const event = signEvent(secret, { kind: 22242, tags: [["relay", "wss://r"], ["challenge", "c"]], content: "", created_at: 1700000000 });
  assert.equal(event.pubkey, bytesToHex(schnorr.getPublicKey(hexToBytes(secret))));
  const serialized = JSON.stringify([0, event.pubkey, 1700000000, 22242, event.tags, ""]);
  assert.equal(event.id, bytesToHex(sha256(new TextEncoder().encode(serialized))));
  assert.ok(schnorr.verify(hexToBytes(event.sig), hexToBytes(event.id), hexToBytes(event.pubkey)));
});
