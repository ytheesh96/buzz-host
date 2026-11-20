// node --test server/orchestrator-wiring.test.mjs
// Verifies attention.mjs's extra handler chain and buzz-mcp.mjs --orchestrate
// tool exposure, chat/cwd forwarding, and end-to-end Solo-chat worker flow.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createConnection } from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { createAttention } from "./attention.mjs";
import { createOrchestrator, ORCHESTRATOR_TOOLS } from "./orchestrator.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBKEY = "a".repeat(64);
const WORKER = "c".repeat(64);
const CHAT = "123e4567-e89b-42d3-a456-426614174000_" + "b".repeat(64);

function sendSock(sockPath, payload) {
  return new Promise((resolve, reject) => {
    const conn = createConnection(sockPath);
    let buf = "";
    conn.setEncoding("utf8");
    conn.on("connect", () => conn.write(`${JSON.stringify(payload)}\n`));
    conn.on("data", (chunk) => {
      buf += chunk;
      const i = buf.indexOf("\n");
      if (i >= 0) {
        conn.end();
        resolve(JSON.parse(buf.slice(0, i)));
      }
    });
    conn.on("error", reject);
  });
}

function startMcp(args, env, cwd) {
  const child = spawn(process.execPath, [path.join(HERE, "buzz-mcp.mjs"), ...args], {
    env: { ...process.env, ...env },
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  let nextId = 1;
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    if (!line.trim()) return;
    const msg = JSON.parse(line);
    const w = pending.get(msg.id);
    if (!w) return;
    pending.delete(msg.id);
    if (msg.error) w.reject(new Error(msg.error.message));
    else w.resolve(msg.result);
  });
  const rpc = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  const close = () =>
    new Promise((resolve) => {
      child.once("exit", () => resolve());
      child.stdin.end();
    });
  return { rpc, close };
}

test("attention.mjs extra array routes memory and orchestrator tools independently", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "buzz-orch-wire-"));
  const dataDir = path.join(tmp, "agents");
  const runDir = path.join(tmp, "run", "buzz-host");
  await fs.mkdir(path.join(dataDir, PUBKEY), { recursive: true });
  const calls = [];
  const fakeMemory = {
    handles: (name) => /^mem_/.test(name),
    call: async (pubkey, name, args) => {
      calls.push({ handler: "memory", pubkey, name, args });
      return JSON.stringify({ ok: "memory" });
    },
  };
  const fakeOrch = {
    handles: (name) => /^orch_/.test(name),
    call: async (pubkey, name, args) => {
      calls.push({ handler: "orchestrator", pubkey, name, args });
      return JSON.stringify({ ok: "orchestrator", seen: args });
    },
  };
  const attention = createAttention({ dataDir, runDir, extra: [fakeMemory, fakeOrch] });
  await attention.start();
  try {
    const sock = path.join(runDir, "attention.sock");
    const r1 = await sendSock(sock, { pubkey: PUBKEY, name: "mem_get", args: { slug: "core" } });
    assert.deepEqual(JSON.parse(r1.result), { ok: "memory" });
    const r2 = await sendSock(sock, { pubkey: PUBKEY, name: "orch_capabilities", args: { retry: true } });
    assert.deepEqual(JSON.parse(r2.result), { ok: "orchestrator", seen: { retry: true } });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].handler, "memory");
    assert.equal(calls[1].handler, "orchestrator");
  } finally {
    await attention.stop();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("buzz-mcp.mjs exposes orch_* only with --orchestrate and injects chat/cwd", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "buzz-mcp-orch-"));
  const dataDir = path.join(tmp, "agents");
  const xdgRun = path.join(tmp, "xdg");
  const runDir = path.join(xdgRun, "buzz-host");
  const workDir = path.join(tmp, "work");
  await fs.mkdir(path.join(dataDir, PUBKEY), { recursive: true });
  await fs.mkdir(workDir, { recursive: true });

  const received = [];
  const fakeOrch = {
    handles: (name) => /^orch_/.test(name),
    call: async (pubkey, name, args) => {
      received.push({ pubkey, name, args });
      return JSON.stringify({ name, args });
    },
  };
  const attention = createAttention({ dataDir, runDir, extra: [fakeOrch] });
  await attention.start();
  try {
    const plain = startMcp([PUBKEY], { XDG_RUNTIME_DIR: xdgRun, BUZZHOST_CHAT: CHAT }, workDir);
    try {
      const list = await plain.rpc("tools/list");
      assert.equal(list.tools.some((t) => t.name.startsWith("orch_")), false);
    } finally {
      await plain.close();
    }

    // Even with --orchestrate, BUZZHOST_NO_ORCHESTRATE=1 hides orch_* (MAX_DEPTH = 1 for worker Solo chats).
    const suppressed = startMcp(
      [PUBKEY, "--orchestrate"],
      { XDG_RUNTIME_DIR: xdgRun, BUZZHOST_CHAT: CHAT, BUZZHOST_NO_ORCHESTRATE: "1" },
      workDir,
    );
    try {
      const init = await suppressed.rpc("initialize");
      assert.doesNotMatch(init.instructions, /Orchestration:/);
      const list = await suppressed.rpc("tools/list");
      assert.equal(list.tools.some((t) => t.name.startsWith("orch_")), false);
    } finally {
      await suppressed.close();
    }

    const orch = startMcp([PUBKEY, "--orchestrate"], { XDG_RUNTIME_DIR: xdgRun, BUZZHOST_CHAT: CHAT }, workDir);
    try {
      const init = await orch.rpc("initialize");
      assert.match(init.instructions, /Orchestration:/);
      assert.match(init.instructions, /Solo-chat/);
      const list = await orch.rpc("tools/list");
      const names = new Set(list.tools.map((t) => t.name));
      for (const tool of ORCHESTRATOR_TOOLS) assert.ok(names.has(tool.name), `missing ${tool.name}`);
      // Internal acp-proxy hooks must never be exposed as MCP tools.
      assert.equal(names.has("_acp_turn_start"), false);
      assert.equal(names.has("_acp_turn_done"), false);

      const res1 = await orch.rpc("tools/call", {
        name: "orch_delegate",
        arguments: { runtime: "claude", prompt: "hi", chat: "spoofed" },
      });
      assert.equal(res1.isError, undefined);
      assert.equal(received[0].name, "orch_delegate");
      assert.equal(received[0].args.chat, CHAT);
      assert.equal(received[0].args.cwd, workDir);

      await orch.rpc("tools/call", {
        name: "orch_list",
        arguments: { chat: "other-chat", limit: 5 },
      });
      assert.equal(received[1].name, "orch_list");
      assert.equal(received[1].args.chat, "other-chat");
      assert.equal(received[1].args.cwd, workDir);
    } finally {
      await orch.close();
    }
  } finally {
    await attention.stop();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("end-to-end: buzz-mcp.mjs --orchestrate -> attention.sock -> Solo-chat worker lifecycle", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "buzz-orch-e2e-"));
  const dataDir = path.join(tmp, "agents");
  const stateDir = path.join(tmp, "orchestrator");
  const xdgRun = path.join(tmp, "xdg");
  const runDir = path.join(xdgRun, "buzz-host");
  const workDir = path.join(tmp, "work");
  const owner = "9".repeat(64);
  const eventId = "7".repeat(64);
  await fs.mkdir(path.join(dataDir, PUBKEY), { recursive: true });
  await fs.mkdir(workDir, { recursive: true });

  await fs.writeFile(
    path.join(dataDir, PUBKEY, "meta.json"),
    JSON.stringify({
      pubkey: PUBKEY,
      name: "Conductor",
      owner,
      runtime: "claude",
      concurrency: 4,
      activated: true,
      orchestrate: true,
    }),
  );
  await fs.writeFile(
    path.join(dataDir, PUBKEY, "turn-authors.json"),
    JSON.stringify({ [CHAT]: { author: owner, eventId, at: Math.floor(Date.now() / 1000) } }),
  );

  const watches = new Map();
  const fakeRelay = {
    async createSoloChat({ channelId }) {
      return { channelId, eventId: "1".repeat(64) };
    },
    async postMessage({ channelId }) {
      return { eventId: "2".repeat(64), createdAt: Math.floor(Date.now() / 1000) };
    },
    async getMessages() {
      return [];
    },
    async watchChannel({ channelId, onMessage }) {
      watches.set(channelId, onMessage);
      return () => watches.delete(channelId);
    },
    async close() {
      watches.clear();
    },
  };

  const orchestrator = createOrchestrator({
    dataDir,
    stateDir,
    runDir,
    relay: fakeRelay,
    cancelWorker: async () => ({ cancelled: true }),
    limits: { checkShimAccess: false },
  });
  const attention = createAttention({ dataDir, runDir, extra: [orchestrator] });
  await attention.start();
  const sock = path.join(runDir, "attention.sock");
  const mcp = startMcp([PUBKEY, "--orchestrate"], { XDG_RUNTIME_DIR: xdgRun, BUZZHOST_CHAT: CHAT }, workDir);
  try {
    const del = await mcp.rpc("tools/call", {
      name: "orch_delegate",
      arguments: { runtime: "hermes", prompt: "ping", label: "ping-test" },
    });
    assert.equal(del.isError, undefined);
    const task = JSON.parse(del.content[0].text);
    assert.equal(task.mode, "solo");
    assert.equal(task.workerPubkey, PUBKEY);
    assert.equal(task.originEventId, eventId);
    assert.equal(task.workspace, workDir);
    assert.ok(task.workerChannelId);
    assert.equal(task.link, `buzz://message?channel=${task.workerChannelId}&id=${"2".repeat(64)}`);

    // Verify self-worker chat-settings.json was written with runtime + noOrchestrate + workspace + expiresAt.
    const settings = JSON.parse(await fs.readFile(path.join(dataDir, PUBKEY, "chat-settings.json"), "utf8"));
    assert.equal(settings[task.workerChannelId].runtime, "hermes");
    assert.equal(settings[task.workerChannelId].noOrchestrate, true);
    assert.deepEqual(settings[task.workerChannelId].workspace, [workDir]);
    assert.ok(settings[task.workerChannelId].expiresAt > Date.now());

    // Verify operator wake file was written to Conductor's wake dir.
    const wakeFiles = (await fs.readdir(path.join(dataDir, PUBKEY, "wake"))).filter((f) => f.endsWith(".json"));
    assert.equal(wakeFiles.length, 1);

    // Simulate Conductor's self-worker acp-proxy notifying start, posting reply on relay, then notifying done.
    const waitPromise = mcp.rpc("tools/call", {
      name: "orch_wait",
      arguments: { taskId: task.taskId, timeoutMs: 5000 },
    });
    await sendSock(sock, {
      pubkey: PUBKEY,
      name: "_acp_turn_start",
      args: { channel: task.workerChannelId, root: "", runtime: "hermes", model: "deepseek", effort: "" },
    });
    const replyId = "3".repeat(64);
    watches.get(task.workerChannelId)?.({
      id: replyId,
      pubkey: PUBKEY,
      created_at: Math.floor(Date.now() / 1000),
      content: "solo-e2e-ok",
    });
    await sendSock(sock, {
      pubkey: PUBKEY,
      name: "_acp_turn_done",
      args: {
        channel: task.workerChannelId,
        root: "",
        runtime: "hermes",
        stopReason: "end_turn",
        error: "",
        model: "deepseek",
        effort: "",
        finalText: "solo-e2e-ok",
      },
    });

    const waitRes = await waitPromise;
    assert.equal(waitRes.isError, undefined);
    const waited = JSON.parse(waitRes.content[0].text);
    assert.equal(waited.timedOut, false);
    assert.equal(waited.task.status, "completed");
    assert.equal(waited.task.result.text, "solo-e2e-ok");
    assert.equal(waited.task.replyEventId, replyId);
    assert.equal(waited.task.link, `buzz://message?channel=${task.workerChannelId}&id=${replyId}`);
  } finally {
    await mcp.close();
    await orchestrator.close();
    await attention.stop();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
