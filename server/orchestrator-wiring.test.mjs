// node --test server/orchestrator-wiring.test.mjs
// Verifies attention.mjs's extra handler chain and buzz-mcp.mjs --orchestrate
// tool exposure, chat/cwd forwarding, and socket routing.
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
import { ORCHESTRATOR_TOOLS } from "./orchestrator.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBKEY = "a".repeat(64);
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
    // Without --orchestrate: no orch_* tools listed.
    const plain = startMcp([PUBKEY], { XDG_RUNTIME_DIR: xdgRun, BUZZHOST_CHAT: CHAT }, workDir);
    try {
      const list = await plain.rpc("tools/list");
      assert.equal(list.tools.some((t) => t.name.startsWith("orch_")), false);
    } finally {
      await plain.close();
    }

    // With --orchestrate: all 7 ORCHESTRATOR_TOOLS listed, chat + cwd injected.
    const orch = startMcp([PUBKEY, "--orchestrate"], { XDG_RUNTIME_DIR: xdgRun, BUZZHOST_CHAT: CHAT }, workDir);
    try {
      const init = await orch.rpc("initialize");
      assert.match(init.instructions, /Orchestration:/);
      const list = await orch.rpc("tools/list");
      const names = new Set(list.tools.map((t) => t.name));
      for (const tool of ORCHESTRATOR_TOOLS) assert.ok(names.has(tool.name), `missing ${tool.name}`);

      // orch_delegate overwrites any spoofed chat with BUZZHOST_CHAT and sets cwd.
      const res1 = await orch.rpc("tools/call", {
        name: "orch_delegate",
        arguments: { runtime: "claude", prompt: "hi", chat: "spoofed" },
      });
      assert.equal(res1.isError, undefined);
      assert.equal(received[0].name, "orch_delegate");
      assert.equal(received[0].args.chat, CHAT);
      assert.equal(received[0].args.cwd, workDir);

      // orch_list preserves explicit chat filter while still passing cwd.
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
