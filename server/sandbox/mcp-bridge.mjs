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
//   3. Explicitly blocks orchestrator, desktop, and host-profile tools

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

export function createSandboxMcpBridge({ runDir, callTool, isAttentionEnabled, log = console }) {
  /** pubkey -> { server, sockPath } */
  const servers = new Map();

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

  async function removeAgent(pubkey) {
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
    close,
    sockPathFor,
  };
}
