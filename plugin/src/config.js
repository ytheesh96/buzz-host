// Shared constants and local server URL / access token storage for the Remote Agents plugin.

export const URL_KEY = "local.buzz-host.url";
export const TOKEN_KEY = "local.buzz-host.token";
export const MACHINES_KEY = "local.buzz-host.machines.v1";
export const AGENT_HOSTS_KEY = "local.buzz-host.agent-hosts.v1";
export const ACTIVE_MACHINE_KEY = "local.buzz-host.active-machine.v1";
export const MACHINES_CHANGED_EVENT = "buzz-host:machines-changed";
export const AGENT_HOSTS_CHANGED_EVENT = "buzz-host:agent-hosts-changed";
export const DEFAULT_URL = "wss://omarchy.tail65c5a9.ts.net:8447";
export const RUNTIMES = [
  { id: "claude", title: "Claude Code" },
  { id: "codex", title: "Codex" },
  { id: "hermes", title: "Hermes" },
  { id: "antigravity", title: "Antigravity" },
];
export const RUNNERS = [
  { id: "host", title: "Host (owner-only)" },
  { id: "docker", title: "Docker sandbox" },
];
export const RESPOND_TO_OPTIONS = [
  { value: "owner-only", label: "Owner only" },
  { value: "allowlist", label: "Allowlist (specific pubkeys)" },
  { value: "anyone", label: "Anyone in shared channels" },
];
export const DEFAULT_CONCURRENCY = 4;
export const CONCURRENCY_VALUES = [1, 2, 4, 6, 8, 12, 16];
export const CONCURRENCY_OPTIONS = CONCURRENCY_VALUES.map((n) => ({
  value: String(n),
  label: n === 1 ? "1 (sequential)" : n === DEFAULT_CONCURRENCY ? `${n} (default)` : `${n} parallel`,
}));
export const EMPTY = {
  runtime: "claude",
  model: "",
  instructions: "",
  profile: "",
  concurrency: DEFAULT_CONCURRENCY,
  runner: "host",
  respondTo: "owner-only",
  respondToAllowlist: [],
};
export const PROFILE_HINT = "Which Hermes home runs this agent: its config, memory, skills and provider.";

export const AGENT_TYPE_ID = "omarchy";
export const CORE_PLUGIN_ID = "local.buzz-host";

/** Matches self-hosted agents created via Remote Agents (omarchy / local.buzz-host/omarchy). */
export function isSelfHostedAgent(agent) {
  const type = agent?.type;
  return (
    type === AGENT_TYPE_ID ||
    type === `${CORE_PLUGIN_ID}/${AGENT_TYPE_ID}` ||
    (typeof type === "string" && type.endsWith(`/${AGENT_TYPE_ID}`))
  );
}

export function parseAllowlistText(value) {
  const items = Array.isArray(value) ? value : String(value ?? "").split(/[\s,]+/);
  const seen = new Set();
  const out = [];
  for (const raw of items) {
    const clean = String(raw ?? "").trim().toLowerCase();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}

export function formatAllowlistText(list) {
  return Array.isArray(list) ? list.join("\n") : String(list ?? "");
}

/**
 * Parse a Server field input that may be either a plain wss:// URL or a
 * 1-paste guest invite link (`wss://host/_buzz-host#token=bhg_...`).
 */
export function parseInviteInput(raw) {
  const text = String(raw ?? "").trim();
  const hashIndex = text.indexOf("#");
  if (hashIndex < 0) return { url: text, token: undefined };
  const base = text.slice(0, hashIndex).trim();
  const fragment = text.slice(hashIndex + 1);
  const params = new URLSearchParams(fragment);
  const token = params.get("token")?.trim();
  if (!token) return { url: text, token: undefined };
  return { url: base, token };
}

/** Update respondTo while enforcing the sandbox invariant in the UI draft. */
export function applyRespondToChange(draft, respondTo) {
  const next = { ...draft, respondTo };
  if (respondTo !== "owner-only" && next.runner === "host") {
    next.runner = "docker";
    next.profile = "";
  }
  if (respondTo !== "allowlist") {
    next.respondToAllowlist = [];
  }
  return next;
}

/** Update runner while keeping respondTo/profile consistent in the UI draft. */
export function applyRunnerChange(draft, runner) {
  const next = { ...draft, runner };
  if (runner !== "host") {
    next.profile = "";
  } else if (next.respondTo !== "owner-only") {
    next.respondTo = "owner-only";
    next.respondToAllowlist = [];
  }
  return next;
}

/** Enforce guest-mode constraints on an agent draft (runner, allowed runtimes, concurrency cap). */
export function applyGuestConstraints(draft, serverInfo) {
  if (serverInfo?.role !== "guest") return draft;
  const limits = serverInfo.limits ?? {};
  const allowedRuntimes = Array.isArray(limits.allowedRuntimes) && limits.allowedRuntimes.length
    ? limits.allowedRuntimes
    : RUNTIMES.map((r) => r.id);
  const maxConcurrency = Number(limits.maxConcurrency) > 0 ? Number(limits.maxConcurrency) : 2;
  const allowHostDesktop = limits.allowHostDesktop === true;
  const next = { ...draft };
  const respondTo = next.respondTo || "owner-only";
  if (allowHostDesktop && respondTo === "owner-only") {
    next.runner = next.runner === "docker" ? "docker" : "host";
  } else {
    next.runner = "docker";
  }
  next.profile = "";
  if (!allowedRuntimes.includes(next.runtime)) {
    next.runtime = allowedRuntimes[0];
    next.model = "";
  }
  const currentConc = Number(next.concurrency) || maxConcurrency;
  next.concurrency = Math.min(currentConc, maxConcurrency);
  return next;
}

export const asConfig = (value) => {
  const merged = { ...EMPTY, ...(value && typeof value === "object" ? value : {}) };
  merged.runner = merged.runner || (merged.respondTo && merged.respondTo !== "owner-only" ? "docker" : "host");
  merged.respondTo = merged.respondTo || "owner-only";
  merged.respondToAllowlist = parseAllowlistText(merged.respondToAllowlist);
  return merged;
};

export function storedUrl() {
  try {
    return localStorage.getItem(URL_KEY) || DEFAULT_URL;
  } catch {
    return DEFAULT_URL;
  }
}

export function setStoredUrl(url) {
  try {
    const clean = String(url ?? "").trim();
    if (clean) localStorage.setItem(URL_KEY, clean);
    else localStorage.removeItem(URL_KEY);
  } catch {}
}

export function storedToken() {
  try {
    return (localStorage.getItem(TOKEN_KEY) || "").trim();
  } catch {
    return "";
  }
}

export function setStoredToken(token) {
  try {
    const clean = String(token ?? "").trim();
    if (clean) localStorage.setItem(TOKEN_KEY, clean);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {}
}

/** First wss:// route URL on a machine record, falling back to `machine.url`. */
export function machineWssUrl(machine) {
  if (!machine || typeof machine !== "object") return "";
  if (Array.isArray(machine.routes)) {
    for (const route of machine.routes) {
      if (route?.type === "wss" && typeof route.url === "string" && route.url.trim()) {
        return route.url.trim();
      }
    }
  }
  return typeof machine.url === "string" ? machine.url.trim() : "";
}

/** First Iroh route on a machine record, or null if none. */
export function machineIrohRoute(machine) {
  if (!machine || typeof machine !== "object") return null;
  if (Array.isArray(machine.routes)) {
    for (const route of machine.routes) {
      if (route?.type === "iroh" && typeof route.endpointAddr === "string" && route.endpointAddr.trim()) {
        return {
          type: "iroh",
          endpointAddr: route.endpointAddr.trim(),
          ...(typeof route.nodeId === "string" && route.nodeId.trim() ? { nodeId: route.nodeId.trim() } : {}),
        };
      }
    }
  }
  return null;
}

/** Join a WebSocket path/query (e.g. `/desktop?ticket=...`) onto a wss:// base URL. */
export function withWsPath(baseUrl, wsPath) {
  const cleanBase = typeof baseUrl === "string" ? baseUrl.trim() : "";
  if (!cleanBase || !wsPath) return cleanBase;
  try {
    const base = new URL(cleanBase);
    const target = new URL(wsPath, "ws://path.invalid");
    base.pathname = `${base.pathname.replace(/\/+$/, "")}${target.pathname}`;
    base.search = target.search;
    return base.toString();
  } catch {
    return `${cleanBase.replace(/\/+$/, "")}${wsPath}`;
  }
}

/** Stable key for a machine's dialable routes + token so pooled sockets refresh on route updates. */
export function machineRoutesKey(machine) {
  if (!machine || typeof machine !== "object") return "";
  const wss = machineWssUrl(machine);
  const iroh = machineIrohRoute(machine)?.endpointAddr ?? "";
  const token = typeof machine.token === "string" ? machine.token.trim() : "";
  return `${wss}\0${iroh}\0${token}`;
}

/**
 * Resolve ordered WebSocket candidates for a machine:
 *   1. Loopback Iroh tunnel (`ws://127.0.0.1:...`) when the machine has an
 *      `iroh` route (`endpointAddr`) AND an access token (Iroh lands on the
 *      token-gated `guestPort`) AND the Tauri bridge is available.
 *   2. `wss` route (with optional `path` joined), as fallback or primary.
 */
export async function resolveMachineWsCandidates(machine, { path } = {}) {
  const candidates = [];
  if (!machine || typeof machine !== "object") return candidates;
  const wssBase = machineWssUrl(machine);
  const wssUrl = wssBase ? withWsPath(wssBase, path) : "";
  const iroh = machineIrohRoute(machine);
  const token = typeof machine.token === "string" ? machine.token.trim() : "";

  if (iroh && token) {
    let irohUrl = null;
    const bridge = globalThis.__BUZZ_IROH_TUNNEL__;
    if (bridge && typeof bridge.resolveUrl === "function") {
      try {
        const resolved = await bridge.resolveUrl(machine, path || undefined);
        if (typeof resolved === "string" && resolved.trim()) {
          const clean = resolved.trim();
          if (!wssUrl || clean !== wssUrl) {
            irohUrl = clean;
          }
        }
      } catch {
        // Fall back to wss below.
      }
    } else if (typeof globalThis.__TAURI_INTERNALS__?.invoke === "function") {
      try {
        const resolved = await globalThis.__TAURI_INTERNALS__.invoke("iroh_tunnel_endpoint", {
          machineId: machine.id,
          endpointAddr: iroh.endpointAddr,
          path: path ?? null,
        });
        if (typeof resolved === "string" && resolved.trim()) {
          irohUrl = resolved.trim();
        }
      } catch {
        // Fall back to wss below.
      }
    }
    if (irohUrl) {
      candidates.push({ routeType: "iroh", url: irohUrl });
    }
  }

  if (wssUrl && !candidates.some((c) => c.url === wssUrl)) {
    candidates.push({ routeType: "wss", url: wssUrl });
  }
  return candidates;
}

function normalizeStoredMachine(entry) {
  if (!entry || typeof entry !== "object") return null;
  const id = typeof entry.id === "string" ? entry.id.trim() : "";
  const url = machineWssUrl(entry);
  if (!id || (!url && !(Array.isArray(entry.routes) && entry.routes.length))) return null;
  return {
    id,
    name: typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : id,
    url,
    token: typeof entry.token === "string" ? entry.token.trim() : "",
    routes: Array.isArray(entry.routes) ? entry.routes : url ? [{ type: "wss", url }] : [],
    platform: typeof entry.platform === "string" ? entry.platform : undefined,
    host: typeof entry.host === "string" ? entry.host : undefined,
    role: entry.role === "admin" || entry.role === "guest" ? entry.role : undefined,
    capabilities: entry.capabilities && typeof entry.capabilities === "object" ? entry.capabilities : undefined,
  };
}

/** Read configured machines from Buzz's multi-machine registry, falling back to legacy single-URL storage. */
export function storedMachines() {
  try {
    const raw = localStorage.getItem(MACHINES_KEY);
    if (raw !== null) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const list = [];
        const seen = new Set();
        for (const item of parsed) {
          const norm = normalizeStoredMachine(item);
          if (!norm || seen.has(norm.id)) continue;
          seen.add(norm.id);
          list.push(norm);
        }
        if (list.length) return list;
      }
    }
  } catch {}
  const url = storedUrl();
  if (!url) return [];
  return [
    {
      id: "default",
      name: "Remote machine",
      url,
      token: storedToken(),
      routes: [{ type: "wss", url }],
    },
  ];
}

export function machineById(id) {
  const clean = typeof id === "string" ? id.trim() : "";
  if (!clean) return undefined;
  return storedMachines().find((m) => m.id === clean);
}

export function activeMachine() {
  const machines = storedMachines();
  if (!machines.length) return undefined;
  try {
    const activeId = localStorage.getItem(ACTIVE_MACHINE_KEY)?.trim();
    if (activeId) {
      const hit = machines.find((m) => m.id === activeId);
      if (hit) return hit;
    }
  } catch {}
  return machines[0];
}

export function storedAgentHosts() {
  try {
    const raw = localStorage.getItem(AGENT_HOSTS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof k === "string" && typeof v === "string" && k.trim() && v.trim()) {
        out[k.trim().toLowerCase()] = v.trim();
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function setStoredAgentHost(pubkey, machineId) {
  const cleanPubkey = typeof pubkey === "string" ? pubkey.trim().toLowerCase() : "";
  const cleanId = typeof machineId === "string" ? machineId.trim() : "";
  if (!cleanPubkey || !cleanId) return;
  try {
    const current = storedAgentHosts();
    if (current[cleanPubkey] === cleanId) return;
    current[cleanPubkey] = cleanId;
    localStorage.setItem(AGENT_HOSTS_KEY, JSON.stringify(current));
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(AGENT_HOSTS_CHANGED_EVENT));
    }
  } catch {}
}

export function mergeStoredAgentHosts(machineId, pubkeys) {
  const cleanId = typeof machineId === "string" ? machineId.trim() : "";
  if (!cleanId) return;
  try {
    const current = storedAgentHosts();
    const owned = new Set(
      (Array.isArray(pubkeys) ? pubkeys : [])
        .map((p) => (typeof p === "string" ? p.trim().toLowerCase() : ""))
        .filter(Boolean),
    );
    const next = {};
    for (const [pubkey, existingId] of Object.entries(current)) {
      if (existingId === cleanId && !owned.has(pubkey)) continue;
      next[pubkey] = existingId;
    }
    for (const pubkey of owned) next[pubkey] = cleanId;
    localStorage.setItem(AGENT_HOSTS_KEY, JSON.stringify(next));
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(AGENT_HOSTS_CHANGED_EVENT));
    }
  } catch {}
}

export function machineForAgent(pubkey) {
  const clean = typeof pubkey === "string" ? pubkey.trim().toLowerCase() : "";
  if (!clean) return undefined;
  const machineId = storedAgentHosts()[clean];
  return machineId ? machineById(machineId) : undefined;
}
