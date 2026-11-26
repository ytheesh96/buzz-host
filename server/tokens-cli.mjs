// The access-token commands behind `buzz-host tokens …` and the
// `buzz-host-tokens` compatibility shim. Deployed next to auth.mjs.
//
//   create --label Alice [--owner <64-hex>] [--max-agents 2] [--max-concurrency 2] [--runtimes hermes,claude,antigravity] [--allow-host-desktop] [--no-sandbox-desktop]
//   create-admin --label "My laptop" [--owner <64-hex>] [--url wss://...]      (same as: create --role admin ...)
//   list
//   revoke <tok_...>
//   every command takes --json and --file <tokens.json>
//
// Guest tokens (bhg_) are scoped, sandboxed friend accounts. Admin tokens (bha_)
// give full access to this host over the token listener, for the owner's own
// devices that are not on the tailnet (server-only Funnel, zrok, any wss://).

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildInviteUrl, createTokenStore } from "./auth.mjs";

/** What buzz-host.mjs advertises when config.json has no publicGuestUrl. */
export const LEGACY_PUBLIC_GUEST_URL = "wss://omarchy.tail65c5a9.ts.net/_buzz-host";
export const DEFAULT_GUEST_PORT = 8467;

export function parseFlags(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1];
      if (val === undefined || val.startsWith("--")) flags[key] = true;
      else {
        flags[key] = val;
        i++;
      }
    } else {
      rest.push(a);
    }
  }
  return { flags, rest };
}

/**
 * The URL clients should connect to: config.publicGuestUrl when set; the
 * legacy default when the key is absent (what buzz-host.mjs itself uses); and
 * the local token listener when it is empty (a `buzz-host up` host that has no
 * public URL yet).
 */
export function resolvePublicUrl(config) {
  const value = config?.publicGuestUrl;
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value === "") return `ws://127.0.0.1:${Number.isInteger(config?.guestPort) ? config.guestPort : DEFAULT_GUEST_PORT}`;
  return LEGACY_PUBLIC_GUEST_URL;
}

export async function readConfig(configFile) {
  try {
    const parsed = JSON.parse(await fs.readFile(configFile, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function defaultTokenPaths({ env = process.env, home = os.homedir() } = {}) {
  return {
    tokensFile: env.BUZZ_HOST_TOKENS_FILE || path.join(home, ".local/share/buzz-host/tokens.json"),
    configFile: env.BUZZ_HOST_CONFIG || path.join(home, ".config/buzz-host/config.json"),
  };
}

/**
 * Run one tokens command. Returns the exit code: 0 ok, 1 error, 2 usage.
 * `prog` is how the command is spelled in hints ("buzz-host tokens" or
 * "buzz-host-tokens").
 */
export async function runTokens(
  argv,
  {
    prog = "buzz-host tokens",
    env = process.env,
    home = os.homedir(),
    out = (line) => process.stdout.write(`${line}\n`),
    err = (line) => process.stderr.write(`${line}\n`),
    ...overrides
  } = {},
) {
  const [cmd, ...args] = argv;
  const { flags, rest } = parseFlags(args);
  const defaults = defaultTokenPaths({ env, home });
  const tokensFile =
    typeof flags.file === "string" && flags.file.trim() ? flags.file.trim() : (overrides.tokensFile ?? defaults.tokensFile);
  const configFile = overrides.configFile ?? defaults.configFile;
  const store = createTokenStore({ filePath: tokensFile });
  const role = cmd === "create-admin" ? "admin" : typeof flags.role === "string" ? flags.role.trim().toLowerCase() : "guest";
  const json = (value) => out(JSON.stringify(value, null, 2));
  const publicUrl = async () => (typeof flags.url === "string" && flags.url.trim() ? flags.url.trim() : resolvePublicUrl(await readConfig(configFile)));

  try {
    if ((cmd === "create" || cmd === "create-admin") && role !== "guest" && role !== "admin") {
      throw new Error(`--role must be "guest" or "admin", not "${flags.role}"`);
    }
    if ((cmd === "create" || cmd === "create-admin") && role === "admin") {
      const guestOnly = ["max-agents", "max-concurrency", "runtimes", "allow-host-desktop", "no-sandbox-desktop", "trusted"].filter((f) => f in flags);
      if (guestOnly.length) throw new Error(`Admin tokens have no guest caps; drop --${guestOnly.join(", --")}`);
      const { token, record } = await store.createAdmin({ label: flags.label ?? rest[0], ownerPubkey: flags.owner });
      const pairingUrl = buildInviteUrl(await publicUrl(), token);
      if (flags.json) {
        json({ token, pairingUrl, inviteUrl: pairingUrl, record });
      } else {
        out(`Created ADMIN token ${record.id} for "${record.label}"`);
        out("Full access to this host (all agents, desktops, guest tokens). Keep it like a password.");
        if (record.ownerPubkey) out(`Owner: ${record.ownerPubkey}`);
        out(`\nToken (shown once):      ${token}`);
        out(`1-paste pairing URL:     ${pairingUrl}`);
        out(`Revoke with:             ${prog} revoke ${record.id}`);
      }
    } else if (cmd === "create") {
      const allowedRuntimes =
        typeof flags.runtimes === "string"
          ? flags.runtimes
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : undefined;
      const allowHostDesktop = Boolean(flags["allow-host-desktop"] || flags.trusted);
      // A desktop in the agent's own container (on by default); nothing runs on the host as you.
      const allowSandboxDesktop = !flags["no-sandbox-desktop"];
      const { token, record } = await store.create({
        label: flags.label ?? rest[0],
        ownerPubkey: flags.owner,
        maxAgents: flags["max-agents"],
        maxConcurrency: flags["max-concurrency"],
        allowedRuntimes,
        allowHostDesktop,
        allowSandboxDesktop,
      });
      const inviteUrl = buildInviteUrl(await publicUrl(), token);
      if (flags.json) {
        json({ token, inviteUrl, record });
      } else {
        out(`Created guest token ${record.id} for "${record.label}"`);
        out(
          `Limits: maxAgents=${record.maxAgents}, maxConcurrency=${record.maxConcurrency}, runtimes=${record.allowedRuntimes.join(",")}, hostDesktop=${record.allowHostDesktop ? "yes (trusted)" : "no"}, sandboxDesktop=${record.allowSandboxDesktop !== false ? "yes" : "no"}`,
        );
        if (record.ownerPubkey) out(`Bound owner: ${record.ownerPubkey}`);
        else out("Bound owner: (will bind automatically on first agent activation)");
        out(`\nToken (shown once):      ${token}`);
        out(`1-paste invite URL:      ${inviteUrl}`);
      }
    } else if (cmd === "list") {
      const tokens = await store.list();
      if (flags.json) {
        json({ tokens });
      } else if (!tokens.length) {
        out("No access tokens.");
      } else {
        for (const t of tokens) {
          const status = t.revokedAt ? `REVOKED (${t.revokedAt})` : "active";
          const owner = t.ownerPubkey ? t.ownerPubkey.slice(0, 12) + "…" : t.role === "admin" ? "-" : "unbound";
          const detail =
            t.role === "admin"
              ? "full access"
              : `caps=${t.maxAgents}a/${t.maxConcurrency}c  runtimes=${t.allowedRuntimes.join(",")}${t.allowHostDesktop ? "  hostDesktop=yes" : ""}${t.allowSandboxDesktop !== false ? "  sandboxDesktop=yes" : "  sandboxDesktop=no"}`;
          out(`${t.id}  ${t.role.padEnd(5)}  ${t.label}  [${status}]  owner=${owner}  ${detail}`);
        }
      }
    } else if (cmd === "revoke") {
      const id = rest[0] || flags.id;
      const record = await store.revoke(id);
      if (flags.json) json({ record });
      else {
        out(`Revoked ${record.role} token ${record.id} (${record.label}) at ${record.revokedAt}`);
        out("buzz-host closes connections still using it within about 15 seconds.");
      }
    } else {
      err(`Usage: ${prog} <create|create-admin|list|revoke> [options]`);
      return 2;
    }
    return 0;
  } catch (error) {
    err(`Error: ${error.message}`);
    return 1;
  }
}
