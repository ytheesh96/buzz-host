// `buzz-host status | down | restart`: the server unit and every agent's unit,
// on systemd (--user) or launchd through server/service-manager.mjs.

import { readIrohAddr } from "../server/discovery.mjs";
import { resolvePublicUrl } from "../server/tokens-cli.mjs";
import { listenerPorts, parseArgs, printJson } from "./host.mjs";
import { waitForHealth } from "./up.mjs";

export const STATUS_USAGE = `Usage: buzz-host status [--json]

Show whether buzz-host and each agent's unit are running, the connection URL
and this bundle's version. Exits 0 when buzz-host is running, 3 when it isn't.

Options:
  --json   Print one JSON object: {version, bundleId, platform, server, url,
           iroh, agents[]} (server.state is systemd's is-active word: active,
           activating, inactive, failed, unknown)
  -h, --help`;

export const DOWN_USAGE = `Usage: buzz-host down [agent] [--keep-agents] [--json]

Stop buzz-host and all of its agents. With an agent (name, or a pubkey prefix),
stop only that agent. Units stay installed: they start again at the next login,
\`buzz-host up\` restarts buzz-host, and \`buzz-host restart --agents\` starts the
agents.

Options:
  --keep-agents   Stop only buzz-host; agents keep running
  --json          Print {server, agents[]} with each unit's state before and after
  -h, --help`;

export const RESTART_USAGE = `Usage: buzz-host restart [agent] [--agents] [--json]

Restart buzz-host and wait for it to answer. Agents keep running. With an agent
(name, or a pubkey prefix), restart only that agent. Also starts what was stopped.

Options:
  --agents   Also restart every agent
  --json     Print {server, agents[]} with each unit's state before and after
  -h, --help`;

/** Server and per-agent unit states, plus the URL/iroh facts `status` and `pair` show. */
export async function collectStatus(host) {
  const [bundle, config, agents] = await Promise.all([host.bundle(), host.config(), host.agents()]);
  const stamp = (await host.fs.readFile(host.paths.stamp, "utf8").catch(() => "")).trim();
  const ports = listenerPorts(config);
  const [state, ...states] = await Promise.all([
    host.services.server.status(),
    ...agents.map((a) => host.services.status(a.pubkey)),
  ]);
  const running = state === "active";
  const [guestOk, tailnetOk, iroh] = await Promise.all([
    running ? host.healthy(ports.guest) : false,
    running && ports.tailnet ? host.healthy(ports.tailnet) : false,
    readIrohAddr(host.runDir),
  ]);
  const listeners = [{ role: "token", port: ports.guest, healthy: guestOk }];
  if (ports.tailnet) listeners.push({ role: "tailnet", port: ports.tailnet, healthy: tailnetOk });
  return {
    version: bundle.version,
    bundleId: stamp || null,
    platform: host.platform,
    server: { unit: host.services.server.unit, state, listeners },
    iroh: iroh ? { nodeId: iroh.nodeId } : null,
    config,
    agents: agents.map((a, i) => ({ pubkey: a.pubkey, name: a.name, runtime: a.runtime, runner: a.runner, unit: host.services.unit(a.pubkey), state: states[i] })),
  };
}

export async function runStatus(argv, host, io) {
  const { opts } = parseArgs(argv, { flags: ["json"] });
  if (opts.help) {
    io.out(STATUS_USAGE);
    return 0;
  }
  const s = await collectStatus(host);
  const url = resolvePublicUrl(s.config);
  const running = s.server.state === "active";
  if (opts.json) {
    const { config, ...rest } = s;
    printJson(io, { ...rest, url });
  } else {
    io.out(`buzz-host ${s.version}${s.bundleId ? ` (${s.bundleId})` : ""} on ${s.platform}`);
    io.out(`server  ${s.server.state.padEnd(10)} ${s.server.unit}`);
    for (const l of s.server.listeners) io.out(`        ${l.role} listener :${l.port} ${running ? (l.healthy ? "answers /health" : "NOT answering /health") : ""}`.trimEnd());
    io.out(`url     ${url}`);
    if (s.iroh) io.out(`iroh    ${s.iroh.nodeId}`);
    io.out("");
    if (!s.agents.length) io.out("No agents.");
    else {
      const w = Math.max(...s.agents.map((a) => a.name.length));
      io.out(`agents (${s.agents.filter((a) => a.state === "active").length}/${s.agents.length} running)`);
      for (const a of s.agents) io.out(`  ${a.name.padEnd(w)}  ${a.state.padEnd(10)} ${a.runtime || "-"}${a.runner !== "host" ? `/${a.runner}` : ""}  ${a.pubkey.slice(0, 8)}`);
    }
  }
  return running ? 0 : 3;
}

/** Apply `action` to the server and/or agents; report each unit's state before and after. */
async function change(host, { server, agents, action }) {
  const out = { server: null, agents: [] };
  const sm = host.services;
  if (server) {
    const before = await sm.server.status();
    await sm.server[action]();
    out.server = { unit: sm.server.unit, before, after: await sm.server.status() };
  }
  for (const a of agents) {
    const before = await sm.status(a.pubkey);
    // `down` leaves units that aren't running alone; restart starts them.
    if (action === "stop" && before === "inactive") {
      out.agents.push({ pubkey: a.pubkey, name: a.name, before, after: before });
      continue;
    }
    await sm[action === "stop" ? "stop" : "restart"](a.pubkey);
    out.agents.push({ pubkey: a.pubkey, name: a.name, before, after: await sm.status(a.pubkey) });
  }
  return out;
}

function printChange(io, result, verb) {
  if (result.server) io.out(`${verb} buzz-host (${result.server.before} -> ${result.server.after})`);
  for (const a of result.agents) io.out(`${verb} ${a.name} ${a.pubkey.slice(0, 8)} (${a.before} -> ${a.after})`);
}

export async function runDown(argv, host, io) {
  const { opts, positional } = parseArgs(argv, { flags: ["json", "keep-agents"] });
  if (opts.help) {
    io.out(DOWN_USAGE);
    return 0;
  }
  if (positional.length > 1) throw new Error("down takes at most one agent");
  let agents = [];
  let server = true;
  if (positional.length) {
    if (opts["keep-agents"]) throw new Error("--keep-agents doesn't apply when naming an agent");
    agents = [await host.findAgent(positional[0])];
    server = false;
  } else if (!opts["keep-agents"]) agents = await host.agents();
  // Server first: nothing is left to react to the agents going away.
  const result = await change(host, { server, agents, action: "stop" });
  if (opts.json) printJson(io, result);
  else printChange(io, result, "stopped");
  return 0;
}

export async function runRestart(argv, host, io, { healthTimeoutMs = 30_000 } = {}) {
  const { opts, positional } = parseArgs(argv, { flags: ["json", "agents"] });
  if (opts.help) {
    io.out(RESTART_USAGE);
    return 0;
  }
  if (positional.length > 1) throw new Error("restart takes at most one agent");
  let agents = [];
  let server = true;
  if (positional.length) {
    if (opts.agents) throw new Error("--agents doesn't apply when naming an agent");
    agents = [await host.findAgent(positional[0])];
    server = false;
  } else if (opts.agents) agents = (await host.agents()).filter((a) => a.activated);
  const result = await change(host, { server, agents, action: "restart" });
  if (server) {
    const { guest } = listenerPorts(await host.config());
    await waitForHealth(guest, { fetchImpl: host.fetchImpl, timeoutMs: healthTimeoutMs });
    result.server.healthy = true;
  }
  if (opts.json) printJson(io, result);
  else printChange(io, result, "restarted");
  return 0;
}
