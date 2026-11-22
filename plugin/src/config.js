// Shared constants and local server URL storage for the Omarchy agents plugin.

export const URL_KEY = "local.buzz-host.url";
export const DEFAULT_URL = "wss://omarchy.tail65c5a9.ts.net:8447";
export const RUNTIMES = [
  { id: "claude", title: "Claude Code" },
  { id: "codex", title: "Codex" },
  { id: "hermes", title: "Hermes" },
  { id: "antigravity", title: "Antigravity" },
];
export const DEFAULT_CONCURRENCY = 4;
export const CONCURRENCY_VALUES = [1, 2, 4, 6, 8, 12, 16];
export const CONCURRENCY_OPTIONS = CONCURRENCY_VALUES.map((n) => ({
  value: String(n),
  label: n === 1 ? "1 (sequential)" : n === DEFAULT_CONCURRENCY ? `${n} (default)` : `${n} parallel`,
}));
export const EMPTY = { runtime: "claude", model: "", instructions: "", profile: "", concurrency: DEFAULT_CONCURRENCY };
export const PROFILE_HINT = "Which Hermes home runs this agent: its config, memory, skills and provider.";

export const asConfig = (value) => ({ ...EMPTY, ...(value && typeof value === "object" ? value : {}) });

export function storedUrl() {
  try {
    return localStorage.getItem(URL_KEY) || DEFAULT_URL;
  } catch {
    return DEFAULT_URL;
  }
}
