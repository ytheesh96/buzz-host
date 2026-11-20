// Orchestrator v1 — ephemeral ACP workers for an opted-in Omarchy agent.
//
// Shape frozen for Tracks B/C: docs/orchestrator-contract.md. This file is the
// implementation skeleton: the exports and the call signatures are final; the
// method bodies land on feat/orchestrator-core.

import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const RUNTIMES = {
  claude: { title: "Claude Code", shim: "claude-agent-acp" },
  codex: { title: "Codex", shim: "codex-acp" },
  hermes: { title: "Hermes", shim: "hermes-acp" },
  antigravity: { title: "Antigravity", shim: "antigravity-acp" },
};
export const MAX_LIVE = 4;
export const MAX_QUEUE = 16;
export const MAX_DEPTH = 1;

const str = { type: "string" };
const tool = (name, description, properties, required = []) => ({
  name,
  description,
  inputSchema: {
    type: "object",
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  },
});

/** MCP `tools/list` entries for `buzz-mcp.mjs --orchestrate`. */
export const ORCHESTRATOR_TOOLS = [
  tool("orch_capabilities", "Runtimes, models and effort levels available to your workers, and the tasks running now.", {
    retry: { type: "boolean" },
  }),
  tool(
    "orch_delegate",
    "Start a worker on another runtime (claude, codex, hermes, antigravity). Use it when another harness fits the work better than yours, then orch_wait for the answer.",
    {
      runtime: str,
      prompt: str,
      model: str,
      effort: str,
      workspace: str,
      label: str,
      timeoutMs: { type: "number" },
    },
    ["runtime", "prompt"],
  ),
  tool("orch_wait", "Wait for a worker task to finish (up to 10 minutes).", {
    taskId: str,
    timeoutMs: { type: "number" },
  }, ["taskId"]),
  tool("orch_status", "One task with its latest step and transcript.", { taskId: str }, ["taskId"]),
  tool("orch_list", "Your recent tasks, newest first.", {
    chat: str,
    status: str,
    limit: { type: "number" },
  }),
  tool("orch_steer", "Queue a follow-up prompt on a running worker. It runs after the current turn.", {
    taskId: str,
    prompt: str,
  }, ["taskId", "prompt"]),
  tool("orch_cancel", "Stop a worker task.", { taskId: str }, ["taskId"]),
];

/**
 * @param {object} options
 * @param {string} options.dataDir   agents dir (~/.local/share/buzz-host/agents)
 * @param {string} options.stateDir  orchestrator state (~/.local/share/buzz-host/orchestrator)
 * @param {string} [options.shimsDir] runtime shims (default sibling ../shims)
 * @param {(runtime: string) => Promise<object>} [options.catalog] cached models per runtime
 * @param {object} [options.log] console-like
 * @param {object} [options.spawn] child_process.spawn-compatible (tests)
 * @param {object} [options.limits] test overrides
 */
export function createOrchestrator({
  dataDir,
  stateDir = path.join(os.homedir(), ".local/share/buzz-host/orchestrator"),
  shimsDir = path.join(HERE, "shims"),
  catalog,
  log = console,
  spawn,
  limits,
} = {}) {
  if (!dataDir) throw new Error("createOrchestrator: dataDir is required");

  async function capabilities() {
    throw new Error("orch_capabilities is not implemented yet");
  }
  async function delegate() {
    throw new Error("orch_delegate is not implemented yet");
  }
  async function wait() {
    throw new Error("orch_wait is not implemented yet");
  }
  async function status() {
    throw new Error("orch_status is not implemented yet");
  }
  async function list() {
    throw new Error("orch_list is not implemented yet");
  }
  async function steer() {
    throw new Error("orch_steer is not implemented yet");
  }
  async function cancelTask() {
    throw new Error("orch_cancel is not implemented yet");
  }

  return {
    handles: (name) => /^orch_/.test(String(name ?? "")),
    async call(pubkey, name, args = {}) {
      const table = {
        orch_capabilities: () => capabilities(pubkey, args),
        orch_delegate: () => delegate(pubkey, args),
        orch_wait: () => wait(pubkey, args),
        orch_status: () => status(pubkey, args),
        orch_list: () => list(pubkey, args),
        orch_steer: () => steer(pubkey, args),
        orch_cancel: () => cancelTask(pubkey, args),
      };
      if (!Object.hasOwn(table, name)) throw new Error(`No tool ${name}`);
      return JSON.stringify(await table[name]());
    },
    capabilities,
    async tasks() {
      throw new Error("orchestrator.tasks is not implemented yet");
    },
    async cancel() {
      throw new Error("orchestrator.cancel is not implemented yet");
    },
    async close() {},
  };
}
