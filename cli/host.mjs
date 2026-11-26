// What the management subcommands (status, down, restart, pair, logs, doctor)
// share: where this machine's buzz-host lives, its service manager, its agents
// and config, plus the small argument parser. Everything that touches the
// machine is injectable so tests run against a temporary HOME with fake
// systemctl/launchctl.

import { execFile } from "node:child_process";
import nodeFs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createServiceManager, runDir } from "../server/service-manager.mjs";
import { describeBundle, hostPaths } from "./up.mjs";

const HEX64 = /^[0-9a-f]{64}$/;
const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** A wrong command line: reported with exit code 2. */
export class UsageError extends Error {}

/**
 * Parse `argv` against `spec`: `flags` (booleans), `values` (take one
 * argument) and `short` ({n: "lines"}). Returns {opts, positional}.
 */
export function parseArgs(argv, { flags = [], values = [], short = {} } = {}) {
  const opts = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    if (arg === "-h") arg = "--help";
    else if (/^-[a-zA-Z]$/.test(arg) && short[arg[1]]) arg = `--${short[arg[1]]}`;
    if (!arg.startsWith("--")) {
      if (arg.startsWith("-") && arg !== "-") throw new UsageError(`unknown option ${arg}`);
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (name === "help" || flags.includes(name)) opts[name] = true;
    else if (values.includes(name)) {
      const value = argv[++i];
      if (value === undefined) throw new UsageError(`${arg} needs a value`);
      opts[name] = value;
    } else throw new UsageError(`unknown option ${arg}`);
  }
  return { opts, positional };
}

/** A positive integer option, or `fallback` when it was not given. */
export function intOption(value, name, fallback, { max = Infinity } = {}) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new UsageError(`--${name} must be a whole number from 1 to ${max}`);
  return n;
}

/** stdout/stderr writers that add the newline. */
export function stdio() {
  return {
    out: (text = "") => process.stdout.write(`${text}\n`),
    err: (text = "") => process.stderr.write(`${text}\n`),
  };
}

/** Print `value` as one JSON document (the shape `--json` promises). */
export const printJson = (io, value) => io.out(JSON.stringify(value, null, 2));

export function createHost(deps = {}) {
  const {
    root = defaultRoot,
    platform = process.platform,
    env = process.env,
    home = os.homedir(),
    uid = process.getuid(),
    user = os.userInfo().username,
    hostname = os.hostname(),
    fs = nodeFs,
    run = promisify(execFile),
    fetchImpl = fetch,
  } = deps;
  if (platform !== "linux" && platform !== "darwin")
    throw new Error(`buzz-host does not support ${platform} hosts (only linux and darwin)`);

  const paths = hostPaths(home, platform);
  // The same overrides buzz-host-tokens always honored.
  if (env.BUZZ_HOST_TOKENS_FILE) paths.tokens = env.BUZZ_HOST_TOKENS_FILE;
  if (env.BUZZ_HOST_CONFIG) paths.config = env.BUZZ_HOST_CONFIG;
  paths.agents = path.join(home, ".local/share/buzz-host/agents");
  paths.machineId = path.join(home, ".local/share/buzz-host/machine-id");
  const services =
    deps.services ?? createServiceManager({ platform, run, fs, home, libDir: paths.lib, uid, env });

  const host = {
    root,
    platform,
    env,
    home,
    uid,
    user,
    hostname,
    fs,
    run,
    fetchImpl,
    paths,
    services,
    runDir: runDir({ platform, env, uid }),

    bundle: () => describeBundle(root, { fs }),

    /** config.json, or {} when it is missing or unreadable (the server then uses its defaults). */
    async config() {
      try {
        const parsed = JSON.parse(await fs.readFile(paths.config, "utf8"));
        return parsed && typeof parsed === "object" ? parsed : {};
      } catch {
        return {};
      }
    },

    /** The agents this host runs (their meta.json), sorted by name. */
    async agents() {
      const names = (await fs.readdir(paths.agents).catch(() => [])).filter((n) => HEX64.test(n));
      const rows = [];
      for (const pubkey of names) {
        try {
          const meta = JSON.parse(await fs.readFile(path.join(paths.agents, pubkey, "meta.json"), "utf8"));
          rows.push({
            pubkey,
            name: typeof meta.name === "string" && meta.name ? meta.name : pubkey.slice(0, 8),
            runtime: typeof meta.runtime === "string" ? meta.runtime : "",
            runner: typeof meta.runner === "string" ? meta.runner : "host",
            activated: meta.activated === true,
          });
        } catch {}
      }
      return rows.sort((a, b) => a.name.localeCompare(b.name) || a.pubkey.localeCompare(b.pubkey));
    },

    /** One agent by full pubkey, a pubkey prefix of 4+ hex digits, or (case-insensitive) name. */
    async findAgent(selector) {
      const agents = await host.agents();
      const wanted = String(selector).trim().toLowerCase();
      const matches = agents.filter((a) => a.pubkey === wanted);
      if (!matches.length && /^[0-9a-f]{4,63}$/.test(wanted)) matches.push(...agents.filter((a) => a.pubkey.startsWith(wanted)));
      if (!matches.length) matches.push(...agents.filter((a) => a.name.toLowerCase() === wanted));
      if (!matches.length) throw new Error(`no agent matches "${selector}" (see \`buzz-host status\`)`);
      if (matches.length > 1)
        throw new Error(`"${selector}" matches ${matches.length} agents: ${matches.map((a) => `${a.name} (${a.pubkey.slice(0, 8)})`).join(", ")}; use a longer pubkey prefix`);
      return matches[0];
    },

    /** Does buzz-host answer /health on 127.0.0.1:<port>? */
    async healthy(port, timeoutMs = 2_000) {
      if (!Number.isInteger(port) || port < 1) return false;
      try {
        return (await fetchImpl(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) })).ok;
      } catch {
        return false;
      }
    },
  };
  return host;
}

/** The ports buzz-host listens on, per its config: the token listener always, the tailnet one only with allowLogins. */
export function listenerPorts(config) {
  const guest = Number.isInteger(config.guestPort) && config.guestPort > 0 ? config.guestPort : 8467;
  const tailnet = Array.isArray(config.allowLogins) && config.allowLogins.length ? (Number.isInteger(config.port) ? config.port : 8457) : null;
  return { guest, tailnet };
}
