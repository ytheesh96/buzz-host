// Per-agent scoped MCP Unix socket bridge for sandboxed containers.
//
// Unlike the host-wide attention.sock (which accepts an arbitrary `pubkey` in
// each JSON line and also exposes host-only tools like orch_* and
// _ensure_hermes_profile), each sandboxed agent gets its own Unix socket at
// <runDir>/sandbox/<pubkey16>/mcp.sock that:
//   1. Hardcodes the agent's pubkey server-side (ignores any spoofed pubkey)
//   2. Only forwards allowlisted tools:
//      - Memory tools (mem_get, mem_set, mem_rm) always
//      - Attention tools (interest_*, watch_*) only when Attention is enabled
//      - Computer tools (cua-driver's, desktop/computer.mjs) only while the
//        agent has a desktop; that desktop runs in its own sidecar container
//        (sandbox/desktop-sidecar.mjs), never on the host's displays
//   3. Explicitly blocks orchestrator and host-profile tools
//
// Wire format, one JSON line each way: {name, args} -> {result} | {error}.
// Computer tools: {op: "computer.tools"} -> {result: {tools, instructions}},
// and {name, args, chat} -> {computer: <MCP tools/call result>}.

import { createServer } from "node:net";
import fs from "node:fs/promises";
import path from "node:path";

const HEX64 = /^[0-9a-f]{64}$/;
const MEMORY_TOOL_NAMES = new Set(["mem_get", "mem_set", "mem_rm", "memory_core"]);
const ATTENTION_TOOL_NAMES = new Set([
  "interest_list",
  "interest_show",
  "interest_set",
  "interest_remove",
  "watch_list",
  "watch_show",
  "watch_add",
  "watch_enable",
  "watch_disable",
  "watch_rearm",
  "watch_remove",
]);

export function isAllowedSandboxTool(name, { attentionEnabled = false } = {}) {
  if (typeof name !== "string") return false;
  if (MEMORY_TOOL_NAMES.has(name)) return true;
  if (attentionEnabled && ATTENTION_TOOL_NAMES.has(name)) return true;
  return false;
}

const CHAT_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:_[0-9a-f]{64})?$/;

export function createSandboxMcpBridge({
  runDir,
  callTool,
  isAttentionEnabled,
  isDesktopEnabled = null,
  computerModule = null,
  log = console,
}) {
  /** pubkey -> { server, sockPath } */
  const servers = new Map();
  /** pubkey -> { computer, instructions, names } — one desktop client per agent, shared by its sessions. */
  const computers = new Map();

  async function computerFor(pubkey) {
    if (!computerModule || !isDesktopEnabled || !(await isDesktopEnabled(pubkey))) {
      throw new Error("This agent has no desktop");
    }
    let entry = computers.get(pubkey);
    if (!entry) {
      const mod = await computerModule();
      entry = {
        computer: mod.createComputer(pubkey, { sandboxed: true }),
        instructions: mod.instructions(pubkey),
        names: null,
      };
      computers.set(pubkey, entry);
    }
    return entry;
  }

  async function computerTools(pubkey) {
    const entry = await computerFor(pubkey);
    const tools = await entry.computer.tools();
    entry.names = new Set(tools.map((t) => t.name));
    return { tools, instructions: entry.instructions };
  }

  async function handleComputer(pubkey, req) {
    if (req?.op === "computer.tools") return { result: await computerTools(pubkey) };
    const name = req?.name;
    if (typeof name !== "string" || !computerModule || !isDesktopEnabled) return null;
    if (MEMORY_TOOL_NAMES.has(name) || ATTENTION_TOOL_NAMES.has(name)) return null;
    if (!(await isDesktopEnabled(pubkey))) return null;
    const entry = await computerFor(pubkey);
    if (!entry.names) await computerTools(pubkey);
    if (!entry.names.has(name)) return null;
    const args = req?.args && typeof req.args === "object" ? req.args : {};
    const chat = typeof req.chat === "string" && CHAT_KEY.test(req.chat) ? req.chat : "";
    return { computer: await entry.computer.call(name, args, { chat }) };
  }

  const sockPathFor = (pubkey) => path.join(runDir, "sandbox", pubkey.slice(0, 16), "mcp.sock");

  async function ensureAgent(pubkey) {
    if (!HEX64.test(pubkey)) throw new Error("Invalid agent pubkey");
    const sockPath = sockPathFor(pubkey);
    const existing = servers.get(pubkey);
    if (existing && existing.server.listening) return { sockPath };

    await fs.mkdir(path.dirname(sockPath), { recursive: true, mode: 0o700 });
    await fs.rm(sockPath, { force: true });

    const server = createServer((socket) => {
      socket.setEncoding("utf8");
      let buf = "";
      socket.on("data", async (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          let reply;
          try {
            const req = JSON.parse(line);
            const viaComputer = await handleComputer(pubkey, req);
            if (viaComputer) {
              if (!socket.destroyed) socket.write(`${JSON.stringify(viaComputer)}\n`);
              continue;
            }
            const name = req?.name;
            const args = req?.args && typeof req.args === "object" ? req.args : {};
            const attentionEnabled = isAttentionEnabled ? await isAttentionEnabled(pubkey) : false;
            if (!isAllowedSandboxTool(name, { attentionEnabled })) {
              throw new Error(`Tool "${name}" is not permitted in a sandboxed agent`);
            }
            // Pin pubkey to this socket's owner regardless of req.pubkey.
            const result = await callTool(pubkey, name, args);
            reply = { result };
          } catch (error) {
            reply = { error: String(error?.message ?? error) };
          }
          if (!socket.destroyed) socket.write(`${JSON.stringify(reply)}\n`);
        }
      });
      socket.on("error", () => {});
    });

    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(sockPath, resolve);
    });
    await fs.chmod(sockPath, 0o600);
    servers.set(pubkey, { server, sockPath });
    return { sockPath };
  }

  /** Drop the agent's desktop client (its desktop was turned off or the agent restarted). */
  function dropComputer(pubkey) {
    const c = computers.get(pubkey);
    computers.delete(pubkey);
    try {
      c?.computer.close();
    } catch {}
  }

  async function removeAgent(pubkey) {
    dropComputer(pubkey);
    const entry = servers.get(pubkey);
    servers.delete(pubkey);
    if (entry?.server) {
      await new Promise((resolve) => entry.server.close(() => resolve()));
    }
    await fs.rm(sockPathFor(pubkey), { force: true }).catch(() => {});
  }

  async function close() {
    await Promise.all([...servers.keys()].map((pubkey) => removeAgent(pubkey)));
  }

  return {
    ensureAgent,
    removeAgent,
    dropComputer,
    close,
    sockPathFor,
  };
}
