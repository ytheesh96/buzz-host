// Shared constants and local server URL / access token storage for the Remote Agents plugin.

export const URL_KEY = "local.buzz-host.url";
export const TOKEN_KEY = "local.buzz-host.token";
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
