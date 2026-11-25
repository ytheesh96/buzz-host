// node --test server/discovery.test.mjs
// Machine discovery: the encrypted kind 30003 status event, its routes, owner
// isolation, publishing through a NIP-42 relay, the stable machine id, and
// buzz-host's `hello` + boot/shutdown wiring end to end.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { schnorr, sha256, bytesToHex, hexToBytes } from "./noble.mjs";
import { decrypt, getConversationKey } from "./nip44.mjs";
import {
  buildStatusEvent,
  createDiscoveryPublisher,
  groupByOwner,
  loadMachineId,
  machineName,
  readAuthorizedAgents,
  readRoutes,
  validAuthTag,
} from "./discovery.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const quiet = { log() {}, warn() {}, error() {} };

// ---------- helpers ----------

function keypair() {
  const secret = bytesToHex(randomBytes(32));
  return { secret, pubkey: bytesToHex(schnorr.getPublicKey(hexToBytes(secret))) };
}

/** The owner's NIP-OA attestation of `agentPubkey` (unconditional). */
function attest(owner, agentPubkey) {
  const digest = sha256(new TextEncoder().encode(`nostr:agent-auth:${agentPubkey}:`));
  return ["auth", owner.pubkey, "", bytesToHex(schnorr.sign(digest, hexToBytes(owner.secret)))];
}

function verifyEvent(event) {
  const id = bytesToHex(
    sha256(
      new TextEncoder().encode(
        JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]),
      ),
    ),
  );
  return id === event.id && schnorr.verify(hexToBytes(event.sig), hexToBytes(id), hexToBytes(event.pubkey));
}

function open(event, owner) {
  return JSON.parse(decrypt(event.content, getConversationKey(hexToBytes(owner.secret), event.pubkey)));
}

async function tmpdir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** Writes an agent the way buzz-host's provision + activate leave it. */
async function writeAgent(dataDir, { owner, name, relay, authTag, agent = keypair(), meta = {} }) {
  const dir = path.join(dataDir, agent.pubkey);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "key"), `${agent.secret}\n`);
  await fs.writeFile(
    path.join(dir, "meta.json"),
    JSON.stringify({ pubkey: agent.pubkey, name, community: relay, owner: owner.pubkey, activated: true, ...meta }),
  );
  const tag = authTag ?? attest(owner, agent.pubkey);
  await fs.writeFile(path.join(dir, "auth.json"), JSON.stringify(tag));
  return { ...agent, authTag: tag };
}

async function until(check, { timeoutMs = 5_000, what = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// ---------- a minimal NIP-01 + NIP-42 relay ----------

function encodeFrame(opcode, payload) {
  const len = payload.length;
  const head =
    len < 126
      ? Buffer.from([0x80 | opcode, len])
      : len < 65536
        ? Buffer.from([0x80 | opcode, 126, len >> 8, len & 255])
        : (() => {
            const b = Buffer.alloc(10);
            b[0] = 0x80 | opcode;
            b[1] = 127;
            b.writeBigUInt64BE(BigInt(len), 2);
            return b;
          })();
  return Buffer.concat([head, payload]);
}

/** A relay that challenges every connection (NIP-42), checks AUTH and EVENT
 * signatures, and refuses events before login. `requireAuth: false` skips the
 * challenge; `refuseLogin` answers AUTH with OK false. */
async function startRelay({ requireAuth = true, refuseLogin = false } = {}) {
  const events = [];
  const logins = [];
  const sockets = new Set();
  let connections = 0;
  const server = createServer();
  let url;
  server.on("upgrade", (req, socket) => {
    connections++;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    const accept = createHash("sha1")
      .update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const send = (value) => socket.write(encodeFrame(1, Buffer.from(JSON.stringify(value))));
    const challenge = randomBytes(8).toString("hex");
    let authed = null;
    if (requireAuth) send(["AUTH", challenge]);
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (buffer.length < 2) return;
        const opcode = buffer[0] & 0x0f;
        let len = buffer[1] & 0x7f;
        let offset = 2;
        if (len === 126) {
          if (buffer.length < 4) return;
          len = buffer.readUInt16BE(2);
          offset = 4;
        } else if (len === 127) {
          if (buffer.length < 10) return;
          len = Number(buffer.readBigUInt64BE(2));
          offset = 10;
        }
        const masked = buffer[1] & 0x80;
        const maskAt = offset;
        if (masked) offset += 4;
        if (buffer.length < offset + len) return;
        const payload = Buffer.from(buffer.subarray(offset, offset + len));
        if (masked) for (let i = 0; i < len; i++) payload[i] ^= buffer[maskAt + (i % 4)];
        buffer = buffer.subarray(offset + len);
        if (opcode === 8) {
          socket.end(encodeFrame(8, Buffer.alloc(0)));
          return;
        }
        if (opcode !== 1) continue;
        const message = JSON.parse(payload.toString("utf8"));
        if (message[0] === "AUTH") {
          const event = message[1];
          const tag = (k) => event.tags.find((t) => t[0] === k);
          const ok =
            !refuseLogin &&
            event.kind === 22242 &&
            verifyEvent(event) &&
            tag("challenge")?.[1] === challenge &&
            tag("relay")?.[1] === url &&
            validAuthTag(event.pubkey, tag("auth"));
          if (ok) {
            authed = event.pubkey;
            logins.push({ pubkey: event.pubkey, authTag: tag("auth") });
          }
          send(["OK", event.id, ok, ok ? "" : "restricted: login refused"]);
        } else if (message[0] === "EVENT") {
          const event = message[1];
          if (requireAuth && !authed) send(["OK", event.id, false, "auth-required: log in first"]);
          else if (!verifyEvent(event)) send(["OK", event.id, false, "invalid: bad signature"]);
          else {
            events.push(event);
            send(["OK", event.id, true, ""]);
          }
        }
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `ws://127.0.0.1:${server.address().port}`;
  return {
    url,
    events,
    logins,
    connections: () => connections,
    /** Drops every connection, as a relay restart would. */
    drop() {
      for (const socket of sockets) socket.destroy();
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

// ---------- the event ----------

test("status event: NIP-44 v2 to the owner, NIP-01 signed, with d/k/p/auth tags", () => {
  const owner = keypair();
  const agent = keypair();
  const authTag = attest(owner, agent.pubkey);
  const payload = { v: 1, status: "online", machineId: "m-1", agents: [{ pubkey: agent.pubkey, name: "A" }] };
  const event = buildStatusEvent({
    secretKey: agent.secret,
    ownerPubkey: owner.pubkey,
    authTag,
    machineId: "11111111-2222-4333-8444-555555555555",
    payload,
    created_at: 1_800_000_000,
  });
  assert.equal(event.kind, 30003);
  assert.equal(event.pubkey, agent.pubkey);
  assert.equal(event.created_at, 1_800_000_000);
  assert.ok(verifyEvent(event), "NIP-01 id and signature verify");
  assert.deepEqual(event.tags, [
    ["d", "buzz-host:11111111-2222-4333-8444-555555555555"],
    ["k", "buzz-host-status"],
    ["p", owner.pubkey],
    authTag,
  ]);
  assert.ok(validAuthTag(event.pubkey, event.tags.find((t) => t[0] === "auth")));
  assert.doesNotMatch(event.content, /online|m-1/, "content is not plaintext");
  assert.deepEqual(open(event, owner), payload);
  // Anyone else's key cannot read it.
  const stranger = keypair();
  assert.throws(() => decrypt(event.content, getConversationKey(hexToBytes(stranger.secret), event.pubkey)));
  // Tampering breaks the signature.
  assert.ok(!verifyEvent({ ...event, content: event.content.slice(0, -2) + "AA" }));
});

test("validAuthTag accepts only the owner's unconditional NIP-OA attestation of that agent", () => {
  const owner = keypair();
  const agent = keypair();
  const other = keypair();
  const tag = attest(owner, agent.pubkey);
  assert.ok(validAuthTag(agent.pubkey, tag));
  assert.ok(!validAuthTag(other.pubkey, tag), "attestation is for another agent");
  assert.ok(!validAuthTag(agent.pubkey, ["auth", other.pubkey, "", tag[3]]), "signed by someone else");
  assert.ok(!validAuthTag(agent.pubkey, ["auth", owner.pubkey, "kind=1", tag[3]]), "conditions not allowed");
  assert.ok(!validAuthTag(agent.pubkey, ["auth", owner.pubkey, ""]));
  assert.ok(!validAuthTag(agent.pubkey, null));
  assert.ok(!validAuthTag(agent.pubkey, ["auth", owner.pubkey, "", "zz".repeat(64)]));
});

// ---------- routes ----------

test("routes: iroh-addr.json first, then the public wss URLs, deduplicated", async () => {
  const runDir = await tmpdir("disc-run-");
  try {
    assert.deepEqual(await readRoutes(runDir, {}), []);
    assert.deepEqual(await readRoutes(runDir, { publicGuestUrl: "wss://g.example/_buzz-host" }), [
      { type: "wss", url: "wss://g.example/_buzz-host" },
    ]);
    await fs.writeFile(
      path.join(runDir, "iroh-addr.json"),
      JSON.stringify({ nodeId: "n0de", endpointAddr: "eyJpZCI6Im4wZGUifQ", updatedAt: 1 }),
    );
    assert.deepEqual(
      await readRoutes(runDir, {
        publicGuestUrl: "wss://g.example/_buzz-host",
        publicUrl: "wss://admin.example",
      }),
      [
        { type: "iroh", nodeId: "n0de", endpointAddr: "eyJpZCI6Im4wZGUifQ" },
        { type: "wss", url: "wss://g.example/_buzz-host" },
        { type: "wss", url: "wss://admin.example" },
      ],
    );
    // The same URL twice, and non-ws URLs, appear once / not at all.
    assert.deepEqual(
      await readRoutes(runDir, { publicGuestUrl: "wss://same.example", publicUrl: "wss://same.example" }),
      [
        { type: "iroh", nodeId: "n0de", endpointAddr: "eyJpZCI6Im4wZGUifQ" },
        { type: "wss", url: "wss://same.example" },
      ],
    );
    assert.deepEqual((await readRoutes(runDir, { publicUrl: "https://nope.example" })).length, 1);
    // A half-written or malformed file is no route rather than an error.
    await fs.writeFile(path.join(runDir, "iroh-addr.json"), '{"nodeId":');
    assert.deepEqual(await readRoutes(runDir, {}), []);
    await fs.writeFile(path.join(runDir, "iroh-addr.json"), JSON.stringify({ nodeId: "x" }));
    assert.deepEqual(await readRoutes(runDir, {}), []);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("machineName: config wins, else the hostname's first label", () => {
  assert.equal(machineName("  Studio  ", "box.local"), "Studio");
  assert.equal(machineName(undefined, "Vaitheeshs-MacBook-Pro.local"), "Vaitheeshs-MacBook-Pro");
  assert.equal(machineName("", "omarchy"), "omarchy");
});

// ---------- owners ----------

test("readAuthorizedAgents keeps only attested agents; groups are per (relay, owner)", async () => {
  const dataDir = await tmpdir("disc-data-");
  try {
    const ownerA = keypair();
    const ownerB = keypair();
    const relay1 = "wss://relay-one.example";
    const relay2 = "wss://relay-two.example";
    const a1 = await writeAgent(dataDir, { owner: ownerA, name: "A1", relay: relay1 });
    const a2 = await writeAgent(dataDir, { owner: ownerA, name: "A2", relay: relay1 });
    const a3 = await writeAgent(dataDir, { owner: ownerA, name: "A3", relay: relay2 });
    const b1 = await writeAgent(dataDir, { owner: ownerB, name: "B1", relay: relay1 });
    // Not owner-authorized: no auth.json, a forged attestation, another owner in meta, a bad key.
    const unattested = keypair();
    await fs.mkdir(path.join(dataDir, unattested.pubkey));
    await fs.writeFile(path.join(dataDir, unattested.pubkey, "key"), unattested.secret);
    await fs.writeFile(
      path.join(dataDir, unattested.pubkey, "meta.json"),
      JSON.stringify({ name: "provisioned", community: relay1 }),
    );
    const forger = keypair();
    const forged = keypair();
    await writeAgent(dataDir, {
      owner: ownerA,
      name: "forged",
      relay: relay1,
      agent: forged,
      authTag: ["auth", ownerA.pubkey, "", attest(forger, forged.pubkey)[3]],
    });
    await writeAgent(dataDir, { owner: ownerA, name: "mismatch", relay: relay1, meta: { owner: ownerB.pubkey } });
    const wrongKey = await writeAgent(dataDir, { owner: ownerA, name: "wrong key", relay: relay1 });
    await fs.writeFile(path.join(dataDir, wrongKey.pubkey, "key"), keypair().secret);
    await fs.mkdir(path.join(dataDir, "not-an-agent"));

    const agents = await readAuthorizedAgents(dataDir, quiet);
    assert.deepEqual(
      agents.map((a) => a.name).sort(),
      ["A1", "A2", "A3", "B1"],
    );
    const groups = groupByOwner(agents);
    assert.equal(groups.size, 3, "A@relay1, A@relay2, B@relay1");
    const byKey = (relay, owner) => groups.get(`${relay}\n${owner.pubkey}`);
    const aOne = byKey(relay1, ownerA);
    const bOne = byKey(relay1, ownerB);
    const aTwo = byKey(relay2, ownerA);
    // The publisher is the lowest pubkey of that owner on that relay.
    assert.equal(aOne.publisher.pubkey, [a1.pubkey, a2.pubkey].sort()[0]);
    assert.equal(aTwo.publisher.pubkey, a3.pubkey);
    assert.equal(bOne.publisher.pubkey, b1.pubkey);
    // Each owner's event lists all of that owner's agents on this host, and only theirs.
    const names = (group) => group.agents.map((a) => a.name).sort();
    assert.deepEqual(names(aOne), ["A1", "A2", "A3"]);
    assert.deepEqual(names(aTwo), ["A1", "A2", "A3"]);
    assert.deepEqual(names(bOne), ["B1"]);
    assert.ok(aOne.agents.every((a) => Object.keys(a).sort().join() === "name,pubkey"), "no keys leak into agents");
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("multi-owner isolation on one relay: each owner gets their own event, readable only by them", async () => {
  const relay = await startRelay();
  const dataDir = await tmpdir("disc-data-");
  const runDir = await tmpdir("disc-run-");
  const ownerA = keypair();
  const ownerB = keypair();
  const a = await writeAgent(dataDir, { owner: ownerA, name: "Alpha", relay: relay.url });
  const b = await writeAgent(dataDir, { owner: ownerB, name: "Bravo", relay: relay.url });
  const publisher = createDiscoveryPublisher({
    dataDir,
    runDir,
    machineId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    authWaitMs: 2_000,
    log: quiet,
  });
  try {
    const events = await publisher.publishNow();
    assert.equal(events.length, 2);
    assert.equal(relay.events.length, 2);
    const forOwner = (owner) => relay.events.find((e) => e.tags.some((t) => t[0] === "p" && t[1] === owner.pubkey));
    const eventA = forOwner(ownerA);
    const eventB = forOwner(ownerB);
    assert.equal(eventA.pubkey, a.pubkey);
    assert.equal(eventB.pubkey, b.pubkey);
    assert.deepEqual(open(eventA, ownerA).agents, [{ pubkey: a.pubkey, name: "Alpha" }]);
    assert.deepEqual(open(eventB, ownerB).agents, [{ pubkey: b.pubkey, name: "Bravo" }]);
    assert.throws(() => open(eventA, ownerB), "owner B cannot read owner A's status");
    assert.throws(() => open(eventB, ownerA), "owner A cannot read owner B's status");
    // Each publisher logged in with its own owner's attestation.
    assert.deepEqual(
      relay.logins.map((l) => [l.pubkey, l.authTag[1]]).sort(),
      [
        [a.pubkey, ownerA.pubkey],
        [b.pubkey, ownerB.pubkey],
      ].sort(),
    );
  } finally {
    await publisher.stop();
    await relay.close();
    await fs.rm(dataDir, { recursive: true, force: true });
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

// ---------- publishing ----------

test("publisher: NIP-42 login, full payload, heartbeat, notifyChanged, iroh watch, stopped on stop()", async () => {
  const relay = await startRelay();
  const dataDir = await tmpdir("disc-data-");
  const runDir = await tmpdir("disc-run-");
  const owner = keypair();
  const first = await writeAgent(dataDir, { owner, name: "First", relay: relay.url });
  const machineId = "12345678-9abc-4def-8123-456789abcdef";
  const config = { machineName: "Test Box", publicGuestUrl: "wss://guest.example/_buzz-host" };
  const publisher = createDiscoveryPublisher({
    dataDir,
    runDir,
    machineId,
    config: () => config,
    runtimes: async () => ["claude", "codex"],
    capabilities: async () => ({ desktop: true, docker: false }),
    intervalMs: 300,
    debounceMs: 20,
    authWaitMs: 2_000,
    hostname: "testbox.local",
    platform: "linux",
    log: quiet,
  });
  const decoded = () => relay.events.map((e) => open(e, owner));
  try {
    publisher.start();
    await until(() => relay.events.length >= 1, { what: "first publish" });
    const [event] = relay.events;
    assert.ok(verifyEvent(event));
    assert.equal(event.pubkey, first.pubkey);
    assert.deepEqual(relay.logins[0], { pubkey: first.pubkey, authTag: first.authTag });
    const payload = decoded()[0];
    assert.deepEqual(payload, {
      v: 1,
      status: "online",
      machineId,
      name: "Test Box",
      host: "testbox.local",
      platform: "linux",
      runtimes: ["claude", "codex"],
      capabilities: { desktop: true, docker: false },
      routes: [{ type: "wss", url: "wss://guest.example/_buzz-host" }],
      agents: [{ pubkey: first.pubkey, name: "First" }],
      publicGuestUrl: "wss://guest.example/_buzz-host",
      updatedAt: event.created_at,
    });

    // Heartbeat: more events arrive with no change, over the same connection.
    await until(() => relay.events.length >= 3, { what: "heartbeats" });
    assert.equal(relay.connections(), 1, "one connection reused across publishes");
    const stamps = relay.events.map((e) => e.created_at);
    assert.ok(stamps.every((t, i) => i === 0 || t > stamps[i - 1]), "created_at strictly increases");

    // A new agent shows up right after notifyChanged(), well before a heartbeat would.
    const slowPublisher = publisher; // same instance; heartbeat is 300ms, debounce 20ms
    const second = await writeAgent(dataDir, { owner, name: "Second", relay: relay.url });
    const before = relay.events.length;
    slowPublisher.notifyChanged();
    await until(() => decoded().slice(before).some((p) => p.agents.length === 2), { what: "agent list update" });
    const latest = decoded().at(-1);
    assert.deepEqual(
      latest.agents.map((a) => a.name).sort(),
      ["First", "Second"],
    );
    assert.equal(relay.events.at(-1).pubkey, [first.pubkey, second.pubkey].sort()[0]);

    // iroh-addr.json appearing is picked up (watch or heartbeat) and ordered first.
    await fs.writeFile(
      path.join(runDir, "iroh-addr.json"),
      JSON.stringify({ nodeId: "abc123", endpointAddr: "eyJhZGRyIjoiMSJ9", updatedAt: 2 }),
    );
    await until(() => decoded().at(-1).routes[0]?.type === "iroh", { what: "iroh route" });
    assert.deepEqual(decoded().at(-1).routes, [
      { type: "iroh", nodeId: "abc123", endpointAddr: "eyJhZGRyIjoiMSJ9" },
      { type: "wss", url: "wss://guest.example/_buzz-host" },
    ]);

    // stop(): a final "stopped" status, then nothing more.
    await publisher.stop();
    const last = relay.events.at(-1);
    assert.equal(open(last, owner).status, "stopped");
    assert.ok(last.created_at > relay.events.at(-2).created_at, "stopped replaces online");
    const count = relay.events.length;
    publisher.notifyChanged();
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(relay.events.length, count, "no publishes after stop()");
  } finally {
    await publisher.stop();
    await relay.close();
    await fs.rm(dataDir, { recursive: true, force: true });
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("publisher reconnects after the relay drops it, and logs in again", async () => {
  const relay = await startRelay();
  const dataDir = await tmpdir("disc-data-");
  const runDir = await tmpdir("disc-run-");
  const owner = keypair();
  await writeAgent(dataDir, { owner, name: "Solo", relay: relay.url });
  const publisher = createDiscoveryPublisher({
    dataDir,
    runDir,
    machineId: "12345678-9abc-4def-8123-456789abcdef",
    authWaitMs: 2_000,
    backoffMinMs: 10,
    log: quiet,
  });
  try {
    assert.equal((await publisher.publishNow()).length, 1);
    relay.drop();
    await until(async () => (await publisher.publishNow()).length === 1, { what: "republish after drop" });
    assert.equal(relay.connections(), 2);
    assert.equal(relay.logins.length, 2);
  } finally {
    await publisher.stop();
    await relay.close();
    await fs.rm(dataDir, { recursive: true, force: true });
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("publisher never throws: no agents, unreachable relay, refused login; stop() stays bounded", async () => {
  const dataDir = await tmpdir("disc-data-");
  const runDir = await tmpdir("disc-run-");
  const warnings = [];
  const log = { log() {}, warn: (m) => warnings.push(m), error() {} };
  try {
    // No agents at all: nothing published, nothing thrown.
    const empty = createDiscoveryPublisher({ dataDir: path.join(dataDir, "missing"), runDir, machineId: "x", log });
    empty.start();
    assert.deepEqual(await empty.publishNow(), []);
    await empty.stop();

    // A relay nobody listens on: a warning and backoff, no exception.
    const owner = keypair();
    const deadPort = await freePort();
    await writeAgent(dataDir, { owner, name: "Lonely", relay: `ws://127.0.0.1:${deadPort}` });
    const offline = createDiscoveryPublisher({
      dataDir,
      runDir,
      machineId: "x",
      log,
      backoffMinMs: 60_000,
      stopTimeoutMs: 500,
    });
    offline.start();
    assert.deepEqual(await offline.publishNow(), []);
    assert.ok(warnings.some((w) => /retrying in 60s/.test(w)), warnings.join("\n"));
    // While backing off, publishes are skipped without reconnecting or warning again.
    const warned = warnings.length;
    assert.deepEqual(await offline.publishNow(), []);
    assert.equal(warnings.length, warned);
    const t0 = Date.now();
    await offline.stop();
    assert.ok(Date.now() - t0 < 2_000, "stop() is bounded");

    // A relay that refuses the login.
    const refusing = await startRelay({ refuseLogin: true });
    const dataDir2 = await tmpdir("disc-data-");
    await writeAgent(dataDir2, { owner, name: "Refused", relay: refusing.url });
    const refused = createDiscoveryPublisher({ dataDir: dataDir2, runDir, machineId: "x", log, authWaitMs: 2_000 });
    assert.deepEqual(await refused.publishNow(), []);
    assert.equal(refusing.events.length, 0);
    assert.ok(warnings.some((w) => /login refused/.test(w)));
    await refused.stop();
    await refusing.close();
    await fs.rm(dataDir2, { recursive: true, force: true });

    // A relay that hangs after accepting the socket: stop() still returns.
    const silent = createServer();
    const silentSockets = new Set();
    silent.on("upgrade", (req, socket) => {
      silentSockets.add(socket);
      socket.on("close", () => silentSockets.delete(socket));
      const accept = createHash("sha1")
        .update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
        .digest("base64");
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      socket.on("error", () => {});
    });
    await new Promise((resolve) => silent.listen(0, "127.0.0.1", resolve));
    const dataDir3 = await tmpdir("disc-data-");
    await writeAgent(dataDir3, { owner, name: "Hung", relay: `ws://127.0.0.1:${silent.address().port}` });
    const hung = createDiscoveryPublisher({
      dataDir: dataDir3,
      runDir,
      machineId: "x",
      log,
      authWaitMs: 60_000,
      stopTimeoutMs: 300,
    });
    hung.start();
    const t1 = Date.now();
    await hung.stop();
    assert.ok(Date.now() - t1 < 1_500, "stop() gives up on a hung relay");
    for (const socket of silentSockets) socket.destroy();
    silent.closeAllConnections?.();
    await new Promise((resolve) => silent.close(resolve));
    await fs.rm(dataDir3, { recursive: true, force: true });
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("relays that ask for no login get the status after the auth wait", async () => {
  const relay = await startRelay({ requireAuth: false });
  const dataDir = await tmpdir("disc-data-");
  const runDir = await tmpdir("disc-run-");
  const owner = keypair();
  await writeAgent(dataDir, { owner, name: "Open", relay: relay.url });
  const publisher = createDiscoveryPublisher({ dataDir, runDir, machineId: "x", authWaitMs: 50, log: quiet });
  try {
    assert.equal((await publisher.publishNow()).length, 1);
    assert.equal(relay.logins.length, 0);
    assert.equal(open(relay.events[0], owner).status, "online");
  } finally {
    await publisher.stop();
    await relay.close();
    await fs.rm(dataDir, { recursive: true, force: true });
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

// ---------- machine id ----------

test("loadMachineId: generated once, persisted 0644, reused; config wins; bad files are replaced", async () => {
  const base = await tmpdir("disc-id-");
  const file = path.join(base, "nested", "machine-id");
  try {
    const id = await loadMachineId({ file, log: quiet });
    assert.match(id, UUID);
    assert.equal((await fs.readFile(file, "utf8")).trim(), id);
    assert.equal((await fs.stat(file)).mode & 0o777, 0o644);
    assert.equal(await loadMachineId({ file, log: quiet }), id, "stable across restarts");
    const configured = "ABCDEF01-2345-4678-89AB-CDEF01234567";
    assert.equal(await loadMachineId({ file, configured, log: quiet }), configured.toLowerCase());
    assert.equal(await loadMachineId({ file, configured: "not-a-uuid", log: quiet }), id);
    await fs.writeFile(file, "garbage\n");
    const replaced = await loadMachineId({ file, log: quiet });
    assert.match(replaced, UUID);
    assert.notEqual(replaced, id);
    assert.equal(await loadMachineId({ file, log: quiet }), replaced);
    // Unwritable location: still an id (for this run), and a warning instead of a throw.
    const warnings = [];
    const blocker = path.join(base, "blocker");
    await fs.writeFile(blocker, "");
    const ephemeral = await loadMachineId({
      file: path.join(blocker, "machine-id"),
      log: { warn: (m) => warnings.push(m) },
    });
    assert.match(ephemeral, UUID);
    assert.ok(warnings.some((w) => /not saved/.test(w)));
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

// ---------- buzz-host end to end ----------

/** Boots server/buzz-host.mjs in a throwaway HOME and runtime dir. */
async function bootHost(home, run, port) {
  // No DBus/systemd from the real session: buzz-host must not reach it.
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_RUNTIME_DIR: run,
    TMPDIR: process.env.TMPDIR ?? "/tmp",
  };
  const child = spawn(process.execPath, [path.join(HERE, "buzz-host.mjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  await until(() => output.includes(`admin listening on 127.0.0.1:${port}`) || child.exitCode !== null, {
    timeoutMs: 20_000,
    what: "buzz-host to listen",
  }).catch(() => {});
  assert.ok(child.exitCode === null, `buzz-host exited early:\n${output}`);
  return { child, exited, output: () => output };
}

function encodeMaskedFrame(opcode, payload) {
  const mask = randomBytes(4);
  const len = payload.length;
  const head =
    len < 126
      ? Buffer.from([0x80 | opcode, 0x80 | len])
      : len < 65536
        ? Buffer.from([0x80 | opcode, 0x80 | 126, len >> 8, len & 255])
        : (() => {
            const b = Buffer.alloc(10);
            b[0] = 0x80 | opcode;
            b[1] = 0x80 | 127;
            b.writeBigUInt64BE(BigInt(len), 2);
            return b;
          })();
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
  return Buffer.concat([head, mask, masked]);
}

async function rpc(port, method, params = {}) {
  const key = randomBytes(16).toString("base64");
  const { socket, head } = await new Promise((resolve, reject) => {
    const req = httpRequest({
      host: "127.0.0.1",
      port,
      path: "/",
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": key,
        "Tailscale-User-Login": "owner@example.com",
      },
    });
    req.on("upgrade", (_res, socket, head) => resolve({ socket, head }));
    req.on("response", (res) => reject(new Error(`rpc upgrade refused (${res.statusCode})`)));
    req.on("error", reject);
    req.end();
  });
  try {
    const reply = new Promise((resolve, reject) => {
      let buffer = head.length ? Buffer.from(head) : Buffer.alloc(0);
      const parse = () => {
        if (buffer.length < 2) return;
        const opcode = buffer[0] & 0x0f;
        let len = buffer[1] & 0x7f;
        let offset = 2;
        if (len === 126) {
          if (buffer.length < 4) return;
          len = buffer.readUInt16BE(2);
          offset = 4;
        } else if (len === 127) {
          if (buffer.length < 10) return;
          len = Number(buffer.readBigUInt64BE(2));
          offset = 10;
        }
        if (buffer.length < offset + len) return;
        const payload = buffer.subarray(offset, offset + len);
        buffer = buffer.subarray(offset + len);
        if (opcode === 1) resolve(JSON.parse(payload.toString("utf8")));
      };
      socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        parse();
      });
      socket.on("error", reject);
      socket.on("close", () => reject(new Error("rpc socket closed before reply")));
      parse();
    });
    socket.write(encodeMaskedFrame(1, Buffer.from(JSON.stringify({ id: 1, method, params }))));
    const message = await reply;
    if (message.error) throw new Error(message.error);
    return message.result;
  } finally {
    socket.destroy();
  }
}

test("buzz-host: hello carries the persisted machineId; boot publishes it, SIGTERM publishes stopped", { timeout: 60_000 }, async () => {
  const relay = await startRelay();
  const home = await tmpdir("disc-home-");
  const run = await tmpdir("disc-xdg-");
  await fs.chmod(run, 0o700);
  const port = await freePort();
  const owner = keypair();
  let host;
  try {
    await fs.mkdir(path.join(home, ".config/buzz-host"), { recursive: true });
    await fs.writeFile(
      path.join(home, ".config/buzz-host/config.json"),
      JSON.stringify({
        port,
        guestPort: 0,
        allowLogins: ["owner@example.com"],
        machineName: "E2E Box",
        publicGuestUrl: "wss://e2e.example/_buzz-host",
      }),
    );
    // An authorized agent that is not activated (so boot never touches systemd).
    const agent = await writeAgent(path.join(home, ".local/share/buzz-host/agents"), {
      owner,
      name: "E2E Agent",
      relay: relay.url,
      meta: { activated: false, runtime: "claude", runner: "host" },
    });

    host = await bootHost(home, run, port);
    const hello = await rpc(port, "hello");
    assert.match(hello.machineId, UUID);
    assert.equal(hello.host, os.hostname());
    const saved = (await fs.readFile(path.join(home, ".local/share/buzz-host/machine-id"), "utf8")).trim();
    assert.equal(hello.machineId, saved);

    await until(() => relay.events.length >= 1, { timeoutMs: 15_000, what: "boot publish" });
    const online = open(relay.events[0], owner);
    assert.equal(online.status, "online");
    assert.equal(online.machineId, hello.machineId, "discovered and manual machines share the id");
    assert.equal(online.name, "E2E Box");
    assert.deepEqual(online.agents, [{ pubkey: agent.pubkey, name: "E2E Agent" }]);
    assert.deepEqual(online.routes, [{ type: "wss", url: "wss://e2e.example/_buzz-host" }]);
    assert.ok(relay.events[0].tags.some((t) => t[0] === "d" && t[1] === `buzz-host:${hello.machineId}`));

    host.child.kill("SIGTERM");
    const exit = await host.exited;
    assert.equal(exit.code, 0, host.output());
    const last = relay.events.at(-1);
    assert.equal(open(last, owner).status, "stopped");

    // Restart: same id.
    host = await bootHost(home, run, port);
    assert.equal((await rpc(port, "hello")).machineId, hello.machineId);
    host.child.kill("SIGTERM");
    await host.exited;

    // discovery: false → hello still answers, nothing is published.
    const config = JSON.parse(await fs.readFile(path.join(home, ".config/buzz-host/config.json"), "utf8"));
    await fs.writeFile(
      path.join(home, ".config/buzz-host/config.json"),
      JSON.stringify({ ...config, discovery: false }),
    );
    const count = relay.events.length;
    host = await bootHost(home, run, port);
    assert.equal((await rpc(port, "hello")).machineId, hello.machineId);
    await new Promise((resolve) => setTimeout(resolve, 500));
    host.child.kill("SIGTERM");
    await host.exited;
    assert.equal(relay.events.length, count, "discovery: false publishes nothing");
  } finally {
    if (host && host.child.exitCode === null) {
      host.child.kill("SIGKILL");
      await host.exited;
    }
    await relay.close();
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(run, { recursive: true, force: true });
  }
});
