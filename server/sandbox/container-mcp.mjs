#!/usr/bin/env node
// Sandboxed Buzz MCP server (stdio JSON-RPC) running inside a Docker container.
//
// Connects ONLY to the agent's host-scoped Unix socket (/run/buzz-sandbox/mcp.sock),
// which pins the agent's pubkey server-side and allows only Memory tools (+ Attention
// tools if enabled). Never exposes host desktop or orchestrator tools.

import fs from "node:fs/promises";
import { createConnection } from "node:net";
import path from "node:path";
import readline from "node:readline";
import { ATTENTION_TOOLS } from "../attention-core.mjs";
import { MEMORY_TOOLS } from "../memory.mjs";

const SOCKET = process.env.BUZZ_HOST_MCP_SOCK || "/run/buzz-sandbox/mcp.sock";
const withAttention = process.env.BUZZ_SANDBOX_ATTENTION === "1";
const TOOLS = [...MEMORY_TOOLS, ...(withAttention ? ATTENTION_TOOLS : [])];
const CALL_TIMEOUT_MS = 60_000;

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
    }, CALL_TIMEOUT_MS);
    sock.setEncoding("utf8");
    sock.on("connect", () => sock.write(`${JSON.stringify({ name, args })}\n`));
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
    case "initialize":
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
        ].join("\n"),
      };
    case "ping":
      return {};
    case "tools/list":
      return {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      };
    case "tools/call": {
      const name = params?.name;
      try {
        if (!TOOLS.some((t) => t.name === name)) throw new Error(`No tool ${name}`);
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
