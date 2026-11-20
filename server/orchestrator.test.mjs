// node --test server/orchestrator.test.mjs
// Covers orchestrator lifecycle, concurrency cap + FIFO queue, timeout,
// cancellation, steering order + trailing stream drain, restart persistence
// (running -> interrupted), owner-initiated chat gate, worker env isolation
// (MAX_DEPTH = 1 + stripped BUZZ*/WAYLAND_DISPLAY), and Codex auth failure.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createOrchestrator, MAX_DEPTH, MAX_LIVE, ORCHESTRATOR_TOOLS } from "./orchestrator.mjs";

const OWNER = "1".repeat(64);
const OTHER = "2".repeat(64);
const AGENT = "a".repeat(64);
const CHANNEL = "123e4567-e89b-42d3-a456-426614174000";
const ROOT = "f".repeat(64);
const CHAT = `${CHANNEL}_${ROOT}`;
const ORIGIN = "e".repeat(64);

const MOCK_SHIM_BODY = `#!/usr/bin/env node
import readline from "node:readline";
import fs from "node:fs";

const mode = process.env.MOCK_MODE || "echo";
const envDump = process.env.MOCK_ENV_DUMP || "";
if (envDump) {
  fs.writeFileSync(envDump, JSON.stringify({ env: process.env, argv: process.argv.slice(2) }));
}

let cancelled = false;
let turnTimer = null;
let pendingPromptId = null;
let promptCount = 0;

const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
const rl = readline.createInterface({ input: process.stdin });

rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    return send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } });
  }
  if (msg.method === "session/new") {
    if (mode === "auth_error") {
      return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "Authentication required" } });
    }
    if (mode === "generic_32000") {
      return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "Temporary backend overload" } });
    }
    return send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        sessionId: "sess-1",
        configOptions: [
          { id: "model", category: "model", currentValue: "default-m", options: [{ value: "default-m", name: "Default" }, { value: "fast-m", name: "Fast" }] },
          { id: "effort", category: "thought_level", currentValue: "medium", options: [{ value: "low", name: "Low" }, { value: "medium", name: "Medium" }, { value: "high", name: "High" }] },
        ],
        mcpServersCount: (msg.params?.mcpServers || []).length,
      },
    });
  }
  if (msg.method === "session/set_config_option") {
    return send({ jsonrpc: "2.0", id: msg.id, result: { configOptions: [] } });
  }
  if (msg.method === "session/cancel") {
    cancelled = true;
    if (turnTimer) clearTimeout(turnTimer);
    if (pendingPromptId !== null) {
      const id = pendingPromptId;
      pendingPromptId = null;
      send({ jsonrpc: "2.0", id, result: { stopReason: "cancelled" } });
    }
    return;
  }
  if (msg.method === "session/prompt") {
    promptCount++;
    cancelled = false;
    const text = (msg.params?.prompt || []).map((b) => b.text || "").join("\\n");
    const delayMatch = text.match(/DELAY=(\\d+)/);
    const delay = delayMatch ? Number(delayMatch[1]) : 40;

    if (text.includes("ASK_PERM")) {
      send({
        jsonrpc: "2.0",
        id: "perm-1",
        method: "session/request_permission",
        params: { options: [{ optionId: "deny", kind: "reject_once" }, { optionId: "ok-once", kind: "allow_once" }] },
      });
    }
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: { update: { sessionUpdate: "tool_call", title: "Read README.md", status: "in_progress" } },
    });

    if (text.includes("HANG")) {
      pendingPromptId = msg.id;
      return;
    }

    pendingPromptId = msg.id;
    turnTimer = setTimeout(() => {
      if (cancelled) return;
      const id = pendingPromptId;
      pendingPromptId = null;
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "turn" + promptCount + ":" + text } } },
      });
      if (text.includes("TRAILING_CHUNK")) {
        // Reply resolves BEFORE the last chunk arrives (real-world adapter behavior).
        send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
        setTimeout(() => {
          send({
            jsonrpc: "2.0",
            method: "session/update",
            params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "+TRAIL" } } },
          });
        }, 40);
        return;
      }
      send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
    }, delay);
  }
});
`;

async function setupEnv({ orchestrate = true, author = OWNER, shims = {} } = {}) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "buzz-orch-test-"));
  const dataDir = path.join(tmp, "agents");
  const stateDir = path.join(tmp, "orchestrator");
  const shimsDir = path.join(tmp, "shims");
  const workDir = path.join(tmp, "workspace");
  await fs.mkdir(path.join(dataDir, AGENT), { recursive: true });
  await fs.mkdir(shimsDir, { recursive: true });
  await fs.mkdir(workDir, { recursive: true });

  await fs.writeFile(
    path.join(dataDir, AGENT, "meta.json"),
    JSON.stringify({ pubkey: AGENT, name: "haiku", owner: OWNER, runtime: "claude", orchestrate }),
  );
  if (author !== null) {
    await fs.writeFile(
      path.join(dataDir, AGENT, "turn-authors.json"),
      JSON.stringify({ [CHAT]: { author, eventId: ORIGIN, at: Math.floor(Date.now() / 1000) } }),
    );
  }

  for (const [file, body] of Object.entries({
    "claude-agent-acp": MOCK_SHIM_BODY,
    "codex-acp": MOCK_SHIM_BODY.replace('process.env.MOCK_MODE || "echo"', '"auth_error"'),
    "hermes-acp": MOCK_SHIM_BODY,
    "antigravity-acp": MOCK_SHIM_BODY,
    ...shims,
  })) {
    const p = path.join(shimsDir, file);
    await fs.writeFile(p, body, { mode: 0o755 });
    await fs.chmod(p, 0o755);
  }

  return {
    tmp,
    dataDir,
    stateDir,
    shimsDir,
    workDir,
    cleanup: () => fs.rm(tmp, { recursive: true, force: true }),
  };
}

test("full lifecycle: delegate, permission auto-allow, trailing chunk drain, wait, status, list", async () => {
  const env = await setupEnv();
  const orch = createOrchestrator({
    dataDir: env.dataDir,
    stateDir: env.stateDir,
    shimsDir: env.shimsDir,
    limits: { idleDrainMs: 90, maxIdleDrainMs: 600 },
  });
  try {
    assert.equal(ORCHESTRATOR_TOOLS.length, 7);
    assert.equal(orch.handles("orch_delegate"), true);
    assert.equal(orch.handles("mem_get"), false);

    const delegated = JSON.parse(
      await orch.call(AGENT, "orch_delegate", {
        runtime: "claude",
        model: "fast-m",
        effort: "high",
        prompt: "ASK_PERM TRAILING_CHUNK hello",
        label: "Check README",
        chat: CHAT,
        cwd: env.workDir,
      }),
    );
    assert.match(delegated.taskId, /^task-/);
    assert.equal(delegated.status, "starting");
    assert.equal(delegated.originEventId, ORIGIN);
    assert.equal(delegated.channelId, CHANNEL);
    assert.equal(delegated.threadRootId, ROOT);

    const waited = JSON.parse(await orch.call(AGENT, "orch_wait", { taskId: delegated.taskId, timeoutMs: 5000 }));
    assert.equal(waited.timedOut, false);
    assert.equal(waited.task.status, "completed");
    assert.equal(waited.task.stopReason, "end_turn");
    assert.equal(waited.task.model, "fast-m");
    assert.equal(waited.task.effort, "high");
    assert.equal(waited.task.result.text, "turn1:ASK_PERM TRAILING_CHUNK hello+TRAIL");
    assert.equal(waited.task.latestStep.kind, "message");
    assert.equal("transcript" in waited.task, false);
    assert.equal("_timeoutMs" in waited.task, false);

    const st = JSON.parse(await orch.call(AGENT, "orch_status", { taskId: delegated.taskId }));
    assert.equal(st.task.prompt, "ASK_PERM TRAILING_CHUNK hello");
    assert.ok(st.task.transcript.length >= 3);
    assert.ok(st.task.transcript.some((e) => e.kind === "tool" && e.text.includes("Read README.md")));

    const listed = JSON.parse(await orch.call(AGENT, "orch_list", { chat: CHAT }));
    assert.equal(listed.tasks.length, 1);
    assert.equal("prompt" in listed.tasks[0], false);
    assert.equal("transcript" in listed.tasks[0], false);

    const rpcTasks = await orch.tasks({ pubkey: AGENT, channelId: CHANNEL, threadRootId: ROOT });
    assert.equal(rpcTasks.tasks.length, 1);
    assert.equal(rpcTasks.tasks[0].taskId, delegated.taskId);
    const rpcFull = await orch.tasks({ pubkey: AGENT, taskId: delegated.taskId, full: true });
    assert.ok(Array.isArray(rpcFull.task.transcript));
  } finally {
    await orch.close();
    await env.cleanup();
  }
});

test("concurrency cap (4) queues overflow FIFO and rejects beyond queue limit", async () => {
  const env = await setupEnv();
  const orch = createOrchestrator({
    dataDir: env.dataDir,
    stateDir: env.stateDir,
    shimsDir: env.shimsDir,
    limits: { maxLive: 2, maxQueue: 1, idleDrainMs: 40 },
  });
  try {
    const t1 = JSON.parse(await orch.call(AGENT, "orch_delegate", { runtime: "claude", prompt: "DELAY=200 one", chat: CHAT, cwd: env.workDir }));
    const t2 = JSON.parse(await orch.call(AGENT, "orch_delegate", { runtime: "claude", prompt: "DELAY=200 two", chat: CHAT, cwd: env.workDir }));
    const t3 = JSON.parse(await orch.call(AGENT, "orch_delegate", { runtime: "claude", prompt: "DELAY=40 three", chat: CHAT, cwd: env.workDir }));
    assert.equal(t1.status, "starting");
    assert.equal(t2.status, "starting");
    assert.equal(t3.status, "queued");

    // 4th exceeds maxLive(2) + maxQueue(1)
    await assert.rejects(
      orch.call(AGENT, "orch_delegate", { runtime: "claude", prompt: "four", chat: CHAT, cwd: env.workDir }),
      /queue is full/i,
    );

    // Steering a queued task must fail without mutating it
    await assert.rejects(
      orch.call(AGENT, "orch_steer", { taskId: t3.taskId, prompt: "nudge", chat: CHAT }),
      /queued/i,
    );

    // All three eventually complete in order
    const [w1, w2, w3] = await Promise.all([
      orch.call(AGENT, "orch_wait", { taskId: t1.taskId, timeoutMs: 5000 }).then(JSON.parse),
      orch.call(AGENT, "orch_wait", { taskId: t2.taskId, timeoutMs: 5000 }).then(JSON.parse),
      orch.call(AGENT, "orch_wait", { taskId: t3.taskId, timeoutMs: 5000 }).then(JSON.parse),
    ]);
    assert.equal(w1.task.status, "completed");
    assert.equal(w2.task.status, "completed");
    assert.equal(w3.task.status, "completed");
    assert.ok(w3.task.startedAt >= Math.min(w1.task.endedAt, w2.task.endedAt) - 50);
  } finally {
    await orch.close();
    await env.cleanup();
  }
});

test("orch_steer queues follow-up after current turn completes on same session", async () => {
  const env = await setupEnv();
  const orch = createOrchestrator({
    dataDir: env.dataDir,
    stateDir: env.stateDir,
    shimsDir: env.shimsDir,
    limits: { idleDrainMs: 50 },
  });
  try {
    const t = JSON.parse(
      await orch.call(AGENT, "orch_delegate", { runtime: "claude", prompt: "DELAY=180 first", chat: CHAT, cwd: env.workDir }),
    );
    const steered = JSON.parse(
      await orch.call(AGENT, "orch_steer", { taskId: t.taskId, prompt: "DELAY=40 second", chat: CHAT }),
    );
    assert.ok(steered.steerQueued >= 1);

    const waited = JSON.parse(await orch.call(AGENT, "orch_wait", { taskId: t.taskId, timeoutMs: 5000 }));
    assert.equal(waited.task.status, "completed");
    assert.equal(waited.task.steerQueued, 0);
    assert.match(waited.task.result.text, /turn1:DELAY=180 first\nturn2:DELAY=40 second/);
  } finally {
    await orch.close();
    await env.cleanup();
  }
});

test("orch_cancel and host orchestrator.cancel stop a hanging worker cleanly", async () => {
  const env = await setupEnv();
  const orch = createOrchestrator({
    dataDir: env.dataDir,
    stateDir: env.stateDir,
    shimsDir: env.shimsDir,
    limits: { cancelGraceMs: 1000, idleDrainMs: 30 },
  });
  try {
    const t1 = JSON.parse(await orch.call(AGENT, "orch_delegate", { runtime: "claude", prompt: "HANG one", chat: CHAT, cwd: env.workDir }));
    await new Promise((r) => setTimeout(r, 80));
    const c1 = JSON.parse(await orch.call(AGENT, "orch_cancel", { taskId: t1.taskId, chat: CHAT }));
    assert.equal(c1.status, "cancelled");
    assert.equal(c1.stopReason, "cancelled");

    // Host RPC cancel does not require turn-authors gate
    const t2 = JSON.parse(await orch.call(AGENT, "orch_delegate", { runtime: "claude", prompt: "HANG two", chat: CHAT, cwd: env.workDir }));
    await new Promise((r) => setTimeout(r, 80));
    const c2 = await orch.cancel({ pubkey: AGENT, taskId: t2.taskId });
    assert.equal(c2.task.status, "cancelled");
  } finally {
    await orch.close();
    await env.cleanup();
  }
});

test("per-task timeout transitions hanging worker to timed_out", async () => {
  const env = await setupEnv();
  const orch = createOrchestrator({
    dataDir: env.dataDir,
    stateDir: env.stateDir,
    shimsDir: env.shimsDir,
    limits: { minTimeoutMs: 100, defaultTimeoutMs: 150, cancelGraceMs: 250, idleDrainMs: 20 },
  });
  try {
    const t = JSON.parse(
      await orch.call(AGENT, "orch_delegate", { runtime: "claude", prompt: "HANG timeout", timeoutMs: 120, chat: CHAT, cwd: env.workDir }),
    );
    const waited = JSON.parse(await orch.call(AGENT, "orch_wait", { taskId: t.taskId, timeoutMs: 5000 }));
    assert.equal(waited.timedOut, false);
    assert.equal(waited.task.status, "timed_out");
    assert.match(waited.task.error, /timed out/i);
  } finally {
    await orch.close();
    await env.cleanup();
  }
});

test("persistence across restart: prior running task loads as interrupted and completed survives", async () => {
  const env = await setupEnv();
  const orch1 = createOrchestrator({
    dataDir: env.dataDir,
    stateDir: env.stateDir,
    shimsDir: env.shimsDir,
    limits: { idleDrainMs: 30 },
  });
  let runningId;
  let completedId;
  try {
    const done = JSON.parse(await orch1.call(AGENT, "orch_delegate", { runtime: "claude", prompt: "quick", chat: CHAT, cwd: env.workDir }));
    completedId = done.taskId;
    await orch1.call(AGENT, "orch_wait", { taskId: completedId, timeoutMs: 5000 });

    const live = JSON.parse(await orch1.call(AGENT, "orch_delegate", { runtime: "claude", prompt: "HANG restart", chat: CHAT, cwd: env.workDir }));
    runningId = live.taskId;
    await new Promise((r) => setTimeout(r, 120));
  } finally {
    await orch1.close();
  }

  // Fresh orchestrator instance simulates buzz-host restart
  const orch2 = createOrchestrator({
    dataDir: env.dataDir,
    stateDir: env.stateDir,
    shimsDir: env.shimsDir,
  });
  try {
    const { tasks } = await orch2.tasks({ pubkey: AGENT });
    const byId = new Map(tasks.map((t) => [t.taskId, t]));
    assert.equal(byId.get(completedId).status, "completed");
    assert.equal(byId.get(runningId).status, "interrupted");
    assert.match(byId.get(runningId).error, /restarted/i);
    // Concurrency cap only counts live children
    const cap = await orch2.capabilities(AGENT);
    assert.equal(cap.active, 0);
    assert.equal(cap.limit, MAX_LIVE);
    assert.equal(cap.maxDepth, MAX_DEPTH);
  } finally {
    await orch2.close();
    await env.cleanup();
  }
});

test("guardrails: opt-in, owner-initiated chat gate, worker env isolation, and Codex auth unavailable", async () => {
  // 1. Opt-in off refuses all orch_* tools
  const envOff = await setupEnv({ orchestrate: false });
  const orchOff = createOrchestrator({ dataDir: envOff.dataDir, stateDir: envOff.stateDir, shimsDir: envOff.shimsDir });
  try {
    await assert.rejects(orchOff.call(AGENT, "orch_capabilities", {}), /Orchestration is off/i);
  } finally {
    await orchOff.close();
    await envOff.cleanup();
  }

  // 2. Non-owner chat author refuses delegate/steer/cancel
  const envOther = await setupEnv({ orchestrate: true, author: OTHER });
  const orchOther = createOrchestrator({ dataDir: envOther.dataDir, stateDir: envOther.stateDir, shimsDir: envOther.shimsDir });
  try {
    await assert.rejects(
      orchOther.call(AGENT, "orch_delegate", { runtime: "claude", prompt: "hi", chat: CHAT, cwd: envOther.workDir }),
      /owner-initiated/i,
    );
  } finally {
    await orchOther.close();
    await envOther.cleanup();
  }

  // 3. Worker env strips BUZZ* and WAYLAND_DISPLAY; Codex auth error marks unavailable until retry:true
  const env = await setupEnv({ orchestrate: true, author: OWNER });
  const dumpFile = path.join(env.tmp, "worker-env.json");
  const prevBuzz = process.env.BUZZ_PRIVATE_KEY;
  const prevMcp = process.env.BUZZ_ACP_MCP_COMMAND;
  const prevWayland = process.env.WAYLAND_DISPLAY;
  process.env.BUZZ_PRIVATE_KEY = "secret-key";
  process.env.BUZZ_ACP_MCP_COMMAND = "/should/not/pass";
  process.env.WAYLAND_DISPLAY = "wayland-1";
  process.env.MOCK_ENV_DUMP = dumpFile;
  const orch = createOrchestrator({
    dataDir: env.dataDir,
    stateDir: env.stateDir,
    shimsDir: env.shimsDir,
    limits: { idleDrainMs: 30 },
  });
  try {
    const t = JSON.parse(await orch.call(AGENT, "orch_delegate", { runtime: "claude", prompt: "check env", chat: CHAT, cwd: env.workDir }));
    await orch.call(AGENT, "orch_wait", { taskId: t.taskId, timeoutMs: 5000 });
    const dumped = JSON.parse(await fs.readFile(dumpFile, "utf8"));
    assert.equal("BUZZ_PRIVATE_KEY" in dumped.env, false);
    assert.equal("BUZZ_ACP_MCP_COMMAND" in dumped.env, false);
    assert.equal("WAYLAND_DISPLAY" in dumped.env, false);

    // Codex fails with -32000 Authentication required -> recorded in runtimes.json
    const codexTask = JSON.parse(await orch.call(AGENT, "orch_delegate", { runtime: "codex", prompt: "hi", chat: CHAT, cwd: env.workDir }));
    const waited = JSON.parse(await orch.call(AGENT, "orch_wait", { taskId: codexTask.taskId, timeoutMs: 5000 }));
    assert.equal(waited.task.status, "failed");
    assert.match(waited.task.error, /Authentication required/i);

    const caps1 = JSON.parse(await orch.call(AGENT, "orch_capabilities", {}));
    const codex1 = caps1.runtimes.find((r) => r.id === "codex");
    assert.equal(codex1.available, false);
    assert.match(codex1.reason, /Authentication required/i);

    // Subsequent delegate to codex fails fast without spawning
    await assert.rejects(
      orch.call(AGENT, "orch_delegate", { runtime: "codex", prompt: "again", chat: CHAT, cwd: env.workDir }),
      /unavailable/i,
    );

    // retry:true clears the cached auth failure
    const caps2 = JSON.parse(await orch.call(AGENT, "orch_capabilities", { retry: true }));
    const codex2 = caps2.runtimes.find((r) => r.id === "codex");
    assert.equal(codex2.available, true);
  } finally {
    if (prevBuzz === undefined) delete process.env.BUZZ_PRIVATE_KEY;
    else process.env.BUZZ_PRIVATE_KEY = prevBuzz;
    if (prevMcp === undefined) delete process.env.BUZZ_ACP_MCP_COMMAND;
    else process.env.BUZZ_ACP_MCP_COMMAND = prevMcp;
    if (prevWayland === undefined) delete process.env.WAYLAND_DISPLAY;
    else process.env.WAYLAND_DISPLAY = prevWayland;
    delete process.env.MOCK_ENV_DUMP;
    await orch.close();
    await env.cleanup();
  }
});

test("summary view clips long result text to 2000 chars with resultTruncated flag", async () => {
  const env = await setupEnv();
  const orch = createOrchestrator({
    dataDir: env.dataDir,
    stateDir: env.stateDir,
    shimsDir: env.shimsDir,
    limits: { idleDrainMs: 30 },
  });
  try {
    const big = "x".repeat(3500);
    const t = JSON.parse(await orch.call(AGENT, "orch_delegate", { runtime: "claude", prompt: big, chat: CHAT, cwd: env.workDir }));
    const waited = JSON.parse(await orch.call(AGENT, "orch_wait", { taskId: t.taskId, timeoutMs: 5000 }));
    assert.equal(waited.task.status, "completed");
    assert.ok(waited.task.result.text.length > 3500);

    const listed = JSON.parse(await orch.call(AGENT, "orch_list", { chat: CHAT }));
    assert.equal(listed.tasks[0].result.text.length, 2000);
    assert.equal(listed.tasks[0].resultTruncated, true);
    assert.equal(listed.tasks[0].result.bytes, waited.task.result.bytes);
  } finally {
    await orch.close();
    await env.cleanup();
  }
});

test("hardening: generic -32000 does not blacklist, steer cap + starting count, wait closed:true, tasks since, Hermes isolation, forget", async () => {
  const env = await setupEnv({
    shims: {
      "antigravity-acp": MOCK_SHIM_BODY.replace('process.env.MOCK_MODE || "echo"', '"generic_32000"'),
    },
  });
  const agentWorkRoot = path.join(env.tmp, "buzz-agents");
  const agentWorkDir = path.join(agentWorkRoot, AGENT);
  await fs.mkdir(agentWorkDir, { recursive: true });

  const orch = createOrchestrator({
    dataDir: env.dataDir,
    stateDir: env.stateDir,
    shimsDir: env.shimsDir,
    limits: { idleDrainMs: 30, maxSteers: 2, agentWorkRoot },
  });
  try {
    // 1. Invalid pubkey is rejected before touching filesystem
    await assert.rejects(orch.call("../escape", "orch_capabilities", {}), /Invalid agent pubkey/i);

    // 2. Generic -32000 error fails the task but does NOT mark antigravity unavailable
    const bad = JSON.parse(await orch.call(AGENT, "orch_delegate", { runtime: "antigravity", prompt: "hi", chat: CHAT, cwd: env.workDir }));
    const badWait = JSON.parse(await orch.call(AGENT, "orch_wait", { taskId: bad.taskId, timeoutMs: 5000 }));
    assert.equal(badWait.task.status, "failed");
    const caps = JSON.parse(await orch.call(AGENT, "orch_capabilities", {}));
    assert.equal(caps.runtimes.find((r) => r.id === "antigravity").available, true);

    // 3. Hermes worker rejects explicit agent workspace and isolates default cwd
    await assert.rejects(
      orch.call(AGENT, "orch_delegate", { runtime: "hermes", prompt: "hi", workspace: agentWorkDir, chat: CHAT, cwd: env.workDir }),
      /identity isolation/i,
    );
    const hermesIso = JSON.parse(
      await orch.call(AGENT, "orch_delegate", { runtime: "hermes", prompt: "ok", chat: CHAT, cwd: agentWorkDir }),
    );
    assert.notEqual(hermesIso.workspace, agentWorkDir);
    assert.ok(hermesIso.workspace.startsWith(path.join(env.stateDir, "work")));
    await orch.call(AGENT, "orch_wait", { taskId: hermesIso.taskId, timeoutMs: 5000 });

    // 4. tasks({ since }) filters by createdAt
    const cutoff = Date.now() + 10_000;
    const emptySince = await orch.tasks({ pubkey: AGENT, since: cutoff });
    assert.equal(emptySince.tasks.length, 0);

    // 5. steerQueued while starting is 1 (not 2) and enforces maxSteers (2)
    const stTask = JSON.parse(
      await orch.call(AGENT, "orch_delegate", { runtime: "claude", prompt: "DELAY=200 start", chat: CHAT, cwd: env.workDir }),
    );
    const s1 = JSON.parse(await orch.call(AGENT, "orch_steer", { taskId: stTask.taskId, prompt: "s1", chat: CHAT }));
    assert.equal(s1.steerQueued, 1);
    const s2 = JSON.parse(await orch.call(AGENT, "orch_steer", { taskId: stTask.taskId, prompt: "s2", chat: CHAT }));
    assert.equal(s2.steerQueued, 2);
    await assert.rejects(
      orch.call(AGENT, "orch_steer", { taskId: stTask.taskId, prompt: "s3", chat: CHAT }),
      /Steer queue is full/i,
    );
    await orch.call(AGENT, "orch_cancel", { taskId: stTask.taskId, chat: CHAT });

    // 6. orch_wait returns closed:true when orchestrator closes mid-wait
    const hang = JSON.parse(
      await orch.call(AGENT, "orch_delegate", { runtime: "claude", prompt: "HANG close", chat: CHAT, cwd: env.workDir }),
    );
    const waitPromise = orch.call(AGENT, "orch_wait", { taskId: hang.taskId, timeoutMs: 30_000 }).then(JSON.parse);
    await new Promise((r) => setTimeout(r, 80));
    await orch.close();
    const waitResult = await waitPromise;
    assert.equal(waitResult.timedOut, false);
    assert.equal(waitResult.closed, true);
  } finally {
    await orch.close();
    await env.cleanup();
  }

  // 7. forget(pubkey) cancels queued + live without promoting queued and deletes persisted file
  const env2 = await setupEnv();
  const orch2 = createOrchestrator({
    dataDir: env2.dataDir,
    stateDir: env2.stateDir,
    shimsDir: env2.shimsDir,
    limits: { maxLive: 1, maxQueue: 2, idleDrainMs: 30 },
  });
  try {
    await orch2.call(AGENT, "orch_delegate", { runtime: "claude", prompt: "HANG live", chat: CHAT, cwd: env2.workDir });
    await orch2.call(AGENT, "orch_delegate", { runtime: "claude", prompt: "queued", chat: CHAT, cwd: env2.workDir });
    await orch2.forget(AGENT);
    const exists = await fs.access(path.join(env2.stateDir, `${AGENT}.json`)).then(() => true, () => false);
    assert.equal(exists, false);
  } finally {
    await orch2.close();
    await env2.cleanup();
  }
});
