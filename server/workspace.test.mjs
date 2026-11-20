// node --test server/
import test from "node:test";
import assert from "node:assert/strict";
import { schnorr, sha256, bytesToHex, hexToBytes } from "./noble.mjs";
import { parseWorkspace, attestedOwner, refusal, readWorkspace } from "./workspace.mjs";

const utf8 = new TextEncoder();
const CHANNEL = "123e4567-e89b-42d3-a456-426614174000";
const key = (n) => {
  const secret = new Uint8Array(32);
  secret[31] = n;
  return { secret, pubkey: bytesToHex(schnorr.getPublicKey(secret)) };
};
const owner = key(1);
const agent = key(2);
const stranger = key(3);

function sign(author, { content, tags = [["h", CHANNEL]], kind = 40100, created_at = 1790000000 }) {
  const event = { pubkey: author.pubkey, created_at, kind, tags, content };
  const id = bytesToHex(sha256(utf8.encode(JSON.stringify([0, event.pubkey, created_at, kind, tags, content]))));
  return { ...event, id, sig: bytesToHex(schnorr.sign(hexToBytes(id), author.secret)) };
}

function authTag(by, target, conditions = "") {
  const digest = sha256(utf8.encode(`nostr:agent-auth:${target.pubkey}:${conditions}`));
  return ["auth", by.pubkey, conditions, bytesToHex(schnorr.sign(digest, by.secret))];
}

// The block buzz-app's workspaceCanvas() writes (src/features/solo/workspace.ts).
const plain = [
  '<!-- buzz-session-workspace:v1 {"folders":["~/Work/app","/home/yt/Work/lib"]} -->',
  "## Project folders",
  "",
  "- `~/Work/app`",
  "- `/home/yt/Work/lib`",
  "<!-- /buzz-session-workspace -->",
  "",
  "Ship the settings page.",
].join("\n");
const worktree = [
  '<!-- buzz-session-workspace:v1 {"folders":["~/Work/app"],"worktree":{"location":"~/.buzz/worktrees","baseBranch":"main"}} -->',
  "## Workspace instructions",
  "",
  "- Use `~/Work/app` for review only. Do not make changes directly in it.",
  "- Before starting new work, fetch the latest `main` branch from origin.",
  "- For each repository that needs changes, create a new worktree under `~/.buzz/worktrees` from `origin/main`.",
  "- Make code changes in that new worktree. A task that only reads code, or does not use a repository, usually does not need one.",
  "<!-- /buzz-session-workspace -->",
  "",
  "",
].join("\n");

test("reads the folders Buzz writes into a Canvas", () => {
  assert.deepEqual(parseWorkspace(plain), { folders: ["~/Work/app", "/home/yt/Work/lib"], worktree: null });
  assert.deepEqual(parseWorkspace(worktree), {
    folders: ["~/Work/app"],
    worktree: { location: "~/.buzz/worktrees", baseBranch: "main" },
  });
  for (const content of ["# Notes\n- `~/x`", "", plain.replace(" -->\n", " ->\n"), plain.replace("<!-- /buzz", "<!-- /x"),
    '<!-- buzz-session-workspace:v1 {"folders":"~/x"} -->\n<!-- /buzz-session-workspace -->\n'])
    assert.deepEqual(parseWorkspace(content), { folders: [], worktree: null }, content.slice(0, 40));
});

test("accepts a Canvas only from the owner or an agent they attest", () => {
  assert.equal(refusal(sign(owner, { content: plain }), owner.pubkey, CHANNEL), "");
  const attested = sign(agent, { content: plain, tags: [["h", CHANNEL], authTag(owner, agent)] });
  assert.equal(attestedOwner(attested), owner.pubkey);
  assert.equal(refusal(attested, owner.pubkey, CHANNEL), "");

  const cases = [
    [sign(stranger, { content: plain }), /someone other/],
    // Attested by someone else, or an attestation for another agent.
    [sign(agent, { content: plain, tags: [["h", CHANNEL], authTag(stranger, agent)] }), /someone other/],
    [sign(stranger, { content: plain, tags: [["h", CHANNEL], authTag(owner, agent)] }), /someone other/],
    // Conditions the event does not meet.
    [sign(agent, { content: plain, tags: [["h", CHANNEL], authTag(owner, agent, "created_at<1700000000")] }), /someone other/],
    [sign(owner, { content: plain, tags: [["h", CHANNEL], ["canvas-instructions", "x"]] }), /partial edit/],
    [sign(owner, { content: plain, tags: [["h", "00000000-0000-4000-8000-000000000000"]] }), /another channel/],
    [{ ...sign(owner, { content: plain }), content: `${plain}\nTampered.` }, /signature/],
    [sign(owner, { content: plain, kind: 9 }), /not a Canvas/],
  ];
  for (const [event, reason] of cases) assert.match(refusal(event, owner.pubkey, CHANNEL), reason);
});

test("reads the newest revision through the agent's buzz CLI", async () => {
  const head = sign(owner, { content: plain });
  const calls = [];
  const run = async (args) => {
    calls.push(args.join(" "));
    if (args[0] === "canvas") return JSON.stringify([{ event_id: head.id, author: owner.pubkey }]);
    return JSON.stringify([head]);
  };
  const out = await readWorkspace(CHANNEL, owner.pubkey, run);
  assert.deepEqual(out.folders, ["~/Work/app", "/home/yt/Work/lib"]);
  assert.equal(out.canvas, plain);
  assert.deepEqual(calls, [`canvas history --channel ${CHANNEL} --limit 1`, `social event --event ${head.id}`]);

  const none = await readWorkspace(CHANNEL, owner.pubkey, async () => "[]");
  assert.deepEqual([none.canvas, none.folders], [null, []]);

  const foreign = sign(stranger, { content: plain });
  const refused = await readWorkspace(CHANNEL, owner.pubkey, async (args) =>
    JSON.stringify(args[0] === "canvas" ? [{ event_id: foreign.id }] : [foreign]));
  assert.deepEqual([refused.canvas, refused.folders], [null, []]);
  assert.match(refused.reason, /someone other/);

  await assert.rejects(readWorkspace("not-a-uuid", owner.pubkey, run), /invalid channel/);
});
