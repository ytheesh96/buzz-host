# Orchestrator v1 — interface contract

Phase 1 cross-harness orchestration for buzz-host. This file is the shared
contract: `server/orchestrator.mjs` implements it; `server/buzz-mcp.mjs`,
`server/attention.mjs`, `server/buzz-host.mjs`, `server/acp-proxy` and
`plugin/plugin.js` consume it. If an implementation needs to change a shape
here, change this file in the same PR and say so in the PR description.

## Ownership (file-disjoint tracks)

| Track | Owner | Files |
|---|---|---|
| Contract + core | Giraffe | `docs/orchestrator-contract.md`, `server/orchestrator.mjs`, `server/orchestrator.test.mjs` |
| Wiring | Haiku | `server/acp-proxy`, `server/test_acp_proxy.py`, `server/buzz-mcp.mjs`, `server/attention.mjs` (extra chain only), `server/buzz-host.mjs` |
| UI | Haiku | `plugin/plugin.js` |

## Model

An **orchestrator** is an Omarchy agent whose owner turned `meta.orchestrate`
on. It can spawn **workers**: ephemeral ACP v1 sessions on another runtime
(`claude`, `codex`, `hermes`, `antigravity`), each running in its own process
and workspace. A worker never receives the Buzz MCP server, so it has no Buzz
identity and no `orch_*` tools — depth is structurally 1 (`MAX_DEPTH = 1`).

Workers are children of buzz-host. They die with it; their records do not.

## Module surface

```js
import { createOrchestrator, ORCHESTRATOR_TOOLS } from "./orchestrator.mjs";

const orchestrator = createOrchestrator({
  dataDir,   // ~/.local/share/buzz-host/agents
  stateDir,  // ~/.local/share/buzz-host/orchestrator
  shimsDir,  // ~/.local/lib/buzz-host/shims
  catalog,   // optional: async (runtime) => ({ current, models: [{id,label,efforts:[{id,label}]}] })
  log,       // optional: console-like
});

orchestrator.handles(name)                  // true for /^orch_/
await orchestrator.call(pubkey, name, args) // string (JSON) for the MCP layer
await orchestrator.capabilities(pubkey, { retry }) // object, for orch_capabilities
await orchestrator.tasks({ pubkey, channelId, threadRootId, taskId, since, full })
await orchestrator.cancel({ pubkey, taskId })
await orchestrator.forget(pubkey)           // cancels tasks & removes persisted state on agent delete
await orchestrator.close()                  // kills live workers (host shutdown/tests)
```

`ORCHESTRATOR_TOOLS` is the MCP `tools/list` entries (name, description,
inputSchema) for the seven tools, so `buzz-mcp.mjs` does not restate them.

## Task record

Every public view is derived from one record. `orch_list` and
`orchestrator.tasks` without `full` return **summaries**: every field below
except `prompt` and `transcript`, with `result.text` clipped to 2,000
characters (`resultTruncated: true` when clipped). `orch_status`,
`orch_wait`, `orch_delegate` and `orchestrator.tasks` with `full: true` return
the full record; transcripts are included for `orch_status` and `full: true`.

```js
{
  taskId: "task-<base36 time>-<6 hex>",
  agentPubkey: "<orchestrator pubkey>",
  chat: "<channelId>" | "<channelId>_<threadRootId>",
  channelId: "<uuid>",
  threadRootId: "" | "<hex64>",
  originEventId: "" | "<hex64>",    // the turn that asked for the work
  runtime: "claude" | "codex" | "hermes" | "antigravity",
  model: "" | "<model id>",         // requested, else the session's current
  effort: "" | "<effort id>",
  label: "short owner-facing label",
  prompt: "<first prompt, ≤ 64 KiB>",
  workspace: "/abs/path",
  status: "queued" | "starting" | "running" | "completed" | "failed" | "cancelled" | "timed_out" | "interrupted",
  createdAt: 1763..., startedAt: 0, updatedAt: 1763..., endedAt: 0,
  elapsedMs: 0,                     // read time: now-startedAt, or endedAt-startedAt
  latestStep: { kind: "tool" | "message" | "thought", title: "...", at: 0 } | null,
  stopReason: "end_turn" | "max_tokens" | "refusal" | "cancelled" | "max_turn_requests" | "",
  steerQueued: 0,
  error: "",
  result: { text: "...", bytes: 0 } | null,
  transcript: [{ at: 0, kind: "user" | "message" | "thought" | "tool" | "status", text: "..." }]
}
```

- `transcript` is capped at 300 entries, 8 KiB per entry and 128 KiB per task;
  the oldest entries are dropped first.
- `startedAt` is set when the worker session starts; `endedAt` when the task
  reaches a terminal status. `elapsedMs` is computed at read time.
- Terminal statuses never change except by a new task. `interrupted` is set on
  load for any record that was `queued`/`starting`/`running` when buzz-host
  stopped: records survive restarts, work does not.
- `completed` means the turn ended (`end_turn`). `stopReason` is preserved even
  when it is `max_tokens` or `refusal`. `failed` means an adapter/protocol
  error or an unexpected exit, or a turn whose whole reply is a short
  quota/rate-limit banner (e.g. Antigravity's `⚠ Individual quota reached…`,
  which arrives as text with `end_turn`; see `runtimeRefusal`); `timed_out` means the wall-clock budget expired;
  `error` says which.

## Guardrails

- **Concurrency**: at most 4 live (`starting` + `running`) tasks per
  orchestrator. More delegates queue in FIFO order (`MAX_QUEUE = 16`; beyond
  that `orch_delegate` fails without creating a task).
- **Timeout**: one wall-clock budget per prompt (default 20 min, per-task
  `timeoutMs`, clamped 10 s … 2 h). The budget resets for each steered prompt.
  A timeout sends `session/cancel`, then kills the worker.
- **Owner-initiated chats**: `orch_delegate`, `orch_steer` and `orch_cancel`
  require that the most recent person-turn in `chat` was the orchestrator's
  owner. The author comes from `<agent dir>/turn-authors.json`, written by
  `acp-proxy` at the start of each turn that names Buzz events (shape below).
  No record ⇒ refuse. This gates by chat, not by individual turn: an Attention
  wake in a chat the owner has spoken in passes. Documented v1 limitation.
- **No recursion**: workers get `mcpServers: []`, so no `orch_*` tools. The
  host also never passes `--orchestrate` to a worker, and the worker env
  strips every `BUZZ*` variable plus `WAYLAND_DISPLAY`.
- **Workspace**: absolute path that exists and is a directory; `~` is
  expanded. Default is the calling session's `cwd` (`args.cwd`).
- **Permissions**: the worker driver answers `session/request_permission` by
  selecting the first `allow_once` option, else `allow_always`, else the first
  offered option; with none, it cancels the request. This is what lets a
  headless worker use its own tools.
- **Opt-in**: `orch_*` tools are only served while `meta.orchestrate === true`.
  Turning it on/off restarts the agent, as Attention and Desktop do.

### `turn-authors.json` (written by acp-proxy)

`<agent dir>/turn-authors.json`, mode 0600, atomic rename, capped at 200 chats:

```json
{ "<chatKey>": { "author": "<hex>", "eventId": "<hex>", "at": 1763000000 } }
```

`chatKey` is the same key `acp-proxy` already uses:
`<channelId>` or `<channelId>_<threadRootId>`. It is written **only** from
structured `session/prompt` `_meta.buzzHost.events` (the newest entry whose
`pubkey` is a valid 64-hex key and not the agent itself), never from untrusted
prompt text. Wakes and turns that name no structured event leave it unchanged.
`eventId` is used only for the plugin's per-message card; the gate checks
`author === meta.owner`.

`acp-proxy` also persists `<agent dir>/session-chats.json` (`sessionId ->
chatKey`, mode 0600, atomic rename) so `session/load` and `session/resume`
after an agent restart still label `buzz-mcp.mjs` with `BUZZHOST_CHAT`.

## Socket / tool contract

`buzz-mcp.mjs` sends `{ pubkey, name, args }` lines to `attention.sock` exactly
as it does for memory. For `orch_*` names it must add to `args`:

- `chat`: `process.env.BUZZHOST_CHAT || ""`
- `cwd`: `process.cwd()`

The host's `extra` chain routes the name to the orchestrator, which exposes
`handles(name)` and `call(pubkey, name, args)` (returns a JSON string).

`orch_wait` blocks up to its `timeoutMs`; `buzz-mcp.mjs` must raise its socket
`CALL_TIMEOUT_MS` for that call (`timeoutMs + 15_000`).

### Tools

| Tool | Arguments | Returns |
|---|---|---|
| `orch_capabilities` | `{ retry? }` | `{ runtimes: [{id,title,available,reason,models,current}], limit, maxDepth, active, queued, tasks }` |
| `orch_delegate` | `runtime`, `prompt`, `model?`, `effort?`, `workspace?`, `label?`, `timeoutMs?` | full task (status `queued`/`starting`) |
| `orch_wait` | `taskId`, `timeoutMs?` (default 120 s, max 600 s) | `{ task, timedOut, closed? }` |
| `orch_status` | `taskId` | `{ task }` with transcript |
| `orch_list` | `chat?`, `status?`, `limit?` | `{ tasks }` summaries |
| `orch_steer` | `taskId`, `prompt` | full task; `steerQueued` ≥ 1 |
| `orch_cancel` | `taskId` | full task |

`orch_capabilities` reports `available: false` with a reason only for a
runtime whose last attempt failed authentication (recorded in
`runtimes.json`); the record expires after 15 minutes, and `retry: true`
clears it immediately. `models` is the cached catalog when one is available
without blocking (the module waits at most ~2.5 s per runtime); otherwise
`null`, and the next call is fast once the host's probe finishes.

`orch_steer` is a queued follow-up on the same session, not an injection: the
driver sends it after the current `session/prompt` resolves (and its trailing
`session/update` frames have gone idle). At most 16 steers may wait on one
task. Steering a task that is `queued` (no session yet) or terminal fails
without changing it. `orch_wait` adds `closed: true` when buzz-host shuts down
while it is waiting, so a caller never mistakes that for a finished task.

## Host RPCs (WebSocket methods)

- `orchestrator.set { pubkey, enabled }` → `{ enabled }`. Persists
  `meta.orchestrate`, rewrites the agent's MCP wrapper, restarts the agent when
  the value changed. Mirrors `attention.set`.
- `orchestrator.tasks { pubkey, channelId?, threadRootId?, taskId?, since?, full? }` →
  `{ enabled, tasks, task? }`. Without `channelId`, all of the agent's tasks
  (Settings view). With it, only that chat (`channel_` + thread root when
  given). `since` filters by `createdAt` (epoch ms). `taskId` returns that one
  task; `full: true` includes transcripts.
  `enabled` comes from `meta.orchestrate`; the rest from
  `orchestrator.tasks(params)`.
- `orchestrator.cancel { pubkey, taskId }` → `{ task }`. Owner-facing (the
  plugin's Stop button); authenticated by the tailnet WebSocket login, not the
  turn-authors gate.

## Plugin card (Track C)

- Settings row **Orchestrator** next to Attention/Desktop: toggle calls
  `orchestrator.set` with `timeoutMs: 90000` and shows the restarting state.
- `response` accessory, `order: 11`, same `registerAccessory` pattern as the
  desktop preview. Props: `{ session, channelId, message }`. Query
  `orchestrator.tasks` with `channelId` and the thread root from the message's
  turn, then render tasks whose `originEventId === message.id` (fallback: all
  live tasks in that chat). Badge: runtime + model/effort. Status, latest
  `latestStep`, elapsed time, Stop (`orchestrator.cancel`), expandable
  transcript (`full: true`).

## Persistence

- `~/.local/share/buzz-host/orchestrator/<pubkey>.json`
  `{ "version": 1, "tasks": [...] }`, atomic tmp+rename, mode 0600, newest 200.
- `~/.local/share/buzz-host/orchestrator/runtimes.json`
  `{ "<runtime>": { "reason": "...", "at": 0 } }` — last known auth failure
  (for example Codex's `-32000 Authentication required`), cleared on success.
