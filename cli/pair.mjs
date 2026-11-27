// `buzz-host pair`: everything a client needs to connect to this machine: the
// URL, an admin token, the pairing URL that carries both, and the iroh /
// discovery details other devices use to find it.

import { createTokenStore, buildInviteUrl } from "../server/auth.mjs";
import { configuredOwner, loadMachineKey, machineName, readAuthorizedAgents, readRoutes } from "../server/discovery.mjs";
import { resolvePublicUrl } from "../server/tokens-cli.mjs";
import { parseArgs, printJson } from "./host.mjs";
import { ensureUpToken } from "./up.mjs";

/** buzz://pair?url=<url>&name=<name>#token=<token>: opens Buzz Desktop's Add
 * machine form prefilled (the user still confirms). The token stays in the
 * fragment, as in the pairing URL. */
export function buildPairDeepLink(url, token, name) {
  const query = new URLSearchParams({ url: String(url).replace(/#.*$/, "").trim() });
  if (name) query.set("name", name);
  return `buzz://pair?${query.toString().replace(/\+/g, "%20")}#token=${encodeURIComponent(token)}`;
}

/** Discovery as `pair`/`status` report it: agent relays plus an attested
 * config owner's relays; `pending` when an owner is set but hasn't attested
 * the machine key yet. */
export function discoveryReport(config, agents, machinePubkey) {
  const owner = configuredOwner(config, machinePubkey);
  const relays = new Set(agents.map((a) => a.relayUrl));
  if (owner?.attested) for (const r of owner.relays) relays.add(r);
  return {
    enabled: config.discovery !== false,
    relays: [...relays].sort(),
    machinePubkey: machinePubkey ?? null,
    owner: owner ? { pubkey: owner.ownerPubkey, relays: owner.relays, attested: owner.attested } : null,
  };
}

/** The one-line discovery summary `pair` and `status` print. */
export function describeDiscovery(d) {
  if (!d.enabled) return "off (discovery: false)";
  const parts = [];
  if (d.relays.length) parts.push(`publishing to ${d.relays.join(", ")}`);
  if (d.owner && !d.owner.attested)
    parts.push(`waiting for the owner to attest machine key ${d.machinePubkey} (Buzz → Settings → Security), then \`buzz-host up --owner-proof '<proof>'\``);
  else if (d.owner && !d.owner.relays.length) parts.push("owner set, but no --relay to announce on");
  if (!parts.length) parts.push("on, but no owner-authorized agent yet (or run `buzz-host up --owner <npub> --relay wss://…`)");
  return parts.join("; ");
}

export const PAIR_USAGE = `Usage: buzz-host pair [--new] [--label <name>] [--url wss://…] [--qr] [--json]

Print how to connect a device to this machine: URL, admin token, a 1-paste
pairing URL (<url>#token=<token>) and a buzz://pair link that opens Buzz
Desktop's Add machine form prefilled. By default it prints the same admin token
\`buzz-host up\` does (and creates it if there isn't one yet). It also lists the
routes other devices use (iroh node id, public wss URL) and whether machine
discovery is on.

Options:
  --new            Mint a new admin token for this device instead (shown once; revoke
                   it later with \`buzz-host tokens revoke <id>\`)
  --label <name>   Label for the new token (default: "pair (<hostname>)")
  --url <wss://…>  Use this URL instead of the configured one
  --qr             Also print the pairing URL as a QR code (needs \`qrencode\` on PATH)
  --json           Print {url, token, pairingUrl, deepLink, tokenId, new, machine, iroh, routes, discovery}
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
  const machineKey = await loadMachineKey({ file: host.paths.machineKey });
  const discovery = discoveryReport(config, agents, machineKey.pubkey);
  const machine = { id: machineId, name: machineName(config.machineName, host.hostname) };
  const deepLink = buildPairDeepLink(url, token, machine.name);

  let qr = "";
  if (opts.qr) qr = await renderQr(host, pairingUrl, log);

  if (opts.json) {
    printJson(io, {
      url,
      token,
      pairingUrl,
      deepLink,
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
  io.out(`  Open in Buzz: ${deepLink}`);
  if (qr) io.out(`\n${qr.replace(/\n$/, "")}`);
  if (url.startsWith("ws://127.0.0.1:"))
    io.out(
      "\nBuzz Desktop on this machine accepts this ws://127.0.0.1 URL directly. For other\n" +
        "devices: `buzz-host up --tailscale-serve`, an SSH tunnel, or Tailscale Funnel\n" +
        "(then pass --url wss://…).",
    );
  io.out("");
  io.out(iroh ? `  Iroh node:    ${iroh.nodeId}` : "  Iroh node:    not running (buzz-host-iroh is off or buzz-host is stopped)");
  io.out(`  Discovery:    ${describeDiscovery(discovery)}`);
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
