// buzz-host Attention: the relay side of event watches. For each agent with
// Attention on and at least one live event watch, one WebSocket to its
// community, logged in as the agent (NIP-42, with its NIP-OA owner tag as the
// buzz CLI sends it), subscribed to the channels and kinds its watches need.
// Each event goes to attention.watchEvent(), which applies Buzz's matching.
//
// Each (re)subscription starts at the time it is sent and counts as a new
// connection (`epoch`); the Attention service catches each watch up from its
// saved checkpoint to then with `query`, Buzz's catch-up.

import fs from "node:fs/promises";
import path from "node:path";
import { schnorr, sha256, bytesToHex, hexToBytes } from "./noble.mjs";
import { CHANNEL_KINDS, interestPaused } from "./attention-core.mjs";

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;
const AUTH_WAIT_MS = 5_000;
const SEEN_LIMIT = 2_000;
const QUERY_TIMEOUT_MS = 20_000;
/** How often an agent's channel memberships are read again. */
const MEMBERS_MAX_AGE_MS = 5 * 60_000;

/** What `record`'s live event watches need from the relay, or null. */
export function filterFor(record) {
  if (!record?.attentionEnabled) return null;
  const kinds = new Set();
  const channels = new Set();
  let all = false;
  for (const { value } of Object.values(record.attention)) {
    if (value.type !== "event" || !value.enabled || interestPaused(record.attention, value.interest_id)) continue;
    // Buzz's stream kinds for a watch of any kind, so live covers what catch-up reads.
    for (const kind of value.kinds.length ? value.kinds : CHANNEL_KINDS) kinds.add(kind);
    if (value.channels === "all") all = true;
    else for (const channel of value.channels) channels.add(channel);
  }
  if (!kinds.size) return null;
  return {
    kinds: [...kinds].sort((a, b) => a - b),
    ...(all ? {} : { "#h": [...channels].sort() }),
  };
}

/** A signed Nostr event (NIP-01) from `secretKey` (hex). */
export function signEvent(secretKey, { kind, tags, content, created_at = Math.floor(Date.now() / 1000) }) {
  const pubkey = bytesToHex(schnorr.getPublicKey(hexToBytes(secretKey)));
  const id = bytesToHex(sha256(new TextEncoder().encode(JSON.stringify([0, pubkey, created_at, kind, tags, content]))));
  const sig = bytesToHex(schnorr.sign(hexToBytes(id), hexToBytes(secretKey)));
  return { id, pubkey, created_at, kind, tags, content, sig };
}

export function createRelayWatcher({ dataDir, onEvent, onReady = () => {}, log = console }) {
  /** pubkey → connection state */
  const agents = new Map();

  async function credentials(pubkey) {
    const dir = path.join(dataDir, pubkey);
    const meta = JSON.parse(await fs.readFile(path.join(dir, "meta.json"), "utf8"));
    const key = (await fs.readFile(path.join(dir, "key"), "utf8")).trim();
    let authTag;
    try {
      authTag = JSON.parse(await fs.readFile(path.join(dir, "auth.json"), "utf8"));
    } catch {
      authTag = undefined;
    }
    return { relay: meta.community, key, authTag };
  }

  /** (Re)subscribes live from now: a new epoch, which catch-up reads up to. */
  function subscribe(pubkey, agent) {
    if (!agent.ws || agent.ws.readyState !== WebSocket.OPEN || !agent.ready) return;
    if (agent.subId) agent.ws.send(JSON.stringify(["CLOSE", agent.subId]));
    agent.subId = `att-${Math.random().toString(36).slice(2, 10)}`;
    const since = Math.floor(Date.now() / 1000);
    agent.ws.send(JSON.stringify(["REQ", agent.subId, { ...agent.filter, since }]));
    agent.subscribedKey = JSON.stringify(agent.filter);
    agent.since = since;
    agent.epoch = (agent.epoch ?? 0) + 1;
    void refreshMembers(pubkey, agent).finally(() => onReady(pubkey));
  }

  /** One read on the agent's connection: the events of `filter` up to EOSE. */
  function query(pubkey, filter, timeoutMs = QUERY_TIMEOUT_MS) {
    const agent = agents.get(pubkey);
    if (!agent?.ws || !agent.ready || agent.ws.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error("not connected"));
    const id = `q-${Math.random().toString(36).slice(2, 10)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error("relay read timed out")), timeoutMs);
      const finish = (error) => {
        clearTimeout(timer);
        agent.queries.delete(id);
        try {
          agent.ws?.send(JSON.stringify(["CLOSE", id]));
        } catch {}
        if (error) reject(error);
        else resolve(entry.events);
      };
      const entry = { events: [], finish };
      agent.queries.set(id, entry);
      agent.ws.send(JSON.stringify(["REQ", id, filter]));
    });
  }

  /** The channels the agent is a member of (NIP-29 kind 39002 lists). */
  async function refreshMembers(pubkey, agent) {
    try {
      const lists = await query(pubkey, { kinds: [39002], "#p": [pubkey], limit: 500 });
      agent.members = new Set(
        lists
          .filter((event) => event.tags.some(([k, v]) => k === "p" && v === pubkey))
          .map((event) => event.tags.find(([k]) => k === "d")?.[1])
          .filter(Boolean),
      );
      agent.membersAt = Date.now();
    } catch (error) {
      log.warn(`attention-relay: ${pubkey.slice(0, 8)}: memberships not read: ${error.message}`);
    }
  }

  function connect(pubkey, agent) {
    if (agent.closed) return;
    clearTimeout(agent.retry);
    void (async () => {
      let creds;
      try {
        creds = await credentials(pubkey);
      } catch (error) {
        log.warn(`attention-relay: ${pubkey.slice(0, 8)}: no credentials (${error.message})`);
        return;
      }
      if (agent.closed) return;
      const ws = new WebSocket(creds.relay);
      agent.ws = ws;
      agent.ready = false;
      agent.subId = undefined;
      let authTimer;
      const ready = () => {
        clearTimeout(authTimer);
        if (agent.ready) return;
        agent.ready = true;
        agent.backoff = RECONNECT_MIN_MS;
        subscribe(pubkey, agent);
      };
      agent.queries = new Map();
      ws.addEventListener("open", () => {
        // A relay that asks for no login gets the subscription after a wait.
        authTimer = setTimeout(ready, AUTH_WAIT_MS);
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
          const tags = [["relay", creds.relay], ["challenge", data[1]]];
          if (Array.isArray(creds.authTag)) tags.push(creds.authTag);
          const event = signEvent(creds.key, { kind: 22242, tags, content: "" });
          agent.authId = event.id;
          ws.send(JSON.stringify(["AUTH", event]));
        } else if (type === "OK" && data[1] === agent.authId) {
          if (data[2] === true) ready();
          else {
            log.warn(`attention-relay: ${pubkey.slice(0, 8)}: login refused: ${data[3]}`);
            ws.close();
          }
        } else if ((type === "EVENT" || type === "EOSE" || type === "CLOSED") && agent.queries.has(data[1])) {
          const entry = agent.queries.get(data[1]);
          if (type === "EVENT" && data[2]?.id) entry.events.push(data[2]);
          else if (type === "EOSE") entry.finish();
          else if (type === "CLOSED") entry.finish(new Error(`relay refused the read: ${data[2]}`));
        } else if (type === "EVENT" && data[1] === agent.subId && data[2]?.id) {
          const event = data[2];
          if (agent.seen.has(event.id)) return;
          agent.seen.add(event.id);
          if (agent.seen.size > SEEN_LIMIT) agent.seen.delete(agent.seen.values().next().value);
          Promise.resolve(onEvent(pubkey, event)).catch((error) =>
            log.warn(`attention-relay: ${pubkey.slice(0, 8)}: ${error.message}`),
          );
        } else if (type === "CLOSED" && data[1] === agent.subId) {
          log.warn(`attention-relay: ${pubkey.slice(0, 8)}: subscription closed: ${data[2]}`);
          ws.close();
        }
      });
      ws.addEventListener("close", () => {
        clearTimeout(authTimer);
        for (const entry of [...(agent.queries?.values() ?? [])]) entry.finish(new Error("connection closed"));
        if (agent.ws !== ws || agent.closed) return;
        agent.ws = undefined;
        agent.ready = false;
        const wait = Math.min(agent.backoff, RECONNECT_MAX_MS);
        agent.backoff = Math.min(agent.backoff * 2, RECONNECT_MAX_MS);
        agent.retry = setTimeout(() => connect(pubkey, agent), wait / 2 + Math.random() * (wait / 2));
      });
      ws.addEventListener("error", () => {});
    })();
  }

  /** Brings `pubkey`'s connection in line with `record` (null: close it). */
  function sync(pubkey, record) {
    const filter = filterFor(record);
    let agent = agents.get(pubkey);
    if (!filter) {
      if (agent) {
        agent.closed = true;
        clearTimeout(agent.retry);
        agent.ws?.close();
        agents.delete(pubkey);
        log.log(`attention-relay: ${pubkey.slice(0, 8)}: no event watches; disconnected`);
      }
      return;
    }
    if (!agent) {
      agent = { filter, seen: new Set(), backoff: RECONNECT_MIN_MS, closed: false };
      agents.set(pubkey, agent);
      log.log(`attention-relay: ${pubkey.slice(0, 8)}: watching ${JSON.stringify(filter)}`);
      connect(pubkey, agent);
      return;
    }
    agent.filter = filter;
    // Not connected yet: the subscription it makes when ready uses this filter.
    if (agent.ready && agent.subscribedKey !== JSON.stringify(filter)) {
      log.log(`attention-relay: ${pubkey.slice(0, 8)}: watching ${JSON.stringify(filter)}`);
      subscribe(pubkey, agent);
    }
  }

  function stop() {
    for (const pubkey of [...agents.keys()]) sync(pubkey, null);
  }

  /** The agent's connection, as catch-up needs it: live since `since` in
   * `epoch`, and the channels it is a member of (undefined until read). */
  function status(pubkey) {
    const agent = agents.get(pubkey);
    if (!agent?.ready || agent.since === undefined) return undefined;
    if (agent.membersAt === undefined || Date.now() - agent.membersAt > MEMBERS_MAX_AGE_MS) {
      agent.membersAt = Date.now(); // one refresh at a time
      void refreshMembers(pubkey, agent);
    }
    return { epoch: agent.epoch, since: agent.since, members: agent.members, filter: agent.filter };
  }

  /** Test and debug hook: drops the agent's connection, as a network blip would. */
  function drop(pubkey) {
    agents.get(pubkey)?.ws?.close();
  }

  return { sync, stop, query, status, drop };
}
