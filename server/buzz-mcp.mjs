#!/usr/bin/env node
// The agent's Buzz tools as an MCP server named "buzz", as Buzz's own (stdio,
// newline-delimited JSON-RPC), started by the agent's runtime for each session
// through BUZZ_ACP_MCP_COMMAND: Buzz's memory tools (memory.mjs) always, and
// its Attention tools (attention-core.mjs) while the owner has Attention on,
// and the computer tools for the agent's own desktop (desktop/computer.mjs)
// while the owner has given it one.
// Each call goes to buzz-host on $XDG_RUNTIME_DIR/buzz-host/attention.sock,
// which owns the agent's records and key. mem_set's `path` is read here, in
// the session's folder, as Buzz reads it in the agent's workspace.
//
//   buzz-mcp.mjs <agent-pubkey> [--attention] [--computer] [--orchestrate]   (buzz-host writes a per-agent wrapper)

import fs from "node:fs/promises";
import { createConnection } from "node:net";
import path from "node:path";
import readline from "node:readline";
import { ATTENTION_TOOLS } from "./attention-core.mjs";
import { MEMORY_TOOLS } from "./memory.mjs";
import { ORCHESTRATOR_TOOLS } from "./orchestrator.mjs";

const pubkey = process.argv[2] ?? process.env.BUZZHOST_AGENT ?? "";
const withAttention = process.argv.includes("--attention");
const withComputer = process.argv.includes("--computer");
const withOrchestrate = process.argv.includes("--orchestrate");
if (!/^[0-9a-f]{64}$/.test(pubkey)) {
  process.stderr.write("buzz-mcp: usage: buzz-mcp.mjs <agent-pubkey> [--attention] [--computer] [--orchestrate]\n");
  process.exit(2);
}
const TOOLS = [
  ...MEMORY_TOOLS,
  ...(withAttention ? ATTENTION_TOOLS : []),
  ...(withOrchestrate ? ORCHESTRATOR_TOOLS : []),
];
// Loaded only for agents with a desktop: everyone else never imports it.
const computerModule = withComputer ? await import("./desktop/computer.mjs") : null;
const computer = computerModule?.createComputer(pubkey);
let computerNames = new Set();
async function computerTools() {
  if (!computer) return [];
  const own = new Set(TOOLS.map((t) => t.name));
  const list = (await computer.tools()).filter((t) => !own.has(t.name));
  computerNames = new Set(list.map((t) => t.name));
  return list;
}

/** mem_set's `path`: a file inside this session's folder, sent as its text.
 *  orch_* tools: attach the session's chat key (from acp-proxy's BUZZHOST_CHAT)
 *  and working directory so buzz-host can enforce owner-initiated chat checks,
 *  scope tasks to the conversation, and default the worker workspace. */
async function prepareArgs(name, args) {
  if (name === "mem_set" && typeof args.path === "string" && args.path) {
    const root = await fs.realpath(process.cwd());
    const full = await fs.realpath(path.resolve(root, args.path));
    const inside = path.relative(root, full);
    if (inside.startsWith("..") || path.isAbsolute(inside)) throw new Error(`${args.path} is outside ${root}`);
    const { path: _, ...rest } = args;
    return { ...rest, text: await fs.readFile(full, "utf8") };
  }
  if (name.startsWith("orch_")) {
    const out = { ...args, cwd: process.cwd() };
    if (name !== "orch_list") out.chat = process.env.BUZZHOST_CHAT || "";
    return out;
  }
  return args;
}
const runDir = path.join(process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`, "buzz-host");
const SOCKET = path.join(runDir, "attention.sock");
const CALL_TIMEOUT_MS = 60_000;
const ORCH_WAIT_DEFAULT_MS = 120_000;
const ORCH_WAIT_MAX_MS = 600_000;

function timeoutFor(name, args) {
  if (name !== "orch_wait") return CALL_TIMEOUT_MS;
  const parsed = Number(args?.timeoutMs);
  const requested = Number.isFinite(parsed) ? parsed : ORCH_WAIT_DEFAULT_MS;
  return Math.min(Math.max(requested, 1_000), ORCH_WAIT_MAX_MS) + 15_000;
}

function call(name, args, timeoutMs = CALL_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const sock = createConnection(SOCKET);
    let buf = "";
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      sock.destroy();
      finish(reject, new Error("buzz-host did not answer"));
    }, timeoutMs);
    sock.setEncoding("utf8");
    sock.on("connect", () => sock.write(`${JSON.stringify({ pubkey, name, args })}\n`));
    sock.on("data", (chunk) => {
      buf += chunk;
      const i = buf.indexOf("\n");
      if (i < 0) return;
      sock.end();
      try {
        const reply = JSON.parse(buf.slice(0, i));
        if (reply.error) finish(reject, new Error(reply.error));
        else finish(resolve, reply.result);
      } catch (error) {
        finish(reject, error);
      }
    });
    sock.on("error", (error) => {
      finish(
        reject,
        error.code === "ENOENT" || error.code === "ECONNREFUSED"
          ? new Error("buzz-host is not running on this host")
          : error,
      );
    });
    sock.on("close", () => {
      finish(reject, new Error("buzz-host closed the connection before answering"));
    });
  });
}

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

async function handle(request) {
  const { id, method, params } = request;
  switch (method) {
    case "initialize":
      return {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "buzz", version: "1.0.0" },
        instructions: [
          "Your memory: core, injected into your context, and cold mem/ entries you read on demand. Your owner sees it in your Memory tab in Buzz.",
          ...(withAttention
            ? [
                "Your Attention: Interests you are responsible for, event watches that wake you when a matching message arrives, and timers that wake you on a schedule.",
              ]
            : []),
          ...(computerModule ? [computerModule.instructions(pubkey)] : []),
          ...(withOrchestrate
            ? [
                "Orchestration: you can spawn ephemeral worker sessions on other runtimes (claude, codex, hermes, antigravity) with orch_capabilities, orch_delegate, orch_wait, orch_status, orch_list, orch_steer, and orch_cancel.",
              ]
            : []),
        ].join("\n"),
      };
    case "ping":
      return {};
    case "tools/list":
      return {
        tools: [
          ...TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
          // A desktop that cannot start must not take memory and Attention down with it.
          ...(await computerTools().catch((error) => {
            process.stderr.write(`buzz-mcp: computer tools unavailable: ${error.message}\n`);
            return [];
          })),
        ],
      };
    case "tools/call": {
      const name = params?.name;
      if (computer && (computerNames.has(name) || !TOOLS.some((t) => t.name === name))) {
        if (!computerNames.size) await computerTools().catch(() => {});
        if (computerNames.has(name)) return computer.call(name, params?.arguments ?? {});
      }
      try {
        if (!TOOLS.some((t) => t.name === name)) throw new Error(`No tool ${name}`);
        const prepared = await prepareArgs(name, params?.arguments ?? {});
        const text = await call(name, prepared, timeoutFor(name, prepared));
        return { content: [{ type: "text", text }] };
      } catch (error) {
        return { content: [{ type: "text", text: String(error.message ?? error) }], isError: true };
      }
    }
    default:
      if (id === undefined) return undefined; // a notification
      throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
  }
}

const lines = readline.createInterface({ input: process.stdin });
lines.on("line", async (line) => {
  if (!line.trim()) return;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return send({ id: null, error: { code: -32700, message: "Parse error" } });
  }
  try {
    const result = await handle(request);
    if (request.id !== undefined && result !== undefined) send({ id: request.id, result });
  } catch (error) {
    if (request.id !== undefined)
      send({ id: request.id, error: { code: error.code ?? -32603, message: String(error.message ?? error) } });
  }
});
lines.on("close", () => {
  computer?.close();
  process.exit(0);
});
