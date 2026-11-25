// An agent's `computer` tools: cua-driver's own MCP tools for the agent's own
// desktop (desktop.mjs), behind the take-over lease. buzz-mcp.mjs serves them
// next to memory and Attention when the agent has a desktop (`--computer`).
//
// - Every action lands on the agent's desktop, never on the owner's session:
//   the cua-driver daemon only has that desktop's DISPLAY, runs without
//   /dev/uinput, and this client gets an allowlisted env (no WAYLAND_DISPLAY).
// - The desktop starts on first use. The tool list is cached per driver
//   version, so listing tools does not start a desktop.
// - While a human holds the lease (Take over) every call is refused,
//   screenshots included: they may be typing a password. A call admitted
//   before a takeover that finishes after it has its result withheld.

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import * as desktop from "./desktop.mjs";
import { readLease, HUMAN, HumanHasControl } from "./lease.mjs";

const CALL_TIMEOUT_MS = 120_000;
const driverVersion = () => path.basename(path.dirname(desktop.CUA_DRIVER));

// Curated subset of cua-driver tools exposed to agents. cua-driver publishes
// ~65 tools (~141 KB of JSON schemas, including deprecated and cursor-theme
// tools). Runtimes with a global eager MCP schema budget (such as Antigravity,
// ~57 KB sorted smallest-first) silently evict large tools — including Buzz's
// own watch_add (6.7 KB) and click (6.3 KB) — when all 65 are published.
// Filtering to the essential Xfce desktop tools and trimming verbose parameter
// prose keeps the combined buzz MCP server comfortably under ~35 KB so every
// Attention and desktop tool loads eagerly.
export const EXPOSED_TOOLS = new Set([
  "get_desktop_state",
  "get_screen_size",
  "list_windows",
  "list_apps",
  "launch_app",
  "kill_app",
  "bring_to_front",
  "set_window_frame",
  "click",
  "double_click",
  "right_click",
  "drag",
  "scroll",
  "move_cursor",
  "type_text",
  "press_key",
  "hotkey",
  "clipboard_read",
  "clipboard_write",
  "zoom",
]);

function shortDesc(text, max) {
  if (typeof text !== "string" || !text) return "";
  const first = text.split(/\n\n/)[0].replace(/\s+/g, " ").trim();
  return first.length <= max ? first : `${first.slice(0, max - 1).trimEnd()}…`;
}

function compactSchema(node, depth = 0) {
  if (!node || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map((item) => compactSchema(item, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === "description" && typeof v === "string") {
      out[k] = shortDesc(v, depth > 0 ? 100 : 180);
    } else if (k === "properties" && v && typeof v === "object") {
      out[k] = {};
      for (const [pk, pv] of Object.entries(v)) out[k][pk] = compactSchema(pv, depth + 1);
    } else {
      out[k] = compactSchema(v, depth + 1);
    }
  }
  return out;
}

export function prepareTools(list) {
  return (list ?? [])
    .filter((tool) => tool && EXPOSED_TOOLS.has(tool.name))
    .map((tool) => ({
      name: tool.name,
      description: shortDesc(tool.description, 180),
      inputSchema: compactSchema(tool.inputSchema),
    }));
}

export const instructions = (pubkey) =>
  "Your computer: your own Linux desktop (Xfce, 1280x800), separate from your owner's screen; it starts on first use. " +
  "Look first with get_desktop_state; for click/type use target {\"kind\":\"desktop\",\"display_id\":\"primary\"} with " +
  "screenshot pixel coordinates, and delivery_mode \"foreground\" for keys in a browser. Open a browser with launch_app " +
  `{"launch_path":"${path.join(desktop.desktopDir(pubkey), "bin", "browser")}","urls":[...]}. If a call says a human has taken over, stop and tell your owner what you need.`;

/** `sandboxed`: the agent runs in Docker, so its desktop runs in a sidecar
 *  container (desktop.mjs); this client still runs in buzz-host. */
export function createComputer(pubkey, { chat, sandboxed = false } = {}) {
  const dir = desktop.desktopDir(pubkey);
  let child = null;
  let starting = null;
  let nextId = 1;
  const waiting = new Map();

  function request(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error(`computer: ${method} timed out`));
      }, CALL_TIMEOUT_MS);
      waiting.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  async function ensure() {
    if (child) return;
    starting ??= (async () => {
      const st = await desktop.start(pubkey, { sandboxed });
      const env = { ...desktop.baseEnv(), ...desktop.desktopEnv(dir), XDG_SESSION_TYPE: "x11" };
      const c = spawn(desktop.CUA_DRIVER, ["mcp", "--socket", st.cuaSocket], {
        env,
        stdio: ["pipe", "pipe", "ignore"],
      });
      c.on("exit", () => {
        if (child === c) child = null;
        starting = null;
        for (const [, w] of waiting) {
          clearTimeout(w.timer);
          w.reject(new Error("computer: the desktop driver stopped"));
        }
        waiting.clear();
      });
      readline.createInterface({ input: c.stdout }).on("line", (line) => {
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          return;
        }
        const w = waiting.get(msg.id);
        if (!w) return;
        waiting.delete(msg.id);
        clearTimeout(w.timer);
        if (msg.error) w.reject(new Error(msg.error.message ?? "computer: driver error"));
        else w.resolve(msg.result);
      });
      child = c;
      await request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "buzz-host", version: "1" },
      });
      c.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    })();
    try {
      await starting;
    } catch (e) {
      starting = null;
      child?.kill();
      child = null;
      throw e;
    }
  }

  async function tools() {
    const cache = path.join(dir, `tools-${driverVersion()}.json`);
    try {
      return prepareTools(JSON.parse(fs.readFileSync(cache, "utf8")));
    } catch {}
    await ensure();
    const list = (await request("tools/list", {})).tools ?? [];
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(cache, JSON.stringify(list), { mode: 0o600 });
    return prepareTools(list);
  }

  // `opts.chat`: the calling session's chat key, for one client shared by
  // several sessions (the sandbox MCP bridge).
  async function call(name, args, opts = {}) {
    const refused = (text) => ({ content: [{ type: "text", text }], isError: true });
    const lease = readLease(dir);
    if (lease.holder === HUMAN) return refused(new HumanHasControl().message);
    // The owner's in-chat preview shows while the agent's turn uses these;
    // acp-proxy labels each session's buzz MCP server with BUZZHOST_CHAT. The
    // shared mcp.sock server passes the session's chat key in directly.
    desktop.recordUse(pubkey, name, opts.chat ?? chat ?? process.env.BUZZHOST_CHAT ?? "");
    try {
      await ensure();
      const result = await request("tools/call", { name, arguments: args ?? {} });
      const now = readLease(dir);
      if (now.holder === HUMAN || now.epoch !== lease.epoch)
        return refused("computer: control changed hands while this action ran; its result is withheld.");
      return result;
    } catch (e) {
      return refused(String(e.message ?? e));
    }
  }

  return { tools, call, close: () => child?.stdin.end() };
}
