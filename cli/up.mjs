// `buzz-host up`: install or upgrade this bundle on this machine, make sure
// buzz-host is running, and print how to connect to it. Idempotent: a re-run
// with the same bundle changes nothing and restarts nothing; a re-run with a
// newer bundle upgrades in place and restarts only buzz-host (agents run in
// their own buzz-agent@<pubkey> units / LaunchAgents and keep running).
//
// `--json` prints exactly one JSON object on stdout (the contract the Buzz
// app's machine list reads, see README "buzz-host up --json"):
//   {"version": "<bundle version>", "url": "<ws(s)://…>", "token": "bha_…", "pubkey": "<iroh node id>"}
// `pubkey` is present only when this machine's iroh endpoint is up. Every
// other message goes to stderr.

import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import nodeFs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { loadMachineKey, parseOwnerProof, parsePubkey } from "../server/discovery.mjs";

export const DEFAULT_PORT = 8457;
export const DEFAULT_GUEST_PORT = 8467;
export const SERVER_LABEL = "com.buzz-host.server";
export const UP_TOKEN_LABEL = "buzz-host up";
export const DEFAULT_TAILSCALE_PATH = "/_buzz-host";
/** Prebuilt binaries a bundle ships in bin/, installed into <lib>/bin. */
export const BUNDLE_BINARIES = ["buzz-acp", "buzz", "buzz-host-iroh"];
const HEALTH_TIMEOUT_MS = 30_000;
const IROH_WAIT_MS = 5_000;

const defaultRun = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const here = path.dirname(fileURLToPath(import.meta.url));

export const UP_USAGE = `Usage: buzz-host up [options]

Install or upgrade buzz-host from this bundle, start it, and print connection info.
Safe to re-run: nothing restarts unless something changed. Agents keep running.

Options:
  --json             Print {"version","url","token","pubkey"} on stdout only
  --url <wss://…>    Public URL clients use (saved as publicGuestUrl)
  --guest-port <n>   Token listener port for a new config (default ${DEFAULT_GUEST_PORT})
  --port <n>         Tailscale-login listener port for a new config (default ${DEFAULT_PORT})
  --tailscale-serve  Publish the token listener on this machine's tailnet HTTPS name
                     (tailscale serve --bg) and save wss://<name>.ts.net<path> as the URL.
                     buzz-host itself stays on 127.0.0.1.
  --tailscale-path <path>  Path for --tailscale-serve (default ${DEFAULT_TAILSCALE_PATH})
  --lan / --no-lan   Bind the token listener to 0.0.0.0 (LAN, still token-gated) /
                     back to 127.0.0.1 (saved as guestHost)
  --owner <npub|hex> Your Buzz identity: announce this machine to you even with no agents
  --relay <wss://…>  Your community relay for that announcement (repeatable; added to
                     discoveryRelays)
  --owner-proof <json>  Your attestation of this machine's key (Buzz → Settings → Security
                     → authorize an identity; \`buzz-host pair\` prints the key)
  --force            Reinstall the files even if this bundle is already installed
  --no-service       Install files and config only; don't touch systemd/launchd
  --no-linger        Linux: don't enable lingering (buzz-host stops at logout)
  --no-adapters      Don't npm-install the Claude/Codex ACP adapters
  -h, --help         Show this help`;

export function parseUpArgs(argv) {
  const opts = { json: false, force: false, service: true, linger: true, adapters: true };
  const int = (name, value) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`${name} must be a port number`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      return v;
    };
    switch (arg) {
      case "--json": opts.json = true; break;
      case "--force": opts.force = true; break;
      case "--no-service": opts.service = false; break;
      case "--no-linger": opts.linger = false; break;
      case "--no-adapters": opts.adapters = false; break;
      case "--tailscale-serve": opts.tailscaleServe = true; break;
      case "--tailscale-path": {
        const p = value().trim();
        if (!/^\/[A-Za-z0-9._~\-/]*$/.test(p)) throw new Error("--tailscale-path must be a path like /_buzz-host");
        opts.tailscalePath = p;
        break;
      }
      case "--lan": opts.lan = true; break;
      case "--no-lan": opts.lan = false; break;
      case "--owner": opts.owner = parsePubkey(value()); break;
      case "--relay": {
        const url = value().trim();
        if (!/^wss?:\/\/[^\s#]+$/.test(url)) throw new Error("--relay must be a wss:// URL");
        (opts.relays ??= []).push(url);
        break;
      }
      case "--owner-proof": opts.ownerProof = value(); break;
      case "--url": {
        const url = value().trim();
        if (!/^wss?:\/\/[^\s#]+$/.test(url)) throw new Error("--url must be a ws:// or wss:// URL");
        opts.url = url;
        break;
      }
      case "--guest-port": opts.guestPort = int(arg, value()); break;
      case "--port": opts.port = int(arg, value()); break;
      case "-h": case "--help": opts.help = true; break;
      default: throw new Error(`unknown option ${arg}`);
    }
  }
  if (opts.tailscalePath && !opts.tailscaleServe) throw new Error("--tailscale-path only applies with --tailscale-serve");
  if (opts.tailscaleServe && opts.url) throw new Error("--tailscale-serve sets the URL itself; drop --url");
  return opts;
}

/** Where everything lives for `home`. Same paths buzz-host.mjs and deploy.sh use. */
export function hostPaths(home, platform) {
  const lib = path.join(home, ".local/lib/buzz-host");
  return {
    lib,
    bin: path.join(lib, "bin"),
    stamp: path.join(lib, ".bundle-id"),
    configDir: path.join(home, ".config/buzz-host"),
    config: path.join(home, ".config/buzz-host/config.json"),
    upToken: path.join(home, ".config/buzz-host/up-token.json"),
    tokens: path.join(home, ".local/share/buzz-host/tokens.json"),
    machineKey: path.join(home, ".local/share/buzz-host/machine-key"),
    serviceFile:
      platform === "darwin"
        ? path.join(home, "Library/LaunchAgents", `${SERVER_LABEL}.plist`)
        : path.join(home, ".config/systemd/user/buzz-host.service"),
  };
}

async function exists(fs, file) {
  try {
    await fs.lstat(file);
    return true;
  } catch {
    return false;
  }
}

async function readText(fs, file) {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function writePrivate(fs, file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(tmp, text, { mode: 0o600 });
  await fs.rename(tmp, file);
}

/** Bundle facts: version, its BUNDLE_ID (absent in a git checkout), and the Node the service should run. */
export async function describeBundle(root, { fs = nodeFs } = {}) {
  const version = (await readText(fs, path.join(root, "VERSION")))?.trim() || "dev";
  const bundleId = (await readText(fs, path.join(root, "BUNDLE_ID")))?.trim() || null;
  let node = null;
  const bundledNode = path.join(root, "node/bin/node");
  if (await exists(fs, bundledNode)) {
    node = bundledNode;
    // install.sh layout: runtime/<version> with runtime/current -> <version>.
    // Point the service at current/ so it survives pruning of old versions.
    const current = path.join(path.dirname(root), "current");
    try {
      const [a, b] = await Promise.all([fs.realpath(current), fs.realpath(root)]);
      if (a === b) node = path.join(current, "node/bin/node");
    } catch {}
  }
  return { root, version, bundleId, node };
}

/**
 * Create config.json if missing (token-only: no allowLogins, so only the
 * token listener runs). An existing config is kept; only a missing guestPort
 * (required for the token this command prints) and the options given
 * (--url, --lan/--no-lan, --owner, --relay, --owner-proof) are filled in.
 * `machinePubkey` checks --owner-proof. Returns the parsed config.
 */
export async function ensureConfig(paths, opts, { fs = nodeFs, log, machinePubkey } = {}) {
  const text = await readText(fs, paths.config);
  const created = text === null;
  const config = created
    ? {
        port: opts.port ?? DEFAULT_PORT,
        guestPort: opts.guestPort ?? DEFAULT_GUEST_PORT,
        // Empty, not omitted: buzz-host.mjs otherwise falls back to omarchy's URL.
        publicGuestUrl: opts.url ?? "",
      }
    : JSON.parse(text);
  let changed = created;
  if (!Number.isInteger(config.guestPort) || config.guestPort <= 0) {
    config.guestPort = opts.guestPort ?? DEFAULT_GUEST_PORT;
    log(`added guestPort ${config.guestPort} to ${paths.config}`);
    changed = true;
  }
  if (opts.url && config.publicGuestUrl !== opts.url) {
    config.publicGuestUrl = opts.url;
    log(`set publicGuestUrl in ${paths.config}`);
    changed = true;
  }
  if (opts.lan !== undefined) {
    const host = opts.lan ? "0.0.0.0" : "127.0.0.1";
    if ((config.guestHost ?? "127.0.0.1") !== host) {
      config.guestHost = host;
      log(`set guestHost ${host} in ${paths.config}`);
      changed = true;
    }
    if (opts.lan)
      log(
        `note: the token listener (port ${config.guestPort}) now takes connections from your LAN. Every connection still needs an access token. Buzz Desktop only accepts wss:// for other machines, so put TLS in front of it (or use --tailscale-serve / iroh).`,
      );
  }
  const proof = opts.ownerProof === undefined ? null : parseOwnerProof(opts.ownerProof, machinePubkey);
  const owner = opts.owner ?? (proof ? parsePubkey(proof[1]) : undefined);
  if (proof && owner !== proof[1]) throw new Error("--owner-proof was signed by a different identity than --owner");
  if (owner && config.ownerPubkey !== owner) {
    // A different owner: their relays and proof replace the old owner's.
    if (config.ownerPubkey) {
      delete config.ownerAuth;
      config.discoveryRelays = [];
    }
    config.ownerPubkey = owner;
    log(`set ownerPubkey in ${paths.config}`);
    changed = true;
  }
  if (opts.relays?.length) {
    if (!config.ownerPubkey) throw new Error("--relay needs --owner (whose relay it is)");
    const current = Array.isArray(config.discoveryRelays) ? config.discoveryRelays : [];
    const next = [...new Set([...current, ...opts.relays])];
    if (next.length !== current.length) {
      config.discoveryRelays = next;
      log(`set discoveryRelays in ${paths.config}`);
      changed = true;
    }
  }
  if (proof && JSON.stringify(config.ownerAuth) !== JSON.stringify(proof)) {
    config.ownerAuth = proof;
    log(`saved the owner's attestation of this machine in ${paths.config}`);
    changed = true;
  }
  if (created) {
    await writePrivate(fs, paths.config, `${JSON.stringify(config, null, 2)}\n`);
    log(`wrote ${paths.config}`);
  } else if (changed) await writePrivate(fs, paths.config, `${JSON.stringify(config, null, 2)}\n`);
  return { config, changed };
}

const tsError = (error) => `${error.stderr || ""}${error.stdout || ""}`.trim() || error.message || "";

/**
 * `--tailscale-serve`: proxy https://<this machine>.ts.net<servePath> to the
 * token listener on 127.0.0.1 (tailscale serve --bg) and return the wss://
 * URL clients use. Every failure says what to fix.
 */
export async function tailscaleServe({ run, guestPort, servePath = DEFAULT_TAILSCALE_PATH, log }) {
  let status;
  try {
    const { stdout } = await run("tailscale", ["status", "--json"], { timeout: 30_000, maxBuffer: 16 << 20 });
    status = JSON.parse(stdout);
  } catch (error) {
    if (error.code === "ENOENT")
      throw new Error("--tailscale-serve needs the tailscale CLI on PATH (install Tailscale: https://tailscale.com/download)");
    if (error instanceof SyntaxError) throw new Error("`tailscale status --json` printed something that isn't JSON");
    const why = tsError(error);
    if (/doesn't appear to be running|failed to connect|connection refused/i.test(why))
      throw new Error(`tailscaled is not running (${why.split("\n")[0]}). Start Tailscale, then rerun.`);
    throw new Error(`tailscale status failed: ${why.split("\n")[0]}`);
  }
  if (status?.BackendState !== "Running")
    throw new Error(`Tailscale is not logged in (state: ${status?.BackendState ?? "unknown"}). Run \`tailscale up\`, then rerun.`);
  const dnsName = String(status?.Self?.DNSName ?? "").replace(/\.$/, "");
  if (!/\.ts\.net$/.test(dnsName))
    throw new Error("This machine has no MagicDNS *.ts.net name. Turn on MagicDNS in the Tailscale admin console (DNS), then rerun.");
  if (Array.isArray(status.CertDomains) && !status.CertDomains.length)
    throw new Error("HTTPS certificates are off for your tailnet. Turn on HTTPS Certificates in the Tailscale admin console (DNS), then rerun.");
  try {
    await run("tailscale", ["serve", "--bg", "--set-path", servePath, `http://127.0.0.1:${guestPort}`], {
      timeout: 60_000,
    });
  } catch (error) {
    const why = tsError(error);
    if (/access denied|permission denied|operator|must be root|sudo/i.test(why))
      throw new Error(
        `tailscale serve needs operator rights: run \`sudo tailscale set --operator=$USER\` once, then rerun. (${why.split("\n")[0]})`,
      );
    const link = why.match(/https:\/\/login\.tailscale\.com\/\S+/)?.[0];
    if (/not enabled|enable.*serve|https/i.test(why) || link)
      throw new Error(`Tailscale Serve/HTTPS is not enabled for your tailnet${link ? `: enable it at ${link}` : " (admin console → DNS → HTTPS Certificates)"}, then rerun.`);
    if (error.killed) throw new Error("`tailscale serve` did not finish within 60s (is it waiting for you to enable Serve in the admin console?)");
    throw new Error(`tailscale serve failed: ${why.split("\n")[0]}`);
  }
  const url = `wss://${dnsName}${servePath === "/" ? "" : servePath}`;
  log(`tailscale serve: https://${dnsName}${servePath} -> http://127.0.0.1:${guestPort}`);
  return url;
}

async function sameBytes(fs, a, b) {
  const [x, y] = await Promise.all([fs.readFile(a), fs.readFile(b).catch(() => null)]);
  return y !== null && x.equals(y);
}

async function atomicInstall(fs, src, dst, mode = 0o755) {
  await fs.mkdir(path.dirname(dst), { recursive: true });
  const tmp = path.join(path.dirname(dst), `.${path.basename(dst)}.${randomBytes(4).toString("hex")}.tmp`);
  await fs.copyFile(src, tmp);
  await fs.chmod(tmp, mode);
  await fs.rename(tmp, dst);
}

/**
 * Copy the bundle's prebuilt binaries into <lib>/bin when their bytes differ.
 * The replaced buzz-acp is kept as buzz-acp.prev (as build-acp.sh does).
 * Running agents keep their old buzz-acp until they restart. Returns the names
 * that changed.
 */
export async function installBinaries(bundle, paths, { fs = nodeFs } = {}) {
  const changed = [];
  const srcBin = path.join(bundle.root, "bin");
  for (const name of BUNDLE_BINARIES) {
    const src = path.join(srcBin, name);
    if (!(await exists(fs, src))) continue;
    const dst = path.join(paths.bin, name);
    if (await sameBytes(fs, src, dst)) continue;
    if (name === "buzz-acp" && (await exists(fs, dst))) await fs.copyFile(dst, `${dst}.prev`);
    await atomicInstall(fs, src, dst);
    changed.push(name);
  }
  const version = path.join(srcBin, "buzz-acp.version");
  if ((await exists(fs, version)) && !(await sameBytes(fs, version, path.join(paths.bin, "buzz-acp.version")))) {
    await atomicInstall(fs, version, path.join(paths.bin, "buzz-acp.version"), 0o644);
    changed.push("buzz-acp.version");
  }
  // Prebuilt MCP bridge: only when deploy.sh found no C compiler to build one.
  const bridge = path.join(srcBin, "buzz-mcp-bridge");
  if ((await exists(fs, bridge)) && !(await exists(fs, path.join(paths.bin, "buzz-mcp-bridge")))) {
    await atomicInstall(fs, bridge, path.join(paths.bin, "buzz-mcp-bridge"));
    changed.push("buzz-mcp-bridge");
  }
  // `#!/usr/bin/env node` tools (buzz-host-tokens, the npm adapters) find the
  // bundle's Node through <lib>/bin, which is on the units' and agents' PATH.
  // Never replace a node the owner put there themselves.
  if (bundle.node) {
    const link = path.join(paths.bin, "node");
    const current = await fs.readlink(link).catch((error) => (error.code === "ENOENT" ? null : undefined));
    if (current === null || (current !== undefined && current !== bundle.node)) {
      const tmp = `${link}.${randomBytes(4).toString("hex")}.tmp`;
      await fs.symlink(bundle.node, tmp);
      await fs.rename(tmp, link);
      changed.push("node");
    }
  }
  return changed;
}

/** True when the files of this bundle need (re)installing. */
export async function needsInstall(bundle, paths, opts, { fs = nodeFs } = {}) {
  if (opts.force || !bundle.bundleId) return true;
  if ((await readText(fs, paths.stamp))?.trim() !== bundle.bundleId) return true;
  for (const file of [path.join(paths.lib, "buzz-host.mjs"), paths.serviceFile]) {
    if (!(await exists(fs, file))) return true;
  }
  return false;
}

async function installFiles(bundle, paths, { run, env, log }) {
  const deployEnv = { ...env, BUZZ_HOST_SKIP_RESTART: "1" };
  if (bundle.node) deployEnv.BUZZ_HOST_NODE = bundle.node;
  const { stdout, stderr } = await run("bash", [path.join(bundle.root, "deploy.sh"), "--local"], {
    env: deployEnv,
    timeout: 300_000,
    maxBuffer: 16 << 20,
  });
  for (const line of `${stdout}${stderr}`.split("\n")) if (line.trim()) log(line);
}

/** npm-install the ACP adapters into <lib>/npm when they're missing. Failures only warn. */
export async function ensureAdapters(bundle, paths, { fs = nodeFs, run, env, log }) {
  const npmDir = path.join(paths.lib, "npm");
  const spec = path.join(bundle.root, "cli/adapters.json");
  const deps = JSON.parse(await fs.readFile(spec, "utf8")).dependencies;
  const missing = [];
  for (const name of Object.keys(deps)) {
    if (!(await exists(fs, path.join(npmDir, "node_modules", name, "package.json")))) missing.push(name);
  }
  if (!missing.length) return false;
  const pkgFile = path.join(npmDir, "package.json");
  if (!(await exists(fs, pkgFile))) {
    await fs.mkdir(npmDir, { recursive: true });
    await fs.writeFile(pkgFile, `${JSON.stringify({ dependencies: deps }, null, 2)}\n`);
  }
  const nodeDir = bundle.node ? path.dirname(bundle.node) : null;
  const npm = nodeDir ? path.join(nodeDir, "npm") : "npm";
  log(`installing ACP adapters: ${missing.join(", ")}`);
  try {
    await run(npm, ["install", "--prefix", npmDir, "--no-audit", "--no-fund", "--omit=dev", ...missing.map((n) => `${n}@${deps[n]}`)], {
      env: nodeDir ? { ...env, PATH: `${nodeDir}:${env.PATH ?? ""}` } : env,
      timeout: 600_000,
      maxBuffer: 16 << 20,
    });
    return true;
  } catch (error) {
    log(`warning: could not install the ACP adapters (${(error.stderr || error.message || "").trim().split("\n").pop()}); rerun \`buzz-host up\` once the network is up`);
    return false;
  }
}

/** Linux: let the user's systemd outlive their login session. Failures only warn. */
export async function ensureLinger({ run, env, log, user }) {
  try {
    const { stdout } = await run("loginctl", ["show-user", user, "-p", "Linger"], { timeout: 15_000 });
    if (/Linger=yes/.test(stdout)) return false;
  } catch {}
  try {
    await run("loginctl", ["enable-linger", user], { timeout: 30_000, env });
    log(`enabled lingering for ${user} (buzz-host keeps running after logout)`);
    return true;
  } catch (error) {
    log(`warning: could not enable lingering (${(error.stderr || error.message || "").trim()}); buzz-host stops when ${user} logs out. Run \`sudo loginctl enable-linger ${user}\`.`);
    return false;
  }
}

/** Start buzz-host, or restart it when something changed. Returns "started" | "restarted" | "running". */
export async function ensureService({ platform, run, uid, paths, restart, log }) {
  if (platform === "linux") {
    const systemctl = (...args) => run("systemctl", ["--user", ...args], { timeout: 60_000 });
    try {
      await systemctl("daemon-reload");
    } catch (error) {
      throw new Error(
        `systemctl --user is not available (${(error.stderr || error.message || "").trim()}). Log in through a session with a user systemd, or pass --no-service.`,
      );
    }
    await systemctl("enable", "buzz-host.service");
    let active = false;
    try {
      active = (await systemctl("is-active", "buzz-host.service")).stdout.trim() === "active";
    } catch {}
    if (active && !restart) return "running";
    await systemctl("restart", "buzz-host.service");
    log(active ? "restarted buzz-host.service" : "started buzz-host.service");
    return active ? "restarted" : "started";
  }
  if (platform === "darwin") {
    const domain = `gui/${uid}`;
    const target = `${domain}/${SERVER_LABEL}`;
    const loaded = () => run("launchctl", ["print", target], { timeout: 30_000 }).then(() => true, () => false);
    const wasLoaded = await loaded();
    if (wasLoaded && !restart) return "running";
    if (wasLoaded) {
      await run("launchctl", ["bootout", target], { timeout: 60_000 }).catch(() => {});
      for (let i = 0; i < 20 && (await loaded()); i++) await sleep(250);
    }
    await run("launchctl", ["bootstrap", domain, paths.serviceFile], { timeout: 60_000 });
    log(wasLoaded ? `reloaded ${SERVER_LABEL}` : `started ${SERVER_LABEL}`);
    return wasLoaded ? "restarted" : "started";
  }
  throw new Error(`buzz-host does not support ${platform} hosts (only linux and darwin)`);
}

export async function waitForHealth(port, { fetchImpl = fetch, timeoutMs = HEALTH_TIMEOUT_MS, sleepMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetchImpl(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2_000) });
      if (res.ok) return true;
      last = `HTTP ${res.status}`;
    } catch (error) {
      last = error.cause?.code || error.message;
    }
    await sleep(sleepMs);
  }
  throw new Error(`buzz-host did not answer on 127.0.0.1:${port}/health within ${timeoutMs / 1000}s (${last}). Check \`journalctl --user -u buzz-host\`.`);
}

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/**
 * The admin token `up` prints: the one saved in up-token.json while it is
 * still live in tokens.json, otherwise a new one (saved, 0600). Saving the
 * secret lets re-runs print the same token; whoever can read it can already
 * run this command as this user.
 */
export async function ensureUpToken(paths, { fs = nodeFs, createTokenStore, log, hostname = os.hostname() }) {
  const saved = JSON.parse((await readText(fs, paths.upToken)) ?? "null");
  if (saved && typeof saved.token === "string" && typeof saved.id === "string") {
    const tokens = JSON.parse((await readText(fs, paths.tokens)) ?? "{}")?.tokens ?? [];
    const record = tokens.find((t) => t.id === saved.id);
    if (record && !record.revokedAt && record.role === "admin" && record.tokenHash === sha256(saved.token))
      return { token: saved.token, id: saved.id, created: false };
    log("the saved access token was revoked or is gone; minting a new one");
  }
  const store = createTokenStore({ filePath: paths.tokens });
  const { token, record } = await store.createAdmin({ label: `${UP_TOKEN_LABEL} (${hostname})`.slice(0, 64) });
  await writePrivate(fs, paths.upToken, `${JSON.stringify({ id: record.id, token }, null, 2)}\n`);
  log(`created admin access token ${record.id}`);
  return { token, id: record.id, created: true };
}

/** The iroh node id from <run dir>/iroh-addr.json, waiting briefly when it may still be starting. */
export async function readIrohNodeId(runDir, { fs = nodeFs, waitMs = 0 } = {}) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const value = JSON.parse(await fs.readFile(path.join(runDir, "iroh-addr.json"), "utf8"));
      if (typeof value?.nodeId === "string" && value.nodeId) return value.nodeId;
    } catch {}
    if (Date.now() >= deadline) return null;
    await sleep(250);
  }
}

export function connectUrl(config) {
  const url = typeof config.publicGuestUrl === "string" ? config.publicGuestUrl.trim() : "";
  return url || `ws://127.0.0.1:${config.guestPort}`;
}

export function runtimeBase({ platform, env, uid }) {
  if (env.XDG_RUNTIME_DIR) return env.XDG_RUNTIME_DIR;
  if (platform === "darwin") return `/tmp/bh-${uid}`;
  return `/run/user/${uid}`;
}

/**
 * Run `up`. Every side effect goes through `deps`, so tests drive it against a
 * temporary HOME with fake systemctl/launchctl.
 */
export async function up(opts = {}, deps = {}) {
  const {
    root = path.resolve(here, ".."),
    platform = process.platform,
    env = process.env,
    home = os.homedir(),
    uid = process.getuid(),
    user = os.userInfo().username,
    fs = nodeFs,
    run = defaultRun,
    fetchImpl = fetch,
    log = (line) => process.stderr.write(`${line}\n`),
    healthTimeoutMs = HEALTH_TIMEOUT_MS,
    irohWaitMs = IROH_WAIT_MS,
  } = deps;
  if (platform !== "linux" && platform !== "darwin")
    throw new Error(`buzz-host does not support ${platform} hosts (only linux and darwin)`);
  const createTokenStore =
    deps.createTokenStore ?? (await import(pathToFileURL(path.join(root, "server/auth.mjs")).href)).createTokenStore;

  const paths = hostPaths(home, platform);
  const bundle = await describeBundle(root, { fs });
  if (opts.tailscaleServe) {
    const existing = JSON.parse((await readText(fs, paths.config)) ?? "{}");
    const guestPort = Number.isInteger(existing.guestPort) && existing.guestPort > 0 ? existing.guestPort : (opts.guestPort ?? DEFAULT_GUEST_PORT);
    opts = { ...opts, url: await tailscaleServe({ run, guestPort, servePath: opts.tailscalePath, log }) };
  }
  // The machine's Nostr key: what the owner attests for zero-agent discovery.
  const machineKey = await loadMachineKey({ file: paths.machineKey });
  const { config, changed: configChanged } = await ensureConfig(paths, opts, { fs, log, machinePubkey: machineKey.pubkey });

  let installed = [];
  const install = await needsInstall(bundle, paths, opts, { fs });
  if (install) {
    log(`installing buzz-host ${bundle.version} into ${paths.lib}`);
    await installFiles(bundle, paths, { run, env, log });
    installed = ["files"];
  }
  installed.push(...(await installBinaries(bundle, paths, { fs })));
  if (install && bundle.bundleId) await writePrivate(fs, paths.stamp, `${bundle.bundleId}\n`);
  if (opts.adapters !== false) await ensureAdapters(bundle, paths, { fs, run, env, log });

  // Mint the token before (re)starting so the server's first read sees it.
  const { token } = await ensureUpToken(paths, { fs, createTokenStore, log });

  let service = "skipped";
  if (opts.service !== false) {
    if (platform === "linux" && opts.linger !== false) await ensureLinger({ run, env, log, user });
    service = await ensureService({
      platform,
      run,
      uid,
      paths,
      restart: configChanged || installed.length > 0,
      log,
    });
    await waitForHealth(config.guestPort, { fetchImpl, timeoutMs: healthTimeoutMs });
  }

  const hasIroh = config.iroh !== false && (await exists(fs, path.join(paths.bin, "buzz-host-iroh")));
  const pubkey =
    service === "skipped" || !hasIroh
      ? null
      : await readIrohNodeId(path.join(runtimeBase({ platform, env, uid }), "buzz-host"), {
          fs,
          waitMs: service === "running" ? 0 : irohWaitMs,
        });

  const result = { version: bundle.version, url: connectUrl(config), token };
  if (pubkey) result.pubkey = pubkey;
  return { result, service, installed, configChanged, machinePubkey: machineKey.pubkey, config };
}

export function formatHuman({ result, service, installed, machinePubkey, config = {} }) {
  const lines = [
    `buzz-host ${result.version}: ${service === "skipped" ? "installed (service not started: --no-service)" : service}`,
    installed.length ? `updated: ${installed.join(", ")}` : "already up to date",
    "",
    `  URL:   ${result.url}`,
    `  Token: ${result.token}`,
  ];
  if (result.pubkey) lines.push(`  Iroh:  ${result.pubkey}`);
  if (result.url.startsWith("ws://127.0.0.1:"))
    lines.push(
      "",
      "Buzz Desktop on this machine accepts this ws://127.0.0.1 URL directly.",
      "For other devices: rerun with --tailscale-serve, use an SSH tunnel, or expose it",
      "(e.g. Tailscale Funnel) and rerun with --url wss://….",
    );
  if (config.ownerPubkey && machinePubkey && !(Array.isArray(config.ownerAuth) && config.ownerAuth[1] === config.ownerPubkey))
    lines.push(
      "",
      `Discovery: waiting for your attestation of this machine's key ${machinePubkey}.`,
      "In Buzz: Settings → Security → authorize that key, then rerun with --owner-proof '<proof>'.",
    );
  return `${lines.join("\n")}\n`;
}
