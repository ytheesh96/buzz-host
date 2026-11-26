// Cross-machine delegation: host A's peer link store and WebSocket client
// manager (docs/cross-machine-delegation.md §§1, 3, 4).
//
// Each saved link in ~/.config/buzz-host/links.json (mode 0600) points to one
// peer host B: its machineId, human name, saved routes (iroh first, then wss),
// pinned irohNodeId, and the `bhd_…` delegate token secret.
//
// Plaintext secrets are NEVER returned by publicLinkView / links.list.

import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { withFileLock } from "./file-lock.mjs";
import { createIrohLinkSupervisor } from "./iroh-supervisor.mjs";

export const LINK_BLOB_PREFIX = "buzz-host-link:v1:";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LINK_ID_RE = /^lnk_[0-9a-f]{12}$/;
const DELEGATE_TOKEN_RE = /^bhd_[0-9a-f]{48}$/;
const MAX_ROUTE_FIELD = 4_096;

const DEFAULT_IDLE_CLOSE_MS = 5 * 60_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_RPC_TIMEOUT_MS = 20_000;
const DEFAULT_RECONNECT_MIN_MS = 1_000;
const DEFAULT_RECONNECT_MAX_MS = 30_000;

function isLoopbackHost(hostname) {
  const clean = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  return clean === "127.0.0.1" || clean === "::1" || clean === "localhost";
}

/** Validate a ws(s) URL for peer delegation: wss:// always ok; ws:// only for loopback. */
export function validateWsRouteUrl(raw) {
  if (typeof raw !== "string" || !raw.trim() || raw.length > MAX_ROUTE_FIELD) {
    throw new Error("Invalid WebSocket route URL");
  }
  let parsed;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new Error(`Invalid WebSocket route URL: "${raw}"`);
  }
  if (parsed.protocol === "wss:") return parsed.toString();
  if (parsed.protocol === "ws:" && isLoopbackHost(parsed.hostname)) return parsed.toString();
  throw new Error(`Insecure ws:// route refused for non-loopback host: "${raw}"`);
}

/** Normalize and validate peer routes (iroh first, then wss). */
export function validateRoutes(rawRoutes) {
  if (!Array.isArray(rawRoutes)) throw new Error("routes must be an array");
  const irohRoutes = [];
  const wssRoutes = [];
  const seenWss = new Set();
  const seenIroh = new Set();

  for (const r of rawRoutes) {
    if (!r || typeof r !== "object") throw new Error("Each route must be an object");
    if (r.type === "iroh") {
      const nodeId = typeof r.nodeId === "string" ? r.nodeId.trim() : "";
      const endpointAddr = typeof r.endpointAddr === "string" ? r.endpointAddr.trim() : "";
      if (!nodeId || !endpointAddr || nodeId.length > MAX_ROUTE_FIELD || endpointAddr.length > MAX_ROUTE_FIELD) {
        throw new Error("iroh route requires non-empty nodeId and endpointAddr");
      }
      const key = `${nodeId}:${endpointAddr}`;
      if (!seenIroh.has(key)) {
        seenIroh.add(key);
        irohRoutes.push({ type: "iroh", nodeId, endpointAddr });
      }
    } else if (r.type === "wss") {
      const url = validateWsRouteUrl(r.url);
      if (!seenWss.has(url)) {
        seenWss.add(url);
        wssRoutes.push({ type: "wss", url });
      }
    } else {
      throw new Error(`Unsupported route type: "${r.type}"`);
    }
  }
  if (irohRoutes.length + wssRoutes.length === 0) {
    throw new Error("At least one valid route (iroh or wss) is required");
  }
  return [...irohRoutes, ...wssRoutes];
}

function checkMachineId(value) {
  const clean = String(value ?? "").trim().toLowerCase();
  if (!UUID_RE.test(clean)) throw new Error("machineId must be a valid UUID");
  return clean;
}

function checkName(value) {
  const clean = String(value ?? "").trim();
  if (!clean || clean.length > 100) throw new Error("Link name must be 1-100 characters");
  return clean;
}

function checkDelegateToken(value) {
  const clean = String(value ?? "").trim();
  if (!DELEGATE_TOKEN_RE.test(clean)) {
    throw new Error("Delegate token must start with bhd_ followed by 48 hex characters");
  }
  return clean;
}

function checkOptionalNodeId(value) {
  if (value === undefined || value === null || value === "") return null;
  const clean = String(value).trim();
  if (!clean || clean.length > MAX_ROUTE_FIELD) throw new Error("Invalid irohNodeId");
  return clean;
}

/** Encode a one-paste pairing blob (`buzz-host-link:v1:<base64url>`). */
export function encodeLinkBlob({ machineId, name, routes, irohNodeId = null, token }) {
  const cleanMachineId = checkMachineId(machineId);
  const cleanName = checkName(name);
  const cleanRoutes = validateRoutes(routes);
  const cleanToken = checkDelegateToken(token);
  const inferredNodeId = cleanRoutes.find((r) => r.type === "iroh")?.nodeId ?? null;
  const cleanNodeId = checkOptionalNodeId(irohNodeId) ?? inferredNodeId;
  const payload = {
    machineId: cleanMachineId,
    name: cleanName,
    routes: cleanRoutes,
    irohNodeId: cleanNodeId,
    token: cleanToken,
  };
  return `${LINK_BLOB_PREFIX}${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;
}

/** Decode and validate a `buzz-host-link:v1:<base64url>` pairing blob. */
export function decodeLinkBlob(raw) {
  const clean = String(raw ?? "").trim();
  if (!clean.startsWith(LINK_BLOB_PREFIX)) {
    throw new Error(`Invalid link blob: expected prefix "${LINK_BLOB_PREFIX}"`);
  }
  const encoded = clean.slice(LINK_BLOB_PREFIX.length);
  if (!encoded) throw new Error("Invalid link blob: empty payload");
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid link blob: malformed JSON payload");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid link blob: payload must be an object");
  }
  const routes = validateRoutes(parsed.routes);
  const irohNodeId = checkOptionalNodeId(parsed.irohNodeId) ?? routes.find((r) => r.type === "iroh")?.nodeId ?? null;
  return {
    machineId: checkMachineId(parsed.machineId),
    name: checkName(parsed.name),
    routes,
    irohNodeId,
    token: checkDelegateToken(parsed.token),
  };
}

/** Public view of a saved link — NEVER includes the bearer secret. */
export function publicLinkView(record) {
  if (!record || typeof record !== "object") return null;
  return {
    id: record.id,
    machineId: record.machineId,
    name: record.name,
    routes: Array.isArray(record.routes) ? record.routes.map((r) => ({ ...r })) : [],
    irohNodeId: record.irohNodeId || null,
    lastRoute: record.lastRoute ? { ...record.lastRoute } : null,
    lastSeenAt: record.lastSeenAt || null,
    lastCapabilities: record.lastCapabilities ? structuredClone(record.lastCapabilities) : null,
    status: record.status || "ok",
    error: record.error || "",
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function createLinkStore({ filePath }) {
  if (!filePath) throw new Error("createLinkStore: filePath is required");

  async function readAll() {
    try {
      const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
      return Array.isArray(parsed?.links) ? parsed.links : [];
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }

  async function writeAll(links) {
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const tmp = `${filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify({ version: 1, links }, null, 2)}\n`, { mode: 0o600 });
    await fs.chmod(tmp, 0o600);
    await fs.rename(tmp, filePath);
  }

  async function mutate(fn) {
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    return withFileLock(filePath, async () => {
      const links = await readAll();
      const result = await fn(links);
      await writeAll(links);
      return result;
    });
  }

  function findIndex(links, selector) {
    const clean = String(selector ?? "").trim();
    if (!clean) return -1;
    const lower = clean.toLowerCase();
    let idx = links.findIndex((l) => l.id === clean || l.machineId === lower);
    if (idx >= 0) return idx;
    const byName = links
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => String(l.name || "").toLowerCase() === lower);
    if (byName.length === 1) return byName[0].i;
    if (byName.length > 1) {
      throw new Error(`Multiple links are named "${clean}"; pass the link id or machineId instead`);
    }
    return -1;
  }

  async function add(input = {}) {
    const source = typeof input === "string" ? decodeLinkBlob(input) : input.blob ? decodeLinkBlob(input.blob) : input;
    const machineId = checkMachineId(source.machineId);
    const name = checkName(input.name ?? source.name);
    const routes = validateRoutes(source.routes);
    const token = checkDelegateToken(source.token);
    const irohNodeId = checkOptionalNodeId(source.irohNodeId) ?? routes.find((r) => r.type === "iroh")?.nodeId ?? null;
    if (irohNodeId) {
      for (const r of routes) {
        if (r.type === "iroh" && r.nodeId !== irohNodeId) {
          throw new Error(`iroh route nodeId (${r.nodeId}) disagrees with pinned irohNodeId (${irohNodeId})`);
        }
      }
    }

    const now = new Date().toISOString();
    const record = {
      id: `lnk_${randomBytes(6).toString("hex")}`,
      machineId,
      name,
      routes,
      irohNodeId,
      token,
      lastRoute: null,
      lastSeenAt: null,
      lastCapabilities: null,
      status: "ok",
      error: "",
      createdAt: now,
      updatedAt: now,
    };

    await mutate((links) => {
      const existing = links.find((l) => l.machineId === machineId);
      if (existing) {
        throw new Error(`A link for machine ${machineId} ("${existing.name}", ${existing.id}) already exists; use update or remove it first`);
      }
      links.push(record);
    });

    return publicLinkView(record);
  }

  async function list() {
    const links = await readAll();
    return links.map(publicLinkView);
  }

  async function listRaw() {
    return readAll();
  }

  async function get(selector) {
    const links = await readAll();
    const idx = findIndex(links, selector);
    return idx >= 0 ? publicLinkView(links[idx]) : null;
  }

  async function getRaw(selector) {
    const links = await readAll();
    const idx = findIndex(links, selector);
    return idx >= 0 ? links[idx] : null;
  }

  async function update(selector, patch = {}) {
    const fromBlob = patch.blob ? decodeLinkBlob(patch.blob) : null;
    return mutate((links) => {
      const idx = findIndex(links, selector);
      if (idx < 0) throw new Error(`Link "${selector}" not found`);
      const cur = links[idx];
      if (fromBlob && fromBlob.machineId !== cur.machineId) {
        throw new Error(`Blob machineId (${fromBlob.machineId}) does not match link machineId (${cur.machineId})`);
      }
      if (patch.name !== undefined || fromBlob?.name) {
        cur.name = checkName(patch.name ?? fromBlob.name);
      }
      if (patch.irohNodeId !== undefined || fromBlob?.irohNodeId !== undefined) {
        cur.irohNodeId = checkOptionalNodeId(patch.irohNodeId ?? fromBlob?.irohNodeId);
      }
      if (patch.routes !== undefined || fromBlob?.routes) {
        const nextRoutes = validateRoutes(patch.routes ?? fromBlob.routes);
        if (cur.irohNodeId) {
          for (const r of nextRoutes) {
            if (r.type === "iroh" && r.nodeId !== cur.irohNodeId) {
              throw new Error(`${cur.name}'s identity changed; pair again`);
            }
          }
        }
        cur.routes = nextRoutes;
      }
      if (patch.token !== undefined || fromBlob?.token) {
        cur.token = checkDelegateToken(patch.token ?? fromBlob.token);
        cur.status = "ok";
        cur.error = "";
      }
      if (patch.lastRoute !== undefined) cur.lastRoute = patch.lastRoute;
      if (patch.lastSeenAt !== undefined) cur.lastSeenAt = patch.lastSeenAt;
      if (patch.lastCapabilities !== undefined) cur.lastCapabilities = patch.lastCapabilities;
      if (patch.status !== undefined) cur.status = patch.status;
      if (patch.error !== undefined) cur.error = String(patch.error ?? "");
      cur.updatedAt = new Date().toISOString();
      return publicLinkView(cur);
    });
  }

  async function remove(selector) {
    return mutate((links) => {
      const idx = findIndex(links, selector);
      if (idx < 0) throw new Error(`Link "${selector}" not found`);
      const [removed] = links.splice(idx, 1);
      return publicLinkView(removed);
    });
  }

  return { add, list, listRaw, get, getRaw, update, remove };
}

// ---------- link client & connection manager ----------

function classifyAuthFailure(message) {
  const s = String(message || "");
  if (/expired/i.test(s)) return "expired";
  if (/revoked|invalid/i.test(s)) return "revoked";
  return "";
}

export function createLinkManager({
  filePath,
  config = () => ({}),
  libDir = "",
  repoBin,
  spawn,
  fsImpl,
  WebSocketImpl = globalThis.WebSocket,
  onDelegateEvent = () => {},
  onLinkDisconnect = () => {},
  onLinkReconnect = () => {},
  onLinkRevoked = () => {},
  idleCloseMs = DEFAULT_IDLE_CLOSE_MS,
  connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
  rpcTimeoutMs = DEFAULT_RPC_TIMEOUT_MS,
  reconnectMinMs = DEFAULT_RECONNECT_MIN_MS,
  reconnectMaxMs = DEFAULT_RECONNECT_MAX_MS,
  log = console,
} = {}) {
  const store = createLinkStore({ filePath });
  // linkId -> runtime session state
  const sessions = new Map();
  let closed = false;
  let nextRpcId = 1;

  function getSession(linkId) {
    let s = sessions.get(linkId);
    if (!s) {
      s = {
        linkId,
        ws: null,
        irohSup: null,
        ready: false,
        connecting: null,
        pending: new Map(), // rpcId -> { resolve, reject, timer }
        activeRefs: new Map(), // ref -> lastSeq
        idleTimer: null,
        reconnectTimer: null,
        backoffMs: reconnectMinMs,
        closed: false,
        hadConnection: false,
      };
      sessions.set(linkId, s);
    }
    return s;
  }

  function clearIdleTimer(s) {
    if (s.idleTimer) {
      clearTimeout(s.idleTimer);
      s.idleTimer = null;
    }
  }

  function clearReconnectTimer(s) {
    if (s.reconnectTimer) {
      clearTimeout(s.reconnectTimer);
      s.reconnectTimer = null;
    }
  }

  function armIdleTimer(s) {
    clearIdleTimer(s);
    if (s.activeRefs.size > 0 || !s.ready || closed || s.closed) return;
    if (!Number.isFinite(idleCloseMs) || idleCloseMs <= 0) return;
    s.idleTimer = setTimeout(() => {
      s.idleTimer = null;
      if (s.activeRefs.size === 0 && s.ws) {
        void disconnectSession(s.linkId, { permanent: false });
      }
    }, idleCloseMs);
    s.idleTimer.unref?.();
  }

  async function disconnectSession(linkId, { permanent = false } = {}) {
    const s = sessions.get(linkId);
    if (!s) return;
    clearIdleTimer(s);
    clearReconnectTimer(s);
    if (permanent) s.closed = true;
    const ws = s.ws;
    const sup = s.irohSup;
    s.ws = null;
    s.irohSup = null;
    s.ready = false;
    for (const [id, p] of s.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("Link connection closed"));
      s.pending.delete(id);
    }
    try {
      ws?.close();
    } catch {}
    await sup?.stop().catch(() => {});
    if (permanent) sessions.delete(linkId);
  }

  function rawRpc(ws, pendingMap, method, params, timeoutMs = rpcTimeoutMs) {
    return new Promise((resolve, reject) => {
      const id = nextRpcId++;
      const timer = setTimeout(() => {
        pendingMap.delete(id);
        reject(new Error(`RPC ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      pendingMap.set(id, { resolve, reject, timer });
      try {
        ws.send(JSON.stringify({ id, method, params: params ?? {} }));
      } catch (error) {
        clearTimeout(timer);
        pendingMap.delete(id);
        reject(error);
      }
    });
  }

  function openWs(url, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (!WebSocketImpl) return reject(new Error("WebSocket implementation unavailable"));
      let ws;
      try {
        ws = new WebSocketImpl(url);
      } catch (error) {
        return reject(error);
      }
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          ws.close();
        } catch {}
        reject(new Error(`Timed out connecting to ${url}`));
      }, timeoutMs);
      timer.unref?.();

      const onOpen = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ws.removeEventListener("error", onError);
        ws.removeEventListener("close", onClose);
        resolve(ws);
      };
      const onError = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ws.removeEventListener("open", onOpen);
        ws.removeEventListener("close", onClose);
        reject(new Error(`Failed to connect to ${url}`));
      };
      const onClose = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ws.removeEventListener("open", onOpen);
        ws.removeEventListener("error", onError);
        reject(new Error(`Connection closed while opening ${url}`));
      };
      ws.addEventListener("open", onOpen);
      ws.addEventListener("error", onError);
      ws.addEventListener("close", onClose);
    });
  }

  function scheduleReconnect(linkId) {
    const s = sessions.get(linkId);
    if (!s || closed || s.closed || s.reconnectTimer || s.activeRefs.size === 0) return;
    const delay = Math.min(s.backoffMs, reconnectMaxMs);
    s.backoffMs = Math.min(s.backoffMs * 2, reconnectMaxMs);
    s.reconnectTimer = setTimeout(() => {
      s.reconnectTimer = null;
      if (closed || s.closed || s.activeRefs.size === 0) return;
      void ensureConnected(linkId).catch(() => {
        if (!closed && !s.closed && s.activeRefs.size > 0) {
          scheduleReconnect(linkId);
        }
      });
    }, delay);
    s.reconnectTimer.unref?.();
  }

  async function tryRoute(link, route, timeoutMs) {
    let irohSup = null;
    let targetUrl;
    if (route.type === "iroh") {
      if (link.irohNodeId && route.nodeId !== link.irohNodeId) {
        const err = new Error(`${link.name}'s identity changed; pair again`);
        err.code = "IDENTITY_MISMATCH";
        throw err;
      }
      irohSup = createIrohLinkSupervisor({
        addr: route.endpointAddr,
        nodeId: route.nodeId,
        config: typeof config === "function" ? config() : config,
        libDir,
        repoBin,
        spawn,
        fsImpl,
        log,
      });
      try {
        targetUrl = await Promise.race([
          irohSup.start(),
          new Promise((_, reject) => {
            const t = setTimeout(() => reject(new Error("Timed out starting iroh link bridge")), timeoutMs);
            t.unref?.();
          }),
        ]);
      } catch (err) {
        await irohSup.stop().catch(() => {});
        if (err.code === "IDENTITY_MISMATCH") {
          const mismatch = new Error(`${link.name}'s identity changed; pair again`);
          mismatch.code = "IDENTITY_MISMATCH";
          throw mismatch;
        }
        throw err;
      }
    } else if (route.type === "wss") {
      targetUrl = validateWsRouteUrl(route.url);
    } else {
      throw new Error(`Unsupported route type: ${route.type}`);
    }

    let ws;
    try {
      ws = await openWs(targetUrl, timeoutMs);
    } catch (err) {
      await irohSup?.stop().catch(() => {});
      throw err;
    }

    const pending = new Map();
    const messageListener = (event) => {
      let msg;
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(String(msg.error)));
        else p.resolve(msg.result);
      }
    };
    const closeDuringHandshake = () => {
      for (const [id, p] of pending) {
        clearTimeout(p.timer);
        p.reject(new Error("Peer closed socket during handshake"));
        pending.delete(id);
      }
    };
    ws.addEventListener("message", messageListener);
    ws.addEventListener("close", closeDuringHandshake);

    try {
      const authRes = await rawRpc(ws, pending, "auth", { token: link.token }, timeoutMs);
      if (authRes?.role !== "delegate") {
        const err = new Error(`Expected delegate role from ${link.name}, got "${authRes?.role}"`);
        err.code = "AUTH_REJECTED";
        throw err;
      }
      const helloRes = await rawRpc(ws, pending, "delegate.hello", {}, timeoutMs);
      if (helloRes?.machineId && helloRes.machineId !== link.machineId) {
        const err = new Error(`${link.name}'s identity changed; pair again`);
        err.code = "IDENTITY_MISMATCH";
        throw err;
      }
      if (link.irohNodeId && Array.isArray(helloRes?.routes)) {
        for (const r of helloRes.routes) {
          if (r?.type === "iroh" && r.nodeId && r.nodeId !== link.irohNodeId) {
            const err = new Error(`${link.name}'s identity changed; pair again`);
            err.code = "IDENTITY_MISMATCH";
            throw err;
          }
        }
      }
      ws.removeEventListener("message", messageListener);
      ws.removeEventListener("close", closeDuringHandshake);
      return { ws, irohSup, hello: helloRes };
    } catch (err) {
      ws.removeEventListener("message", messageListener);
      ws.removeEventListener("close", closeDuringHandshake);
      try {
        ws.close();
      } catch {}
      await irohSup?.stop().catch(() => {});
      const authKind = classifyAuthFailure(err.message);
      if (authKind) err.code = authKind === "expired" ? "TOKEN_EXPIRED" : "TOKEN_REVOKED";
      throw err;
    }
  }

  function ensureConnected(linkId, { timeoutMs = connectTimeoutMs } = {}) {
    if (closed) return Promise.reject(new Error("Link manager is closed"));
    const s = getSession(linkId);
    if (s.ready && s.ws?.readyState === WebSocketImpl?.OPEN) {
      return Promise.resolve(s);
    }
    if (s.connecting) return s.connecting;
    s.closed = false;
    clearReconnectTimer(s);

    s.connecting = (async () => {
      const link = await store.getRaw(linkId);
      if (!link) throw new Error(`Link "${linkId}" not found`);
      if (link.status === "revoked" || link.status === "expired") {
        const err = new Error(`Host ${link.name} link is ${link.status}; pair again with a new token`);
        err.code = link.status === "expired" ? "TOKEN_EXPIRED" : "TOKEN_REVOKED";
        throw err;
      }
      if (link.status === "identity_mismatch") {
        const err = new Error(`${link.name}'s identity changed; pair again`);
        err.code = "IDENTITY_MISMATCH";
        throw err;
      }

      const routes = Array.isArray(link.routes) ? link.routes : [];
      let lastError = new Error(`Host ${link.name} has no reachable routes`);
      let connected = null;
      let usedRoute = null;

      for (const route of routes) {
        try {
          connected = await tryRoute(link, route, timeoutMs);
          usedRoute = route;
          break;
        } catch (err) {
          lastError = err;
          if (err.code === "IDENTITY_MISMATCH") {
            await store.update(link.id, { status: "identity_mismatch", error: err.message }).catch(() => {});
            throw err;
          }
          if (err.code === "TOKEN_REVOKED" || err.code === "TOKEN_EXPIRED") {
            const st = err.code === "TOKEN_EXPIRED" ? "expired" : "revoked";
            const updated = await store.update(link.id, { status: st, error: err.message }).catch(() => publicLinkView(link));
            onLinkRevoked(updated, st);
            throw err;
          }
          // Otherwise (unreachable, NO_IROH_BIN, timeout) try next route.
        }
      }

      if (!connected) {
        const seen = link.lastSeenAt ? ` (last seen ${link.lastSeenAt})` : "";
        const err = new Error(`Host ${link.name} is unreachable${seen}: ${lastError.message}`);
        err.code = "UNREACHABLE";
        await store.update(link.id, { status: "unreachable", error: lastError.message }).catch(() => {});
        throw err;
      }

      const { ws, irohSup, hello } = connected;
      s.ws = ws;
      s.irohSup = irohSup;
      s.ready = true;
      s.backoffMs = reconnectMinMs;
      const wasReconnect = s.hadConnection;
      s.hadConnection = true;

      // Refresh routes and cached capabilities from hello.
      const patch = {
        lastRoute: usedRoute,
        lastSeenAt: new Date().toISOString(),
        lastCapabilities: hello,
        status: "ok",
        error: "",
      };
      if (Array.isArray(hello?.routes) && hello.routes.length > 0) {
        try {
          patch.routes = validateRoutes(hello.routes);
        } catch {}
      }
      await store.update(link.id, patch).catch(() => {});

      const dispatchEvent = (evt) => {
        if (!evt || typeof evt !== "object" || typeof evt.ref !== "string") return;
        const seq = Number(evt.seq) || 0;
        if (s.activeRefs.has(evt.ref)) {
          const prev = s.activeRefs.get(evt.ref) || 0;
          if (seq > 0 && seq <= prev) return;
          if (seq > prev) s.activeRefs.set(evt.ref, seq);
        }
        try {
          onDelegateEvent(link.id, evt);
        } catch (error) {
          log.warn?.(`links: delegate.event handler error: ${error.message}`);
        }
      };

      ws.addEventListener("message", (event) => {
        let msg;
        try {
          msg = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (msg.method === "delegate.event" && msg.params) {
          dispatchEvent(msg.params);
          return;
        }
        if (msg.id !== undefined && s.pending.has(msg.id)) {
          const p = s.pending.get(msg.id);
          s.pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.error) p.reject(new Error(String(msg.error)));
          else p.resolve(msg.result);
        }
      });

      ws.addEventListener("close", () => {
        const isCurrent = s.ws === ws;
        if (!isCurrent) return;
        s.ws = null;
        s.ready = false;
        const oldSup = s.irohSup;
        s.irohSup = null;
        void oldSup?.stop().catch(() => {});
        clearIdleTimer(s);
        for (const [id, p] of s.pending) {
          clearTimeout(p.timer);
          p.reject(new Error(`Connection to ${link.name} closed`));
          s.pending.delete(id);
        }
        if (closed || s.closed) return;
        if (s.activeRefs.size > 0) {
          try {
            onLinkDisconnect(link.id, publicLinkView(link));
          } catch {}
          scheduleReconnect(link.id);
        }
      });

      ws.addEventListener("error", () => {});

      // Replay missed events if reconnecting with active tasks.
      if (wasReconnect && s.activeRefs.size > 0) {
        try {
          const refs = [...s.activeRefs.keys()];
          const after = Object.fromEntries(s.activeRefs);
          const synced = await rawRpc(ws, s.pending, "delegate.sync", { refs, after }, rpcTimeoutMs);
          for (const item of Array.isArray(synced?.tasks) ? synced.tasks : []) {
            for (const evt of Array.isArray(item.events) ? item.events : []) {
              dispatchEvent({ ref: item.ref, ...evt });
            }
          }
        } catch (err) {
          log.warn?.(`links: delegate.sync on ${link.name} failed: ${err.message}`);
        }
        try {
          onLinkReconnect(link.id, publicLinkView(link));
        } catch {}
      }

      armIdleTimer(s);
      return s;
    })().finally(() => {
      s.connecting = null;
    });

    return s.connecting;
  }

  async function call(linkId, method, params = {}, { timeoutMs = rpcTimeoutMs } = {}) {
    const s = await ensureConnected(linkId, { timeoutMs: Math.min(timeoutMs, connectTimeoutMs) });
    if (!s.ws || !s.ready) throw new Error("Link is not connected");
    const res = await rawRpc(s.ws, s.pending, method, params, timeoutMs);
    armIdleTimer(s);
    return res;
  }

  async function hello(linkId, { timeoutMs = connectTimeoutMs } = {}) {
    const s = await ensureConnected(linkId, { timeoutMs });
    const res = await rawRpc(s.ws, s.pending, "delegate.hello", {}, timeoutMs);
    const patch = {
      lastSeenAt: new Date().toISOString(),
      lastCapabilities: res,
      status: "ok",
      error: "",
    };
    if (Array.isArray(res?.routes) && res.routes.length > 0) {
      try {
        patch.routes = validateRoutes(res.routes);
      } catch {}
    }
    await store.update(linkId, patch).catch(() => {});
    armIdleTimer(s);
    return res;
  }

  function trackRef(linkId, ref, lastSeq = 0) {
    const s = getSession(linkId);
    clearIdleTimer(s);
    const prev = s.activeRefs.get(ref) ?? 0;
    s.activeRefs.set(ref, Math.max(prev, lastSeq));
  }

  function untrackRef(linkId, ref) {
    const s = sessions.get(linkId);
    if (!s) return;
    s.activeRefs.delete(ref);
    if (s.activeRefs.size === 0) armIdleTimer(s);
  }

  function isConnected(linkId) {
    const s = sessions.get(linkId);
    return Boolean(s?.ready && s.ws?.readyState === WebSocketImpl?.OPEN);
  }

  async function resolveHost(spec) {
    return store.get(spec);
  }

  async function test(selector) {
    const link = await store.get(selector);
    if (!link) throw new Error(`Link "${selector}" not found`);
    const info = await hello(link.id);
    const refreshed = await store.get(link.id);
    return { ok: true, link: refreshed, hello: info };
  }

  async function add(params) {
    return { link: await store.add(params) };
  }

  async function list() {
    const links = await store.list();
    return {
      links: links.map((l) => ({
        ...l,
        connected: isConnected(l.id),
      })),
    };
  }

  async function update({ linkId, id, selector, ...patch } = {}) {
    const target = linkId ?? id ?? selector;
    if (!target) throw new Error("linkId is required");
    const existing = await store.get(target);
    if (!existing) throw new Error(`Link "${target}" not found`);
    const updated = await store.update(existing.id, patch);
    if (patch.token !== undefined || patch.routes !== undefined || patch.blob !== undefined) {
      await disconnectSession(existing.id, { permanent: false });
    }
    return { link: updated };
  }

  async function remove({ linkId, id, selector } = {}) {
    const target = linkId ?? id ?? selector;
    if (!target) throw new Error("linkId is required");
    const existing = await store.get(target);
    if (!existing) throw new Error(`Link "${target}" not found`);
    await disconnectSession(existing.id, { permanent: true });
    const removed = await store.remove(existing.id);
    return { link: removed };
  }

  async function close() {
    closed = true;
    await Promise.all([...sessions.keys()].map((id) => disconnectSession(id, { permanent: true })));
  }

  return {
    store,
    add,
    list,
    update,
    remove,
    test,
    resolveHost,
    ensureConnected,
    call,
    hello,
    trackRef,
    untrackRef,
    isConnected,
    close,
  };
}
