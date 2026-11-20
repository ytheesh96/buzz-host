// node --test server/parallel.test.mjs
// Covers cross-process file locking (file-lock.mjs) and multi-worker control
// socket routing (control.mjs) used by parallel conversations (BUZZ_ACP_AGENTS > 1).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { listControlSockets, proxyControl } from "./control.mjs";
import { updateJsonLocked, withFileLock } from "./file-lock.mjs";

const PUBKEY = "a".repeat(64);
const CHANNEL = "123e4567-e89b-42d3-a456-426614174000";

function startFakeWorker(sockPath, handler) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer((conn) => {
      let buf = "";
      conn.setEncoding("utf8");
      conn.on("data", (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (!line.trim()) continue;
          const req = JSON.parse(line);
          const reply = handler(req);
          conn.write(`${JSON.stringify(reply)}\n`);
        }
      });
    });
    srv.on("error", reject);
    srv.listen(sockPath, () =>
      resolve({
        sockPath,
        close: () =>
          new Promise((res) => {
            srv.close(() => res());
          }),
      }),
    );
  });
}

test("updateJsonLocked serializes concurrent updates without losing keys and preserves 0600 mode", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "buzz-lock-"));
  const file = path.join(tmp, "chat-settings.json");
  try {
    await Promise.all(
      Array.from({ length: 16 }, (_, i) =>
        updateJsonLocked(file, async (data) => {
          await new Promise((r) => setTimeout(r, (i % 4) * 5));
          data[`chat-${i}`] = { runtime: i % 2 === 0 ? "claude" : "hermes", idx: i };
          return data;
        }),
      ),
    );
    const saved = JSON.parse(await fs.readFile(file, "utf8"));
    assert.equal(Object.keys(saved).length, 16);
    for (let i = 0; i < 16; i++) {
      assert.equal(saved[`chat-${i}`].idx, i);
    }
    const st = await fs.stat(file);
    assert.equal(st.mode & 0o777, 0o600);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("withFileLock recovers a stale lock left by a dead PID", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "buzz-stale-lock-"));
  const file = path.join(tmp, "state.json");
  const lock = `${file}.lock`;
  try {
    // Pick an almost-certainly-dead PID.
    await fs.writeFile(lock, "99999999\n", { mode: 0o600 });
    let ran = false;
    await withFileLock(file, () => {
      ran = true;
    });
    assert.equal(ran, true);
    await assert.rejects(() => fs.access(lock));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("proxyControl fans out state/cancel/new/compact across multiple worker sockets", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "buzz-ctrl-"));
  const sockDir = path.join(tmp, `${PUBKEY}.d`);
  await fs.mkdir(sockDir, { recursive: true, mode: 0o700 });

  const calls = [];
  const stateByWorker = {
    w1: { state: "idle", hasSession: false, lastUsed: 0 },
    w2: { state: "idle", hasSession: true, lastUsed: 42 },
    w3: { state: "active", hasSession: true, lastUsed: 99 },
  };
  const workers = [];
  try {
    for (const [name, st] of Object.entries(stateByWorker)) {
      const w = await startFakeWorker(path.join(sockDir, `${name}.sock`), (req) => {
        calls.push({ name, req });
        if (req.op === "state") return { ...st };
        if (req.op === "cancel") return { cancelled: st.state === "active" };
        if (req.op === "new") return { ok: true, worker: name };
        if (req.op === "compact") return { compacted: true, worker: name };
        return { error: "unknown" };
      });
      workers.push(w);
    }

    const found = await listControlSockets(tmp, PUBKEY);
    assert.equal(found.length, 3);

    // State priority: active beats idle.
    const st1 = await proxyControl(tmp, PUBKEY, { op: "state", channel: CHANNEL });
    assert.equal(st1.state, "active");
    assert.equal(st1.hasSession, true);
    assert.equal(st1.lastUsed, 99);

    // New while any worker is active is refused without invoking `new`.
    const newWhileBusy = await proxyControl(tmp, PUBKEY, { op: "new", channel: CHANNEL });
    assert.match(newWhileBusy.error, /Wait for the turn to finish/);

    // Cancel reaches w3 and returns cancelled: true.
    const cancelled = await proxyControl(tmp, PUBKEY, { op: "cancel", channel: CHANNEL });
    assert.deepEqual(cancelled, { cancelled: true });

    // Once w3 goes idle, compact routes specifically to w3 (highest lastUsed with hasSession).
    stateByWorker.w3.state = "idle";
    const compacted = await proxyControl(tmp, PUBKEY, { op: "compact", channel: CHANNEL });
    assert.equal(compacted.compacted, true);
    assert.equal(compacted.worker, "w3");

    // New succeeds once all workers are idle.
    const fresh = await proxyControl(tmp, PUBKEY, { op: "new", channel: CHANNEL });
    assert.equal(fresh.ok, true);
  } finally {
    await Promise.all(workers.map((w) => w.close()));
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("real acp-proxy subprocesses: per-PID control sockets, lazy secondary runtime spawn, and _acp_turn_done over attention.sock", async () => {
  const { spawn } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const { createAttention } = await import("./attention.mjs");
  const readline = await import("node:readline");

  const here = path.dirname(fileURLToPath(import.meta.url));
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "buzz-proxy-int-"));
  const home = path.join(tmp, "home");
  const agentDir = path.join(tmp, "agent");
  const dataDir = path.join(tmp, "agents");
  const xdgRun = path.join(tmp, "xdg");
  const runDir = path.join(xdgRun, "buzz-host");
  const ctrlDir = path.join(runDir, `${PUBKEY.slice(0, 16)}.d`);
  const workDir = path.join(tmp, "work");
  await Promise.all([
    fs.mkdir(home, { recursive: true }),
    fs.mkdir(agentDir, { recursive: true }),
    fs.mkdir(path.join(dataDir, PUBKEY), { recursive: true }),
    fs.mkdir(ctrlDir, { recursive: true, mode: 0o700 }),
    fs.mkdir(workDir, { recursive: true }),
  ]);

  const fakeAdapterPath = path.join(tmp, "fake-adapter.mjs");
  await fs.writeFile(
    fakeAdapterPath,
    `#!/usr/bin/env node
import readline from "node:readline";
const tag = process.argv[2] || "primary";
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
let activePrompt = null;
let waitingPerm = null;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const m = JSON.parse(line);
  if (!m.method && waitingPerm && m.id === waitingPerm.reqId) {
    const promptId = waitingPerm.promptId;
    const sid = waitingPerm.sid;
    waitingPerm = null;
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "perm-ok-" + tag } } } });
    return send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
  }
  if (m.method === "initialize") return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1 } });
  if (m.method === "session/new") return send({ jsonrpc: "2.0", id: m.id, result: { sessionId: tag + "-s1", configOptions: [] } });
  if (m.method === "session/cancel") {
    if (activePrompt) {
      const id = activePrompt;
      activePrompt = null;
      send({ jsonrpc: "2.0", id, result: { stopReason: "cancelled" } });
    }
    return;
  }
  if (m.method === "session/prompt") {
    const text = (m.params?.prompt || []).map((b) => b.text || "").join("\\n");
    if (text.includes("CRASH")) {
      process.exit(2);
    }
    if (text.includes("ASK_PERM")) {
      waitingPerm = { reqId: 42, promptId: m.id, sid: m.params.sessionId };
      return send({ jsonrpc: "2.0", id: 42, method: "session/request_permission", params: { sessionId: m.params.sessionId, options: [{ optionId: "allow", kind: "allow_once" }] } });
    }
    if (text.includes("HOLD")) {
      activePrompt = m.id;
      return;
    }
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: m.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "from-" + tag } } } });
    return send({ jsonrpc: "2.0", id: m.id, result: { stopReason: "end_turn" } });
  }
});
`,
    { mode: 0o755 },
  );
  await fs.chmod(fakeAdapterPath, 0o755);

  const chSecondary = "223e4567-e89b-42d3-a456-426614174000";
  await updateJsonLocked(path.join(agentDir, "chat-settings.json"), (d) => {
    d[chSecondary] = { runtime: "hermes", workspace: [workDir] };
    return d;
  });

  const hookEvents = [];
  const fakeOrch = {
    handles: (name) => name === "_acp_turn_start" || name === "_acp_turn_done",
    call: async (pubkey, name, args) => {
      hookEvents.push({ pubkey, name, args });
      return JSON.stringify({ ok: true });
    },
  };
  const attention = createAttention({ dataDir, runDir, extra: [fakeOrch] });
  await attention.start();

  const spawnProxy = () => {
    const proc = spawn(path.join(here, "acp-proxy"), [fakeAdapterPath, "claude-agent-acp"], {
      env: {
        ...process.env,
        HOME: home,
        XDG_RUNTIME_DIR: xdgRun,
        BUZZ_HOST_AGENT: PUBKEY,
        BUZZ_HOST_AGENT_DIR: agentDir,
        BUZZ_HOST_CONTROL_DIR: ctrlDir,
        BUZZ_ACP_AGENT_OWNER: "b".repeat(64),
        BUZZ_HOST_ADAPTERS_JSON: JSON.stringify({ hermes: [fakeAdapterPath, "hermes-acp"] }),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const pending = new Map();
    readline.createInterface({ input: proc.stdout }).on("line", (line) => {
      if (!line.trim()) return;
      const msg = JSON.parse(line);
      if (msg.method === "session/request_permission" && msg.id !== undefined) {
        proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "selected", optionId: "allow" } } })}\n`);
        return;
      }
      if (msg.id !== undefined && !msg.method && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      }
    });
    let seq = 1;
    const rpc = (method, params) =>
      new Promise((resolve, reject) => {
        const id = seq++;
        pending.set(id, { resolve, reject });
        proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    const stop = () =>
      new Promise((resolve) => {
        proc.once("exit", () => resolve());
        proc.stdin.end();
        setTimeout(() => proc.kill("SIGTERM"), 200);
      });
    return { proc, rpc, stop };
  };

  const p1 = spawnProxy();
  const p2 = spawnProxy();
  try {
    await Promise.all([
      p1.rpc("initialize", { protocolVersion: 1, clientCapabilities: {} }),
      p2.rpc("initialize", { protocolVersion: 1, clientCapabilities: {} }),
    ]);

    // Wait briefly for both per-PID control sockets to bind.
    let sockets = [];
    for (let i = 0; i < 40; i++) {
      sockets = await listControlSockets(runDir, PUBKEY);
      if (sockets.length === 2) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(sockets.length, 2, "both acp-proxy workers bound separate PID sockets");

    // p1 runs a holding turn on primary runtime in CHANNEL.
    const s1 = await p1.rpc("session/new", {
      cwd: workDir,
      mcpServers: [],
      _meta: { buzzHost: { channelId: CHANNEL, rootEventId: null } },
    });
    const holdPrompt = p1.rpc("session/prompt", {
      sessionId: s1.sessionId,
      prompt: [{ type: "text", text: "HOLD" }],
      _meta: { buzzHost: { channelId: CHANNEL, rootEventId: null, events: [] } },
    });
    await new Promise((r) => setTimeout(r, 80));

    // p2 simultaneously runs a turn routed to secondary runtime (hermes) in chSecondary,
    // including a session/request_permission round-trip back to the secondary adapter!
    const s2 = await p2.rpc("session/new", {
      cwd: workDir,
      mcpServers: [],
      _meta: { buzzHost: { channelId: chSecondary, rootEventId: null } },
    });
    assert.equal(s2.sessionId, "rt:hermes:hermes-acp-s1");
    const secRes = await p2.rpc("session/prompt", {
      sessionId: s2.sessionId,
      prompt: [{ type: "text", text: "ASK_PERM" }],
      _meta: { buzzHost: { channelId: chSecondary, rootEventId: null, events: [] } },
    });
    assert.equal(secRes.stopReason, "end_turn");

    // Secondary adapter crash mid-turn fails the in-flight RPC cleanly and emits _acp_turn_done with error.
    await assert.rejects(
      () =>
        p2.rpc("session/prompt", {
          sessionId: s2.sessionId,
          prompt: [{ type: "text", text: "CRASH" }],
          _meta: { buzzHost: { channelId: chSecondary, rootEventId: null, events: [] } },
        }),
      /hermes adapter exited unexpectedly/,
    );
    const afterCrash = await proxyControl(runDir, PUBKEY, { op: "state", channel: chSecondary });
    assert.equal(afterCrash.state, "idle");

    // Meanwhile p1 is still active on CHANNEL; proxyControl detects active state and cancels it!
    const st = await proxyControl(runDir, PUBKEY, { op: "state", channel: CHANNEL });
    assert.equal(st.state, "active");
    const cancelRes = await proxyControl(runDir, PUBKEY, { op: "cancel", channel: CHANNEL });
    assert.deepEqual(cancelRes, { cancelled: true });
    const held = await holdPrompt;
    assert.equal(held.stopReason, "cancelled");

    // Wait briefly for fire-and-forget _acp_turn_start / _acp_turn_done hooks from both workers.
    for (let i = 0; i < 40; i++) {
      const hasSec = hookEvents.some((e) => e.name === "_acp_turn_done" && e.args.channel === chSecondary);
      const hasPri = hookEvents.some((e) => e.name === "_acp_turn_done" && e.args.channel === CHANNEL);
      if (hasSec && hasPri) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(hookEvents.some((e) => e.name === "_acp_turn_start" && e.args.channel === chSecondary && e.args.runtime === "hermes"));
    assert.ok(hookEvents.some((e) => e.name === "_acp_turn_done" && e.args.channel === chSecondary && e.args.stopReason === "end_turn"));
    assert.ok(hookEvents.some((e) => e.name === "_acp_turn_done" && e.args.channel === CHANNEL && e.args.stopReason === "cancelled"));
  } finally {
    await Promise.all([p1.stop(), p2.stop()]);
    await attention.stop();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
