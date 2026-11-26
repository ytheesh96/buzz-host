// node --test server/cross-machine-delegation.test.mjs
//
// End-to-end two-host tests (host A orchestrator + host B delegate executor
// over real loopback WebSockets, real tokenStore, real NIP-01/NIP-OA signed
// events, and a shared in-memory relay) plus security and CLI tests.

import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { signEvent } from "./attention-relay.mjs";
import { assertMethodAllowed, createTokenStore, isTokenExpired } from "./auth.mjs";
import {
  buildDelegateAuthEvent,
  createDelegateExecutor,
  resolveDelegateWorkspace,
  verifyDelegateAuthEvent,
} from "./delegate-executor.mjs";
import {
  createLinkManager,
  decodeLinkBlob,
  encodeLinkBlob,
  validateRoutes,
} from "./links.mjs";
import { runLinks } from "./links-cli.mjs";
import { bytesToHex, hexToBytes, schnorr, sha256 } from "./noble.mjs";
import { createOrchestrator } from "./orchestrator.mjs";
import { runTokens } from "./tokens-cli.mjs";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function genKeypair() {
  const secret = bytesToHex(randomBytes(32));
  const pubkey = bytesToHex(schnorr.getPublicKey(hexToBytes(secret)));
  return { secret, pubkey };
}

function makeAuthTag(ownerSecret, ownerPubkey, agentPubkey) {
  const digest = sha256(new TextEncoder().encode(`nostr:agent-auth:${agentPubkey}:`));
  const sig = bytesToHex(schnorr.sign(digest, hexToBytes(ownerSecret)));
  return ["auth", ownerPubkey, "", sig];
}

// Minimal RFC 6455 WebSocket server mirroring buzz-host.mjs token listener.
function wsFrame(opcode, payload) {
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

function attachWs(socket, onText) {
  let buf = Buffer.alloc(0);
  const send = (text) => socket.write(wsFrame(1, Buffer.from(text)));
  socket.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const opcode = buf[0] & 0x0f;
      const masked = buf[1] & 0x80;
      let len = buf[1] & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        offset = 10;
      }
      if (!masked) return socket.destroy();
      if (buf.length < offset + 4 + len) return;
      const mask = buf.subarray(offset, offset + 4);
      const payload = Buffer.from(buf.subarray(offset + 4, offset + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      buf = buf.subarray(offset + 4 + len);
      if (opcode === 8) {
        socket.end(wsFrame(8, Buffer.alloc(0)));
        return;
      }
      if (opcode === 9) {
        socket.write(wsFrame(10, payload));
        continue;
      }
      if (opcode === 1) onText(payload.toString("utf8"), send);
    }
  });
  socket.on("error", () => {});
  return send;
}

// Shared in-memory relay for two-host tests.
function createFakeSharedRelay() {
  const chats = new Map(); // channelId -> { createEvent, messages: [] }
  const watchers = new Map(); // channelId -> Set<{ authorPubkey, onMessage }>

  return {
    chats,
    async createSoloChat({ pubkey, ownerPubkey, workerPubkey, channelId, name }) {
      const createEvent = {
        id: bytesToHex(randomBytes(32)),
        pubkey,
        kind: 9007,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ["h", channelId],
          ["name", name],
          ["t", "buzz.solo"],
          ["p", ownerPubkey],
          ...(workerPubkey && workerPubkey !== pubkey ? [["p", workerPubkey]] : []),
        ],
        content: "",
      };
      chats.set(channelId, { createEvent, messages: [] });
      return { channelId, eventId: createEvent.id };
    },
    async postMessage({ pubkey, channelId, content, extraTags = [] }) {
      const chat = chats.get(channelId);
      if (!chat) throw new Error(`Unknown channel ${channelId}`);
      const ev = {
        id: bytesToHex(randomBytes(32)),
        pubkey,
        kind: 9,
        created_at: Math.floor(Date.now() / 1000),
        tags: [["h", channelId], ...extraTags],
        content,
      };
      chat.messages.push(ev);
      for (const w of watchers.get(channelId) ?? []) {
        if (!w.authorPubkey || w.authorPubkey === pubkey) {
          w.onMessage(ev);
        }
      }
      return { eventId: ev.id, createdAt: ev.created_at };
    },
    async getMessages({ channelId, authorPubkey, since }) {
      const chat = chats.get(channelId);
      if (!chat) return [];
      return chat.messages.filter(
        (m) => (!authorPubkey || m.pubkey === authorPubkey) && (!since || m.created_at >= since),
      );
    },
    async watchChannel({ channelId, authorPubkey, onMessage }) {
      let set = watchers.get(channelId);
      if (!set) watchers.set(channelId, (set = new Set()));
      const entry = { authorPubkey, onMessage };
      set.add(entry);
      return () => set.delete(entry);
    },
    verifySoloChat({ workerPubkey, channelId, orchestratorPubkey, ownerPubkey }) {
      const chat = chats.get(channelId);
      if (!chat) throw new Error("Solo chat does not exist on relay");
      const ev = chat.createEvent;
      if (ev.pubkey !== orchestratorPubkey) throw new Error("Solo chat creator mismatch");
      const hasSolo = ev.tags.some((t) => t[0] === "t" && t[1] === "buzz.solo");
      const hasOwner = ev.tags.some((t) => t[0] === "p" && t[1] === ownerPubkey);
      const hasWorker = ev.tags.some((t) => t[0] === "p" && t[1] === workerPubkey);
      if (!hasSolo || !hasOwner || !hasWorker) throw new Error("Solo chat tags invalid");
      return true;
    },
    async close() {},
  };
}

async function writeAgent(dataDir, { keypair, owner, ownerSecret, name, runner = "host", orchestrate = false, createdByTokenId }) {
  const dir = path.join(dataDir, keypair.pubkey);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const authTag = makeAuthTag(ownerSecret, owner, keypair.pubkey);
  await fs.writeFile(path.join(dir, "key"), `${keypair.secret}\n`, { mode: 0o600 });
  await fs.writeFile(path.join(dir, "auth.json"), JSON.stringify(authTag), { mode: 0o600 });
  await fs.writeFile(
    path.join(dir, "meta.json"),
    JSON.stringify({
      pubkey: keypair.pubkey,
      name,
      owner,
      community: "wss://relay.example.test",
      runtime: "claude",
      runner,
      concurrency: 4,
      activated: true,
      orchestrate,
      ...(createdByTokenId ? { createdByTokenId } : {}),
    }),
  );
  return { pubkey: keypair.pubkey, authTag };
}

async function setupTwoHosts(t, { access = "host", maxConcurrency = 2, leaseMs = 60_000, workspaces = [] } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "buzz-xdelegate-"));

  const owner = genKeypair();
  const otherOwner = genKeypair();
  const orchAgent = genKeypair();
  const workerHost = genKeypair();
  const workerDocker = genKeypair();
  const guestAgent = genKeypair();

  const machineA = randomUUID();
  const machineB = randomUUID();
  const relay = createFakeSharedRelay();

  const dirA = path.join(root, "host-a");
  const dirB = path.join(root, "host-b");
  const dataA = path.join(dirA, "agents");
  const dataB = path.join(dirB, "agents");
  const workB = path.join(dirB, "work");
  const cfgB = path.join(dirB, "config");
  const allowedExtraWs = path.join(dirB, "projects", "repo1");
  await fs.mkdir(allowedExtraWs, { recursive: true });
  await fs.mkdir(cfgB, { recursive: true });

  await writeAgent(dataA, {
    keypair: orchAgent,
    owner: owner.pubkey,
    ownerSecret: owner.secret,
    name: "Conductor",
    orchestrate: true,
  });
  const parentChat = randomUUID();
  const originEventId = bytesToHex(randomBytes(32));
  await fs.writeFile(
    path.join(dataA, orchAgent.pubkey, "turn-authors.json"),
    JSON.stringify({ [parentChat]: { author: owner.pubkey, eventId: originEventId, at: Date.now() } }),
  );

  await writeAgent(dataB, {
    keypair: workerHost,
    owner: owner.pubkey,
    ownerSecret: owner.secret,
    name: "M1Host",
    runner: "host",
  });
  await writeAgent(dataB, {
    keypair: workerDocker,
    owner: owner.pubkey,
    ownerSecret: owner.secret,
    name: "M1Box",
    runner: "docker",
  });
  await writeAgent(dataB, {
    keypair: guestAgent,
    owner: owner.pubkey,
    ownerSecret: owner.secret,
    name: "GuestBox",
    runner: "docker",
    createdByTokenId: "tok_999999999999",
  });

  // Host B token store + delegate executor + WebSocket server.
  const tokenStoreB = createTokenStore({ filePath: path.join(dirB, "tokens.json") });
  const wakesB = [];
  const cancelsB = [];
  const socketsB = new Map(); // tokenId -> Set<socket>
  const allServerSockets = new Set();

  let serverUrlB = "";
  let executorB;
  const makeExecutorB = () =>
    createDelegateExecutor({
      dataDir: dataB,
      stateDir: path.join(dirB, "delegate"),
      workDir: workB,
      runDir: path.join(dirB, "run"),
      configDir: cfgB,
      homeDir: dirB,
      machineId: machineB,
      config: () => ({ machineName: "m1", publicGuestUrl: serverUrlB }),
      tokenStore: tokenStoreB,
      readRoutesFn: async () => [{ type: "wss", url: serverUrlB }],
      verifySoloChat: (p) => relay.verifySoloChat(p),
      wakeWorker: async (req) => {
        wakesB.push(req);
        return { id: req.wakeId, path: "" };
      },
      cancelWorker: async (pk, ch) => {
        cancelsB.push({ workerPubkey: pk, channelId: ch });
        return { cancelled: true };
      },
      leaseMs,
      checkShimAccess: false,
      log: { log: () => {}, warn: () => {}, error: () => {} },
    });

  executorB = makeExecutorB();
  await executorB.start();

  const httpServerB = createServer((req, res) => {
    res.writeHead(200);
    res.end("ok\n");
  });
  httpServerB.on("upgrade", (req, socket) => {
    allServerSockets.add(socket);
    socket.on("close", () => allServerSockets.delete(socket));
    const key = req.headers["sec-websocket-key"];
    const accept = createHash("sha1").update(key + GUID).digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const session = { authenticated: false, role: "guest", tokenId: null };
    let delegateSend = null;
    const send = attachWs(socket, async (text, replySend) => {
      let id;
      try {
        const msg = JSON.parse(text);
        id = msg.id;
        const m = msg.method;
        const params = msg.params ?? {};
        if (m === "auth") {
          const rec = await tokenStoreB.verify(params.token);
          if (!rec) throw new Error("Invalid or revoked access token");
          session.authenticated = true;
          session.role = rec.role;
          session.tokenId = rec.id;
          session.ownerPubkey = rec.ownerPubkey;
          let set = socketsB.get(rec.id);
          if (!set) socketsB.set(rec.id, (set = new Set()));
          set.add(socket);
          if (rec.role === "delegate") {
            delegateSend = replySend;
            executorB.registerSocket(rec.id, replySend);
          }
          replySend(JSON.stringify({ id, result: { role: rec.role, tokenId: rec.id } }));
          return;
        }
        assertMethodAllowed(session, m);
        const handler = executorB.methods[m];
        if (!handler) throw new Error(`Unknown method ${m}`);
        const result = await handler({}, params, session);
        replySend(JSON.stringify({ id, result }));
      } catch (err) {
        replySend(JSON.stringify({ id, error: String(err.message ?? err) }));
      }
    });
    socket.on("close", () => {
      if (session.tokenId) {
        socketsB.get(session.tokenId)?.delete(socket);
        if (delegateSend) executorB.unregisterSocket(session.tokenId, delegateSend);
      }
    });
    void send;
  });

  await new Promise((resolve) => httpServerB.listen(0, "127.0.0.1", resolve));
  const portB = httpServerB.address().port;
  serverUrlB = `ws://127.0.0.1:${portB}`;

  // Mint delegate token on B and install link on A.
  const minted = await tokenStoreB.createDelegate({
    label: "from omarchy",
    ownerPubkey: owner.pubkey,
    peerMachineId: machineA,
    agents: "all",
    allowedRuntimes: ["claude", "codex"],
    access,
    workspaces,
    maxConcurrency,
  });

  let orchA;
  const linkManagerA = createLinkManager({
    filePath: path.join(dirA, "links.json"),
    reconnectMinMs: 40,
    reconnectMaxMs: 120,
    onDelegateEvent: (linkId, evt) => orchA?.handleDelegateEvent(linkId, evt),
    onLinkDisconnect: (linkId) => orchA?.handleLinkDisconnect(linkId),
    onLinkReconnect: (linkId) => void orchA?.handleLinkReconnect(linkId),
    onLinkRevoked: (link, reason) => void orchA?.handleLinkRevoked(link, reason),
    log: { log: () => {}, warn: () => {}, error: () => {} },
  });

  const blob = encodeLinkBlob({
    machineId: machineB,
    name: "m1",
    routes: [{ type: "wss", url: serverUrlB }],
    token: minted.token,
  });
  const { link } = await linkManagerA.add({ blob });

  orchA = createOrchestrator({
    dataDir: dataA,
    stateDir: path.join(dirA, "orchestrator"),
    machineId: machineA,
    links: linkManagerA,
    relay,
    limits: { cancelGraceMs: 120, defaultTimeoutMs: 5_000, minTimeoutMs: 100, catalogBudgetMs: 2_000 },
    log: { log: () => {}, warn: () => {}, error: () => {} },
  });

  t.after(async () => {
    await orchA.close();
    await linkManagerA.close();
    await executorB.close();
    for (const s of allServerSockets) s.destroy();
    allServerSockets.clear();
    httpServerB.closeAllConnections?.();
    await new Promise((r) => httpServerB.close(r));
    await fs.rm(root, { recursive: true, force: true });
  });

  return {
    root,
    dirA,
    dirB,
    dataA,
    dataB,
    workB,
    cfgB,
    allowedExtraWs,
    owner,
    otherOwner,
    orchAgent,
    workerHost,
    workerDocker,
    guestAgent,
    machineA,
    machineB,
    parentChat,
    relay,
    tokenStoreB,
    minted,
    wakesB,
    cancelsB,
    socketsB,
    serverUrlB,
    link,
    linkManagerA,
    orchA,
    getExecutorB: () => executorB,
    restartExecutorB: async () => {
      await executorB.close();
      for (const set of socketsB.values()) {
        for (const s of set) s.destroy();
      }
      socketsB.clear();
      executorB = makeExecutorB();
      await executorB.start();
      return executorB;
    },
    dropAllSocketsB: () => {
      for (const set of socketsB.values()) {
        for (const s of set) s.destroy();
      }
      socketsB.clear();
    },
    callA: async (name, args = {}) =>
      JSON.parse(await orchA.call(orchAgent.pubkey, name, { chat: parentChat, cwd: dirA, ...args })),
  };
}

// ---------- tests ----------

test("two-host delegate, steer, and release end-to-end", async (t) => {
  const h = await setupTwoHosts(t, { access: "host", workspaces: [] });

  // 1. orch_capabilities lists m1 with both eligible agents (guest-created agent excluded!).
  const caps = await h.callA("orch_capabilities");
  assert.equal(caps.hosts.length, 1);
  assert.equal(caps.hosts[0].host, "m1");
  assert.equal(caps.hosts[0].online, true);
  assert.deepEqual(
    caps.hosts[0].agents.map((a) => a.name),
    ["M1Box", "M1Host"],
    "guest-created agent must never appear in delegate.hello",
  );
  assert.deepEqual(
    caps.hosts[0].runtimes.map((r) => r.id),
    ["claude", "codex"],
  );

  // 2. Multiple eligible agents on m1 require specifying `agent`.
  await assert.rejects(
    () => h.callA("orch_delegate", { host: "m1", runtime: "claude", prompt: "hi" }),
    /multiple eligible agents/i,
  );

  // 3. Delegate to M1Host on m1.
  const task = await h.callA("orch_delegate", {
    host: "m1",
    agent: "M1Host",
    runtime: "claude",
    prompt: "Compute 2+2",
    context: "Use arithmetic",
  });
  assert.equal(task.host.name, "m1");
  assert.equal(task.host.machineId, h.machineB);
  assert.equal(task.workerPubkey, h.workerHost.pubkey);
  assert.match(task.link, /^buzz:\/\/message\?channel=/);
  assert.equal(h.wakesB.length, 1);
  assert.match(h.wakesB[0].prompt, /<delegated-worker-task /);
  assert.match(h.wakesB[0].prompt, /Compute 2\+2/);

  // Verify B wrote chat-settings.json with noOrchestrate: true and delegatedBy.
  const cs = JSON.parse(await fs.readFile(path.join(h.dataB, h.workerHost.pubkey, "chat-settings.json"), "utf8"));
  assert.equal(cs[task.workerChannelId].noOrchestrate, true);
  assert.equal(cs[task.workerChannelId].delegatedBy, h.minted.record.id);

  // 4. B signals turn_start; A queues a steer follow-up.
  const exB = h.getExecutorB();
  assert.ok(exB.onProxyTurnEvent(h.workerHost.pubkey, "_acp_turn_start", { channel: task.workerChannelId, runtime: "claude" }));
  await h.callA("orch_steer", { taskId: task.taskId, prompt: "Also check 3+3" });

  // 5. Worker posts first reply over shared relay + B signals turn_done -> triggers follow-up wake on B.
  const waitP = h.callA("orch_wait", { taskId: task.taskId, timeoutMs: 5_000 });
  await h.relay.postMessage({ pubkey: h.workerHost.pubkey, channelId: task.workerChannelId, content: "Answer 1: 4" });
  exB.onProxyTurnEvent(h.workerHost.pubkey, "_acp_turn_done", {
    channel: task.workerChannelId,
    runtime: "claude",
    stopReason: "end_turn",
  });

  // Wait for follow-up wake to arrive on B.
  for (let i = 0; i < 40 && h.wakesB.length < 2; i++) await new Promise((r) => setTimeout(r, 25));
  assert.equal(h.wakesB.length, 2);
  assert.match(h.wakesB[1].prompt, /<delegated-worker-followup /);
  assert.match(h.wakesB[1].prompt, /Also check 3\+3/);

  // 6. Worker posts second reply + B signals turn_done -> A settles completed and releases B's slot.
  await h.relay.postMessage({ pubkey: h.workerHost.pubkey, channelId: task.workerChannelId, content: "Answer 2: 6" });
  exB.onProxyTurnEvent(h.workerHost.pubkey, "_acp_turn_done", {
    channel: task.workerChannelId,
    runtime: "claude",
    stopReason: "end_turn",
  });

  const waited = await waitP;
  assert.equal(waited.task.status, "completed");
  assert.match(waited.task.result.text, /Answer 1: 4/);
  assert.match(waited.task.result.text, /Answer 2: 6/);

  // Wait briefly for release RPC to prune chat-settings and free liveCount on B.
  for (let i = 0; i < 40 && exB.liveCount(h.minted.record.id) > 0; i++) await new Promise((r) => setTimeout(r, 25));
  assert.equal(exB.liveCount(h.minted.record.id), 0);
  const csAfter = JSON.parse(await fs.readFile(path.join(h.dataB, h.workerHost.pubkey, "chat-settings.json"), "utf8"));
  assert.equal(csAfter[task.workerChannelId], undefined);
});

test("link drop mid-task keeps worker running and delegate.sync replays missed turn_done on reconnect", async (t) => {
  const h = await setupTwoHosts(t, { access: "host" });
  const task = await h.callA("orch_delegate", {
    host: "m1",
    agent: "M1Host",
    runtime: "claude",
    prompt: "Long job",
  });
  const exB = h.getExecutorB();
  exB.onProxyTurnEvent(h.workerHost.pubkey, "_acp_turn_start", { channel: task.workerChannelId, runtime: "claude" });

  // Drop the socket between A and B while running.
  h.dropAllSocketsB();
  await new Promise((r) => setTimeout(r, 30));

  // Worker posts reply over relay and finishes turn on B while link is down.
  await h.relay.postMessage({ pubkey: h.workerHost.pubkey, channelId: task.workerChannelId, content: "Done despite drop" });
  exB.onProxyTurnEvent(h.workerHost.pubkey, "_acp_turn_done", {
    channel: task.workerChannelId,
    runtime: "claude",
    stopReason: "end_turn",
  });

  // A reconnects automatically, calls delegate.sync, replays turn_done, and settles completed!
  const waited = await h.callA("orch_wait", { taskId: task.taskId, timeoutMs: 5_000 });
  assert.equal(waited.task.status, "completed");
  assert.equal(waited.task.result.text, "Done despite drop");
  const st = await h.callA("orch_status", { taskId: task.taskId });
  assert.ok(st.task.transcript.some((e) => e.text.includes("link to m1 lost; reconnecting")));
});

test("B restart mid-task marks task interrupted and A settles interrupted after sync", async (t) => {
  const h = await setupTwoHosts(t, { access: "host" });
  const task = await h.callA("orch_delegate", {
    host: "m1",
    agent: "M1Host",
    runtime: "claude",
    prompt: "Will be interrupted",
  });
  h.getExecutorB().onProxyTurnEvent(h.workerHost.pubkey, "_acp_turn_start", { channel: task.workerChannelId });

  await h.restartExecutorB();
  const waited = await h.callA("orch_wait", { taskId: task.taskId, timeoutMs: 5_000 });
  assert.equal(waited.task.status, "interrupted");
  assert.ok(h.cancelsB.some((c) => c.channelId === task.workerChannelId));
});

test("B at maxConcurrency queues on A and dispatches once slot frees", async (t) => {
  const h = await setupTwoHosts(t, { access: "host", maxConcurrency: 1 });
  const t1 = await h.callA("orch_delegate", { host: "m1", agent: "M1Host", runtime: "claude", prompt: "First" });
  assert.equal(t1.status, "starting");

  const t2 = await h.callA("orch_delegate", { host: "m1", agent: "M1Host", runtime: "claude", prompt: "Second" });
  assert.equal(t2.status, "queued");
  assert.equal(h.wakesB.length, 1);

  // Finish t1 -> t2 should automatically start on B.
  const exB = h.getExecutorB();
  await h.relay.postMessage({ pubkey: h.workerHost.pubkey, channelId: t1.workerChannelId, content: "One" });
  exB.onProxyTurnEvent(h.workerHost.pubkey, "_acp_turn_done", { channel: t1.workerChannelId, stopReason: "end_turn" });

  for (let i = 0; i < 60 && h.wakesB.length < 2; i++) await new Promise((r) => setTimeout(r, 25));
  assert.equal(h.wakesB.length, 2);
  assert.match(h.wakesB[1].prompt, /Second/);
});

test("revocation cancels live tasks on B, fails queued tasks on A, and reports error in capabilities", async (t) => {
  const h = await setupTwoHosts(t, { access: "host", maxConcurrency: 1 });
  const t1 = await h.callA("orch_delegate", { host: "m1", agent: "M1Host", runtime: "claude", prompt: "Running" });
  const t2 = await h.callA("orch_delegate", { host: "m1", agent: "M1Host", runtime: "claude", prompt: "Queued" });
  assert.equal(t2.status, "queued");

  // Revoke token on B and drop access.
  await h.tokenStoreB.revoke(h.minted.record.id);
  await h.getExecutorB().dropToken(h.minted.record.id, "revoked");
  h.dropAllSocketsB();

  const w1 = await h.callA("orch_wait", { taskId: t1.taskId, timeoutMs: 5_000 });
  assert.equal(w1.task.status, "failed");
  assert.match(w1.task.error, /revoked/i);

  // Re-checking capabilities notices revocation and fails queued t2.
  const caps = await h.callA("orch_capabilities");
  assert.equal(caps.hosts[0].online, false);
  assert.equal(caps.hosts[0].error, "revoked");

  const w2 = await h.callA("orch_wait", { taskId: t2.taskId, timeoutMs: 5_000 });
  assert.equal(w2.task.status, "failed");
});

test("cancel sends delegate.cancel on B and per-host auth failure does not pollute local runtime", async (t) => {
  const h = await setupTwoHosts(t, { access: "host" });

  // Cancel test.
  const t1 = await h.callA("orch_delegate", { host: "m1", agent: "M1Host", runtime: "claude", prompt: "Cancel me" });
  const cancelP = h.callA("orch_cancel", { taskId: t1.taskId });
  for (let i = 0; i < 40 && h.cancelsB.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(h.cancelsB.some((c) => c.channelId === t1.workerChannelId));
  h.getExecutorB().onProxyTurnEvent(h.workerHost.pubkey, "_acp_turn_done", {
    channel: t1.workerChannelId,
    stopReason: "cancelled",
  });
  const cancelled = await cancelP;
  assert.equal(cancelled.status, "cancelled");

  // Auth error on B's codex must NOT mark A's local codex unavailable!
  const t2 = await h.callA("orch_delegate", { host: "m1", agent: "M1Host", runtime: "codex", prompt: "Auth fail" });
  h.getExecutorB().onProxyTurnEvent(h.workerHost.pubkey, "_acp_turn_done", {
    channel: t2.workerChannelId,
    runtime: "codex",
    error: "Authentication required",
  });
  const w2 = await h.callA("orch_wait", { taskId: t2.taskId, timeoutMs: 5_000 });
  assert.equal(w2.task.status, "failed");

  const caps = await h.callA("orch_capabilities");
  const localCodex = caps.runtimes.find((r) => r.id === "codex");
  const remoteCodex = caps.hosts[0].runtimes.find((r) => r.id === "codex");
  assert.equal(localCodex.available, true, "local runtime must remain available");
  assert.equal(remoteCodex.available, false, "remote runtime on m1 should be marked unavailable");
});

test("security: sandboxed access, workspace realpath jail, auth event verification, and cross-token isolation", async (t) => {
  // 1. access: "sandboxed" hides host-runner workers and defaults to the single Docker worker.
  const h = await setupTwoHosts(t, { access: "sandboxed", workspaces: ["~/projects"] });
  const caps = await h.callA("orch_capabilities");
  assert.deepEqual(
    caps.hosts[0].agents.map((a) => a.name),
    ["M1Box"],
    "sandboxed delegate token must expose only Docker-runner agents",
  );

  // Attempting to specify the host-runner agent is refused.
  await assert.rejects(
    () => h.callA("orch_delegate", { host: "m1", agent: h.workerHost.pubkey, runtime: "claude", prompt: "nope" }),
    /not eligible/i,
  );

  // Workspace inside allowed prefix succeeds; outside or symlink escape is refused.
  const okTask = await h.callA("orch_delegate", {
    host: "m1",
    runtime: "claude",
    prompt: "Allowed ws",
    workspace: h.allowedExtraWs,
  });
  assert.equal(okTask.workspace, await fs.realpath(h.allowedExtraWs));
  await h.callA("orch_cancel", { taskId: okTask.taskId });

  const outsideDir = path.join(h.dirB, "outside-secret");
  await fs.mkdir(outsideDir, { recursive: true });
  await assert.rejects(
    () => h.callA("orch_delegate", { host: "m1", runtime: "claude", prompt: "bad ws", workspace: outsideDir }),
    /outside the allowed directories/i,
  );

  // Symlink inside allowed prefix pointing into forbidden buzz-sandboxes or outside is rejected!
  const sandboxDir = path.join(h.dirB, "buzz-sandboxes", "friend1");
  await fs.mkdir(sandboxDir, { recursive: true });
  const escapeLink = path.join(h.allowedExtraWs, "escape-link");
  await fs.symlink(sandboxDir, escapeLink);
  await assert.rejects(
    () =>
      resolveDelegateWorkspace({
        requested: escapeLink,
        workerPubkey: h.workerDocker.pubkey,
        workDir: h.workB,
        allowedPrefixes: [path.join(h.dirB, "projects")],
        forbiddenDirs: [path.join(h.dirB, "buzz-sandboxes"), h.dataB, h.cfgB],
        homeDir: h.dirB,
      }),
    /forbidden host directory/i,
  );

  // 2. Auth event negative checks: tampered, stale, replayed, wrong owner, wrong machine.
  const ref = `${h.machineA}:task-sec-1`;
  const ch = randomUUID();
  const authTag = makeAuthTag(h.owner.secret, h.owner.pubkey, h.orchAgent.pubkey);
  const validEv = buildDelegateAuthEvent({
    secretKey: h.orchAgent.secret,
    authTag,
    targetMachineId: h.machineB,
    ref,
    channelId: ch,
    workerPubkey: h.workerDocker.pubkey,
  });
  const cache = new Map();
  verifyDelegateAuthEvent({
    event: validEv,
    targetMachineId: h.machineB,
    expectedOwnerPubkey: h.owner.pubkey,
    ref,
    channelId: ch,
    workerPubkey: h.workerDocker.pubkey,
    replayCache: cache,
  });
  // Replay must fail!
  assert.throws(
    () =>
      verifyDelegateAuthEvent({
        event: validEv,
        targetMachineId: h.machineB,
        expectedOwnerPubkey: h.owner.pubkey,
        ref,
        channelId: ch,
        workerPubkey: h.workerDocker.pubkey,
        replayCache: cache,
      }),
    /Replayed/,
  );
  // Stale timestamp (>120s) fails.
  const staleEv = buildDelegateAuthEvent({
    secretKey: h.orchAgent.secret,
    authTag,
    targetMachineId: h.machineB,
    ref,
    channelId: ch,
    workerPubkey: h.workerDocker.pubkey,
    created_at: Math.floor(Date.now() / 1000) - 300,
  });
  assert.throws(
    () =>
      verifyDelegateAuthEvent({
        event: staleEv,
        targetMachineId: h.machineB,
        expectedOwnerPubkey: h.owner.pubkey,
        ref,
        channelId: ch,
        workerPubkey: h.workerDocker.pubkey,
      }),
    /outside ±120s/,
  );
  // Wrong owner attestation fails.
  assert.throws(
    () =>
      verifyDelegateAuthEvent({
        event: validEv,
        targetMachineId: h.machineB,
        expectedOwnerPubkey: h.otherOwner.pubkey,
        ref,
        channelId: ch,
        workerPubkey: h.workerDocker.pubkey,
      }),
    /owner does not match/,
  );
  // Tampered signature fails.
  assert.throws(
    () =>
      verifyDelegateAuthEvent({
        event: { ...validEv, content: "tampered" },
        targetMachineId: h.machineB,
        expectedOwnerPubkey: h.owner.pubkey,
        ref,
        channelId: ch,
        workerPubkey: h.workerDocker.pubkey,
      }),
    /signature/,
  );

  // 3. Route validation rejects non-loopback ws:// and iroh node id mismatch.
  assert.throws(() => validateRoutes([{ type: "wss", url: "ws://192.168.1.50:8467" }]), /Insecure ws:\/\//);
  assert.doesNotThrow(() => validateRoutes([{ type: "wss", url: "wss://m1.example.com/_buzz-host" }]));
  assert.throws(
    () =>
      decodeLinkBlob(
        encodeLinkBlob({
          machineId: h.machineB,
          name: "m1",
          routes: [{ type: "iroh", nodeId: "nodeA", endpointAddr: "addrA" }],
          irohNodeId: "nodeA",
          token: h.minted.token,
        }) + "corrupted",
      ),
    /Invalid link blob/,
  );
});

test("CLI round-trip: create-delegate prints pairing blob, links CLI adds/lists/tests/updates/removes", async (t) => {
  const h = await setupTwoHosts(t, { access: "host" });
  const out = [];
  const err = [];
  const io = { out: (l) => out.push(l), err: (l) => err.push(l) };

  // 1. Mint delegate token via tokens-cli.mjs
  const code1 = await runTokens(
    [
      "create-delegate",
      "--label",
      "cli-link",
      "--owner",
      h.owner.pubkey,
      "--access",
      "host",
      "--runtimes",
      "claude,codex",
      "--expires",
      "30d",
      "--url",
      h.serverUrlB,
      "--json",
    ],
    {
      tokensFile: path.join(h.dirB, "tokens.json"),
      configFile: path.join(h.dirB, "config.json"),
      machineIdFile: path.join(h.dirB, "machine-id"),
      runDir: path.join(h.dirB, "run-empty"),
      ...io,
    },
  );
  assert.equal(code1, 0, err.join("\n"));
  const minted = JSON.parse(out.join("\n"));
  assert.match(minted.token, /^bhd_[0-9a-f]{48}$/);
  assert.match(minted.pairingBlob, /^buzz-host-link:v1:/);
  assert.equal(isTokenExpired(minted.record), false);

  // Overwrite machineId in blob to match running host B's machineId for live test.
  const blobForB = encodeLinkBlob({
    machineId: h.machineB,
    name: "m1-cli",
    routes: [{ type: "wss", url: h.serverUrlB }],
    token: minted.token,
  });

  const linksFile = path.join(h.dirA, "cli-links.json");
  const runL = async (argv) => {
    const o = [];
    const e = [];
    const code = await runLinks(argv, { linksFile, configFile: path.join(h.dirA, "none.json"), out: (l) => o.push(l), err: (l) => e.push(l) });
    return { code, out: o.join("\n"), err: e.join("\n") };
  };

  const added = await runL(["add", blobForB, "--json"]);
  assert.equal(added.code, 0, added.err);
  const addJson = JSON.parse(added.out);
  assert.equal(addJson.link.name, "m1-cli");
  assert.equal(addJson.link.token, undefined, "links output must never leak bearer secret");

  const listed = await runL(["list", "--json"]);
  assert.equal(listed.code, 0, listed.err);
  assert.equal(JSON.parse(listed.out).links.length, 1);
  assert.ok(!listed.out.includes(minted.token), "list must never include token secret");

  const tested = await runL(["test", "m1-cli", "--json"]);
  assert.equal(tested.code, 0, tested.err);
  const testJson = JSON.parse(tested.out);
  assert.equal(testJson.ok, true);
  assert.equal(testJson.hello.machineId, h.machineB);

  const updated = await runL(["update", "m1-cli", "--name", "m1-renamed", "--json"]);
  assert.equal(updated.code, 0, updated.err);
  assert.equal(JSON.parse(updated.out).link.name, "m1-renamed");

  const removed = await runL(["remove", "m1-renamed", "--json"]);
  assert.equal(removed.code, 0, removed.err);
  assert.equal(JSON.parse((await runL(["list", "--json"])).out).links.length, 0);
});

test("security: cross-token isolation on B and fail-fast when remote host is offline", async (t) => {
  const h = await setupTwoHosts(t, { access: "host" });
  const t1 = await h.callA("orch_delegate", { host: "m1", agent: "M1Host", runtime: "claude", prompt: "Owned by tok1" });

  // Mint a second delegate token for the same owner and try to touch t1's ref.
  const tok2 = await h.tokenStoreB.createDelegate({
    label: "other-peer",
    ownerPubkey: h.owner.pubkey,
    access: "host",
  });
  const exB = h.getExecutorB();
  const sess2 = { authenticated: true, role: "delegate", tokenId: tok2.record.id, ownerPubkey: h.owner.pubkey };
  await assert.rejects(() => exB.methods["delegate.cancel"]({}, { ref: t1.remoteRef }, sess2), /not found/);
  await assert.rejects(() => exB.methods["delegate.followup"]({}, { ref: t1.remoteRef, prompt: "hijack" }, sess2), /not active/);
  const sync2 = await exB.methods["delegate.sync"]({}, { refs: [t1.remoteRef] }, sess2);
  assert.equal(sync2.tasks[0].phase, "unknown");

  // Offline host fails fast on orch_delegate without queuing.
  const deadLink = await h.linkManagerA.add({
    blob: encodeLinkBlob({
      machineId: randomUUID(),
      name: "deadbox",
      routes: [{ type: "wss", url: "ws://127.0.0.1:1" }],
      token: tok2.token,
    }),
  });
  assert.equal(deadLink.link.name, "deadbox");
  await assert.rejects(
    () => h.callA("orch_delegate", { host: "deadbox", runtime: "claude", prompt: "hello?" }),
    /unreachable/i,
  );
  const listed = await h.callA("orch_list", { status: "queued" });
  assert.equal(listed.tasks.length, 0, "offline host must fail fast, not queue");
});
