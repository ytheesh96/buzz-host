#!/usr/bin/env node
// A Buzz chat's workspace for buzz-host agents: the folders its Canvas names.
//
//   node workspace.mjs <channel-uuid>
//
// Prints JSON: { canvas, folders, worktree, author, eventId } for a Canvas
// the agent's owner approved, or { canvas: null, folders: [], reason } when
// there is none or Buzz would not hand it to an agent.
//
// Buzz (buzz-app src/features/solo/workspace.ts) writes a workspace's folders
// into each new Solo chat's Canvas as a managed block:
//
//   <!-- buzz-session-workspace:v1 {"folders":[...],"worktree":{...}} -->
//   ## Project folders ... (or ## Workspace instructions for worktree mode)
//   <!-- /buzz-session-workspace -->
//
// and hands a chat's Canvas to its agent only when the owner, or an agent
// the owner attests (NIP-OA), wrote its current head without a
// `canvas-instructions` tag (channel-templates/canvas-approval.ts). Same here.
// Reads go through the agent's own `buzz` CLI (agent-bin), as that agent.
import { execFile } from "node:child_process";
import { schnorr, sha256, hexToBytes, bytesToHex } from "./noble.mjs";

const KIND_CANVAS = 40100;
const HEX64 = /^[0-9a-f]{64}$/;
const SIG = /^[0-9a-f]{128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CLAUSE = /^(kind=|created_at<|created_at>)(0|[1-9][0-9]*)$/;
const PREFIX = "<!-- buzz-session-workspace:v1 ";
const END = "<!-- /buzz-session-workspace -->";
const utf8 = new TextEncoder();

/** The folders (and worktree) in a Canvas's workspace block; none when it has
 * no block or a malformed one, as Buzz's `workspaceDirectories` reads it. */
export function parseWorkspace(content) {
  const none = { folders: [], worktree: null };
  if (typeof content !== "string" || !content.startsWith(PREFIX)) return none;
  const lineEnd = content.indexOf(" -->\n");
  if (lineEnd < 0 || content.indexOf(`\n${END}\n`, lineEnd) < 0) return none;
  let raw;
  try {
    raw = JSON.parse(content.slice(PREFIX.length, lineEnd));
  } catch {
    return none;
  }
  if (!raw || !Array.isArray(raw.folders) || raw.folders.some((f) => typeof f !== "string"))
    return none;
  const folders = [...new Set(raw.folders.map((f) => f.trim()).filter(Boolean))];
  if (folders.length > 20 || folders.some((f) => f.length > 2048 || /[\u0000-\u001f`]/.test(f)))
    return none;
  const wt = raw.worktree;
  const worktree =
    wt && typeof wt.location === "string" && typeof wt.baseBranch === "string" && wt.location.trim()
      ? { location: wt.location.trim(), baseBranch: wt.baseBranch.trim() }
      : null;
  return { folders, worktree };
}

function validConditions(conditions) {
  return (
    conditions === "" ||
    conditions.split("&").every((clause) => {
      const [, name, digits] = CLAUSE.exec(clause) ?? [];
      if (!name || !digits) return false;
      return Number(digits) <= (name === "kind=" ? 65535 : 4294967295);
    })
  );
}

function satisfied(conditions, event) {
  if (!validConditions(conditions)) return false;
  if (conditions === "") return true;
  return conditions.split("&").every((clause) => {
    const [, name, digits] = CLAUSE.exec(clause) ?? [];
    const value = Number(digits);
    if (name === "kind=") return event.kind === value;
    return name === "created_at<" ? event.created_at < value : event.created_at > value;
  });
}

/** NIP-OA owner of an event (Buzz's `attestedOwner`), or undefined. */
export function attestedOwner(event) {
  const tags = (event.tags ?? []).filter((tag) => tag[0] === "auth");
  if (tags.length !== 1) return undefined;
  const [name, owner, conditions, sig] = tags[0];
  if (
    name !== "auth" ||
    tags[0].length !== 4 ||
    !HEX64.test(owner ?? "") ||
    typeof conditions !== "string" ||
    !SIG.test(sig ?? "") ||
    owner === event.pubkey ||
    !satisfied(conditions, event)
  )
    return undefined;
  try {
    const digest = sha256(utf8.encode(`nostr:agent-auth:${event.pubkey}:${conditions}`));
    return schnorr.verify(hexToBytes(sig), digest, hexToBytes(owner)) ? owner : undefined;
  } catch {
    return undefined;
  }
}

/** NIP-01: the event's id is its hash and its signature is its author's. */
export function validEvent(event) {
  try {
    const serial = JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]);
    const id = bytesToHex(sha256(utf8.encode(serial)));
    return id === event.id && schnorr.verify(hexToBytes(event.sig), hexToBytes(id), hexToBytes(event.pubkey));
  } catch {
    return false;
  }
}

/** Why Buzz would not hand this Canvas head to `owner`'s agent, or "" if it would. */
export function refusal(event, owner, channel) {
  if (!event || event.kind !== KIND_CANVAS) return "not a Canvas event";
  if (!(event.tags ?? []).some((tag) => tag[0] === "h" && tag[1] === channel))
    return "Canvas belongs to another channel";
  if (!validEvent(event)) return "Canvas signature is invalid";
  if ((event.tags ?? []).some((tag) => tag[0] === "canvas-instructions"))
    return "Canvas head is a partial edit (canvas-instructions)";
  if (event.pubkey === owner || attestedOwner(event) === owner) return "";
  return "Canvas was last written by someone other than the owner or their agents";
}

function buzz(args, timeout = 4000) {
  return new Promise((resolve, reject) => {
    // --format json: agent processes default to BUZZ_OUTPUT_FORMAT=agent,
    // which drops signatures and trims auth tags.
    execFile("buzz", ["--format", "json", ...args], { timeout, maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || error.message).trim().slice(0, 300)));
      else resolve(stdout);
    });
  });
}

export async function readWorkspace(channel, owner, run = buzz) {
  if (!UUID.test(channel)) throw new Error("invalid channel id");
  if (!HEX64.test(owner ?? "")) throw new Error("owner pubkey unknown");
  const history = JSON.parse(await run(["canvas", "history", "--channel", channel, "--limit", "1"]));
  const head = Array.isArray(history) ? history[0] : undefined;
  if (!head?.event_id) return { canvas: null, folders: [], worktree: null, reason: "no Canvas" };
  if (!HEX64.test(head.event_id)) throw new Error("invalid Canvas revision id");
  const found = JSON.parse(await run(["social", "event", "--event", head.event_id]));
  const event = Array.isArray(found) ? found[0] : found;
  const reason = refusal(event, owner, channel);
  if (reason) return { canvas: null, folders: [], worktree: null, reason, author: event?.pubkey };
  if (!event.content.trim()) return { canvas: null, folders: [], worktree: null, reason: "Canvas is empty" };
  return {
    canvas: event.content,
    ...parseWorkspace(event.content),
    author: event.pubkey,
    eventId: event.id,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const out = await readWorkspace(process.argv[2] ?? "", process.env.BUZZ_ACP_AGENT_OWNER?.toLowerCase());
    process.stdout.write(`${JSON.stringify(out)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ error: String(error.message ?? error) })}\n`);
    process.exitCode = 1;
  }
}
