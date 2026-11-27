// buzz-host machine discovery: tells each owner, over their own community
// relay, that this machine exists and how to reach it.
//
// For every (relay, owner) pair that has an owner-authorized agent here, one
// of those agents (the publisher) logs in to the relay (NIP-42, with its NIP-OA
// owner tag, as attention-relay.mjs does) and publishes a kind 30003
// parameterized-replaceable event, d = "buzz-host:<machineId>". Its content is
// the machine's status JSON, NIP-44 v2 encrypted to the owner, so only the
// owner's Buzz can read which machine, routes and agents it describes.
//
// Published on start, every `intervalMs` (45 s), soon after notifyChanged()
// (agents added, removed or renamed; a new iroh address), and once more with
// status "stopped" on stop(). Never throws into buzz-host: a relay that is
// down is retried with backoff, and a host with no authorized agents simply
// publishes nothing.
//
// Zero-agent discovery: the machine has its own Nostr key (machine-key, 0600).
// When config.json names an owner (`ownerPubkey`), their relays
// (`discoveryRelays`) and the owner's NIP-OA attestation of the machine key
// (`ownerAuth`), the machine key publishes for every such relay that no agent
// of that owner already publishes to. The owner's Buzz only accepts a status
// signed by a key the owner attested, so the owner and relay alone are not
// enough: `buzz-host up --owner-proof` or the admin RPC `machine.attest`
// supplies the attestation.

import fs from "node:fs/promises";
import { watch } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { schnorr, sha256, bytesToHex, hexToBytes } from "./noble.mjs";
import { encrypt, getConversationKey } from "./nip44.mjs";
import { signEvent } from "./attention-relay.mjs";

export const STATUS_KIND = 30003;
export const STATUS_K = "buzz-host-status";
export const IROH_ADDR_FILE = "iroh-addr.json";
const HEX64 = /^[0-9a-f]{64}$/;
const SIG = /^[0-9a-f]{128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DEFAULT_INTERVAL_MS = 45_000;
const DEBOUNCE_MS = 250;
const AUTH_WAIT_MS = 5_000;
const PUBLISH_TIMEOUT_MS = 10_000;
const STOP_TIMEOUT_MS = 3_000;
const BACKOFF_MIN_MS = 5_000;
const BACKOFF_MAX_MS = 5 * 60_000;
const MAX_ROUTE_FIELD = 4_096;

// ---------- machine id ----------

/** This machine's stable id: `configured` when it is a UUID, else the one
 * saved in `file`, else a new UUIDv4 saved there (0644: an id, not a secret).
 * A file that cannot be written still yields an id, for this run only. */
export async function loadMachineId({ file, configured, log = console } = {}) {
  if (typeof configured === "string" && UUID.test(configured.trim().toLowerCase()))
    return configured.trim().toLowerCase();
  try {
    const saved = (await fs.readFile(file, "utf8")).trim().toLowerCase();
    if (UUID.test(saved)) return saved;
  } catch (error) {
    if (error.code !== "ENOENT") log.warn(`discovery: machine id not read (${error.message})`);
  }
  const id = randomUUID();
  try {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, `${id}\n`, { mode: 0o644 });
    // Enforce 0644 even under strict service umasks (e.g. UMask=0077).
    await fs.chmod(tmp, 0o644);
    await fs.rename(tmp, file);
  } catch (error) {
    log.warn(`discovery: machine id not saved (${error.message}); using ${id} for this run`);
  }
  return id;
}

/** The name the owner sees: config.machineName, else the hostname's first label. */
export function machineName(configured, hostname = os.hostname()) {
  if (typeof configured === "string" && configured.trim()) return configured.trim().slice(0, 100);
  return hostname.split(".")[0] || hostname;
}

/** This machine's Nostr key: the hex secret saved in `file` (0600), else a
 * new one saved there. `create: false` returns null instead of creating one. */
export async function loadMachineKey({ file, create = true } = {}) {
  try {
    const key = (await fs.readFile(file, "utf8")).trim().toLowerCase();
    if (HEX64.test(key)) return { key, pubkey: bytesToHex(schnorr.getPublicKey(hexToBytes(key))) };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!create) return null;
  const key = bytesToHex(schnorr.utils.randomSecretKey());
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, `${key}\n`, { mode: 0o600 });
  await fs.chmod(tmp, 0o600);
  await fs.rename(tmp, file);
  return { key, pubkey: bytesToHex(schnorr.getPublicKey(hexToBytes(key))) };
}

const BECH32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

/** A hex pubkey from 64 hex digits or an `npub1…`; throws on anything else. */
export function parsePubkey(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (HEX64.test(text)) return text;
  const sep = text.lastIndexOf("1");
  if (text.startsWith("npub1") && sep === 4 && text.length === 63) {
    const data = [...text.slice(5)].map((c) => BECH32.indexOf(c));
    if (!data.includes(-1)) {
      const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
      let chk = 1;
      for (const v of [..."npub"].map((c) => c.charCodeAt(0) >> 5).concat([0], [..."npub"].map((c) => c.charCodeAt(0) & 31), data)) {
        const top = chk >> 25;
        chk = ((chk & 0x1ffffff) << 5) ^ v;
        for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= GEN[i];
      }
      if (chk === 1) {
        let acc = 0;
        let bits = 0;
        const bytes = [];
        for (const v of data.slice(0, -6)) {
          acc = (acc << 5) | v;
          bits += 5;
          while (bits >= 8) {
            bits -= 8;
            bytes.push((acc >> bits) & 0xff);
          }
        }
        if (bytes.length === 32) return bytesToHex(Uint8Array.from(bytes));
      }
    }
  }
  throw new Error(`not a Nostr public key (npub1… or 64 hex digits): ${String(value).slice(0, 80)}`);
}

/** The relays config.json lists for discovery: wss:// (or ws://) URLs, deduplicated. */
export function discoveryRelays(config) {
  const list = Array.isArray(config?.discoveryRelays) ? config.discoveryRelays : [];
  return [...new Set(list.filter((u) => typeof u === "string" && /^wss?:\/\/[^\s#]+$/.test(u.trim())).map((u) => u.trim()))];
}

/**
 * The owner config.json names for this machine and whether they attested the
 * machine key: { ownerPubkey, relays, authTag, attested }, or null without an
 * owner. `authTag` is set only when it is a valid NIP-OA attestation of
 * `machinePubkey` by that owner.
 */
export function configuredOwner(config, machinePubkey) {
  let ownerPubkey;
  try {
    ownerPubkey = config?.ownerPubkey ? parsePubkey(config.ownerPubkey) : null;
  } catch {
    ownerPubkey = null;
  }
  if (!ownerPubkey) return null;
  const auth = config.ownerAuth;
  const attested =
    Boolean(machinePubkey) && Array.isArray(auth) && auth[1] === ownerPubkey && validAuthTag(machinePubkey, auth);
  return { ownerPubkey, relays: discoveryRelays(config), authTag: attested ? [...auth] : null, attested };
}

/** Parse an owner proof: the JSON `["auth", owner, "", sig]` Buzz's Security
 * settings print, checked against `machinePubkey`. Throws with a reason. */
export function parseOwnerProof(text, machinePubkey) {
  let auth;
  try {
    auth = typeof text === "string" ? JSON.parse(text) : text;
  } catch {
    throw new Error('owner proof must be the JSON Buzz prints: ["auth","<owner>","","<signature>"]');
  }
  if (!Array.isArray(auth) || auth[0] !== "auth" || auth.length !== 4)
    throw new Error('owner proof must be the JSON Buzz prints: ["auth","<owner>","","<signature>"]');
  if (auth[2] !== "") throw new Error("owner proof must be unconditional (empty conditions)");
  if (!validAuthTag(machinePubkey, auth))
    throw new Error(`owner proof does not attest this machine's key (${machinePubkey}); authorize that key in Buzz`);
  return auth;
}

// ---------- owners and their agents ----------

/** True when `authTag` is `["auth", owner, "", sig]` with sig the owner's
 * NIP-OA attestation of `agentPubkey` (unconditional). */
export function validAuthTag(agentPubkey, authTag) {
  if (
    !Array.isArray(authTag) ||
    authTag.length !== 4 ||
    authTag[0] !== "auth" ||
    !HEX64.test(authTag[1]) ||
    authTag[2] !== "" ||
    !SIG.test(authTag[3])
  )
    return false;
  try {
    const digest = sha256(new TextEncoder().encode(`nostr:agent-auth:${agentPubkey}:`));
    return schnorr.verify(hexToBytes(authTag[3]), digest, hexToBytes(authTag[1]));
  } catch {
    return false;
  }
}

/** The owner-authorized agents in `dataDir` (`<pubkey>/{meta.json,key,auth.json}`),
 * sorted by pubkey. Agents without a key, a valid attestation, or whose meta
 * names a different owner are left out. */
export async function readAuthorizedAgents(dataDir, log = console) {
  const names = (await fs.readdir(dataDir).catch(() => [])).filter((n) => HEX64.test(n)).sort();
  const agents = [];
  for (const pubkey of names) {
    const dir = path.join(dataDir, pubkey);
    try {
      const [metaText, keyText, authText] = await Promise.all([
        fs.readFile(path.join(dir, "meta.json"), "utf8"),
        fs.readFile(path.join(dir, "key"), "utf8"),
        fs.readFile(path.join(dir, "auth.json"), "utf8"),
      ]);
      const meta = JSON.parse(metaText);
      const authTag = JSON.parse(authText);
      const key = keyText.trim();
      if (!HEX64.test(key) || !validAuthTag(pubkey, authTag)) continue;
      if (meta.owner && meta.owner !== authTag[1]) continue;
      if (typeof meta.community !== "string" || !/^wss?:\/\//.test(meta.community)) continue;
      if (bytesToHex(schnorr.getPublicKey(hexToBytes(key))) !== pubkey) {
        log.warn(`discovery: ${pubkey.slice(0, 8)}: key does not match its pubkey; skipped`);
        continue;
      }
      agents.push({
        pubkey,
        name: typeof meta.name === "string" ? meta.name.trim() : "",
        relayUrl: meta.community,
        ownerPubkey: authTag[1],
        key,
        authTag,
      });
    } catch (error) {
      if (error.code !== "ENOENT") log.warn(`discovery: ${pubkey.slice(0, 8)}: skipped (${error.message})`);
    }
  }
  return agents;
}

/** One publish target per (relay, owner): the first agent there (by pubkey)
 * publishes, and the event lists all of that owner's agents on this host.
 * `machine` ({ key, pubkey, owner: configuredOwner(...) }) adds a target per
 * configured relay of an attested owner that no agent of theirs covers; the
 * machine key publishes those, listing that owner's agents (maybe none). */
export function groupByOwner(agents, machine = null) {
  const byOwner = new Map();
  for (const agent of agents) {
    if (!byOwner.has(agent.ownerPubkey)) byOwner.set(agent.ownerPubkey, []);
    byOwner.get(agent.ownerPubkey).push(
      agent.name ? { pubkey: agent.pubkey, name: agent.name } : { pubkey: agent.pubkey },
    );
  }
  const groups = new Map();
  for (const agent of agents) {
    const id = `${agent.relayUrl}\n${agent.ownerPubkey}`;
    if (groups.has(id)) continue;
    groups.set(id, {
      id,
      relayUrl: agent.relayUrl,
      ownerPubkey: agent.ownerPubkey,
      publisher: { pubkey: agent.pubkey, key: agent.key, authTag: agent.authTag },
      agents: byOwner.get(agent.ownerPubkey),
    });
  }
  const owner = machine?.owner;
  if (machine?.key && owner?.attested) {
    for (const relayUrl of owner.relays) {
      const id = `${relayUrl}\n${owner.ownerPubkey}`;
      if (groups.has(id)) continue;
      groups.set(id, {
        id,
        relayUrl,
        ownerPubkey: owner.ownerPubkey,
        publisher: { pubkey: machine.pubkey, key: machine.key, authTag: owner.authTag },
        agents: byOwner.get(owner.ownerPubkey) ?? [],
      });
    }
  }
  return groups;
}

// ---------- routes ----------

const routeField = (value) => typeof value === "string" && value.length > 0 && value.length <= MAX_ROUTE_FIELD;

/** The live iroh address `$RUN_DIR/iroh-addr.json` holds, or null. */
export async function readIrohAddr(runDir) {
  try {
    const value = JSON.parse(await fs.readFile(path.join(runDir, IROH_ADDR_FILE), "utf8"));
    if (!routeField(value?.nodeId) || !routeField(value?.endpointAddr)) return null;
    return { nodeId: value.nodeId, endpointAddr: value.endpointAddr };
  } catch {
    return null;
  }
}

/** Ways to reach this machine, best first: iroh, then each public wss URL. */
export async function readRoutes(runDir, { publicGuestUrl, publicUrl } = {}) {
  const routes = [];
  const iroh = await readIrohAddr(runDir);
  if (iroh) routes.push({ type: "iroh", ...iroh });
  const seen = new Set();
  for (const url of [publicGuestUrl, publicUrl]) {
    if (!routeField(url) || !/^wss?:\/\//.test(url) || seen.has(url)) continue;
    seen.add(url);
    routes.push({ type: "wss", url });
  }
  return routes;
}

// ---------- the event ----------

/** The kind 30003 status event: `payload` encrypted to the owner, signed by
 * the publisher, with the tags the contract requires. */
export function buildStatusEvent({ secretKey, ownerPubkey, authTag, machineId, payload, created_at }) {
  const conversationKey = getConversationKey(hexToBytes(secretKey), ownerPubkey);
  return signEvent(secretKey, {
    kind: STATUS_KIND,
    tags: [
      ["d", `buzz-host:${machineId}`],
      ["k", STATUS_K],
      ["p", ownerPubkey],
      authTag,
    ],
    content: encrypt(JSON.stringify(payload), conversationKey),
    created_at,
  });
}

// ---------- the publisher ----------

/**
 * @param {object} options
 * @param {string} options.dataDir  agents' directory (`<pubkey>/…`)
 * @param {string} options.runDir   where iroh-addr.json appears
 * @param {string} options.machineId
 * @param {() => object} [options.config]  current config (machineName, publicGuestUrl, publicUrl)
 * @param {() => Promise<string[]>} [options.runtimes]  installed runtime ids
 * @param {() => Promise<object>} [options.capabilities]  { desktop, docker }
 * @param {{key: string, pubkey: string}} [options.machineKey]  this machine's
 *   Nostr key; publishes for an attested config owner (see groupByOwner)
 */
export function createDiscoveryPublisher({
  dataDir,
  runDir,
  machineId,
  config = () => ({}),
  runtimes = async () => [],
  capabilities = async () => ({}),
  machineKey = null,
  intervalMs = DEFAULT_INTERVAL_MS,
  debounceMs = DEBOUNCE_MS,
  authWaitMs = AUTH_WAIT_MS,
  publishTimeoutMs = PUBLISH_TIMEOUT_MS,
  stopTimeoutMs = STOP_TIMEOUT_MS,
  backoffMinMs = BACKOFF_MIN_MS,
  backoffMaxMs = BACKOFF_MAX_MS,
  hostname = os.hostname(),
  platform = process.platform,
  WebSocketImpl = globalThis.WebSocket,
  log = console,
}) {
  /** relay + publisher pubkey → { ws, ready, backoff, retryAt, pending } */
  const connections = new Map();
  /** group id → last created_at, so a later event never ties an earlier one. */
  const lastCreatedAt = new Map();
  let groups = new Map();
  let timer;
  let debounce;
  let fileWatch;
  let running = false;
  let stopped = false;
  let closed = false;
  let chain = Promise.resolve();
  let queued = false;
  let lastAgentsKey = "";

  const connectionKey = (group) => `${group.relayUrl}\n${group.publisher.pubkey}`;

  function closeConnection(key) {
    const conn = connections.get(key);
    if (!conn) return;
    connections.delete(key);
    conn.abort?.();
    for (const waiter of conn.pending.values()) waiter(new Error("connection closed"));
    conn.pending.clear();
    try {
      conn.ws?.close();
    } catch {}
  }

  function failed(conn, why) {
    conn.retryAt = Date.now() + conn.backoff;
    conn.backoff = Math.min(conn.backoff * 2, backoffMaxMs);
    log.warn(`discovery: ${conn.relayUrl}: ${why}; retrying in ${Math.round((conn.retryAt - Date.now()) / 1000)}s`);
  }

  /** The publisher's logged-in connection to the relay (opened on demand). */
  function connection(group, { ignoreBackoff = false } = {}) {
    if (closed) return Promise.reject(new Error("publisher stopped"));
    const key = connectionKey(group);
    let conn = connections.get(key);
    if (conn?.ws && conn.ready) return conn.ready;
    if (!conn) {
      conn = { relayUrl: group.relayUrl, backoff: backoffMinMs, retryAt: 0, pending: new Map() };
      connections.set(key, conn);
    }
    if (conn.opening) return conn.opening;
    if (!ignoreBackoff && Date.now() < conn.retryAt) return Promise.reject(new Error("backing off"));
    if (!WebSocketImpl) return Promise.reject(new Error("no WebSocket implementation"));
    conn.opening = new Promise((resolve, reject) => {
      let ws;
      try {
        ws = new WebSocketImpl(group.relayUrl);
      } catch (error) {
        conn.opening = undefined;
        failed(conn, `cannot connect (${error.message})`);
        return reject(error);
      }
      conn.ws = ws;
      let authId;
      let connectTimer;
      let authTimer;
      let settled = false;
      const done = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        clearTimeout(authTimer);
        conn.abort = undefined;
        conn.opening = undefined;
        if (error) {
          if (!closed) failed(conn, error.message);
          if (conn.ws === ws) conn.ws = undefined;
          try {
            ws.close();
          } catch {}
          reject(error);
        } else {
          conn.backoff = backoffMinMs;
          conn.retryAt = 0;
          conn.ready = Promise.resolve(conn);
          resolve(conn);
        }
      };
      conn.abort = () => done(new Error("connection closed"));
      connectTimer = setTimeout(() => done(new Error("connect timed out")), publishTimeoutMs);
      connectTimer.unref?.();
      ws.addEventListener("open", () => {
        clearTimeout(connectTimer);
        // A relay that asks for no login can be written to after a short wait.
        authTimer = setTimeout(() => done(), authWaitMs);
        authTimer.unref?.();
      });
      ws.addEventListener("message", (message) => {
        let data;
        try {
          data = JSON.parse(String(message.data));
        } catch {
          return;
        }
        const [type] = data;
        if (type === "AUTH" && typeof data[1] === "string") {
          clearTimeout(authTimer);
          authTimer = setTimeout(() => done(new Error("login timed out")), publishTimeoutMs);
          authTimer.unref?.();
          const event = signEvent(group.publisher.key, {
            kind: 22242,
            tags: [["relay", group.relayUrl], ["challenge", data[1]], group.publisher.authTag],
            content: "",
          });
          authId = event.id;
          try {
            ws.send(JSON.stringify(["AUTH", event]));
          } catch (error) {
            done(error);
          }
        } else if (type === "OK" && data[1] === authId) {
          if (data[2] === true) done();
          else done(new Error(`login refused: ${data[3]}`));
        } else if (type === "OK" && conn.pending.has(data[1])) {
          const waiter = conn.pending.get(data[1]);
          conn.pending.delete(data[1]);
          waiter(data[2] === true ? null : new Error(`relay refused the status: ${data[3]}`));
        }
      });
      ws.addEventListener("close", () => {
        done(new Error("connection closed"));
        if (conn.ws !== ws) return;
        conn.ws = undefined;
        conn.ready = undefined;
        for (const waiter of conn.pending.values()) waiter(new Error("connection closed"));
        conn.pending.clear();
      });
      ws.addEventListener("error", () => {});
    });
    return conn.opening;
  }

  function send(conn, event) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        conn.pending.delete(event.id);
        reject(new Error("relay did not answer"));
      }, publishTimeoutMs);
      timeout.unref?.();
      conn.pending.set(event.id, (error) => {
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve();
      });
      try {
        conn.ws.send(JSON.stringify(["EVENT", event]));
      } catch (error) {
        conn.pending.delete(event.id);
        clearTimeout(timeout);
        reject(error);
      }
    });
  }

  async function machineInfo() {
    const cfg = config() ?? {};
    const [installed, caps, routes] = await Promise.all([
      Promise.resolve()
        .then(runtimes)
        .catch(() => []),
      Promise.resolve()
        .then(capabilities)
        .catch(() => ({})),
      readRoutes(runDir, cfg),
    ]);
    return {
      name: machineName(cfg.machineName, hostname),
      runtimes: Array.isArray(installed) ? installed : [],
      capabilities: { desktop: caps?.desktop === true, docker: caps?.docker === true },
      routes,
      publicGuestUrl: typeof cfg.publicGuestUrl === "string" && cfg.publicGuestUrl ? cfg.publicGuestUrl : null,
    };
  }

  function payloadFor(group, info, status, updatedAt) {
    return {
      v: 1,
      status,
      machineId,
      name: info.name,
      host: hostname,
      platform,
      runtimes: info.runtimes,
      capabilities: info.capabilities,
      routes: info.routes,
      agents: group.agents,
      publicGuestUrl: info.publicGuestUrl,
      updatedAt,
    };
  }

  async function publishGroup(group, info, status, connectOptions) {
    const conn = await connection(group, connectOptions);
    const now = Math.floor(Date.now() / 1000);
    const created_at = Math.max(now, (lastCreatedAt.get(group.id) ?? 0) + 1);
    lastCreatedAt.set(group.id, created_at);
    const event = buildStatusEvent({
      secretKey: group.publisher.key,
      ownerPubkey: group.ownerPubkey,
      authTag: group.publisher.authTag,
      machineId,
      payload: payloadFor(group, info, status, created_at),
      created_at,
    });
    await send(conn, event);
    return event;
  }

  /** Reads the agents again and publishes `status` to every (relay, owner). */
  async function publishAll(status = "online", connectOptions) {
    const agents = await readAuthorizedAgents(dataDir, log);
    const next = groupByOwner(
      agents,
      machineKey && { ...machineKey, owner: configuredOwner(config() ?? {}, machineKey.pubkey) },
    );
    // Connections whose publisher no longer publishes there are closed.
    const wanted = new Set([...next.values()].map(connectionKey));
    for (const key of [...connections.keys()]) if (!wanted.has(key)) closeConnection(key);
    groups = next;
    const agentsKey = JSON.stringify([...next.values()].map((g) => [g.id, g.publisher.pubkey, g.agents.length]));
    if (agentsKey !== lastAgentsKey) {
      lastAgentsKey = agentsKey;
      if (!next.size) log.log("discovery: no owner-authorized agents or attested owner; nothing to publish");
      else
        log.log(
          `discovery: publishing machine ${machineId} to ${next.size} owner relay(s): ` +
            [...next.values()].map((g) => `${g.ownerPubkey.slice(0, 8)}@${g.relayUrl} via ${g.publisher.pubkey.slice(0, 8)}`).join(", "),
        );
    }
    if (!next.size) return [];
    const info = await machineInfo();
    const results = await Promise.allSettled(
      [...next.values()].map((group) => publishGroup(group, info, status, connectOptions)),
    );
    const events = [];
    results.forEach((result, i) => {
      const group = [...next.values()][i];
      if (result.status === "fulfilled") events.push(result.value);
      else if (result.reason?.message !== "backing off")
        log.warn(`discovery: ${group.relayUrl} (owner ${group.ownerPubkey.slice(0, 8)}): ${result.reason?.message}`);
    });
    return events;
  }

  /** One publish at a time; a request during one runs once after it. */
  function schedule() {
    if (stopped) return chain;
    if (queued) return chain;
    queued = true;
    chain = chain
      .then(() => {
        queued = false;
        if (stopped) return [];
        return publishAll("online");
      })
      .catch((error) => {
        log.warn(`discovery: publish failed: ${error.message}`);
        return [];
      });
    return chain;
  }

  function notifyChanged() {
    if (!running || stopped) return;
    clearTimeout(debounce);
    debounce = setTimeout(() => void schedule(), debounceMs);
    debounce.unref?.();
  }

  function start() {
    if (running || stopped) return;
    running = true;
    timer = setInterval(() => void schedule(), intervalMs);
    timer.unref?.();
    try {
      fileWatch = watch(runDir, { persistent: false }, (_event, filename) => {
        if (!filename || String(filename) === IROH_ADDR_FILE) notifyChanged();
      });
      fileWatch.on("error", () => {});
    } catch (error) {
      log.warn(`discovery: not watching ${runDir} (${error.message}); iroh changes go out with the heartbeat`);
    }
    void schedule();
  }

  /** Publishes status "stopped" (bounded by stopTimeoutMs), then closes. */
  async function stop() {
    if (stopped) return;
    const wasRunning = running;
    stopped = true;
    running = false;
    clearInterval(timer);
    clearTimeout(debounce);
    try {
      fileWatch?.close();
    } catch {}
    if (wasRunning) {
      let bound;
      let timedOut = false;
      const final = chain
        .catch(() => {})
        .then(() => {
          if (timedOut) return;
          return publishAll("stopped", { ignoreBackoff: true });
        })
        .catch((error) => log.warn(`discovery: stopped status not published: ${error.message}`));
      await Promise.race([
        final,
        new Promise((resolve) => {
          bound = setTimeout(() => {
            timedOut = true;
            resolve();
          }, stopTimeoutMs);
          bound.unref?.();
        }),
      ]);
      clearTimeout(bound);
    }
    closed = true;
    for (const key of [...connections.keys()]) closeConnection(key);
  }

  return {
    start,
    stop,
    notifyChanged,
    /** Publishes now and resolves with the events the relays accepted. */
    publishNow: () => schedule(),
    groups: () => groups,
  };
}
