// node --test plugin/
// The composer's model list from buzz-host's catalog answer.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { apply, catalogKey, catalogParams, composerModels } from "./plugin.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, "plugin.js"), "utf8");

test("other runtimes' models pass through grouped; a pending answer is kept briefly", () => {
  const answer = {
    current: "opus",
    models: [
      { id: "opus", label: "Claude Code · Opus 5.5", group: "Claude Code", efforts: [] },
      { id: "codex::gpt-5", label: "Codex · GPT-5", group: "Codex", efforts: [{ id: "low", label: "Low" }] },
    ],
  };
  const done = composerModels(answer);
  assert.deepEqual(done.models, answer, "Buzz's Models, untouched");
  assert.equal(done.ttlMs, 5 * 60_000);
  const pending = composerModels({ ...answer, runtimesPending: true });
  assert.deepEqual(pending.models, answer, "the flag isn't Buzz's");
  assert.equal(pending.ttlMs, 15_000);
});

test("an older buzz-host's single-runtime answer is used as it is", () => {
  const old = { current: "go:flash", models: [{ id: "go:flash", label: "OpenCode Go · flash", group: "OpenCode Go", efforts: [] }] };
  assert.deepEqual(composerModels(old), { models: old, ttlMs: 5 * 60_000 });
});

test("stock Buzz: the type registers again without models", () => {
  // Stock Buzz refuses `models` on a hosted type; the fallback registers without models/sessionControls.
  const calls = [];
  const cleanups = [];
  try {
    apply({
      react: { createElement: () => null },
      effect: (fn) => cleanups.push(fn()),
      agents: {
        register: (type) => {
          calls.push(type);
          if ("models" in type) throw new Error("A hosted agent type has no run, models or timeoutMs");
        },
        registerTab: () => {},
      },
      conversation: { registerAccessory: () => {} },
      settingsCards: { register: () => {} },
    });
    assert.equal(calls.length, 2);
    assert.equal(typeof calls[0].models, "function");
    assert.ok(calls[0].sessionControls);
    assert.equal("models" in calls[1], false);
    assert.equal("sessionControls" in calls[1], false);
    assert.equal(calls[1].id, "omarchy");
  } finally {
    for (const fn of cleanups) fn?.();
  }

  // Unrelated register errors are rethrown rather than silently swallowed.
  assert.throws(() => {
    const c = [];
    try {
      apply({
        react: { createElement: () => null },
        effect: (fn) => c.push(fn()),
        agents: {
          register: () => {
            throw new Error("duplicate type id");
          },
          registerTab: () => {},
        },
        conversation: { registerAccessory: () => {} },
        settingsCards: { register: () => {} },
      });
    } finally {
      for (const fn of c) fn?.();
    }
  }, /duplicate type id/);

  assert.match(source, /ctx\.agents\.register\(omarchyType\)/);
});

test("catalogKey and catalogParams scope requests to channel/thread when place is given", () => {
  const pubkey = "a".repeat(64);
  const channelId = "61ace2b8-1160-44c8-ad2b-6efd96b816af";
  const root = "b".repeat(64);

  assert.equal(catalogKey(pubkey), pubkey);
  assert.deepEqual(catalogParams(pubkey), { pubkey });

  assert.equal(catalogKey(pubkey, { channelId }), `${pubkey}|${channelId}|`);
  assert.deepEqual(catalogParams(pubkey, { channelId }), { pubkey, channelId, threadRootId: null });

  assert.equal(catalogKey(pubkey, { channelId, root }), `${pubkey}|${channelId}|${root}`);
  assert.deepEqual(catalogParams(pubkey, { channelId, root }), { pubkey, channelId, threadRootId: root });

  assert.equal(
    catalogKey(pubkey, { channelId, root }, "hermes:career-lead"),
    `${pubkey}|${channelId}|${root}|rt:hermes:career-lead`,
  );
  assert.deepEqual(catalogParams(pubkey, { channelId, root }, "hermes:career-lead"), {
    pubkey,
    channelId,
    threadRootId: root,
    runtime: "hermes:career-lead",
  });
});

test("hostedModels caches per conversation and invalidates when session.state reports a chat change", async () => {
  const pubkey = "7".repeat(64);
  const ch = "61ace2b8-1160-44c8-ad2b-6efd96b816af";
  const thA = "a".repeat(64);
  const thB = "b".repeat(64);
  const calls = [];
  let threadAChat = { runtime: "claude", model: "", effort: "" };

  class FakeWebSocket {
    static OPEN = 1;
    constructor() {
      this.readyState = 0;
      queueMicrotask(() => {
        this.readyState = FakeWebSocket.OPEN;
        this.onopen?.();
      });
    }
    send(raw) {
      const msg = JSON.parse(raw);
      calls.push(msg);
      let result;
      if (msg.method === "catalog") {
        const current =
          msg.params.runtime === "hermes:career-lead"
            ? "go:flash"
            : msg.params.threadRootId === thA && threadAChat.runtime === "antigravity"
              ? "antigravity::gemini-4-neon"
              : "default";
        result = {
          current,
          models: [
            { id: "default", label: "Claude Code · Default", group: "Claude Code", efforts: [] },
            { id: "antigravity::gemini-4-neon", label: "Antigravity · Gemini 4 Neon", group: "Antigravity", efforts: [] },
            { id: "go:flash", label: "OpenCode Go · flash", group: "OpenCode Go", efforts: [] },
          ],
        };
      } else if (msg.method === "session.state") {
        result = {
          state: "idle",
          chat: msg.params.threadRootId === thA ? { ...threadAChat } : { runtime: "claude", model: "", effort: "" },
        };
      } else {
        result = {};
      }
      queueMicrotask(() => {
        this.onmessage?.({ data: JSON.stringify({ id: msg.id, result }) });
      });
    }
    close() {
      this.readyState = 3;
      this.onclose?.();
    }
  }

  const prevWS = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket;
  const cleanups = [];
  let registered;
  let tabSync;
  try {
    apply({
      react: { createElement: () => null },
      effect: (fn) => cleanups.push(fn()),
      agents: {
        register: (type) => {
          registered = type;
        },
        registerTab: (tab) => {
          if (tab.id === "catalog-sync") tabSync = tab;
        },
      },
      conversation: { registerAccessory: () => {} },
      settingsCards: { register: () => {} },
    });

    let notified = 0;
    const stopCatalogSync = tabSync.subscribe(() => {
      notified++;
    });
    const stopSessions = registered.sessionControls.subscribe(() => {});

    const agent = { pubkey };
    const placeA = { channelId: ch, root: thA };
    const placeB = { channelId: ch, root: thB };

    // Two threads cache independently.
    const a1 = await registered.models(agent, placeA);
    const b1 = await registered.models(agent, placeB);
    assert.equal(a1.current, "default");
    assert.equal(b1.current, "default");
    assert.equal(calls.filter((c) => c.method === "catalog").length, 2);

    // Seed session.state for thread A (fires immediate poll).
    registered.sessionControls.state(agent, placeA);
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(notified, 0, "initial chat state does not spuriously invalidate");

    // Simulate switching thread A to Antigravity on the server, then a session action poll.
    threadAChat = { runtime: "antigravity", model: "gemini-4-neon", effort: "" };
    await registered.sessionControls.run(agent, placeA, "new");
    assert.equal(notified, 1, "chat change invalidates thread A and notifies Buzz");

    // Thread A re-fetches and returns Antigravity; thread B stays cached (no extra catalog call).
    const a2 = await registered.models(agent, placeA);
    const b2 = registered.models(agent, placeB);
    assert.equal(a2.current, "antigravity::gemini-4-neon");
    assert.equal(b2.current, "default");
    assert.equal(calls.filter((c) => c.method === "catalog").length, 3);

    // Runtime preview caches independently per runtime and is invalidated with the chat.
    const preview = await registered.models(agent, placeA, "hermes:career-lead");
    assert.equal(preview.current, "go:flash");
    assert.equal(calls.at(-1).params.runtime, "hermes:career-lead");

    // Backward compatibility: older Buzz calling models(agent) with no place.
    const noPlace = await registered.models(agent);
    assert.equal(noPlace.current, "default");
    assert.deepEqual(calls.at(-1).params, { pubkey });

    stopSessions();
    stopCatalogSync();
  } finally {
    for (const fn of cleanups) fn?.();
    globalThis.WebSocket = prevWS;
  }
});
