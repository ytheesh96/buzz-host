// node --test plugin/
// Direct unit tests for modular plugin/src/* modules and bundle sync verification.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_CONCURRENCY, DEFAULT_URL, EMPTY, asConfig, storedUrl } from "./src/config.js";
import { groupByProvider, modelChoices, profileOptions, providerOf } from "./src/ui.js";
import { buildTurns, parseFrame, promptRequest } from "./src/activity.js";
import { previewKeys } from "./src/desktop.js";
import { plain, schedule, titleOf, words } from "./src/attention.js";
import * as srcEntry from "./src/index.js";
import * as builtEntry from "./plugin.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = process.env.BUZZ_APP ?? path.join(os.homedir(), "Work/buzz-app");
const hasRolldown = fs.existsSync(path.join(app, "node_modules/.pnpm"));

test("config helpers normalize drafts and fall back to default URL", () => {
  assert.deepEqual(asConfig(undefined), EMPTY);
  assert.deepEqual(asConfig({ runtime: "hermes", profile: "work" }), {
    ...EMPTY,
    runtime: "hermes",
    profile: "work",
    concurrency: DEFAULT_CONCURRENCY,
  });
  assert.equal(storedUrl(), DEFAULT_URL);
});

test("ui helpers parse Hermes providers, group models, and build profile options", () => {
  assert.equal(providerOf("nous:anthropic/claude-opus"), "nous");
  assert.equal(providerOf("custom:local:llama"), "custom:local");
  assert.equal(providerOf("opus"), undefined);

  const hermesModels = [
    { id: "nous:claude", name: "Nous · Claude" },
    { id: "go:flash", name: "OpenCode Go · Flash" },
    { id: "go:pro", name: "OpenCode Go · Pro" },
  ];
  const groups = groupByProvider(hermesModels);
  assert.deepEqual(
    groups.map((g) => [g.key, g.label, g.models.length]),
    [
      ["nous", "Nous", 1],
      ["go", "OpenCode Go", 2],
    ],
  );
  const grouped = modelChoices(hermesModels);
  assert.equal(grouped.byFamily, true);
  assert.equal(grouped.models.length, 3);

  const flat = modelChoices([
    { id: "default", name: "Default" },
    { id: "opus", name: "Opus" },
  ]);
  assert.deepEqual(flat, { byFamily: false, models: [{ id: "opus", label: "Opus" }] });

  const opts = profileOptions(
    [
      { name: "default", model: "go:flash" },
      { name: "work", model: "nous:opus" },
    ],
    "missing",
  );
  assert.deepEqual(opts, [
    { value: "", label: "Default profile", description: "go:flash" },
    { value: "work", label: "work", description: "nous:opus" },
    { value: "missing", label: "missing", description: "Not on the server" },
  ]);
});

test("activity helpers parse observer frames and rebuild turns", () => {
  assert.equal(parseFrame({ plaintext: "not json" }), undefined);
  assert.equal(
    promptRequest("Content: first\nTags: []\nContent: second line\nTags: []"),
    "second line",
  );

  const agent = "a".repeat(64);
  const turns = buildTurns(
    [
      {
        agent,
        createdAt: 1000,
        plaintext: JSON.stringify({
          kind: "acp_write",
          turnId: "t1",
          channelId: "ch1",
          timestamp: "2026-11-22T10:00:00Z",
          payload: { id: 1, method: "session/prompt", params: { prompt: [{ text: "Content: hello\nTags: []" }] } },
        }),
      },
      {
        agent,
        createdAt: 1001,
        plaintext: JSON.stringify({
          kind: "acp_read",
          turnId: "t1",
          channelId: "ch1",
          payload: {
            method: "session/update",
            params: { update: { sessionUpdate: "tool_call", toolCallId: "c1", title: "Read file", status: "completed", kind: "read" } },
          },
        }),
      },
      {
        agent,
        createdAt: 1002,
        plaintext: JSON.stringify({
          kind: "acp_read",
          turnId: "t1",
          channelId: "ch1",
          payload: {
            method: "session/update",
            params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi!" } } },
          },
        }),
      },
      {
        agent,
        createdAt: 1003,
        plaintext: JSON.stringify({
          kind: "acp_read",
          turnId: "t1",
          channelId: "ch1",
          payload: { id: 1, result: { stopReason: "end_turn" } },
        }),
      },
      {
        agent: "b".repeat(64),
        createdAt: 1004,
        plaintext: JSON.stringify({ kind: "turn_completed", turnId: "other", channelId: "ch1" }),
      },
    ],
    agent,
  );
  assert.equal(turns.length, 1);
  assert.equal(turns[0].request, "hello");
  assert.equal(turns[0].reply, "hi!");
  assert.equal(turns[0].outcome, "end_turn");
  assert.equal(turns[0].tools.get("c1").title, "Read file");
});

test("desktop previewKeys picks latest turn per desktop agent for the triggering message", () => {
  const agents = new Set(["ag1"]);
  const snap = {
    turns: [
      { agent: "ag1", channelId: "c1", turnId: "t1", state: "done", timestamp: 10, triggeringEventIds: ["m1"] },
      { agent: "ag1", channelId: "c1", turnId: "t2", state: "working", timestamp: 20, triggeringEventIds: ["m1"], threadRootId: "r1" },
      { agent: "ag2", channelId: "c1", turnId: "t3", state: "working", timestamp: 30, triggeringEventIds: ["m1"] },
    ],
  };
  assert.equal(previewKeys(snap, "c1", "m1", agents), "ag1 t2 live r1");
  assert.equal(previewKeys(snap, "c1", "m2", agents), "");
});

test("attention formatting helpers format ids, headings, and schedules", () => {
  assert.equal(titleOf("ci-watch_pr"), "Ci watch pr");
  assert.equal(words("daily-check-a1b2c3d4-1111-2222-3333-444455556666"), "daily check");
  assert.equal(plain("## Watch [haiku](nostr:npub1abc) **now**"), "Watch haiku now");
  assert.equal(schedule({ interval: 3600, maxOccurrences: 3 }), "Every 1h · 3 runs");
  assert.equal(schedule({ interval: 300 }), "Every 5m");
  assert.equal(schedule({ interval: 45 }), "Every 45s");
});

test("plugin/src/index.js and bundled plugin/plugin.js expose the same API surface", () => {
  assert.deepEqual(builtEntry.inject, srcEntry.inject);
  assert.equal(typeof builtEntry.apply, "function");
  assert.equal(typeof builtEntry.catalogKey, "function");
  assert.equal(typeof builtEntry.catalogParams, "function");
  assert.equal(typeof builtEntry.composerModels, "function");

  for (const mod of [srcEntry, builtEntry]) {
    const cleanups = [];
    const registered = { types: [], tabs: [], accessories: [], cards: [] };
    try {
      mod.apply({
        react: { createElement: () => null },
        effect: (fn) => cleanups.push(fn()),
        agents: {
          register: (t) => registered.types.push(t),
          registerTab: (t) => registered.tabs.push(t),
        },
        conversation: { registerAccessory: (a) => registered.accessories.push(a) },
        settingsCards: { register: (c) => registered.cards.push(c) },
      });
      assert.deepEqual(registered.types.map((t) => t.id), ["omarchy"]);
      assert.deepEqual(registered.types[0].tabs.map((t) => t.id), ["activity", "attention", "settings"]);
      assert.deepEqual(registered.tabs.map((t) => t.id), ["catalog-sync"]);
      assert.deepEqual(registered.accessories.map((a) => a.id), ["desktop-preview"]);
      assert.deepEqual(registered.cards.map((c) => c.id), ["server"]);
    } finally {
      for (const fn of cleanups) fn?.();
    }
  }
});

test("plugin/plugin.js matches plugin/src/ via plugin/build.mjs --check", { skip: !hasRolldown && "no buzz-app rolldown" }, () => {
  execFileSync(process.execPath, [path.join(here, "build.mjs"), "--check", app], { stdio: "pipe" });
});
