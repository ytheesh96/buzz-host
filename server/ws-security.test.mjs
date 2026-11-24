// node --test server/ws-security.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  clientIpFromForwardedFor,
  createFragmentBuffer,
  createGuestSocketRegistry,
  createIdleWatch,
  GUEST_IDLE_TIMEOUT_MS,
  MAX_GUEST_SOCKETS,
  MAX_MESSAGE_BYTES,
  MAX_UNAUTHENTICATED_GUEST_SOCKETS,
} from "./ws-security.mjs";

test("fragment buffer concatenates fragments up to the total cap", () => {
  const buf = createFragmentBuffer({ maxBytes: 8 });
  assert.equal(buf.push(Buffer.from("abc")), true);
  assert.equal(buf.push(Buffer.from("def")), true);
  assert.equal(buf.bytes, 6);
  assert.equal(buf.count, 2);
  assert.equal(buf.take().toString("utf8"), "abcdef");
  // take() resets, so the next message starts from zero.
  assert.equal(buf.bytes, 0);
  assert.equal(buf.count, 0);
  assert.equal(buf.push(Buffer.from("12345678")), true);
  assert.equal(buf.take().toString("utf8"), "12345678");
});

test("fragment buffer rejects a message that would exceed the cap and clears itself", () => {
  const buf = createFragmentBuffer({ maxBytes: 8 });
  assert.equal(buf.push(Buffer.from("abcd")), true);
  // 4 + 5 > 8: rejected, and the partially accumulated message is dropped.
  assert.equal(buf.push(Buffer.from("efghi")), false);
  assert.equal(buf.bytes, 0);
  assert.equal(buf.count, 0);
  // The buffer is reusable after a rejection.
  assert.equal(buf.push(Buffer.from("1234")), true);
  assert.equal(buf.take().toString("utf8"), "1234");
});

test("fragment buffer does not accumulate unbounded continuation frames", () => {
  // Mirrors the attack: many small continuation frames each under the frame cap.
  const buf = createFragmentBuffer();
  const chunk = Buffer.alloc(64 * 1024, 0x61);
  let accepted = 0;
  for (let i = 0; i < 100; i += 1) {
    if (!buf.push(chunk)) break;
    accepted += 1;
  }
  assert.equal(accepted, MAX_MESSAGE_BYTES / chunk.length);
  assert.equal(buf.bytes, 0, "oversized message freed");
  assert.equal(buf.count, 0);
});

test("fragment buffer defaults to a 1 MiB message cap", () => {
  assert.equal(MAX_MESSAGE_BYTES, 1 << 20);
  const buf = createFragmentBuffer();
  assert.equal(buf.push(Buffer.alloc(MAX_MESSAGE_BYTES)), true);
  assert.equal(buf.push(Buffer.from("x")), false);
});

test("client IP comes from the rightmost X-Forwarded-For entry", () => {
  // Client-supplied leftmost value must not win: Funnel appends the real peer.
  assert.equal(clientIpFromForwardedFor("1.2.3.4, 203.0.113.9", "127.0.0.1"), "203.0.113.9");
  assert.equal(
    clientIpFromForwardedFor("spoofed, 10.0.0.1, 203.0.113.9", "127.0.0.1"),
    "203.0.113.9",
  );
  // Empty/whitespace entries are skipped.
  assert.equal(clientIpFromForwardedFor("1.2.3.4, , 203.0.113.9 ,", "127.0.0.1"), "203.0.113.9");
  assert.equal(clientIpFromForwardedFor("203.0.113.9"), "203.0.113.9");
  assert.equal(clientIpFromForwardedFor(["1.2.3.4", "203.0.113.9"]), "203.0.113.9");
});

test("client IP falls back when X-Forwarded-For is absent or empty", () => {
  assert.equal(clientIpFromForwardedFor(undefined, "::1"), "::1");
  assert.equal(clientIpFromForwardedFor("", "::1"), "::1");
  assert.equal(clientIpFromForwardedFor("  ,  ", "::1"), "::1");
  assert.equal(clientIpFromForwardedFor(undefined, undefined), "unknown");
});

test("guest registry enforces the unauthenticated socket cap", () => {
  const registry = createGuestSocketRegistry({ maxSockets: 64, maxUnauthenticated: 2 });
  const a = registry.admit();
  const b = registry.admit();
  assert.ok(a && b);
  assert.equal(registry.unauthenticated, 2);
  assert.equal(registry.admit(), null, "third unauthenticated socket refused");
  assert.equal(registry.total, 2, "refused admission is not counted");

  // Authenticating frees an unauthenticated slot but keeps the socket counted.
  a.authenticate();
  assert.equal(registry.unauthenticated, 1);
  assert.equal(registry.total, 2);
  const c = registry.admit();
  assert.ok(c);

  a.release();
  assert.equal(registry.total, 2, "release after authenticate only drops the total");
  assert.equal(registry.unauthenticated, 2);

  // Releasing an unauthenticated socket drops both counters; double release is a no-op.
  b.release();
  b.release();
  assert.equal(registry.total, 1);
  assert.equal(registry.unauthenticated, 1);
});

test("guest registry enforces the total socket cap and defaults", () => {
  assert.equal(MAX_GUEST_SOCKETS, 64);
  assert.equal(MAX_UNAUTHENTICATED_GUEST_SOCKETS, 16);

  const registry = createGuestSocketRegistry({ maxSockets: 2, maxUnauthenticated: 16 });
  const a = registry.admit();
  const b = registry.admit();
  assert.ok(a && b);
  a.authenticate();
  b.authenticate();
  assert.equal(registry.admit(), null, "authenticated sockets still count toward the total");
  assert.equal(registry.total, 2);

  a.release();
  const c = registry.admit();
  assert.ok(c, "a released slot is reusable");
  assert.equal(registry.total, 2);
});

test("guest registry defaults to 64 total / 16 unauthenticated sockets", () => {
  const registry = createGuestSocketRegistry();
  const slots = [];
  for (let i = 0; i < MAX_UNAUTHENTICATED_GUEST_SOCKETS; i += 1) slots.push(registry.admit());
  assert.ok(slots.every(Boolean));
  assert.equal(registry.admit(), null);

  for (const slot of slots) slot.authenticate();
  assert.equal(registry.unauthenticated, 0);
  while (registry.total < MAX_GUEST_SOCKETS) {
    const slot = registry.admit();
    assert.ok(slot, `admitted socket ${registry.total}`);
    slot.authenticate();
    slots.push(slot);
  }
  assert.equal(registry.total, MAX_GUEST_SOCKETS);
  assert.equal(registry.admit(), null);
});

test("idle watch fires once, and only while armed and unsettled", () => {
  const timers = [];
  const cleared = [];
  let fired = 0;
  const watch = createIdleWatch({
    timeoutMs: 15_000,
    onTimeout: () => {
      fired += 1;
    },
    setTimer: (fn, ms) => {
      const handle = { fn, ms };
      timers.push(handle);
      return handle;
    },
    clearTimer: (handle) => cleared.push(handle),
  });

  watch.arm();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, GUEST_IDLE_TIMEOUT_MS);
  assert.equal(watch.pending, true);

  timers[0].fn();
  assert.equal(fired, 1);
  assert.equal(watch.pending, false);
  // A timer that fires is settled: a second invocation is ignored.
  timers[0].fn();
  assert.equal(fired, 1);
});

test("idle watch cancel clears the timer so a late fire does nothing", () => {
  let fire = null;
  const cleared = [];
  let fired = 0;
  const watch = createIdleWatch({
    timeoutMs: 1000,
    onTimeout: () => {
      fired += 1;
    },
    setTimer: (fn) => {
      fire = fn;
      return { fn };
    },
    clearTimer: (handle) => cleared.push(handle),
  });

  watch.arm();
  watch.cancel();
  assert.equal(cleared.length, 1);
  assert.equal(watch.pending, false);
  fire();
  assert.equal(fired, 0);
});

test("idle watch is a no-op for a non-positive timeout", () => {
  let armed = false;
  const watch = createIdleWatch({
    timeoutMs: 0,
    onTimeout: () => {},
    setTimer: () => {
      armed = true;
      return {};
    },
  });
  watch.arm();
  assert.equal(armed, false);
  assert.equal(watch.pending, false);
});
