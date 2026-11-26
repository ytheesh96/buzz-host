# Cross-machine delegation (design, issue #8)

Status: **approved design, ready for implementation**. Owner decisions are
recorded in §7. It builds on the orchestrator contract
(`docs/orchestrator-contract.md`), access tokens (PR #37, `server/auth.mjs`),
and Nostr discovery plus the iroh bridge (PR #38, `server/discovery.mjs`,
`server/iroh-supervisor.mjs`, `iroh-bridge/`).

## Goal

An orchestrator agent on **host A** (e.g. omarchy) can run `orch_delegate` on a
Solo-chat worker that lives on **host B** (e.g. m1, once #5 installs
buzz-host there). Status, wait, steer and cancel keep working, and the worker
chat still links back to the owner's message. Host B gives host A a scoped
**delegate token**, not admin access.

Terms used below:

- **A** is the delegating host (where the orchestrator agent runs).
- **B** is the executing host (where the worker agent runs).
- A **link** is A's saved connection to B: B's routes, B's pinned iroh node id,
  and the delegate token secret.

## Decision summary

1. **A keeps the task; B runs the worker.** The task record, queue, timeout,
   steer queue, result assembly and `orch_*` tools all stay on A. B exposes a
   narrow executor API (`delegate.*`). It writes the worker's chat settings,
   drops the wake file, cancels, and streams turn signals back to A. B never
   runs `orch_*` for A and holds no task record beyond a thin lease.
   *Why:* the Solo chat and visible prompts are signed by A's orchestrator
   agent, as they are today, so B never needs A's keys. B's attack surface
   is four methods instead of the whole orchestrator.
   *How this differs from the issue text:* the issue says `orch_delegate`
   "proxies to host B's orchestrator". This design proxies to a smaller
   executor on B instead.
2. **Results travel over the shared relay, not the link.** A's orchestrator
   is a member of the Solo chat and already watches it for the worker's
   messages (`relay.watchChannel`). The link only carries control (start,
   follow-up, cancel) and turn signals. If the link drops mid-task, the reply
   still reaches A.
3. **New token role `delegate` (`bhd_…`)**, minted on B by the owner (admin
   only), scoped by owner, agents, runtimes, access level, concurrency and
   expiry. A delegate session gets an **allow-list** of methods, unlike the guest
   role, which uses a deny-list.
4. **Pairing goes through the owner, not discovery.** Discovery events are
   NIP-44 encrypted to the owner, so A cannot read B's. The owner's Buzz app
   (or the CLI) mints the token on B and installs the link on A. A pins B's
   iroh node id at pairing time.
5. **Every start is signed by the orchestrator agent.** `delegate.start`
   carries a Nostr event signed by A's orchestrator with its NIP-OA owner
   attestation. B checks it with `validAuthTag` and requires the attested
   owner to equal the token's owner and the worker's owner. A leaked token
   alone cannot start work.

## 1. How A finds and authenticates to B

### Pairing (once per A→B direction)

From the owner's Buzz app, which already has admin sessions to both hosts
(admin tokens from PR #37, machines from discovery in PR #38):

1. App → B (admin): `tokens.createDelegate { label, ownerPubkey, agents,
   runtimes, access, workspaces?, maxConcurrency, expiresAt, peerMachineId: A }`
   returns the `bhd_…` secret once and B's current routes (`readRoutes`: iroh
   first, then `publicGuestUrl` / `publicUrl`).
2. App → A (admin): `links.add { machineId: B, name, routes, irohNodeId, token }`.
   A saves it to `~/.config/buzz-host/links.json` (0600).
3. App → A: `links.test { linkId }` connects and calls `delegate.hello`, so
   the owner sees "m1: 3 agents, claude/codex" or the error.

The CLI does the same without the app, for headless setups and for #6 (v1 ships
CLI pairing + host RPCs; 1-click app UI is a follow-up `buzz-app` PR):

```sh
# on B (m1)
buzz-host-tokens create-delegate --label "from omarchy" --owner <hex> \
  --agents all|<pk,…> --runtimes claude,codex --access sandboxed|host \
  [--workspaces ~/Work,…] --max-concurrency 2 --expires 90d
# prints the bhd_… secret once and a pairing blob:
#   buzz-host-link:v1:<base64url {machineId,name,routes,irohNodeId,token}>

# on A (omarchy)
buzz-host-links add 'buzz-host-link:v1:…'
buzz-host-links list | test <id> | remove <id>
```

The blob holds a bearer secret. It is printed once, never logged, and is meant
for copy-paste between two terminals the owner controls.

### Transport

The delegate session uses B's existing **token listener** (`guestPort`), the
same socket the plugin uses with admin and guest tokens, reached in route
order:

1. **iroh** (preferred): QUIC to B's `buzz-host-iroh` (ALPN `buzz-host/ws/1`),
   which proxies to `127.0.0.1:<guestPort>`. A **pins B's node id** from pairing
   and refuses an endpoint whose id differs. iroh authenticates the peer key,
   so a stale or forged address can't redirect A. This needs a **dial mode in
   `buzz-host-iroh`** (today it only accepts). The proposal is
   `buzz-host-iroh connect --addr <endpointAddr> --node-id <id> --listen
   127.0.0.1:0`, a loopback forwarder that buzz-host spawns per link (with the
   same supervisor and backoff as `iroh-supervisor.mjs`). Node's built-in
   `WebSocket` then connects to `ws://127.0.0.1:<port>`.
2. **wss** fallback: `publicGuestUrl` behind Funnel/zrok (TLS). `ws://` is
   refused unless the host is loopback.

The tailnet listener (`Tailscale-User-Login`) is **never** used for
host-to-host traffic, because it maps to admin.

First message on the socket: `auth { token: "bhd_…" }`, as for every token
today (never in the URL; the auth rate limiter applies).

### Keeping routes fresh

- The iroh node id is stable (it comes from `iroh.key`), but the
  `endpointAddr` (relay URL, direct addresses) can change.
- On every successful connect, `delegate.hello` returns B's current routes,
  and A rewrites the link.
- When B is unreachable on every saved route, the owner's app, which still
  sees B's discovery event, can push fresh routes with `links.update`. The app
  only does this when the iroh node id still matches. (Deferred to Phase 2; see
  §7.)

### Session

A keeps **one long-lived WebSocket per link** while that link has active
tasks, or while capabilities were asked for within the last 5 minutes. B
pushes `delegate.event` notifications on it. The socket reconnects with
backoff from 1 s to 30 s.

## 2. The delegate token

Stored in B's `tokens.json` beside guest and admin tokens, hashed (SHA-256),
with the prefix checked against the role, exactly like today.

```js
{
  id: "tok_<12hex>",
  label: "from omarchy",
  role: "delegate",
  tokenHash: "<sha256>",
  ownerPubkey: "<64hex>",        // required; never TOFU-bound
  peerMachineId: "<uuid>",       // A's machineId; informational + shown in lists
  agents: ["<pk>", …] | "all",   // "all" = every eligible agent of ownerPubkey, evaluated per call
  allowedRuntimes: ["claude", "codex"],
  access: "sandboxed" | "host",  // which runners the token may drive (default "sandboxed")
  workspaces: ["<abs path>", …], // optional allowed workspace prefixes (default []: worker's own dir only)
  maxConcurrency: 2,             // 1..8 live delegated tasks for this token
  maxTaskMs: 7_200_000,          // per-prompt ceiling B enforces itself (≤ 2 h)
  expiresAt: "<ISO>",            // required; default 90 days, max 365 days
  createdAt, lastUsedAt, revokedAt
}
```

- **Eligible agent on B:** activated, `meta.owner === ownerPubkey`, no
  `createdByTokenId` (so never an agent a guest token created), the same
  community relay as the orchestrator, listed in `agents` (or `"all"`), and a
  runner allowed by `access`.
- **Expiry:** `verify()` refuses expired tokens. The revoke sweep that runs
  every 15 s (`REVOKE_SWEEP_MS`) also closes sockets of tokens that are
  expired, and it cancels their live tasks.
- **Revocation:** `buzz-host-tokens revoke <tok_…>` (or the app) works as
  today. `dropTokenAccess` also cancels this token's live delegated tasks
  through the agent control socket, and removes their `chat-settings.json`
  entries.
- **Renewal:** no in-place extension. The owner mints a new token and runs
  `links.update` on A. That keeps expiry a hard property of a secret.

## 3. API changes

### B: new `delegate.*` methods (token listener, delegate role only)

| Method | Params | Result |
|---|---|---|
| `delegate.hello` | `{}` | `{ machineId, name, platform, routes, limits: { maxConcurrency, live, access, expiresAt, maxTaskMs }, agents: [{ pubkey, name, runner, concurrency, relayUrl }], runtimes: [{ id, title, available, reason?, models, current }] }` |
| `delegate.start` | `{ ref, auth: <signed event>, workerPubkey, channelId, runtime, model?, effort?, workspace?, label, prompt }` | `{ ref, workerPubkey, workspace, acceptedAt }` |
| `delegate.followup` | `{ ref, prompt, seq }` | `{ ok }`; B drops the next wake file |
| `delegate.cancel` | `{ ref }` | `{ ok, phase }` |
| `delegate.release` | `{ ref }` | `{ ok }`; A is done, B frees the slot and prunes the chat entry |
| `delegate.sync` | `{ refs: [ref…], after?: { [ref]: seq } }` | `{ tasks: [{ ref, phase, events: [...] }] }`; replay after reconnect |

There is also a server push on the same socket:
`{ method: "delegate.event", params: { ref, seq, type: "turn_start" | "turn_done" | "ended", ...payload } }`.
The `turn_*` payloads are the existing `_acp_turn_start` / `_acp_turn_done`
fields (`runtime, model, effort, stopReason, error, finalText, fallbackPosted`).
`ended` reports a B-side stop (lease expiry, revocation, B restart →
`interrupted`).

- `ref` is `<A machineId>:<taskId>`. B scopes every lookup to
  `(tokenId, ref)`, so one token can never see or touch another token's tasks.
- `delegate.start` checks, in order:
  1. the token is live;
  2. the `auth` event (described below) is valid;
  3. the worker is eligible;
  4. the runtime is allowed and installed;
  5. live tasks < `maxConcurrency`;
  6. the workspace is allowed;
  7. the Solo chat is genuine.
- **The `auth` event:** a kind 27235 event (the NIP-98 shape) signed by A's
  orchestrator, with these tags:
  - `["u", "buzz-host:delegate.start:<B machineId>"]`
  - `["ref", ref]`
  - `["h", channelId]`
  - `["p", workerPubkey]`
  - the orchestrator's NIP-OA `auth` tag

  `created_at` must be within ±120 s. B rejects a replayed event id within a
  10-minute window. It checks the owner with `validAuthTag(orchestratorPubkey,
  authTag)` and requires `authTag[1] === token.ownerPubkey === worker meta.owner`.
- **Workspace:** the default is the worker agent's own work dir on B
  (`~/buzz-agents/<pubkey>`), because A's `cwd` means nothing on B. When A
  passes a workspace, it must resolve (`realpath`) under the worker's work dir
  or under one of the token's optional `workspaces` allowed-prefix paths
  (default: worker's own dir only). It is never under `~/buzz-sandboxes/` or
  the buzz-host data/config dirs.
- **Genuine Solo chat:** B's worker agent queries the relay for the channel's
  kind 9007 create event. B requires that it was signed by the orchestrator
  pubkey from `auth`, that it has `t=buzz.solo`, and that it p-tags both the
  owner and the worker. So B's worker only ever works in a private chat that
  the owner is in and that the orchestrator created.
- B then does exactly what `startSoloWorker` does locally for the worker side:
  it writes `{ runtime, model?, effort?, workspace: [ws], noOrchestrate: true,
  expiresAt, delegatedBy: tokenId }` into the worker's `chat-settings.json`,
  builds the same `<delegated-worker-task>` header itself (A cannot replace
  it), and drops `wake/orch-<taskId>-<seq>.json`.
- B routes `_acp_turn_start` / `_acp_turn_done` for channels it owns as a
  delegate task to the link socket instead of the local orchestrator.
- **B's own lease:** B stops a task (cancel, then `ended`) if any of these
  happen:
  - A has had no socket for `leaseMs` (10 min);
  - a prompt runs past `maxTaskMs`;
  - the token expires or is revoked.

  B persists its thin records in `~/.local/share/buzz-host/delegate/<tokenId>.json`
  (0600). On restart it marks live records `interrupted`, cancels them, and
  reports `ended` on the next `sync`.

### A: admin RPCs and CLI

- `links.add | links.list | links.update | links.remove | links.test` are
  admin-only (added to `ADMIN_ONLY_METHODS`). `links.list` never returns the
  secret.
- B gets `tokens.createDelegate` (admin-only). `tokens.list` shows delegate
  tokens with their scope, `peerMachineId`, expiry and live task count.

### A: orchestrator tool changes (backward compatible)

- **`orch_capabilities`**: the output is unchanged, plus a new `hosts` array:

  ```js
  hosts: [{
    host: "m1", machineId, linkId, online: true, lastSeenAt,
    limits: { maxConcurrency, live, access, expiresAt },
    agents: [{ pubkey, name, runner }],
    runtimes: [{ id, available, models, current }],
    error?: "unreachable" | "revoked" | "expired"
  }]
  ```

  Remote hosts are fetched in parallel with the same 2.5 s catalog budget. A
  host that misses the budget shows its last known capabilities with
  `online: false`.
- **`orch_delegate`**: new optional `host` (machine name, machineId or link
  id). If it is omitted or `"local"`, nothing changes. With `host`, `agent`
  resolves among B's eligible agents (the default is the only agent if there
  is one, otherwise it is required), and `workspace` is a path on B (the
  default is the worker's work dir there).
- **Flow with `host`:**
  1. Same as today: `requireOwnerChat`, A's MAX_LIVE/queue, and `composeWorkerBrief`
     with the parent backlink.
  2. A creates the Solo chat (p-tags the owner and B's worker) and posts the
     visible prompt as itself, as today.
  3. A calls `delegate.start`.
  4. A watches the chat for the worker's replies, as today.
- **Task record**: new fields `host: null | { machineId, name, linkId }` and
  `remoteRef`. Everything else (status values, `link`, transcript) keeps its
  current meaning.
- **`orch_wait` / `orch_status` / `orch_list`**: no signature change. Turn
  signals arrive as `delegate.event`, and messages arrive over the relay
  watch, as today.
- **`orch_steer`**: A posts the visible follow-up, then calls
  `delegate.followup`.
- **`orch_cancel`**: A calls `delegate.cancel` and settles `cancelled` on
  `turn_done`/`ended` or after the grace period, as today.
- **Backlink**: unchanged. The parent `buzz://message?…` link is in the
  brief, and the relay is shared, so it opens on any device.
- **MAX_DEPTH = 1**: unchanged on both sides. B writes `noOrchestrate: true`,
  and `delegate.*` cannot be reached from agent tools at all. A worker on B
  has no link credentials of its own.

## 4. Failure modes

| Situation | Behaviour |
|---|---|
| B offline at `orch_delegate` | Fails fast (no task is queued remotely): `"Host m1 is unreachable (last seen 14:02)"`. `orch_capabilities` shows `online: false`. |
| B reachable but at `maxConcurrency` | The task stays `queued` on A, and A retries when a remote slot frees (a `turn_done`/`ended` for this link) or when the link reconnects. A's own MAX_QUEUE of 16 still applies. |
| Link drops mid-task | The worker keeps running on B. Its replies still land in the Solo chat, and A's relay watch records them. A reconnects with backoff and calls `delegate.sync` to replay missed turn signals. The task stays `running` meanwhile, with a transcript line "link to m1 lost; reconnecting". |
| Link stays down past A's timeout | A settles `timed_out` with the error `"m1 unreachable; m1 stops the worker within 10 min"`. B's lease cancels it. If the link comes back first, A also sends `delegate.cancel`. |
| Link down when the owner cancels | A marks the task `cancelling`, settles `cancelled` after the grace period, and queues `delegate.cancel` for the reconnect. B's lease is the backstop. |
| B restarts mid-task | B marks the task `interrupted` and cancels it. On reconnect, `sync` returns `ended(interrupted)`, and A settles `interrupted`. |
| A restarts mid-task | A's tasks become `interrupted`, as they do today. On start, A calls `delegate.release` for those refs on each link. If A never comes back, B's lease ends them. |
| Token expired / revoked | B closes the socket within 15 s and cancels live tasks (`ended(revoked)`). A marks the link `revoked`/`expired`, fails its queued tasks, and hides the host in `orch_capabilities` (it is still listed with `error`). |
| iroh unreachable, wss works | A falls back to the next route and records which one worked. |
| B's iroh node id changed | A refuses the connection (`"m1's identity changed; pair again"`). B only gets a new node id if `iroh.key` was deleted. |
| Runtime unavailable on B (auth/quota) | B reports it in `hello.runtimes`. A `turn_done` error is recorded per host (keyed `<machineId>:<runtime>`), not in A's local `runtimes.json`. |

## 5. Security analysis

### Threat model

- **The main threat is a compromised or misbehaving host A.** It holds the
  delegate secret and its agents' keys.
- **A leaked delegate secret**, from logs, a pasted blob or a backup.
- **A malicious network path** between A and B.
- **Out of scope:** a compromised B (it executes the work anyway) and a
  compromised relay (it is already trusted for all chat traffic).

### Properties and how they hold

1. **No escalation to admin.**
   - A distinct prefix `bhd_` is recorded at mint, and `verify()` already
     rejects a secret whose prefix disagrees with the stored role.
   - **Required code change:** `tokenRole()` today returns `"guest"` for any
     record that isn't `admin`, so a delegate record would be read as a guest
     record. It must return `admin | guest | delegate` explicitly, and refuse
     unknown roles. `TOKEN_RE` gains `bhd`.
   - `assertMethodAllowed` uses an **allow-list** for `delegate`: only
     `auth` and `delegate.*`. Every other method, including new ones added
     later, is refused by default. (Guests use a deny-list, which is the
     wrong default for a machine credential.)
   - `tokens.createDelegate`, `links.*` and every `tokens.*` method are
     admin-only. A delegate cannot mint, list or revoke tokens.
   - `isValidDesktopTicket` / `desktopTicketTokenAllowed` already accept only
     the `guest` and `admin` roles, so a delegate can't open desktops. Tests
     will pin this down.
   - The tailnet listener never accepts tokens, and A never receives an admin
     token for B.
2. **No reading other agents' state.**
   - `hello` returns only eligible agents, with name, pubkey, runner,
     concurrency and relay. It never returns instructions, memory,
     chat-settings, logs or attention.
   - `start`/`followup`/`cancel`/`release`/`sync` are scoped to
     `(tokenId, ref)`.
   - `orchestrator.tasks` stays admin-only. B's local orchestrator tasks and
     other tokens' delegated tasks are invisible.
   - Results flow over the relay to members of the Solo chat, which are the
     owner, A's orchestrator and B's worker.
3. **No reaching guest-tenant data.**
   - Eligibility requires `meta.owner === token.ownerPubkey` and no
     `createdByTokenId`, so agents of friends (guest tenants) are never
     eligible.
   - The workspace is realpath-checked and can never point under
     `~/buzz-sandboxes/`.
   - **Limit:** a **host-runner** worker runs as the owner's Unix user. A
     delegated prompt is code execution as that user on B. It can read
     anything that user can, including `~/buzz-sandboxes/*`, other agents'
     keys in the data dir, and `tokens.json` hashes. The workspace check stops
     *accidental* reach. It is not a sandbox. Hence the token's **access
     level**:
     - `access: "sandboxed"` (**recommended default**): only Docker-runner
       workers are eligible. They are jailed (own bridge network, egress
       firewall, no host mounts beyond their workspace), so this property
       holds even against a hostile A.
     - `access: "host"`: host-runner workers too. The owner opts in, knowing
       that a compromised A then means owner-level code execution on B. This
       matches t3code's "full access" linked environment.
4. **Binding to the owner.**
   - Every `delegate.start` needs a fresh (±120 s, non-replayed) signature
     from an orchestrator agent whose NIP-OA attestation names the token's
     owner.
   - A stolen `bhd_` secret alone cannot start work. It still lets someone
     call `hello` (a list of agent names and models), `cancel` or `sync` for
     refs they would have to guess. The ref includes A's random
     `task-<time>-<6hex>`, so guessing is impractical, and cancel can't
     exfiltrate anything.
5. **Bounded blast radius.**
   - `maxConcurrency` limits work per token, `maxTaskMs` limits each prompt,
     and B's lease limits how long a task survives without A.
   - The existing prompt cap (60 KiB) and MAX_QUEUE apply on A.
   - Mandatory expiry is capped at 365 days.
   - Revoking cuts the link and its live tasks within 15 s.
   - The existing auth rate limiter applies per remote address, and the iroh
     bridge has its own `--max-streams` cap.
6. **Transport integrity.**
   - Over iroh, A pins B's node id (QUIC with key-authenticated peers). Over
     wss, A requires TLS.
   - The token is sent only after the transport is up, in the first `auth`
     call, never in a URL.
7. **Secret at rest on A.**
   - `links.json` is 0600 and holds the plaintext `bhd_` secret, because A
     must present it.
   - Host-runner agents on A run as the same Unix user and could read it.
     That is consistent with today, where they can already read every
     agent's key in A's data dir.
   - Sandboxed agents on A cannot read it.
   - This is why every start must also be signed (point 4) and why tokens
     expire.

### What B trusts A for

- B trusts that the owner really initiated the parent chat. A's
  `requireOwnerChat` (turn-authors) enforces this, and B cannot verify it
  without being in the parent channel.
- This is acceptable because the owner chose to pair A. The token is the
  trust boundary.

## 6. Implementation plan (after approval)

1. **`auth.mjs`:** the `delegate` role, `createDelegate`, the explicit
   `tokenRole`, expiry in `verify`, and the allow-list in
   `assertMethodAllowed`. Tests in `auth.test.mjs`.
2. **`iroh-bridge`:** a `connect` dial mode with node-id pinning, plus Rust
   tests. **`iroh-supervisor.mjs`:** spawn per link.
3. **New `server/links.mjs`:** the link store, the client (reconnect, routes,
   event fan-in) and `links.*` RPCs. **`buzz-host-tokens`:**
   `create-delegate`. **New `buzz-host-links` CLI.**
4. **New `server/delegate-executor.mjs` on B:** `delegate.*`, the lease, the
   thin persistence and turn-signal routing. Wired into `buzz-host.mjs` and
   the revoke/expiry sweep.
5. **`orchestrator.mjs`:** `host` in `orch_delegate`, `hosts` in
   `orch_capabilities`, and the remote driver (the same `driver` interface,
   with remote wake and cancel). Contract doc update.
6. **Tests:** two buzz-host instances in one test process (A and B, fake
   relay, real token store) covering delegate, steer, cancel, link drop and
   resync, revoke and expiry, and every negative security case above.
7. **Live run:** omarchy → m1 after #5 installs buzz-host on m1.
8. **Follow-up (`buzz-app` PR):** 1-click pairing UI in Settings (not bundled
   into #7).

Each step is one PR or part of one. Nothing touches the live omarchy units
until merge.

## 7. Resolved owner decisions

1. **Executor vs. full proxy:** Keep the narrow executor on B (decision 1).
   Host A keeps task state, timeouts, steer queues and `orch_*`; B only exposes
   the narrow `delegate.*` methods and never needs A's keys.
2. **Default access level:** Keep `sandboxed` as the code default, and opt in
   to `--access host` when pairing personal host-runner machines (e.g. omarchy
   ↔ m1).
3. **Revocation / expiry of running work:** Cancel live tasks immediately on
   revocation or expiry.
4. **Workspaces on B:** Support an optional `--workspaces` allowed-prefix list
   on the delegate token (default: worker's own work dir only), validated with
   `realpath` and always excluding `~/buzz-sandboxes/` and buzz-host
   data/config dirs.
5. **Pairing UX:** Ship CLI pairing + host RPCs (`tokens.createDelegate`,
   `links.*`) in #8; implement the 1-click app UI in a follow-up `buzz-app` PR
   (do not bundle into #7).
6. **Route refresh when every saved route fails:** Defer to Phase 2 (app pushes
   fresh routes via `links.update`). No per-link Nostr discovery key in v1.
7. **Defaults:** Keep `maxConcurrency: 2` and the 10-minute lease; bump default
   token expiry from 30 days to **90 days** (still capped at 365 days).
