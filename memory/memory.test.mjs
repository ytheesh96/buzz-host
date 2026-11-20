// node --test memory/   — buzz-host memory against a fake relay HTTP API.
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { decrypt, getConversationKey } from "../server/nip44.mjs";
import { schnorr, bytesToHex, hexToBytes } from "../server/noble.mjs";
import { callMemoryTool, createMemory, memoryClient, memoryVersion, MEMORY_TOOLS } from "../server/memory.mjs";

const secretOf = () => bytesToHex(randomBytes(32));
const pubOf = (secret) => bytesToHex(schnorr.getPublicKey(hexToBytes(secret)));
const agentSecret = secretOf();
const ownerSecret = secretOf();
const agent = pubOf(agentSecret);
const owner = pubOf(ownerSecret);
const authTag = JSON.stringify(["auth", owner, "", "f".repeat(128)]);

/** The relay's /query and /events for kind 30174, as fetch. */
function fakeRelay() {
  const events = [];
  const requests = [];
  let clock = 1_800_000_000;
  const fetch = async (url, init) => {
    requests.push({ url, init });
    const body = JSON.parse(init.body);
    if (url.endsWith("/events")) {
      events.push(body);
      return new Response(JSON.stringify({ accepted: true, message: "" }));
    }
    const [filter] = body;
    const found = events.filter(
      (e) =>
        filter.kinds.includes(e.kind) &&
        filter.authors.includes(e.pubkey) &&
        e.tags.some(([k, v]) => k === "p" && filter["#p"].includes(v)) &&
        (!filter["#d"] || e.tags.some(([k, v]) => k === "d" && filter["#d"].includes(v))),
    );
    return new Response(JSON.stringify(found));
  };
  return { events, requests, fetch, now: () => ++clock };
}
const client = (relay) =>
  memoryClient({ relay: "wss://relay.test:8446", secret: agentSecret, owner, authTag, fetch: relay.fetch, now: relay.now });

test("writes Buzz's memory records: owner-decryptable, HMAC address, exact tags", async () => {
  const relay = fakeRelay();
  const c = client(relay);
  assert.equal(await callMemoryTool(c, "mem_set", { slug: "notes", text: "Owner prefers W2 roles." }), `saved; version ${memoryVersion("Owner prefers W2 roles.")}`);
  await callMemoryTool(c, "mem_set", { slug: "core", text: "I am haiku." });
  const [note, core] = relay.events;
  // The owner's side of the conversation key, as Buzz's reader derives it.
  const key = getConversationKey(hexToBytes(ownerSecret), agent);
  for (const [event, slug, body] of [
    [note, "mem/notes", { slug: "mem/notes", value: "Owner prefers W2 roles." }],
    [core, "core", { slug: "core", profile: "I am haiku." }],
  ]) {
    assert.equal(event.kind, 30174);
    assert.equal(event.pubkey, agent);
    assert.deepEqual(event.tags, [
      ["d", createHmac("sha256", key).update(`agent-memory/v1/d-tag\0${slug}`).digest("hex")],
      ["p", owner],
    ]);
    assert.deepEqual(JSON.parse(decrypt(event.content, key)), body);
    assert.equal(event.id, createHash("sha256").update(JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content])).digest("hex"));
    assert.ok(schnorr.verify(hexToBytes(event.sig), hexToBytes(event.id), hexToBytes(agent)));
  }
  // Each request is NIP-98 signed by the agent and carries its owner tag.
  const { url, init } = relay.requests.at(-1);
  assert.equal(url, "https://relay.test:8446/events");
  assert.equal(init.headers["x-auth-tag"], authTag);
  const nip98 = JSON.parse(Buffer.from(init.headers.authorization.replace("Nostr ", ""), "base64").toString());
  assert.equal(nip98.kind, 27235);
  assert.equal(nip98.pubkey, agent);
  assert.deepEqual(nip98.tags.slice(0, 3), [
    ["u", url],
    ["method", "POST"],
    ["payload", createHash("sha256").update(init.body).digest("hex")],
  ]);
});

test("mem_get / mem_set / mem_rm follow Buzz's versions", async () => {
  const relay = fakeRelay();
  const c = client(relay);
  assert.equal(await callMemoryTool(c, "mem_get", {}), "No memory.");
  await callMemoryTool(c, "mem_set", { slug: "team/plan", text: "ship memory\nthen activity" });
  const v1 = memoryVersion("ship memory\nthen activity");
  assert.equal(await callMemoryTool(c, "mem_get", { slug: "team/plan" }), `version: ${v1}\n\nship memory\nthen activity`);
  await assert.rejects(callMemoryTool(c, "mem_set", { slug: "team/plan", text: "x" }), /exists\. Read it with mem_get/);
  await assert.rejects(callMemoryTool(c, "mem_set", { slug: "team/plan", text: "x", expected: "0".repeat(16) }), /changed since version/);
  await assert.rejects(callMemoryTool(c, "mem_set", { slug: "team/plan", text: `version: ${v1}\nx`, expected: v1 }), /Leave out the version line/);
  await callMemoryTool(c, "mem_set", { slug: "team/plan", text: "ship memory\nthen popups", expected: v1 });
  assert.match(await callMemoryTool(c, "mem_get", { q: "popups" }), /^mem\/team\/plan .*Z\n {2}then popups$/);
  assert.equal(await callMemoryTool(c, "mem_get", { q: "nothing-here" }), "No memory matches nothing-here.");
  await assert.rejects(callMemoryTool(c, "mem_rm", { slug: "core", expected: v1 }), /core cannot be deleted/);
  await assert.rejects(callMemoryTool(c, "mem_set", { slug: "Bad Slug", text: "x" }), /Bad slug/);
  const v2 = memoryVersion("ship memory\nthen popups");
  assert.equal(await callMemoryTool(c, "mem_rm", { slug: "team/plan", expected: v2 }), "deleted mem/team/plan");
  assert.equal(await callMemoryTool(c, "mem_get", { slug: "team/plan" }), "No memory mem/team/plan.");
  // Recreating it follows its tombstone, so it is the newest.
  await callMemoryTool(c, "mem_set", { slug: "team/plan", text: "again" });
  assert.match(await callMemoryTool(c, "mem_get", { slug: "team/plan" }), /\n\nagain$/);
  const dated = relay.events.map((e) => e.created_at);
  assert.deepEqual(dated, [...dated].sort((a, b) => a - b));
});

test("the service reads the agent's files and gives the core note", async () => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "buzz-host-memory-"));
  try {
    const dir = path.join(data, agent);
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, "meta.json"), JSON.stringify({ pubkey: agent, owner, community: "wss://relay.test:8446", activated: true }));
    await fs.writeFile(path.join(dir, "key"), `${agentSecret}\n`);
    await fs.writeFile(path.join(dir, "auth.json"), authTag);
    const relay = fakeRelay();
    const memory = createMemory({ dataDir: data, fetch: relay.fetch, log: { warn() {} } });
    assert.ok(memory.handles("mem_get") && memory.handles("memory_core") && !memory.handles("watch_add"));
    assert.match(await memory.call(agent, "memory_core"), /## Agent Memory[\s\S]*<core-memory>\nNo core memory found\./);
    await memory.call(agent, "mem_set", { slug: "core", text: "I am haiku. [[mem/notes]]" });
    const note = await memory.call(agent, "memory_core");
    assert.ok(note.startsWith("## Agent Memory"));
    assert.ok(note.endsWith("<core-memory>\nI am haiku. [[mem/notes]]\n</core-memory>"));
    await assert.rejects(memory.call("0".repeat(64), "mem_get", {}), /not on this host/);
  } finally {
    await fs.rm(data, { recursive: true, force: true });
  }
});

test("lists Buzz's three memory tools", () => {
  assert.deepEqual(MEMORY_TOOLS.map((t) => t.name), ["mem_get", "mem_set", "mem_rm"]);
  assert.deepEqual(MEMORY_TOOLS[2].inputSchema.required, ["slug", "expected"]);
});
