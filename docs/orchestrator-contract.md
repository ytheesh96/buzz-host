# Orchestrator v1.5 — Solo-chat workers & parallel conversations

Cross-harness orchestration for buzz-host built on parallel conversations
(`BUZZ_ACP_AGENTS`, default 4) and per-chat runtime dispatch in `acp-proxy`.
This file is the shared contract consumed by `server/orchestrator.mjs`,
`server/buzz-mcp.mjs`, `server/buzz-host.mjs`, `server/acp-proxy`,
`server/control.mjs`, `server/file-lock.mjs`, and `plugin/plugin.js`.

## Model

1. **Parallel conversations** — every Omarchy agent defaults to
   `concurrency: 4` (`BUZZ_ACP_AGENTS=4`, configurable `1..16` in agent
   Settings). `buzz-acp` spawns one `acp-proxy` worker process per slot so
   independent chats/threads run concurrently instead of queuing.
   - Each `acp-proxy` binds its own Unix control socket under
     `$XDG_RUNTIME_DIR/buzz-host/<pubkey[:16]>.d/<pid>.sock` (16-hex prefix
     keeps paths well under Linux's 108-byte `sun_path` cap). `server/control.mjs`
     fans out `state` / `cancel` / `new` / `compact` across all live workers.
   - Shared per-agent JSON files (`chat-settings.json`, `model-restore.json`,
     `turn-authors.json`, `session-chats.json`) are updated under an advisory
     cross-process `.lock` file (`server/file-lock.mjs` and `acp-proxy`) with
     PID-unique atomic renames (mode `0600`).
2. **Per-chat runtime dispatch (backend)** — on `session/new` (and
   `session/load` / `session/resume`), `acp-proxy` reads the chat's `runtime`
   from `chat-settings.json` (falling back to the agent's default runtime) and
   lazily spawns/routes to that runtime's adapter (`claude`, `codex`, `hermes`,
   `antigravity`). Secondary runtime session IDs are namespaced as
   `rt:<runtime>:<adapterSessionId>` so sessions across runtimes never collide.
3. **Solo-chat workers** — an orchestrator agent (`meta.orchestrate === true`)
   designates one non-orchestrator Omarchy agent owned by the same owner as its
   worker pool (`meta.workerPubkey`, e.g. an agent named `Workers`).
   - `orch_delegate` writes `{ runtime, model?, effort?, workspace: [ws] }` to
     the worker agent's `chat-settings.json`, creates a private ephemeral Buzz
     Solo chat (`kind: 9007`, `t=buzz.solo`, `ttl=86400`) with the owner and
     worker agent, and posts the task prompt tagging the worker agent.
   - Because it is a real Buzz Solo chat, the owner can click the returned
     `buzz://message?channel=<uuid>&id=<event-id>` link to watch the worker's
     live activity bubble, inspect the Activity tab, Stop it, or type to steer.
   - The in-chat live worker card (`orchestrator-tasks` accessory) is removed;
     Conductor links directly to the worker Solo chats in its replies.
   - `MAX_DEPTH = 1` is enforced structurally: an agent with `orchestrate: true`
     cannot be chosen as `workerPubkey`, and turning `orchestrate: true` on an
     agent currently used as a `workerPubkey` is refused.

## Module surface

```js
import { createOrchestrator, ORCHESTRATOR_TOOLS } from "./orchestrator.mjs";

const orchestrator = createOrchestrator({
  dataDir,      // ~/.local/share/buzz-host/agents
  stateDir,     // ~/.local/share/buzz-host/orchestrator
  shimsDir,     // ~/.local/lib/buzz-host/shims
  runDir,       // $XDG_RUNTIME_DIR/buzz-host (control sockets for cancel)
  catalog,      // optional: async (runtime) => ({ current, models: [{id,label,efforts:[{id,label}]}] })
  ensureHermes, // optional: async (profile) => void
  relay,        // optional: relay transport override (tests)
  cancelWorker, // optional: (workerPubkey, channelId) => Promise<{cancelled}> (tests)
  log,          // optional: console-like
});

orchestrator.handles(name)                  // true for /^orch_/ plus _acp_turn_start / _acp_turn_done
await orchestrator.call(pubkey, name, args) // string (JSON) for attention.sock
await orchestrator.capabilities(pubkey, { retry })
await orchestrator.tasks({ pubkey, channelId, threadRootId, taskId, since, full })
await orchestrator.cancel({ pubkey, taskId })
await orchestrator.forget(pubkey)
await orchestrator.close()
```

## Task record

`orch_list` and `orchestrator.tasks` without `full` return **summaries** (no
`prompt` or `transcript`, `result.text` clipped to 2,000 chars with
`resultTruncated: true`). `orch_status`, `orch_wait`, `orch_delegate`, and
`orchestrator.tasks` with `full: true` return the full record (`transcript`
included for `orch_status` and `full: true`).

```js
{
  taskId: "task-<base36 time>-<6 hex>",
  mode: "solo",
  agentPubkey: "<orchestrator pubkey>",
  workerPubkey: "<worker agent pubkey>",
  workerName: "Workers",
  workerChannelId: "<solo chat uuid>",
  promptEventId: "<hex64>",
  replyEventId: "" | "<hex64>",
  link: "" | "buzz://message?channel=<uuid>&id=<hex64>",
  chat: "<channelId>" | "<channelId>_<threadRootId>",
  channelId: "<uuid>",
  threadRootId: "" | "<hex64>",
  originEventId: "" | "<hex64>",
  runtime: "claude" | "codex" | "hermes" | "antigravity",
  model: "" | "<model id>",
  effort: "" | "<effort id>",
  label: "short owner-facing label",
  prompt: "<first prompt, ≤ 64 KiB>",
  workspace: "/abs/path",
  status: "queued" | "starting" | "running" | "completed" | "failed" | "cancelled" | "timed_out" | "interrupted",
  createdAt: 1763..., startedAt: 0, updatedAt: 1763..., endedAt: 0,
  elapsedMs: 0,
  latestStep: { kind: "tool" | "message" | "thought", title: "...", at: 0 } | null,
  stopReason: "end_turn" | "max_tokens" | "refusal" | "cancelled" | "max_turn_requests" | "",
  steerQueued: 0,
  error: "",
  result: { text: "...", bytes: 0 } | null,
  transcript: [{ at: 0, kind: "user" | "message" | "thought" | "tool" | "status", text: "..." }]
}
```

## Turn lifecycle signals (`acp-proxy` → `buzz-host`)

Over `attention.sock` (internal only; never listed in `ORCHESTRATOR_TOOLS`):

- `_acp_turn_start`: `{ channel, root, runtime, model, effort }` — transitions
  an active Solo task for `channel` (matching `workerPubkey`) from `starting`
  to `running` and fills in resolved `model` / `effort`.
- `_acp_turn_done`: `{ channel, root, runtime, stopReason, error, errorCode,
  model, effort, finalText, fallbackPosted }` — emitted after `session/prompt`
  finishes (and after `reply_fallback`, when applicable) or when `session/new`
  fails. Completes, fails (including quota banners via `runtimeRefusal` and
  auth errors recorded in `runtimes.json`), cancels, or dispatches the next
  queued `orch_steer` prompt.

## Guardrails

- **Concurrency**: at most 4 live (`starting` + `running`) tasks per
  orchestrator (`MAX_QUEUE = 16`).
- **Timeout**: per-prompt wall-clock budget (default 20 min, clamped 10 s … 2 h),
  reset on each steered follow-up. Timeout sends `cancel` to the worker agent's
  control socket and settles as `timed_out`.
- **Owner-initiated chats**: `orch_delegate`, `orch_steer`, and `orch_cancel`
  require the latest person-turn in `chat` (`turn-authors.json`) to be
  `meta.owner`.
- **No recursion (`MAX_DEPTH = 1`)**: worker agent must have `orchestrate !== true`.
- **Opt-in**: `orch_*` tools are only served while `meta.orchestrate === true`.

## Host RPCs (WebSocket methods)

- `settings.get { pubkey }` → `{ runtime, model, profile, concurrency, status }`
- `settings.set { pubkey, runtime, model, profile, concurrency? }` → `{ status }`
- `orchestrator.set { pubkey, enabled?, workerPubkey? }` → `{ enabled, workerPubkey }`.
  Toggling `enabled` rewrites the MCP wrapper and restarts the agent; changing
  `workerPubkey` takes effect immediately without restarting.
- `orchestrator.tasks { pubkey, channelId?, threadRootId?, taskId?, since?, full? }` →
  `{ enabled, workerPubkey, tasks, task? }`.
- `orchestrator.cancel { pubkey, taskId }` → `{ task }`.

## Persistence

- `~/.local/share/buzz-host/orchestrator/<pubkey>.json`
  `{ "version": 1, "tasks": [...] }`, atomic tmp+rename, mode `0600`, newest 200.
- `~/.local/share/buzz-host/orchestrator/runtimes.json`
  `{ "<runtime>": { "reason": "...", "at": 0 } }`.
