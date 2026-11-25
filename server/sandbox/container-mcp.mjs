#!/usr/bin/env node
// Sandboxed Buzz MCP server (stdio JSON-RPC) running inside a Docker container.
//
// Connects ONLY to the agent's host-scoped Unix socket (/run/buzz-sandbox/mcp.sock),
// which pins the agent's pubkey server-side and allows only Memory tools (+ Attention
// tools if enabled). With BUZZ_SANDBOX_COMPUTER=1 it also lists and forwards
// the computer tools of the agent's own desktop, which runs in a separate
// sidecar container (never on the host's displays). Never exposes orchestrator
// tools.

import fs from "node:fs/promises";
import { createConnection } from "node:net";
import path from "node:path";
import readline from "node:readline";
import { ATTENTION_TOOLS } from "../attention-core.mjs";
import { MEMORY_TOOLS } from "../memory.mjs";

const SOCKET = process.env.BUZZ_HOST_MCP_SOCK || "/run/buzz-sandbox/mcp.sock";
const withAttention = process.env.BUZZ_SANDBOX_ATTENTION === "1";
const TOOLS = [...MEMORY_TOOLS, ...(withAttention ? ATTENTION_TOOLS : [])];
const withComputer = process.env.BUZZ_SANDBOX_COMPUTER === "1";
const CALL_TIMEOUT_MS = 60_000;
// The desktop starts on first use (up to a minute), and a computer call may
// itself take up to two minutes (desktop/computer.mjs).
const COMPUTER_TIMEOUT_MS = 200_000;
let computer = null; // { tools, instructions } once listed

async function prepareArgs(name, args) {
  if (name === "mem_set" && typeof args.path === "string" && args.path) {
    const root = await fs.realpath("/workspace");
    const full = await fs.realpath(path.resolve(root, args.path));
    const inside = path.relative(root, full);
    if (inside.startsWith("..") || path.isAbsolute(inside)) {
      throw new Error(`${args.path} is outside /workspace`);
    }
    const { path: _, ...rest } = args;
    return { ...rest, text: await fs.readFile(full, "utf8") };
  }
  return args;
}

function call(name, args) {
  return bridgeRequest({ name, args }).then((reply) => reply.result);
}

async function computerTools() {
  if (!withComputer) return null;
  computer ??= await bridgeRequest({ op: "computer.tools" }, COMPUTER_TIMEOUT_MS).then((reply) => reply.result);
  return computer;
}

function bridgeRequest(payload, timeoutMs = CALL_TIMEOUT_MS) {
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
      finish(reject, new Error("buzz-host sandbox MCP bridge did not answer"));
    }, timeoutMs);
    sock.setEncoding("utf8");
    sock.on("connect", () => sock.write(`${JSON.stringify(payload)}\n`));
    sock.on("data", (chunk) => {
      buf += chunk;
      const i = buf.indexOf("\n");
      if (i < 0) return;
      sock.end();
      try {
        const reply = JSON.parse(buf.slice(0, i));
        if (reply.error) finish(reject, new Error(reply.error));
        else finish(resolve, reply);
      } catch (error) {
        finish(reject, error);
      }
    });
    sock.on("error", (error) => {
      finish(
        reject,
        error.code === "ENOENT" || error.code === "ECONNREFUSED"
          ? new Error("buzz-host sandbox MCP bridge is not available")
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
    case "initialize": {
      const desk = await computerTools().catch(() => null);
      return {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "buzz", version: "1.0.0" },
        instructions: [
          "Your memory: core, injected into your context, and cold mem/ entries you read on demand.",
          ...(withAttention
            ? [
                "Your Attention: Interests you are responsible for, event watches that wake you when a matching message arrives, and timers that wake you on a schedule.",
              ]
            : []),
          ...(desk?.instructions ? [desk.instructions] : []),
        ].join("\n"),
      };
    }
    case "ping":
      return {};
    case "tools/list": {
      const own = TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
      const ownNames = new Set(own.map((t) => t.name));
      const desk = await computerTools().catch(() => null);
      return { tools: [...own, ...(desk?.tools ?? []).filter((t) => !ownNames.has(t.name))] };
    }
    case "tools/call": {
      const name = params?.name;
      try {
        if (!TOOLS.some((t) => t.name === name)) {
          const desk = await computerTools().catch(() => null);
          if (!desk?.tools?.some((t) => t.name === name)) throw new Error(`No tool ${name}`);
          const reply = await bridgeRequest(
            { name, args: params?.arguments ?? {}, chat: process.env.BUZZHOST_CHAT || "" },
            COMPUTER_TIMEOUT_MS,
          );
          return reply.computer;
        }
        const prepared = await prepareArgs(name, params?.arguments ?? {});
        const text = await call(name, prepared);
        return { content: [{ type: "text", text }] };
      } catch (error) {
        return { content: [{ type: "text", text: String(error.message ?? error) }], isError: true };
      }
    }
    default:
      if (id === undefined) return undefined;
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
lines.on("close", () => process.exit(0));
