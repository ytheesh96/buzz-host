import test from "node:test";
import assert from "node:assert/strict";
import { RfbClientFilter, MAX_CUT_TEXT } from "./rfb-filter.mjs";

const HANDSHAKE = Buffer.concat([Buffer.from("RFB 003.008\n"), Buffer.from([1, 0])]);
const key = Buffer.from([4, 1, 0, 0, 0, 0, 0, 0x61]);
const pointer = Buffer.from([5, 0, 0, 10, 0, 20]);
const fbRequest = Buffer.from([3, 1, 0, 0, 0, 0, 5, 0, 3, 32]);
const setEncodings = Buffer.from([2, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 1]);
const cut = (s) => {
  const head = Buffer.from([6, 0, 0, 0, 0, 0, 0, 0]);
  head.writeInt32BE(s.length, 4);
  return Buffer.concat([head, Buffer.from(s)]);
};

test("handshake passes and ClientInit is forced shared", () => {
  const f = new RfbClientFilter(() => false);
  const out = f.feed(HANDSHAKE);
  assert.equal(out.length, 14);
  assert.equal(out[13], 1);
});

test("viewers without the lease cannot send input, but can request frames", () => {
  const f = new RfbClientFilter(() => false);
  f.feed(HANDSHAKE);
  const out = f.feed(Buffer.concat([key, fbRequest, pointer, setEncodings, cut("pw")]));
  assert.deepEqual(out, Buffer.concat([fbRequest, setEncodings]));
});

test("the lease holder's input passes", () => {
  const f = new RfbClientFilter(() => true);
  f.feed(HANDSHAKE);
  const all = Buffer.concat([key, pointer, cut("hi")]);
  assert.deepEqual(f.feed(all), all);
});

test("messages split across chunks are reassembled; lease checked per message", () => {
  let allow = true;
  const f = new RfbClientFilter(() => allow);
  f.feed(HANDSHAKE.subarray(0, 5));
  assert.equal(f.feed(HANDSHAKE.subarray(5)).length, 9);
  assert.equal(f.feed(key.subarray(0, 3)).length, 0);
  assert.deepEqual(f.feed(key.subarray(3)), key);
  allow = false;
  assert.equal(f.feed(pointer).length, 0);
});

test("oversized clipboard and unknown message types are rejected", () => {
  const f = new RfbClientFilter(() => true);
  f.feed(HANDSHAKE);
  const big = Buffer.from([6, 0, 0, 0, 0, 0, 0, 0]);
  big.writeInt32BE(MAX_CUT_TEXT + 1, 4);
  assert.throws(() => f.feed(big), /too large/);
  const g = new RfbClientFilter(() => true);
  g.feed(HANDSHAKE);
  assert.throws(() => g.feed(Buffer.from([77])), /unknown/);
});
