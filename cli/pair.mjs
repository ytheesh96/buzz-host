// `buzz-host pair`: everything a client needs to connect to this machine: the
// URL, an admin token, the pairing URL that carries both, and the iroh /
// discovery details other devices use to find it.

import { createTokenStore, buildInviteUrl } from "../server/auth.mjs";
import { machineName, readAuthorizedAgents, readRoutes } from "../server/discovery.mjs";
import { resolvePublicUrl } from "../server/tokens-cli.mjs";
import { parseArgs, printJson } from "./host.mjs";
import { ensureUpToken } from "./up.mjs";

export const PAIR_USAGE = `Usage: buzz-host pair [--new] [--label <name>] [--url wss://…] [--qr] [--json]

Print how to connect a device to this machine: URL, admin token and a 1-paste
pairing URL (<url>#token=<token>). By default it prints the same admin token
\`buzz-host up\` does (and creates it if there isn't one yet). It also lists the
routes other devices use (iroh node id, public wss URL) and whether machine
discovery is on.

Options:
  --new            Mint a new admin token for this device instead (shown once; revoke
                   it later with \`buzz-host tokens revoke <id>\`)
  --label <name>   Label for the new token (default: "pair (<hostname>)")
  --url <wss://…>  Use this URL instead of the configured one
  --qr             Also print the pairing URL as a QR code (needs \`qrencode\` on PATH)
  --json           Print {url, token, pairingUrl, tokenId, new, machine, iroh, routes, discovery}
  -h, --help`;

export async function runPair(argv, host, io, { log = io.err } = {}) {
  const { opts } = parseArgs(argv, { flags: ["json", "new", "qr"], values: ["label", "url"] });
  if (opts.help) {
    io.out(PAIR_USAGE);
    return 0;
  }
  if (opts.url && !/^wss?:\/\/[^\s#]+$/.test(opts.url)) throw new Error("--url must be a ws:// or wss:// URL");
  if (opts.label && !opts.new) throw new Error("--label only applies with --new");
  const config = await host.config();
  const url = opts.url ?? resolvePublicUrl(config);

  let token;
  let tokenId;
  if (opts.new) {
    const store = createTokenStore({ filePath: host.paths.tokens });
    const made = await store.createAdmin({ label: (opts.label ?? `pair (${host.hostname})`).slice(0, 64) });
    token = made.token;
    tokenId = made.record.id;
  } else {
    const saved = await ensureUpToken(host.paths, { fs: host.fs, createTokenStore, log, hostname: host.hostname });
    token = saved.token;
    tokenId = saved.id;
  }
  const pairingUrl = buildInviteUrl(url, token);

  const routes = await readRoutes(host.runDir, { publicGuestUrl: opts.url ?? config.publicGuestUrl, publicUrl: config.publicUrl });
  const iroh = routes.find((r) => r.type === "iroh") ?? null;
  const machineId = (await host.fs.readFile(host.paths.machineId, "utf8").catch(() => "")).trim() || null;
  const agents = await readAuthorizedAgents(host.paths.agents, { warn() {} });
  const discovery = {
    enabled: config.discovery !== false,
    relays: [...new Set(agents.map((a) => a.relayUrl))].sort(),
  };
  const machine = { id: machineId, name: machineName(config.machineName, host.hostname) };

  let qr = "";
  if (opts.qr) qr = await renderQr(host, pairingUrl, log);

  if (opts.json) {
    printJson(io, {
      url,
      token,
      pairingUrl,
      tokenId,
      new: Boolean(opts.new),
      machine,
      iroh: iroh && { nodeId: iroh.nodeId, endpointAddr: iroh.endpointAddr },
      routes,
      discovery,
      ...(qr && { qr }),
    });
    return 0;
  }
  io.out(`Pair a device with ${machine.name}${machine.id ? ` (${machine.id})` : ""}`);
  io.out("");
  io.out(`  URL:          ${url}`);
  io.out(`  Token:        ${token}${opts.new ? "   (shown once)" : ""}`);
  io.out(`  Pairing URL:  ${pairingUrl}`);
  if (qr) io.out(`\n${qr.replace(/\n$/, "")}`);
  if (url.startsWith("ws://127.0.0.1:"))
    io.out("\nThe URL is local to this machine: reach it over an SSH tunnel, or expose it\n(e.g. `tailscale funnel`) and pass --url wss://….");
  io.out("");
  io.out(iroh ? `  Iroh node:    ${iroh.nodeId}` : "  Iroh node:    not running (buzz-host-iroh is off or buzz-host is stopped)");
  io.out(`  Discovery:    ${discovery.enabled ? (discovery.relays.length ? `publishing to ${discovery.relays.join(", ")}` : "on, but no owner-authorized agent yet") : "off (discovery: false)"}`);
  io.out(`  Revoke:       buzz-host tokens revoke ${tokenId}`);
  return 0;
}

async function renderQr(host, text, log) {
  try {
    const { stdout } = await host.run("qrencode", ["-t", "ANSIUTF8", "-m", "1", text], { timeout: 15_000 });
    return stdout;
  } catch (error) {
    log(`warning: no QR code (${error.code === "ENOENT" ? "qrencode is not installed" : (error.stderr || error.message || "").trim()})`);
    return "";
  }
}
