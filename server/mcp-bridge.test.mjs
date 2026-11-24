// node --test server/mcp-bridge.test.mjs
// Compiles the real server/buzz-mcp-bridge.c and drives it against the real
// createMcpServer over a temp mcp.sock: the init handshake, tool groups,
// memory/Attention/orchestrator calls, mem_set path confinement, orch chat/cwd
// injection (with quotes and backslashes), recovery across a buzz-host restart
// on the same socket, and stdin EOF. Also checks the bridge's resident size.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { ATTENTION_TOOLS } from "./attention-core.mjs";
import { MEMORY_TOOLS } from "./memory.mjs";
import { ORCHESTRATOR_TOOLS } from "./orchestrator.mjs";
import { createMcpServer } from "./mcp-server.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBKEY = "a".repeat(64);
const SILENT = { warn() {} };

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** RSS of a live process, in KiB (Linux). */
async function rssKiB(pid) {
  const status = await fs.readFile(`/proc/${pid}/status`, "utf8");
  return Number(/VmRSS:\s+(\d+) kB/.exec(status)?.[1] ?? 0);
}

test("buzz-mcp-bridge", async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "buzz-mcp-bridge-"));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));

  const bin = path.join(tmp, "buzz-mcp-bridge");
  execFileSync(process.env.CC || "cc", ["-O2", "-Wall", "-Wextra", "-o", bin, path.join(HERE, "buzz-mcp-bridge.c")], {
    stdio: "pipe",
  });

  const runtime = path.join(tmp, "runtime");
  const runDir = path.join(runtime, "buzz-host");
  const calls = [];
  const callTool = async (pubkey, name, args) => {
    calls.push({ pubkey, name, args });
    if (name === "mem_get") return `core of ${pubkey.slice(0, 4)}: ${args.slug}`;
    if (name === "mem_set") return `saved ${args.slug}: ${args.text}`;
    if (name === "orch_list") return JSON.stringify({ chat: args.chat ?? null, cwd: args.cwd });
    if (name === "orch_delegate") return JSON.stringify({ chat: args.chat, cwd: args.cwd, prompt: args.prompt });
    return `ok ${name}`;
  };

  let server = createMcpServer({ runDir, callTool, log: SILENT });
  await server.start();
  t.after(() => server.stop());

  function startBridge({ args = [], env = {}, cwd } = {}) {
    const child = spawn(bin, [PUBKEY, ...args], {
      cwd: cwd ?? tmp,
      env: { ...process.env, XDG_RUNTIME_DIR: runtime, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const pending = new Map();
    let nextId = 1;
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    readline.createInterface({ input: child.stdout }).on("line", (line) => {
      if (!line.trim()) return;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    });
    const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code ?? -1)));
    const rpc = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`buzz-mcp-bridge did not answer ${method}: ${stderr}`));
        }, 5000);
        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    const close = async () => {
      child.stdin.end();
      return exited;
    };
    return { child, rpc, close, exited, stderr: () => stderr };
  }

  await t.test("initialize, ping and tools/list follow --attention and --orchestrate", async () => {
    const bridge = startBridge({ args: ["--attention", "--orchestrate"] });
    t.after(() => bridge.close());
    const init = await bridge.rpc("initialize", { protocolVersion: "2025-06-18" });
    assert.equal(init.serverInfo.name, "buzz");
    assert.match(init.instructions, /Your memory/);
    assert.match(init.instructions, /Your Attention/);
    assert.match(init.instructions, /Orchestration/);
    assert.deepEqual(await bridge.rpc("ping"), {});

    const names = new Set((await bridge.rpc("tools/list")).tools.map((tool) => tool.name));
    for (const tool of [...MEMORY_TOOLS, ...ATTENTION_TOOLS, ...ORCHESTRATOR_TOOLS])
      assert.ok(names.has(tool.name), `${tool.name} listed`);

    const plain = startBridge();
    t.after(() => plain.close());
    await plain.rpc("initialize", {});
    const plainNames = new Set((await plain.rpc("tools/list")).tools.map((tool) => tool.name));
    assert.ok(plainNames.has("mem_get"));
    assert.equal(plainNames.has(ATTENTION_TOOLS[0].name), false);
    assert.equal(plainNames.has("orch_list"), false);

    // A worker Solo chat: --orchestrate plus BUZZHOST_NO_ORCHESTRATE=1 exposes none.
    const worker = startBridge({ args: ["--orchestrate"], env: { BUZZHOST_NO_ORCHESTRATE: "1" } });
    t.after(() => worker.close());
    const workerInit = await worker.rpc("initialize", {});
    const workerNames = new Set((await worker.rpc("tools/list")).tools.map((tool) => tool.name));
    assert.equal(workerNames.has("orch_list"), false);
    assert.doesNotMatch(workerInit.instructions, /Orchestration/);
  });

  await t.test("tools/call forwards memory, confines mem_set paths, injects orch chat/cwd", async () => {
    const cwd = path.join(tmp, 'agent "cwd" \\ back');
    await fs.mkdir(cwd, { recursive: true });
    await fs.writeFile(path.join(cwd, "notes.md"), "notes from the session\n");
    await fs.mkdir(path.join(tmp, "outside"), { recursive: true });
    await fs.writeFile(path.join(tmp, "outside", "secret.txt"), "do not read me\n");
    // Quotes, backslashes, a tab and a control character all survive the C→JSON hop.
    const chat = 'chat "quoted" \\ with\\backslash\nand\ttab\x01end';

    const bridge = startBridge({ args: ["--orchestrate"], env: { BUZZHOST_CHAT: chat }, cwd });
    t.after(() => bridge.close());

    const got = await bridge.rpc("tools/call", { name: "mem_get", arguments: { slug: "core" } });
    assert.match(got.content[0].text, /core of aaaa: core/);
    assert.equal(calls.at(-1).pubkey, PUBKEY);

    const saved = await bridge.rpc("tools/call", { name: "mem_set", arguments: { slug: "notes", path: "notes.md" } });
    assert.equal(saved.content[0].text, "saved notes: notes from the session\n");
    assert.deepEqual(calls.at(-1).args, { slug: "notes", text: "notes from the session\n" });

    const escaped = await bridge.rpc("tools/call", {
      name: "mem_set",
      arguments: { slug: "leak", path: "../outside/secret.txt" },
    });
    assert.equal(escaped.isError, true);
    assert.match(escaped.content[0].text, /is outside/);
    assert.equal(calls.at(-1).name, "mem_set"); // nothing was read or routed

    const delegate = await bridge.rpc("tools/call", {
      name: "orch_delegate",
      arguments: { runtime: "claude", prompt: "do the thing" },
    });
    const injected = JSON.parse(delegate.content[0].text);
    assert.equal(injected.chat, chat);
    assert.equal(injected.cwd, await fs.realpath(cwd));
    assert.equal(injected.prompt, "do the thing");

    // orch_list carries no chat key, but still gets the session's cwd.
    const list = await bridge.rpc("tools/call", { name: "orch_list", arguments: {} });
    assert.deepEqual(JSON.parse(list.content[0].text), { chat: null, cwd: await fs.realpath(cwd) });
  });

  await t.test("computer tools stay lazy and arrive only with --computer", async () => {
    const otherRun = path.join(tmp, "computer-runtime", "buzz-host");
    const calls2 = [];
    const computerModule = async () => ({
      instructions: () => "Your computer: a test desktop.",
      createComputer: () => ({
        tools: async () => [{ name: "screenshot", description: "shot", inputSchema: {} }],
        call: async (name) => {
          calls2.push(name);
          return { content: [{ type: "text", text: `computer ${name}` }] };
        },
        close() {},
      }),
    });
    const local = createMcpServer({ runDir: otherRun, callTool, computerModule, log: SILENT });
    await local.start();
    t.after(() => local.stop());

    const bridge = startBridge({ args: ["--computer"], env: { XDG_RUNTIME_DIR: path.dirname(otherRun) } });
    t.after(() => bridge.close());
    const init = await bridge.rpc("initialize", {});
    assert.match(init.instructions, /Your computer: a test desktop/);
    const names = (await bridge.rpc("tools/list")).tools.map((tool) => tool.name);
    assert.ok(names.includes("screenshot"));
    const shot = await bridge.rpc("tools/call", { name: "screenshot", arguments: {} });
    assert.equal(shot.content[0].text, "computer screenshot");
    assert.deepEqual(calls2, ["screenshot"]);
  });

  await t.test("the same bridge reconnects and replays after a buzz-host restart", async () => {
    const bridge = startBridge();
    t.after(() => bridge.close());
    await bridge.rpc("initialize", {});
    assert.deepEqual(await bridge.rpc("ping"), {});

    await server.stop();
    // The bridge sees the socket EOF immediately; give it a beat to drop it.
    await sleep(300);
    const buffered = bridge.rpc("ping"); // waits for the reconnect, then replays
    server = createMcpServer({ runDir, callTool, log: SILENT });
    await server.start();
    assert.deepEqual(await buffered, {});

    const got = await bridge.rpc("tools/call", { name: "mem_get", arguments: { slug: "again" } });
    assert.match(got.content[0].text, /core of aaaa: again/);
  });

  await t.test("stdin EOF exits 0 promptly", async () => {
    const bridge = startBridge();
    await bridge.rpc("initialize", {});
    const started = Date.now();
    assert.equal(await bridge.close(), 0);
    assert.ok(Date.now() - started < 2000);
  });

  await t.test("the bridge's resident memory stays tiny", async () => {
    const bridge = startBridge({ args: ["--attention", "--orchestrate"] });
    t.after(() => bridge.close());
    await bridge.rpc("initialize", {});
    await bridge.rpc("tools/list");
    const kib = await rssKiB(bridge.child.pid);
    t.diagnostic(`buzz-mcp-bridge RSS: ${kib} KiB`);
    assert.ok(kib > 0 && kib < 8 * 1024, `RSS ${kib} KiB`);
  });
});
