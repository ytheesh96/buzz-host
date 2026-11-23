// node --test plugin/
// Direct unit tests for modular plugin/src/* modules, split plugins, and bundle sync verification.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_CONCURRENCY,
  DEFAULT_URL,
  EMPTY,
  applyGuestConstraints,
  applyRespondToChange,
  applyRunnerChange,
  asConfig,
  formatAllowlistText,
  isSelfHostedAgent,
  parseAllowlistText,
  parseInviteInput,
  storedToken,
  storedUrl,
} from "./src/config.js";
import { groupByProvider, modelChoices, profileOptions, providerOf } from "./src/ui.js";
import { buildTurns, parseFrame, promptRequest } from "./src/activity.js";
import { previewKeys } from "./src/desktop.js";
import { plain, schedule, titleOf, words } from "./src/attention.js";
import * as remoteAgentsSrc from "./src/index.js";
import * as remoteAgentsBuilt from "./plugin.js";
import * as viewportSrc from "../plugins/viewport/src/index.js";
import * as viewportBuilt from "../plugins/viewport/plugin.js";
import * as hiveWatchSrc from "../plugins/hive-watch/src/index.js";
import * as hiveWatchBuilt from "../plugins/hive-watch/plugin.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = process.env.BUZZ_APP ?? path.join(os.homedir(), "Work/buzz-app");
const hasRolldown = fs.existsSync(path.join(app, "node_modules/.pnpm"));

test("config helpers normalize drafts, recognize self-hosted agents, and fall back to default URL", () => {
  assert.deepEqual(asConfig(undefined), EMPTY);
  assert.deepEqual(asConfig({ runtime: "hermes", profile: "work" }), {
    ...EMPTY,
    runtime: "hermes",
    profile: "work",
    concurrency: DEFAULT_CONCURRENCY,
  });
  assert.equal(storedUrl(), DEFAULT_URL);

  assert.equal(isSelfHostedAgent({ type: "omarchy" }), true);
  assert.equal(isSelfHostedAgent({ type: "local.buzz-host/omarchy" }), true);
  assert.equal(isSelfHostedAgent({ type: "remote/omarchy" }), true);
  assert.equal(isSelfHostedAgent({ type: "codex" }), false);
  assert.equal(isSelfHostedAgent({ type: "claude-code" }), false);
  assert.equal(isSelfHostedAgent(undefined), false);
  assert.equal(isSelfHostedAgent(null), false);

  // Sandbox runner & respondTo helpers enforce shared-agent isolation in UI drafts.
  const shared = applyRespondToChange({ ...EMPTY, runtime: "hermes", profile: "work" }, "anyone");
  assert.equal(shared.runner, "docker");
  assert.equal(shared.profile, "");
  assert.equal(shared.respondTo, "anyone");

  const backToHost = applyRunnerChange(shared, "host");
  assert.equal(backToHost.runner, "host");
  assert.equal(backToHost.respondTo, "owner-only");
  assert.deepEqual(backToHost.respondToAllowlist, []);

  const pk1 = "a".repeat(64);
  const pk2 = "b".repeat(64);
  assert.deepEqual(parseAllowlistText(`${pk1.toUpperCase()}, ${pk2}\n${pk1}`), [pk1, pk2]);
  assert.equal(formatAllowlistText([pk1, pk2]), `${pk1}\n${pk2}`);
  assert.equal(storedToken(), "");

  // 1-paste invite URL parsing
  assert.deepEqual(parseInviteInput("wss://omarchy.tail65c5a9.ts.net:8447"), {
    url: "wss://omarchy.tail65c5a9.ts.net:8447",
    token: undefined,
  });
  assert.deepEqual(parseInviteInput("wss://omarchy.tail65c5a9.ts.net/_buzz-host#token=bhg_abc123"), {
    url: "wss://omarchy.tail65c5a9.ts.net/_buzz-host",
    token: "bhg_abc123",
  });
  assert.deepEqual(parseInviteInput("wss://example.com/_buzz-host#foo=bar"), {
    url: "wss://example.com/_buzz-host#foo=bar",
    token: undefined,
  });

  // Guest UI constraints enforce docker runner, runtime allowlist, and concurrency cap
  const guestInfo = {
    role: "guest",
    limits: { maxAgents: 2, maxConcurrency: 2, allowedRuntimes: ["hermes", "claude"] },
  };
  const constrained = applyGuestConstraints(
    { ...EMPTY, runtime: "codex", model: "o3", profile: "work", concurrency: 8, runner: "host", respondTo: "anyone" },
    guestInfo,
  );
  assert.equal(constrained.runner, "docker");
  assert.equal(constrained.profile, "");
  assert.equal(constrained.runtime, "hermes");
  assert.equal(constrained.model, "");
  assert.equal(constrained.concurrency, 2);
  assert.equal(constrained.respondTo, "anyone");

  // Admin draft is unchanged by applyGuestConstraints
  const adminDraft = { ...EMPTY, runtime: "codex", runner: "host", concurrency: 8 };
  assert.deepEqual(applyGuestConstraints(adminDraft, { role: "admin" }), adminDraft);
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

test("Remote Agents: src and bundled plugin.js expose the same API surface", () => {
  assert.deepEqual(remoteAgentsBuilt.inject, remoteAgentsSrc.inject);
  assert.deepEqual(remoteAgentsBuilt.inject, ["react", "agents", "settingsCards"]);
  assert.equal(typeof remoteAgentsBuilt.apply, "function");
  assert.equal(typeof remoteAgentsBuilt.catalogKey, "function");
  assert.equal(typeof remoteAgentsBuilt.catalogParams, "function");
  assert.equal(typeof remoteAgentsBuilt.composerModels, "function");

  for (const mod of [remoteAgentsSrc, remoteAgentsBuilt]) {
    const cleanups = [];
    const registered = { types: [], tabs: [], cards: [] };
    try {
      mod.apply({
        react: { createElement: () => null },
        effect: (fn) => cleanups.push(fn()),
        agents: {
          register: (t) => registered.types.push(t),
          registerTab: (t) => registered.tabs.push(t),
        },
        settingsCards: { register: (c) => registered.cards.push(c) },
      });
      assert.deepEqual(registered.types.map((t) => t.id), ["omarchy"]);
      assert.equal(registered.types[0].title, "Self-hosted");
      assert.deepEqual(registered.types[0].tabs.map((t) => t.id), ["activity", "settings"]);
      assert.deepEqual(registered.tabs.map((t) => t.id), ["catalog-sync"]);
      assert.deepEqual(registered.cards.map((c) => c.id), ["server"]);
      assert.equal(registered.cards[0].title, "Remote Agents");
    } finally {
      for (const fn of cleanups) fn?.();
    }
  }
});

test("Viewport: src and bundled plugin.js expose the same API surface", () => {
  assert.deepEqual(viewportBuilt.inject, viewportSrc.inject);
  assert.deepEqual(viewportBuilt.inject, ["react", "agents", "conversation"]);
  assert.equal(typeof viewportBuilt.apply, "function");
  assert.equal(typeof viewportBuilt.previewKeys, "function");

  for (const mod of [viewportSrc, viewportBuilt]) {
    const cleanups = [];
    const registered = { tabs: [], accessories: [] };
    try {
      mod.apply({
        react: { createElement: () => null },
        effect: (fn) => cleanups.push(fn()),
        agents: {
          registerTab: (t) => registered.tabs.push(t),
        },
        conversation: {
          registerAccessory: (a) => registered.accessories.push(a),
        },
      });
      assert.deepEqual(registered.tabs.map((t) => t.id), ["desktop"]);
      assert.equal(registered.tabs[0].title, "Desktop");
      assert.equal(registered.tabs[0].when({ type: "omarchy" }), true);
      assert.equal(registered.tabs[0].when({ type: "local.buzz-host/omarchy" }), true);
      assert.equal(registered.tabs[0].when({ type: "claude-code" }), false);

      assert.deepEqual(registered.accessories.map((a) => a.id), ["desktop-preview"]);
      assert.equal(registered.accessories[0].title, "Agent desktop preview");
      assert.equal(registered.accessories[0].placement, "response");
    } finally {
      for (const fn of cleanups) fn?.();
    }
  }
});

test("Hive Watch: src and bundled plugin.js expose the same API surface", () => {
  assert.deepEqual(hiveWatchBuilt.inject, hiveWatchSrc.inject);
  assert.deepEqual(hiveWatchBuilt.inject, ["react", "agents"]);
  assert.equal(typeof hiveWatchBuilt.apply, "function");
  assert.equal(typeof hiveWatchBuilt.plain, "function");
  assert.equal(typeof hiveWatchBuilt.schedule, "function");
  assert.equal(typeof hiveWatchBuilt.titleOf, "function");
  assert.equal(typeof hiveWatchBuilt.words, "function");

  for (const mod of [hiveWatchSrc, hiveWatchBuilt]) {
    const cleanups = [];
    const registered = { tabs: [] };
    try {
      mod.apply({
        react: { createElement: () => null },
        effect: (fn) => cleanups.push(fn()),
        agents: {
          registerTab: (t) => registered.tabs.push(t),
        },
      });
      assert.deepEqual(registered.tabs.map((t) => t.id), ["attention"]);
      assert.equal(registered.tabs[0].title, "Attention");
      assert.equal(registered.tabs[0].when({ type: "omarchy" }), true);
      assert.equal(registered.tabs[0].when({ type: "local.buzz-host/omarchy" }), true);
      assert.equal(registered.tabs[0].when({ type: "claude-code" }), false);
    } finally {
      for (const fn of cleanups) fn?.();
    }
  }
});

test("all plugin bundles match their sources via plugin/build.mjs --check", { skip: !hasRolldown && "no buzz-app rolldown" }, () => {
  execFileSync(process.execPath, [path.join(here, "build.mjs"), "--check", app], { stdio: "pipe" });
});
