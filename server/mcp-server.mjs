// The agent's Buzz tools, shared by every agent session on this host.
//
// Each session's runtime starts a tiny stdio process (`buzz-mcp-bridge`, a
// compiled C program) that connects to this server on
// $XDG_RUNTIME_DIR/buzz-host/mcp.sock and speaks MCP JSON-RPC 2.0 over it,
// newline-delimited. The bridge costs a few hundred KB per session instead of
// a whole Node/V8 process for `buzz-mcp.mjs`, which stays as the standalone
// fallback when the bridge is not installed.
//
// Wire protocol, per Unix socket connection:
//   1. one init line — {"_buzzMcpInit":true,"pubkey":"<64hex>", ...} — naming
//      the agent, its tool groups, its chat key and its working directory.
//      A connection whose first line is not a valid init is destroyed.
//   2. then standard MCP JSON-RPC requests: initialize, ping, tools/list,
//      tools/call, notifications.
//
// Tools are routed to `callTool(pubkey, name, args)`, which buzz-host wires to
// Attention's handler chain (memory.mjs, orchestrator.mjs, attention.mjs).
// mem_set's `path` is read here, confined to the session's own folder, exactly
// as buzz-mcp.mjs reads it in the session's process.

import fs from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { ATTENTION_TOOLS } from "./attention-core.mjs";
import { MEMORY_TOOLS } from "./memory.mjs";
import { ORCHESTRATOR_TOOLS } from "./orchestrator.mjs";

const HEX64 = /^[0-9a-f]{64}$/;
const CALL_TIMEOUT_MS = 60_000;
const ORCH_WAIT_DEFAULT_MS = 120_000;
const ORCH_WAIT_MAX_MS = 600_000;
/** One JSON-RPC line (or the unparsed remainder of one) may not exceed this. */
const MAX_LINE = 4 << 20;

const MEMORY_GUIDE =
  "Your memory: core, injected into your context, and cold mem/ entries you read on demand. Your owner sees it in your Memory tab in Buzz.";
const ATTENTION_GUIDE =
  "Your Attention: Interests you are responsible for, event watches that wake you when a matching message arrives, and timers that wake you on a schedule.";
const ORCHESTRATE_GUIDE =
  "Orchestration: you can delegate tasks to real Solo-chat workers on other runtimes (claude, codex, hermes, antigravity) with orch_capabilities, orch_delegate, orch_wait, orch_status, orch_list, orch_steer, and orch_cancel. Workers see no history from this chat, so write each orch_delegate prompt as a self-contained brief and put background (decisions, constraints, findings so far) in its optional context field. Each delegated task opens a real Solo chat that links back to the owner's message here, with a buzz://message link — include that link verbatim in your chat updates so the owner can open and inspect the worker chat directly.";

/** Same budget rules as buzz-mcp.mjs: orch_wait may wait as long as it asked. */
function timeoutFor(name, args) {
  if (name !== "orch_wait") return CALL_TIMEOUT_MS;
  const parsed = Number(args?.timeoutMs);
  const requested = Number.isFinite(parsed) ? parsed : ORCH_WAIT_DEFAULT_MS;
  return Math.min(Math.max(requested, 1_000), ORCH_WAIT_MAX_MS) + 15_000;
}

function withTimeout(promise, ms, message) {
  let timer;
  const expiry = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}

/**
 * @param {object} options
 * @param {string} options.runDir       buzz-host's runtime dir (holds mcp.sock)
 * @param {(pubkey: string, name: string, args: object) => Promise<unknown>} options.callTool
 * @param {() => Promise<any>} [options.computerModule]  lazy desktop/computer.mjs
 * @param {Console} [options.log]
 */
export function createMcpServer({ runDir, callTool, computerModule = null, log = console }) {
  const socketPath = path.join(runDir, "mcp.sock");
  const connections = new Set();
  let server = null;
  let modulePromise = null;

  // Loaded only for agents with a desktop, and only once per host.
  function computerModuleFor(pubkey) {
    if (!computerModule) return Promise.resolve(null);
    modulePromise ??= Promise.resolve()
      .then(computerModule)
      .then((mod) => (mod?.createComputer ? mod : null))
      .catch((error) => {
        log.warn?.(`buzz-mcp: computer tools unavailable: ${error.message}`);
        modulePromise = null;
        return null;
      });
    return modulePromise;
  }

  const toolsFor = (session) => [
    ...MEMORY_TOOLS,
    ...(session.attention ? ATTENTION_TOOLS : []),
    ...(session.orchestrate ? ORCHESTRATOR_TOOLS : []),
  ];

  /** mem_set's `path`: a file inside this session's folder, sent as its text.
   *  orch_* tools: attach the session's chat key and working directory so
   *  buzz-host can enforce owner-initiated chat checks, scope tasks to the
   *  conversation, and default the worker workspace. */
  async function prepareArgs(session, name, args) {
    if (name === "mem_set" && typeof args.path === "string" && args.path) {
      const root = await fs.realpath(session.cwd);
      const full = await fs.realpath(path.resolve(root, args.path));
      const inside = path.relative(root, full);
      if (inside.startsWith("..") || path.isAbsolute(inside)) throw new Error(`${args.path} is outside ${root}`);
      const { path: _, ...rest } = args;
      return { ...rest, text: await fs.readFile(full, "utf8") };
    }
    if (name.startsWith("orch_")) {
      const out = { ...args, cwd: session.cwd };
      if (name !== "orch_list") out.chat = session.chat || "";
      return out;
    }
    return args;
  }

  async function computerTools(session) {
    if (!session.computer) return [];
    const own = new Set(toolsFor(session).map((t) => t.name));
    const list = (await session.computer.tools()).filter((t) => !own.has(t.name));
    session.computerNames = new Set(list.map((t) => t.name));
    return list;
  }

  async function ensureComputer(session) {
    if (session.computer || !session.withComputer) return session.computer;
    const mod = await computerModuleFor(session.pubkey);
    if (!mod) return null;
    try {
      session.computer = mod.createComputer(session.pubkey, { chat: session.chat });
      session.computerInstructions = mod.instructions(session.pubkey);
    } catch (error) {
      log.warn?.(`buzz-mcp: computer unavailable for ${session.pubkey.slice(0, 8)}: ${error.message}`);
      return null;
    }
    return session.computer;
  }

  function closeComputer(session) {
    const computer = session?.computer;
    if (session) session.computer = null;
    try {
      computer?.close?.();
    } catch {}
  }

  async function initialize(session, params) {
    await ensureComputer(session);
    return {
      protocolVersion: params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "buzz", version: "1.0.0" },
      instructions: [
        MEMORY_GUIDE,
        ...(session.attention ? [ATTENTION_GUIDE] : []),
        ...(session.computerInstructions ? [session.computerInstructions] : []),
        ...(session.orchestrate ? [ORCHESTRATE_GUIDE] : []),
      ].join("\n"),
    };
  }

  async function handleRequest(session, request) {
    const { id, method, params } = request;
    switch (method) {
      case "initialize":
        return initialize(session, params);
      case "ping":
        return {};
      case "tools/list":
        return {
          tools: [
            ...toolsFor(session).map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
            // A desktop that cannot start must not take memory and Attention down with it.
            ...(await computerTools(session).catch((error) => {
              log.warn?.(`buzz-mcp: computer tools unavailable: ${error.message}`);
              return [];
            })),
          ],
        };
      case "tools/call": {
        const name = params?.name;
        const args = params?.arguments ?? {};
        if (session.withComputer) {
          if (!session.computer) await ensureComputer(session);
          if (session.computer && (session.computerNames.has(name) || !toolsFor(session).some((t) => t.name === name))) {
            if (!session.computerNames.size) await computerTools(session).catch(() => {});
            if (session.computerNames.has(name)) return session.computer.call(name, args);
          }
        }
        try {
          if (!toolsFor(session).some((t) => t.name === name)) throw new Error(`No tool ${name}`);
          const prepared = await prepareArgs(session, name, args);
          const text = await withTimeout(
            Promise.resolve(callTool(session.pubkey, name, prepared)),
            timeoutFor(name, prepared),
            "buzz-host did not answer",
          );
          return { content: [{ type: "text", text }] };
        } catch (error) {
          return { content: [{ type: "text", text: String(error?.message ?? error) }], isError: true };
        }
      }
      default:
        if (id === undefined) return undefined; // a notification
        throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
    }
  }

  function parseInit(line) {
    let init;
    try {
      init = JSON.parse(line);
    } catch {
      return null;
    }
    if (!init || init._buzzMcpInit !== true) return null;
    if (typeof init.pubkey !== "string" || !HEX64.test(init.pubkey)) return null;
    return {
      pubkey: init.pubkey,
      attention: init.attention === true,
      withComputer: init.computer === true,
      orchestrate: init.orchestrate === true,
      chat: typeof init.chat === "string" ? init.chat : "",
      cwd: typeof init.cwd === "string" && init.cwd ? init.cwd : process.cwd(),
      computer: null,
      computerNames: new Set(),
      computerInstructions: "",
    };
  }

  function send(conn, message) {
    if (!conn.destroyed) conn.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  }

  async function handleLine(conn, state, line) {
    if (!line.trim()) return;
    if (!state.session) {
      const init = parseInit(line);
      // A socket that does not open with a valid handshake is not an agent's bridge.
      if (!init) {
        conn.destroy();
        return;
      }
      state.session = init;
      return;
    }
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      return send(conn, { id: null, error: { code: -32700, message: "Parse error" } });
    }
    try {
      const result = await handleRequest(state.session, request);
      if (request.id !== undefined && result !== undefined) send(conn, { id: request.id, result });
    } catch (error) {
      if (request.id !== undefined)
        send(conn, {
          id: request.id,
          error: { code: error?.code ?? -32603, message: String(error?.message ?? error) },
        });
    }
  }

  function handleConnection(conn) {
    const state = { session: null, buf: "", closed: false };
    conn.setEncoding("utf8");
    conn.on("error", () => {});
    conn.on("close", () => {
      state.closed = true;
      closeComputer(state.session);
    });
    conn.on("data", (chunk) => {
      if (state.closed) return;
      state.buf += chunk;
      if (state.buf.length > MAX_LINE) {
        // No line may grow past the cap: drop the socket rather than buzz-host's memory.
        conn.destroy();
        return;
      }
      let i;
      while ((i = state.buf.indexOf("\n")) >= 0) {
        const line = state.buf.slice(0, i);
        state.buf = state.buf.slice(i + 1);
        // Like buzz-mcp.mjs: each request runs on its own, so a slow tool call
        // does not stall the session's next request. The init line is handled
        // synchronously, before any request that follows it.
        void handleLine(conn, state, line).catch(() => {});
      }
    });
  }

  async function start() {
    await fs.mkdir(runDir, { recursive: true, mode: 0o700 });
    await fs.chmod(runDir, 0o700).catch(() => {});
    await fs.rm(socketPath, { force: true });
    server = createServer((conn) => {
      connections.add(conn);
      conn.on("close", () => connections.delete(conn));
      handleConnection(conn);
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    await fs.chmod(socketPath, 0o600);
    return socketPath;
  }

  async function stop() {
    for (const conn of connections) conn.destroy();
    connections.clear();
    const closing = server;
    server = null;
    if (closing) await new Promise((resolve) => closing.close(resolve));
    await fs.rm(socketPath, { force: true });
  }

  return { start, stop, socketPath };
}
