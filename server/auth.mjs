// Multi-tenant authentication, guest token storage, and per-owner access control for buzz-host.
//
// Two caller roles:
//   - "admin": authenticated either via Tailscale-User-Login on the tailnet-only listener,
//              or via an admin access token (`bha_<48hex>`) sent in the `auth` RPC on the
//              token listener (works over server-only Tailscale Funnel, zrok, or any
//              wss:// proxy, so client devices need no Tailscale). Full access to host &
//              sandbox agents, desktops, orchestrator, and guest tokens.
//   - "guest": authenticated via a per-friend opaque token (`bhg_<48hex>`) sent in the
//              initial WebSocket `auth` RPC (never in URL query params). Strictly scoped
//              to their own Docker-sandboxed agents within per-token caps.
//
// A token's role is fixed when it is minted and stored with its hash. The secret's
// prefix must match the stored role, so a guest token can never act as an admin one.
//
// Security properties:
//   - Plaintext tokens are NEVER stored on disk (only sha256 hashes with timing-safe lookup).
//   - Guest listener ignores Tailscale-User-Login completely so a proxy misconfiguration
//     can never escalate public Funnel traffic to admin.
//   - Supports pre-bound ownerPubkey OR bind-on-first-activate (TOFU) locked permanently
//     to the first cryptographically attested Buzz owner pubkey.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { withFileLock } from "./file-lock.mjs";

const HEX64 = /^[0-9a-f]{64}$/;
export const TOKEN_PREFIXES = { guest: "bhg_", admin: "bha_" };
const TOKEN_RE = /^(bhg|bha)_[0-9a-f]{48}$/;
const TOKEN_ID_RE = /^tok_[0-9a-f]{12}$/;

export const DEFAULT_GUEST_MAX_AGENTS = 2;
export const DEFAULT_GUEST_MAX_CONCURRENCY = 2;
export const DEFAULT_GUEST_RUNTIMES = ["hermes", "claude", "antigravity"];
const VALID_RUNTIMES = new Set(["claude", "codex", "hermes", "antigravity"]);

export const DESKTOP_METHODS = new Set([
  "desktop.status",
  "desktop.set",
  "desktop.start",
  "desktop.stop",
  "desktop.snapshot",
  "desktop.view",
  "desktop.lease",
]);

export const ADMIN_ONLY_METHODS = new Set([
  "orchestrator.set",
  "orchestrator.tasks",
  "orchestrator.cancel",
  "hermes.profiles",
  "tokens.create",
  "tokens.list",
  "tokens.revoke",
  "machine.attest",
]);

export function hashToken(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}

function safeHexEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function checkLabel(label) {
  const clean = String(label ?? "").trim();
  if (!clean || clean.length > 80) throw new Error("Token label must be 1-80 characters");
  return clean;
}

function checkOptionalPubkey(pubkey) {
  if (pubkey === undefined || pubkey === null || pubkey === "") return null;
  const clean = String(pubkey).trim().toLowerCase();
  if (!HEX64.test(clean)) throw new Error("ownerPubkey must be a 64-character hex pubkey");
  return clean;
}

function checkCap(value, fallback, min, max, name) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return n;
}

function checkAllowedRuntimes(value, fallback = DEFAULT_GUEST_RUNTIMES) {
  if (value === undefined || value === null) return [...fallback];
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("allowedRuntimes must be a non-empty list");
  }
  const out = [];
  for (const item of value) {
    const clean = String(item ?? "").trim().toLowerCase();
    if (!VALID_RUNTIMES.has(clean)) throw new Error(`Unknown runtime in allowedRuntimes: "${clean}"`);
    if (!out.includes(clean)) out.push(clean);
  }
  return out;
}

/** The stored role; records written before admin tokens existed are guests. */
export function tokenRole(record) {
  return record?.role === "admin" ? "admin" : "guest";
}

export function publicTokenView(record) {
  if (tokenRole(record) === "admin") {
    return {
      id: record.id,
      label: record.label,
      ownerPubkey: record.ownerPubkey || null,
      role: "admin",
      createdAt: record.createdAt,
      lastUsedAt: record.lastUsedAt || null,
      revokedAt: record.revokedAt || null,
    };
  }
  return {
    id: record.id,
    label: record.label,
    ownerPubkey: record.ownerPubkey || null,
    role: "guest",
    maxAgents: record.maxAgents,
    maxConcurrency: record.maxConcurrency,
    allowedRuntimes: [...record.allowedRuntimes],
    allowHostDesktop: record.allowHostDesktop === true,
    allowSandboxDesktop: sandboxDesktopAllowed(record),
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt || null,
    revokedAt: record.revokedAt || null,
  };
}

/** Guest tokens get a sandboxed desktop unless it was turned off (`false`);
 *  tokens made before the flag existed count as on. */
export function sandboxDesktopAllowed(record) {
  return record?.allowSandboxDesktop !== false;
}

export function buildInviteUrl(publicUrl, token) {
  if (!publicUrl) return "";
  const clean = String(publicUrl).replace(/#.*$/, "").trim();
  return `${clean}#token=${token}`;
}

export function createTokenStore({ filePath }) {
  async function readAll() {
    try {
      const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
      return Array.isArray(parsed?.tokens) ? parsed.tokens : [];
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }

  async function writeAll(tokens) {
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const tmp = `${filePath}.${randomBytes(4).toString("hex")}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify({ version: 1, tokens }, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(tmp, filePath);
  }

  async function mutate(fn) {
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    return withFileLock(filePath, async () => {
      const tokens = await readAll();
      const result = await fn(tokens);
      await writeAll(tokens);
      return result;
    });
  }

  async function create({
    label,
    ownerPubkey,
    maxAgents,
    maxConcurrency,
    allowedRuntimes,
    allowHostDesktop = false,
    allowSandboxDesktop = true,
  } = {}) {
    const cleanLabel = checkLabel(label);
    const cleanOwner = checkOptionalPubkey(ownerPubkey);
    const cleanMaxAgents = checkCap(maxAgents, DEFAULT_GUEST_MAX_AGENTS, 1, 20, "maxAgents");
    const cleanMaxConc = checkCap(maxConcurrency, DEFAULT_GUEST_MAX_CONCURRENCY, 1, 8, "maxConcurrency");
    const cleanRuntimes = checkAllowedRuntimes(allowedRuntimes, DEFAULT_GUEST_RUNTIMES);
    const cleanAllowHostDesktop = allowHostDesktop === true;
    const cleanAllowSandboxDesktop = allowSandboxDesktop !== false;

    const token = `${TOKEN_PREFIXES.guest}${randomBytes(24).toString("hex")}`;
    const record = {
      id: `tok_${randomBytes(6).toString("hex")}`,
      label: cleanLabel,
      tokenHash: hashToken(token),
      ownerPubkey: cleanOwner,
      role: "guest",
      maxAgents: cleanMaxAgents,
      maxConcurrency: cleanMaxConc,
      allowedRuntimes: cleanRuntimes,
      allowHostDesktop: cleanAllowHostDesktop,
      // A desktop in the agent's own sidecar container (sandbox/desktop-sidecar.mjs):
      // a guest agent's desktop without running anything on the host as the owner.
      allowSandboxDesktop: cleanAllowSandboxDesktop,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      revokedAt: null,
    };

    await mutate((tokens) => {
      tokens.push(record);
    });

    return { token, record: publicTokenView(record) };
  }

  /** An admin access token: full host access over the token listener. Shown once. */
  async function createAdmin({ label, ownerPubkey } = {}) {
    const cleanLabel = checkLabel(label);
    const cleanOwner = checkOptionalPubkey(ownerPubkey);
    const token = `${TOKEN_PREFIXES.admin}${randomBytes(24).toString("hex")}`;
    const record = {
      id: `tok_${randomBytes(6).toString("hex")}`,
      label: cleanLabel,
      tokenHash: hashToken(token),
      ownerPubkey: cleanOwner,
      role: "admin",
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      revokedAt: null,
    };
    await mutate((tokens) => {
      tokens.push(record);
    });
    return { token, record: publicTokenView(record) };
  }

  async function verify(rawToken) {
    if (typeof rawToken !== "string" || !TOKEN_RE.test(rawToken.trim())) return null;
    const clean = rawToken.trim();
    const candidateHash = hashToken(clean);
    const tokens = await readAll();
    let matched = null;
    for (const t of tokens) {
      if (safeHexEqual(t.tokenHash, candidateHash)) {
        matched = t;
      }
    }
    if (!matched || matched.revokedAt) return null;
    // The secret's prefix must agree with the role stored at mint time: an
    // edited or mixed-up record can never turn a guest secret into an admin.
    if (!clean.startsWith(TOKEN_PREFIXES[tokenRole(matched)])) return null;

    // Best-effort lastUsedAt update.
    await mutate((list) => {
      const hit = list.find((t) => t.id === matched.id);
      if (hit && !hit.revokedAt) hit.lastUsedAt = new Date().toISOString();
    }).catch(() => {});

    return publicTokenView(matched);
  }

  async function getById(id) {
    if (typeof id !== "string" || !TOKEN_ID_RE.test(id)) return null;
    const tokens = await readAll();
    const hit = tokens.find((t) => t.id === id);
    return hit ? publicTokenView(hit) : null;
  }

  /** Permanently bind an unbound guest token to its first attested Buzz owner pubkey. */
  async function bindOwner(id, pubkey) {
    if (typeof id !== "string" || !TOKEN_ID_RE.test(id)) throw new Error("Invalid token id");
    const cleanOwner = checkOptionalPubkey(pubkey);
    if (!cleanOwner) throw new Error("ownerPubkey is required");

    return mutate((tokens) => {
      const hit = tokens.find((t) => t.id === id);
      if (!hit || hit.revokedAt) throw new Error("Access token has been revoked");
      if (tokenRole(hit) !== "guest") throw new Error("Only guest tokens bind to an owner");
      if (hit.ownerPubkey && hit.ownerPubkey !== cleanOwner) {
        throw new Error("This access token is already bound to another user");
      }
      hit.ownerPubkey = cleanOwner;
      hit.lastUsedAt = new Date().toISOString();
      return publicTokenView(hit);
    });
  }

  async function list() {
    const tokens = await readAll();
    return tokens.map(publicTokenView);
  }

  async function revoke(id) {
    if (typeof id !== "string" || !TOKEN_ID_RE.test(id)) throw new Error("Invalid token id");
    return mutate((tokens) => {
      const hit = tokens.find((t) => t.id === id);
      if (!hit) throw new Error(`Token ${id} not found`);
      if (!hit.revokedAt) hit.revokedAt = new Date().toISOString();
      return publicTokenView(hit);
    });
  }

  return { create, createAdmin, verify, getById, bindOwner, list, revoke };
}

/**
 * Which listeners a config asks for. `allowLogins` is optional: a token-only
 * host (client devices not on a tailnet) leaves it out or empty, which turns
 * the Tailscale-User-Login listener off; every caller then authenticates with
 * an access token on the token listener, so `guestPort` must be set.
 */
export function parseListenerConfig(raw, file = "config.json") {
  const list = raw?.allowLogins;
  if (list !== undefined && list !== null && !Array.isArray(list))
    throw new Error(`${file}: allowLogins must list Tailscale logins`);
  // Entries are kept exactly as written (the same Set as before this was optional).
  const allowLogins = new Set(list ?? []);
  const guestPort = raw?.guestPort ?? 8467;
  if (!allowLogins.size && !(Number.isInteger(guestPort) && guestPort > 0))
    throw new Error(`${file}: with no allowLogins, guestPort must be set so access tokens can connect`);
  return { allowLogins, guestPort };
}

/** Whether `session` owns or may access agent metadata `m`. */
export function canAccessAgent(session, m) {
  if (!session?.authenticated || !m) return false;
  if (session.role === "admin") return true;
  if (session.role !== "guest") return false;
  if (session.ownerPubkey && m.owner === session.ownerPubkey) return true;
  if (!m.activated && session.tokenId && m.createdByTokenId === session.tokenId) return true;
  return false;
}

export function assertAgentAccess(session, m) {
  if (!canAccessAgent(session, m)) {
    throw new Error("Agent not found on this host");
  }
}

export function assertMethodAllowed(session, methodName) {
  if (!session?.authenticated) {
    throw new Error("Authentication required");
  }
  if (session.role === "guest") {
    if (DESKTOP_METHODS.has(methodName)) {
      if (session.limits?.allowHostDesktop === true || session.limits?.allowSandboxDesktop === true) return;
      throw new Error(`Method "${methodName}" is not permitted for guest accounts`);
    }
    if (ADMIN_ONLY_METHODS.has(methodName)) {
      throw new Error(`Method "${methodName}" is not permitted for guest accounts`);
    }
  }
}

/** Enforce guest policy caps on runtime, runner, profile, and concurrency. */
export function enforceGuestSettings(session, settings) {
  if (session?.role !== "guest") return settings;
  const limits = session.limits ?? {
    maxAgents: DEFAULT_GUEST_MAX_AGENTS,
    maxConcurrency: DEFAULT_GUEST_MAX_CONCURRENCY,
    allowedRuntimes: DEFAULT_GUEST_RUNTIMES,
    allowHostDesktop: false,
  };
  if (!limits.allowedRuntimes.includes(settings.runtime)) {
    throw new Error(`Runtime "${settings.runtime}" is not enabled for this guest token`);
  }
  const allowHostDesktop = limits.allowHostDesktop === true;
  const respondTo = settings.respondTo || "owner-only";
  let runner;
  if (allowHostDesktop) {
    if (settings.runner === "host" && respondTo !== "owner-only") {
      throw new Error('Shared agents (respondTo != "owner-only") must use a sandboxed runner (docker)');
    }
    runner = respondTo !== "owner-only" ? "docker" : settings.runner || "host";
  } else {
    if (settings.runner === "host") {
      throw new Error("Guest agents must run in a sandboxed runner (docker)");
    }
    runner = "docker";
  }
  const concurrency = Math.min(settings.concurrency, limits.maxConcurrency);
  return {
    ...settings,
    runner,
    profile: "",
    concurrency,
  };
}

/**
 * Whether a desktop ticket is valid for the given listener ("admin" = the
 * tailnet listener, "guest" = the public token listener). On the token listener
 * a ticket must have been minted by a token session (guest or admin token);
 * a ticket minted on the tailnet listener has no token and is refused there,
 * and the tailnet listener refuses token-minted tickets in turn.
 */
export function isValidDesktopTicket(view, listenerRole, now = Date.now()) {
  if (!view || typeof view !== "object") return false;
  if (!Number.isFinite(view.expires) || view.expires < now) return false;
  // Tailnet listener: only tickets minted there (no token behind them).
  if (listenerRole === "admin") return view.role === "admin" && !view.tokenId;
  if (listenerRole === "guest") {
    return (
      (view.role === "guest" || view.role === "admin") &&
      typeof view.tokenId === "string" &&
      view.tokenId.length > 0
    );
  }
  return false;
}

/**
 * Whether the token behind a token-listener desktop ticket still allows the
 * view: it must exist, be unrevoked and have the ticket's role. Admin tokens
 * always may; guest tokens only with `allowHostDesktop` or `allowSandboxDesktop`
 * (assertGuestDesktop keeps the latter to sandboxed agents).
 */
export function desktopTicketTokenAllowed(view, tokenRecord) {
  if (!view || !tokenRecord || tokenRecord.revokedAt) return false;
  if (tokenRecord.id !== view.tokenId) return false;
  const role = tokenRole(tokenRecord);
  if (role !== view.role) return false;
  if (role === "admin") return true;
  return tokenRecord.allowHostDesktop === true || sandboxDesktopAllowed(tokenRecord);
}

/**
 * A guest may use an agent's desktop only as its token allows: a host-runner
 * desktop needs `allowHostDesktop`; a sandboxed agent's sidecar desktop needs
 * either flag. Admin sessions always may.
 */
export function assertGuestDesktop(session, m) {
  if (session?.role !== "guest") return;
  const limits = session.limits ?? {};
  if (limits.allowHostDesktop === true) return;
  const sandboxed = Boolean(m?.runner && m.runner !== "host");
  if (sandboxed && limits.allowSandboxDesktop === true) return;
  throw new Error("Desktops are not enabled for this guest token");
}

/** Select running guest desktops that have exceeded `idleMs` with no active viewers. */
export function findIdleGuestDesktops({ metas, isRunning, activeViewers, lastActivityAt, now = Date.now(), idleMs }) {
  if (!Number.isFinite(idleMs) || idleMs <= 0) return [];
  const idle = [];
  for (const m of metas) {
    if (!m?.createdByTokenId || !m.pubkey) continue;
    if (!isRunning(m.pubkey)) continue;
    if ((activeViewers(m.pubkey) || 0) > 0) continue;
    const lastAt = lastActivityAt(m.pubkey);
    if (Number.isFinite(lastAt) && now - lastAt >= idleMs) {
      idle.push(m.pubkey);
    }
  }
  return idle;
}

/**
 * Simple sliding-window auth failure rate limiter (per remote address).
 *
 * Buckets are capped at `maxKeys` so rotating/spoofed addresses cannot grow the
 * map without bound: expired buckets are swept periodically and, once over the
 * cap, the least-recently-touched buckets are evicted (they start empty again,
 * so an evicted attacker simply gets a fresh window).
 */
export function createAuthRateLimiter({
  maxFailures = 10,
  windowMs = 60_000,
  maxKeys = 10_000,
  now = () => Date.now(),
  sweepEvery = 256,
} = {}) {
  const buckets = new Map();
  const limit = Math.max(1, Number(maxKeys) || 10_000);
  const sweepInterval = Math.max(1, Number(sweepEvery) || 256);
  let opsSinceSweep = 0;

  function prune(key, at) {
    const list = buckets.get(key);
    if (!list) return [];
    const cutoff = at - windowMs;
    while (list.length && list[0] <= cutoff) list.shift();
    if (!list.length) buckets.delete(key);
    return list;
  }

  /** Drop expired buckets, then the oldest ones while over the cap. */
  function sweep(at = now()) {
    for (const key of [...buckets.keys()]) prune(key, at);
    while (buckets.size > limit) buckets.delete(buckets.keys().next().value);
    opsSinceSweep = 0;
  }

  function maybeSweep(at) {
    if (++opsSinceSweep >= sweepInterval || buckets.size > limit) sweep(at);
  }

  return {
    isLimited(key) {
      const at = now();
      return prune(key, at).length >= maxFailures;
    },
    recordFailure(key) {
      const at = now();
      const list = prune(key, at);
      list.push(at);
      // Re-insert so the map's insertion order tracks recency for eviction.
      buckets.delete(key);
      buckets.set(key, list);
      maybeSweep(at);
    },
    clear(key) {
      buckets.delete(key);
    },
    /** Current bucket count (tests/ops). */
    size() {
      return buckets.size;
    },
    sweep,
  };
}
