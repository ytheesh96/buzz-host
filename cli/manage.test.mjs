// status, down, restart, pair, tokens, logs and doctor against a temporary
// HOME with fake systemctl/journalctl/launchctl/loginctl/qrencode.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createTokenStore } from "../server/auth.mjs";
import { bytesToHex, hexToBytes, schnorr, sha256 } from "../server/noble.mjs";
import { runDoctor } from "./doctor.mjs";
import { createHost, parseArgs, UsageError } from "./host.mjs";
import { runDown, runRestart, runStatus } from "./lifecycle.mjs";
import { runLogs } from "./logs.mjs";
import { COMMANDS, usage } from "./main.mjs";
import { runPair } from "./pair.mjs";
import { runTokensCommand } from "./tokens.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const realRun = promisify(execFile);
const hex = () => randomBytes(32).toString("hex");
const keypair = () => {
  const secret = bytesToHex(randomBytes(32));
  return { secret, pubkey: bytesToHex(schnorr.getPublicKey(hexToBytes(secret))) };
};
const HEALTH_PORTS = (state) => state.health ?? new Set([8467]);

async function tmp(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bh-cli-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * A temporary HOME with `agents`, a config and fake service tools.
 * `state.units` maps a unit name (systemd) or launchd label to its state.
 */
async function setup(t, { platform = "linux", config = { port: 8457, guestPort: 8467, publicGuestUrl: "" }, agents = ["Alice:claude", "Bob:hermes"], units = {}, extra = {} } = {}) {
  const home = await tmp(t);
  const state = { units: { ...units }, calls: [], health: new Set([8467]), linger: "yes", ...extra };
  if (config) {
    await fs.mkdir(path.join(home, ".config/buzz-host"), { recursive: true });
    await fs.writeFile(path.join(home, ".config/buzz-host/config.json"), JSON.stringify(config));
  }
  const keys = [];
  for (const spec of agents) {
    const [name, runtime] = spec.split(":");
    const pubkey = hex();
    keys.push({ name, pubkey });
    const dir = path.join(home, ".local/share/buzz-host/agents", pubkey);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "meta.json"), JSON.stringify({ pubkey, name, runtime, runner: "host", activated: true }));
  }
  const unitName = (pubkey) => (platform === "linux" ? `buzz-agent@${pubkey}.service` : `com.buzz-host.agent.${pubkey}`);
  const serverUnit = platform === "linux" ? "buzz-host.service" : "com.buzz-host.server";
  const run = async (cmd, args, options = {}) => {
    state.calls.push([cmd, ...args]);
    if (cmd === "systemctl") {
      const [, sub, unit] = args;
      if (sub === "show-environment") return { stdout: "PATH=/usr/bin\n" };
      if (sub === "is-active") {
        const s = state.units[unit] ?? "inactive";
        if (s === "active") return { stdout: "active\n" };
        throw Object.assign(new Error(s), { stdout: `${s}\n`, code: 3 });
      }
      if (sub === "stop") state.units[unit] = "inactive";
      if (sub === "restart" || sub === "start") state.units[unit] = "active";
      return { stdout: "" };
    }
    if (cmd === "launchctl") {
      const [sub, target] = args;
      const label = target?.split("/").pop();
      if (sub === "print") {
        if (target === `gui/${process.getuid()}`) return { stdout: "" };
        const s = state.units[label];
        if (!s) throw Object.assign(new Error("Could not find service"), { code: 113 });
        return { stdout: `state = ${s === "active" ? "running" : "waiting"}\n` };
      }
      if (sub === "bootout") delete state.units[label];
      if (sub === "bootstrap") state.units[path.basename(args[2], ".plist")] = "active";
      if (sub === "kickstart") state.units[label] = "active";
      return { stdout: "" };
    }
    if (cmd === "journalctl") return { stdout: `line one for ${args[args.indexOf("-u") + 1]}\nline two\n` };
    if (cmd === "loginctl") return { stdout: `Linger=${state.linger}\n` };
    if (cmd === "qrencode") {
      if (state.noQr) throw Object.assign(new Error("spawn qrencode ENOENT"), { code: "ENOENT" });
      return { stdout: `QR[${args.at(-1)}]\n` };
    }
    throw new Error(`unexpected command ${cmd}`);
  };
  const fetchImpl = async (url) => {
    const port = Number(new URL(url).port);
    if (!HEALTH_PORTS(state).has(port)) throw new Error("ECONNREFUSED");
    return { ok: true, status: 200 };
  };
  const host = createHost({
    root: REPO,
    platform,
    home,
    uid: process.getuid(),
    user: "tester",
    hostname: "box.local",
    env: { PATH: path.join(home, "bin"), HOME: home, XDG_RUNTIME_DIR: path.join(home, "run") },
    run,
    fetchImpl,
  });
  const io = { lines: [], errs: [], out: (s = "") => io.lines.push(s), err: (s = "") => io.errs.push(s) };
  io.text = () => io.lines.join("\n");
  io.json = () => JSON.parse(io.text());
  return { home, host, io, state, keys, unitName, serverUnit };
}

const callsTo = (state, cmd, sub) => state.calls.filter((c) => c[0] === cmd && (!sub || c[2] === sub || c[1] === sub));

// ---------- argument parsing and the command table ----------

test("parseArgs: flags, values, short options and mistakes", () => {
  assert.deepEqual(parseArgs(["a", "--json", "-n", "5"], { flags: ["json"], values: ["lines"], short: { n: "lines" } }), {
    opts: { json: true, lines: "5" },
    positional: ["a"],
  });
  assert.equal(parseArgs(["-h"]).opts.help, true);
  assert.throws(() => parseArgs(["--nope"]), UsageError);
  assert.throws(() => parseArgs(["-x"]), /unknown option -x/);
  assert.throws(() => parseArgs(["--lines"], { values: ["lines"] }), /needs a value/);
});

test("the command table lists every management subcommand", () => {
  for (const name of ["up", "down", "restart", "status", "pair", "tokens", "logs", "doctor", "version"]) {
    assert.ok(COMMANDS[name], name);
    assert.match(usage(), new RegExp(`^ {2}${name} {2}`, "m"));
  }
});

test("every management subcommand has --help", async (t) => {
  const { host, io } = await setup(t);
  for (const name of ["down", "restart", "status", "pair", "tokens", "logs", "doctor"]) {
    io.lines.length = 0;
    assert.equal(await COMMANDS[name].run(["--help"], { host, io }), 0, name);
    assert.match(io.text(), new RegExp(`Usage: buzz-host ${name}`), name);
  }
});

// ---------- status ----------

test("status (systemd): server and agent states, version, url, exit 0 when running", async (t) => {
  const { host, io, state, keys, unitName } = await setup(t, { units: { "buzz-host.service": "active" } });
  state.units[unitName(keys[0].pubkey)] = "active";
  assert.equal(await runStatus([], host, io), 0);
  const text = io.text();
  assert.match(text, /^buzz-host dev on linux/);
  assert.match(text, /server {2}active +buzz-host\.service/);
  assert.match(text, /token listener :8467 answers \/health/);
  assert.match(text, /url {5}ws:\/\/127\.0\.0\.1:8467/);
  assert.match(text, /agents \(1\/2 running\)/);
  assert.match(text, /Alice +active +claude/);
  assert.match(text, /Bob +inactive +hermes/);
});

test("status --json: the documented shape; exit 3 when buzz-host is down", async (t) => {
  const { host, io, state, keys, unitName } = await setup(t, { units: { "buzz-host.service": "active" } });
  await fs.mkdir(host.runDir, { recursive: true });
  await fs.writeFile(path.join(host.runDir, "iroh-addr.json"), JSON.stringify({ nodeId: "node1", endpointAddr: "addr1" }));
  state.units[unitName(keys[1].pubkey)] = "failed";
  assert.equal(await runStatus(["--json"], host, io), 0);
  const j = io.json();
  assert.deepEqual(Object.keys(j).sort(), ["agents", "bundleId", "iroh", "platform", "server", "url", "version"]);
  assert.deepEqual(j.server, { unit: "buzz-host.service", state: "active", listeners: [{ role: "token", port: 8467, healthy: true }] });
  assert.deepEqual(j.iroh, { nodeId: "node1" });
  assert.equal(j.url, "ws://127.0.0.1:8467");
  assert.deepEqual(j.agents.map((a) => [a.name, a.state]), [["Alice", "inactive"], ["Bob", "failed"]]);
  assert.equal("config" in j, false);

  state.units["buzz-host.service"] = "inactive";
  io.lines.length = 0;
  assert.equal(await runStatus(["--json"], host, io), 3);
  assert.equal(io.json().server.state, "inactive");
  assert.equal(io.json().server.listeners[0].healthy, false);
});

test("status (launchd): uses launchctl and reports the same shape", async (t) => {
  const { host, io, state, keys, unitName } = await setup(t, { platform: "darwin", units: { "com.buzz-host.server": "active" } });
  state.units[unitName(keys[0].pubkey)] = "active";
  assert.equal(await runStatus(["--json"], host, io), 0);
  const j = io.json();
  assert.equal(j.platform, "darwin");
  assert.deepEqual(j.server.unit, "com.buzz-host.server");
  assert.deepEqual(j.agents.map((a) => [a.name, a.state]), [["Alice", "active"], ["Bob", "inactive"]]);
  assert.ok(callsTo(state, "launchctl", "print").length >= 3);
});

// ---------- down / restart ----------

test("down stops buzz-host and running agents, leaves stopped ones alone", async (t) => {
  const { host, io, state, keys, unitName } = await setup(t, { units: { "buzz-host.service": "active" } });
  state.units[unitName(keys[0].pubkey)] = "active";
  assert.equal(await runDown(["--json"], host, io), 0);
  const j = io.json();
  assert.deepEqual(j.server, { unit: "buzz-host.service", before: "active", after: "inactive" });
  assert.deepEqual(j.agents.map((a) => [a.name, a.before, a.after]), [["Alice", "active", "inactive"], ["Bob", "inactive", "inactive"]]);
  const stops = state.calls.filter((c) => c[0] === "systemctl" && c[2] === "stop").map((c) => c[3]);
  assert.deepEqual(stops, ["buzz-host.service", unitName(keys[0].pubkey)]);
  // Units stay enabled: down never disables or removes anything.
  assert.equal(callsTo(state, "systemctl", "disable").length, 0);
});

test("down --keep-agents and down <agent>", async (t) => {
  const { host, io, state, keys, unitName } = await setup(t, { units: { "buzz-host.service": "active" } });
  state.units[unitName(keys[0].pubkey)] = "active";
  assert.equal(await runDown(["--keep-agents"], host, io), 0);
  assert.equal(state.units["buzz-host.service"], "inactive");
  assert.equal(state.units[unitName(keys[0].pubkey)], "active");

  state.units["buzz-host.service"] = "active";
  io.lines.length = 0;
  assert.equal(await runDown(["alice"], host, io), 0);
  assert.equal(state.units["buzz-host.service"], "active", "naming an agent leaves buzz-host up");
  assert.equal(state.units[unitName(keys[0].pubkey)], "inactive");
  assert.match(io.text(), /^stopped Alice/);
  await assert.rejects(runDown(["nobody"], host, io), /no agent matches "nobody"/);
  await assert.rejects(runDown(["alice", "--keep-agents"], host, io), /doesn't apply/);
});

test("down (launchd): bootout keeps the plist installed", async (t) => {
  const { host, io, state, keys, unitName, home } = await setup(t, { platform: "darwin", units: { "com.buzz-host.server": "active" } });
  state.units[unitName(keys[0].pubkey)] = "active";
  const plist = path.join(home, "Library/LaunchAgents/com.buzz-host.server.plist");
  await fs.mkdir(path.dirname(plist), { recursive: true });
  await fs.writeFile(plist, "<plist/>");
  assert.equal(await runDown([], host, io), 0);
  assert.deepEqual(state.units, {});
  assert.deepEqual(state.calls.filter((c) => c[1] === "bootout").map((c) => c[2].split("/").pop()), ["com.buzz-host.server", unitName(keys[0].pubkey)]);
  await fs.access(plist);
});

test("restart restarts only buzz-host, then waits for /health", async (t) => {
  const { host, io, state, keys, unitName } = await setup(t, { units: { "buzz-host.service": "active" } });
  state.units[unitName(keys[0].pubkey)] = "active";
  assert.equal(await runRestart(["--json"], host, io, { healthTimeoutMs: 500 }), 0);
  const j = io.json();
  assert.equal(j.server.healthy, true);
  assert.deepEqual(j.agents, []);
  assert.deepEqual(state.calls.filter((c) => c[2] === "restart").map((c) => c[3]), ["buzz-host.service"]);
});

test("restart fails loudly when buzz-host doesn't come back", async (t) => {
  const { host, io, state } = await setup(t);
  state.health = new Set();
  await assert.rejects(runRestart([], host, io, { healthTimeoutMs: 300 }), /did not answer on 127\.0\.0\.1:8467/);
});

test("restart --agents restarts every activated agent; restart <agent> only that one", async (t) => {
  const { host, io, state, keys, unitName } = await setup(t, { units: { "buzz-host.service": "active" } });
  assert.equal(await runRestart(["--agents", "--json"], host, io, { healthTimeoutMs: 500 }), 0);
  assert.deepEqual(io.json().agents.map((a) => [a.name, a.before, a.after]), [["Alice", "inactive", "active"], ["Bob", "inactive", "active"]]);

  state.calls.length = 0;
  io.lines.length = 0;
  assert.equal(await runRestart([keys[1].pubkey.slice(0, 8)], host, io), 0);
  assert.deepEqual(state.calls.filter((c) => c[2] === "restart").map((c) => c[3]), [unitName(keys[1].pubkey)]);
  assert.match(io.text(), /^restarted Bob/);
});

test("restart (launchd) bootstraps what isn't loaded and kickstarts what is", async (t) => {
  const { host, io, state, home } = await setup(t, { platform: "darwin", units: {} });
  await fs.mkdir(path.join(home, "Library/LaunchAgents"), { recursive: true });
  assert.equal(await runRestart([], host, io, { healthTimeoutMs: 500 }), 0);
  assert.ok(state.calls.some((c) => c[1] === "bootstrap" && c[3].endsWith("com.buzz-host.server.plist")));
  assert.equal(state.units["com.buzz-host.server"], "active");
  state.calls.length = 0;
  assert.equal(await runRestart([], host, io, { healthTimeoutMs: 500 }), 0);
  assert.ok(state.calls.some((c) => c[1] === "kickstart" && c[3] === `gui/${process.getuid()}/com.buzz-host.server`));
});

// ---------- tokens ----------

test("tokens create-admin / create / list / revoke, with and without --json", async (t) => {
  const { host, io, home } = await setup(t, { config: { guestPort: 8467, publicGuestUrl: "wss://box.example/_buzz-host" } });
  assert.equal(await runTokensCommand(["create-admin", "--label", "Laptop", "--json"], host, io), 0);
  const admin = io.json();
  assert.match(admin.token, /^bha_[0-9a-f]{48}$/);
  assert.equal(admin.pairingUrl, `wss://box.example/_buzz-host#token=${admin.token}`);
  assert.equal(admin.record.role, "admin");

  io.lines.length = 0;
  assert.equal(await runTokensCommand(["create", "--label", "Friend", "--max-agents", "1", "--json"], host, io), 0);
  const guest = io.json();
  assert.match(guest.token, /^bhg_/);
  assert.equal(guest.record.maxAgents, 1);

  io.lines.length = 0;
  assert.equal(await runTokensCommand(["list", "--json"], host, io), 0);
  assert.deepEqual(io.json().tokens.map((x) => [x.label, x.role, x.revokedAt]), [["Laptop", "admin", null], ["Friend", "guest", null]]);
  assert.ok(!JSON.stringify(io.json()).includes(admin.token), "list never prints a secret");

  io.lines.length = 0;
  assert.equal(await runTokensCommand(["revoke", guest.record.id], host, io), 0);
  assert.match(io.text(), /^Revoked guest token tok_\w+ \(Friend\)/);
  assert.match(io.text(), /within about 15 seconds/);

  io.lines.length = 0;
  assert.equal(await runTokensCommand(["list"], host, io), 0);
  assert.match(io.text(), /Laptop {2}\[active]/);
  assert.match(io.text(), /Friend {2}\[REVOKED/);
  const stored = JSON.parse(await fs.readFile(path.join(home, ".local/share/buzz-host/tokens.json"), "utf8"));
  assert.equal(stored.tokens.length, 2);
});

test("tokens: usage, errors, and the local fallback URL for a host with no public URL", async (t) => {
  const { host, io } = await setup(t);
  assert.equal(await runTokensCommand([], host, io), 2);
  assert.match(io.text(), /Usage: buzz-host tokens/);
  assert.equal(await runTokensCommand(["bogus"], host, io), 2);
  assert.match(io.errs.at(-1), /Usage: buzz-host tokens <create\|create-admin\|list\|revoke>/);
  assert.equal(await runTokensCommand(["revoke", "tok_000000000000"], host, io), 1);
  assert.match(io.errs.at(-1), /^Error: /);
  assert.equal(await runTokensCommand(["create-admin", "--label", "x", "--max-agents", "3"], host, io), 1);
  assert.match(io.errs.at(-1), /Admin tokens have no guest caps/);
  io.lines.length = 0;
  assert.equal(await runTokensCommand(["create-admin", "--label", "x"], host, io), 0);
  assert.match(io.text(), /1-paste pairing URL: +ws:\/\/127\.0\.0\.1:8467#token=bha_/);
  assert.match(io.text(), /Revoke with: +buzz-host tokens revoke tok_/);
});

test("server/buzz-host-tokens still works (shim) and shares the token file with `tokens`", async (t) => {
  const { home, host, io } = await setup(t, { config: { guestPort: 8467, publicGuestUrl: "wss://x.example/_buzz-host" } });
  const shim = path.join(REPO, "server/buzz-host-tokens");
  const env = { PATH: process.env.PATH, HOME: home };
  const created = JSON.parse((await realRun(shim, ["create-admin", "--label", "via shim", "--json"], { env })).stdout);
  assert.match(created.pairingUrl, /^wss:\/\/x\.example\/_buzz-host#token=bha_/);
  assert.equal(await runTokensCommand(["list", "--json"], host, io), 0);
  assert.equal(io.json().tokens[0].label, "via shim");
  const text = (await realRun(shim, ["create-admin", "--label", "again"], { env })).stdout;
  assert.match(text, /Revoke with: +buzz-host-tokens revoke tok_/);
  await assert.rejects(realRun(shim, ["nope"], { env }), (e) => e.code === 2 && /Usage: buzz-host-tokens/.test(e.stderr));
});

// ---------- pair ----------

test("pair prints URL, the token `up` uses, pairing URL and routes; --json is stable", async (t) => {
  const { host, io, home } = await setup(t, { config: { guestPort: 8467, publicGuestUrl: "wss://box.example/_buzz-host", machineName: "Box" } });
  await fs.mkdir(host.runDir, { recursive: true });
  await fs.writeFile(path.join(host.runDir, "iroh-addr.json"), JSON.stringify({ nodeId: "nodeabc", endpointAddr: "addrabc" }));
  await fs.writeFile(host.paths.machineId, "11111111-2222-4333-8444-555555555555\n");
  // An owner-authorized agent gives discovery a relay.
  const owner = keypair();
  const agent = keypair();
  const dir = path.join(host.paths.agents, agent.pubkey);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "key"), agent.secret);
  await fs.writeFile(path.join(dir, "meta.json"), JSON.stringify({ name: "Authz", community: "wss://relay.example", owner: owner.pubkey, activated: true }));
  const digest = sha256(new TextEncoder().encode(`nostr:agent-auth:${agent.pubkey}:`));
  await fs.writeFile(path.join(dir, "auth.json"), JSON.stringify(["auth", owner.pubkey, "", bytesToHex(schnorr.sign(digest, hexToBytes(owner.secret)))]));

  assert.equal(await runPair(["--json"], host, io, { log() {} }), 0);
  const j = io.json();
  assert.equal(j.url, "wss://box.example/_buzz-host");
  assert.match(j.token, /^bha_/);
  assert.equal(j.pairingUrl, `${j.url}#token=${j.token}`);
  assert.equal(j.new, false);
  assert.deepEqual(j.machine, { id: "11111111-2222-4333-8444-555555555555", name: "Box" });
  assert.deepEqual(j.iroh, { nodeId: "nodeabc", endpointAddr: "addrabc" });
  assert.deepEqual(j.routes.map((r) => r.type), ["iroh", "wss"]);
  assert.deepEqual(j.discovery, { enabled: true, relays: ["wss://relay.example"] });

  // The same admin token as `buzz-host up` keeps printing.
  io.lines.length = 0;
  await runPair(["--json"], host, io, { log() {} });
  assert.equal(io.json().token, j.token);
  const saved = JSON.parse(await fs.readFile(path.join(home, ".config/buzz-host/up-token.json"), "utf8"));
  assert.equal(saved.token, j.token);
  assert.equal(j.tokenId, saved.id);

  io.lines.length = 0;
  await runPair([], host, io, { log() {} });
  assert.match(io.text(), /Pair a device with Box \(11111111/);
  assert.match(io.text(), /Pairing URL: +wss:\/\/box\.example\/_buzz-host#token=bha_/);
  assert.match(io.text(), /Iroh node: +nodeabc/);
  assert.match(io.text(), /Discovery: +publishing to wss:\/\/relay\.example/);
});

test("pair --new mints a separate admin token; --qr uses qrencode and degrades without it", async (t) => {
  const { host, io, state } = await setup(t);
  await runPair(["--json"], host, io, { log() {} });
  const first = io.json();
  io.lines.length = 0;
  await runPair(["--new", "--label", "tablet", "--json", "--url", "wss://z.example/x", "--qr"], host, io, { log() {} });
  const second = io.json();
  assert.notEqual(second.token, first.token);
  assert.equal(second.new, true);
  assert.equal(second.url, "wss://z.example/x");
  assert.equal(second.qr, `QR[${second.pairingUrl}]\n`);
  const tokens = await createTokenStore({ filePath: host.paths.tokens }).list();
  assert.deepEqual(tokens.map((x) => x.label), [`buzz-host up (box.local)`, "tablet"]);

  state.noQr = true;
  const warnings = [];
  io.lines.length = 0;
  assert.equal(await runPair(["--qr", "--json"], host, io, { log: (m) => warnings.push(m) }), 0);
  assert.equal("qr" in io.json(), false);
  assert.match(warnings[0], /qrencode is not installed/);
  await assert.rejects(runPair(["--label", "x"], host, io), /only applies with --new/);
  await assert.rejects(runPair(["--url", "https://x"], host, io), /ws:\/\/ or wss:\/\//);
});

// ---------- logs ----------

test("logs: server by default, one agent by name or pubkey prefix; --json", async (t) => {
  const { host, io, keys, unitName } = await setup(t);
  assert.equal(await runLogs([], host, io), 0);
  assert.match(io.text(), /^line one for buzz-host\.service/);
  io.lines.length = 0;
  assert.equal(await runLogs(["bob", "-n", "20", "--json"], host, io), 0);
  const j = io.json();
  assert.deepEqual(j.target, { pubkey: keys[1].pubkey, name: "Bob" });
  assert.equal(j.unit, unitName(keys[1].pubkey));
  assert.deepEqual(j.lines, [`line one for ${unitName(keys[1].pubkey)}`, "line two"]);
  await assert.rejects(runLogs(["--lines", "0"], host, io), /--lines must be/);
  await assert.rejects(runLogs(["a", "b"], host, io), /at most one agent/);
  await assert.rejects(runLogs(["-f", "--json"], host, io), /can't be combined/);
  await assert.rejects(runLogs(["zzzz"], host, io), /no agent matches/);
});

test("logs -f follows with journalctl on Linux and tail -F on macOS", async (t) => {
  const linux = await setup(t);
  const seen = [];
  assert.equal(await runLogs(["-f", "alice"], linux.host, linux.io, { followFn: async (c, a) => (seen.push([c, ...a]), 0) }), 0);
  assert.deepEqual(seen[0], ["journalctl", "--user", "-u", linux.unitName(linux.keys[0].pubkey), "-n", "80", "-f", "-o", "short-iso"]);

  const mac = await setup(t, { platform: "darwin" });
  assert.equal(await runLogs(["-f"], mac.host, mac.io, { followFn: async (c, a) => (seen.push([c, ...a]), 0) }), 0);
  assert.deepEqual(seen[1], ["tail", "-n", "80", "-F", path.join(mac.home, "Library/Logs/buzz-host/server.log")]);
});

test("logs (launchd) reads the log files", async (t) => {
  const { host, io, home, keys } = await setup(t, { platform: "darwin" });
  const logs = path.join(home, "Library/Logs/buzz-host");
  await fs.mkdir(logs, { recursive: true });
  await fs.writeFile(path.join(logs, "server.log"), "s1\ns2\ns3\n");
  await fs.writeFile(path.join(logs, `agent-${keys[0].pubkey}.log`), "a1\na2\n");
  assert.equal(await runLogs(["-n", "2"], host, io), 0);
  assert.equal(io.text(), "s2\ns3");
  io.lines.length = 0;
  assert.equal(await runLogs(["alice"], host, io), 0);
  assert.equal(io.text(), "a1\na2");
  io.lines.length = 0;
  assert.equal(await runLogs(["bob"], host, io), 0);
  assert.match(io.errs.at(-1), /no log lines/);
});

// ---------- doctor ----------

async function installFake(host, { bins = ["buzz-acp", "buzz", "acp-proxy"], runtimes = [] } = {}) {
  const { paths, home } = host;
  await fs.mkdir(paths.bin, { recursive: true });
  await fs.mkdir(path.dirname(paths.serviceFile), { recursive: true });
  await fs.writeFile(path.join(paths.lib, "buzz-host.mjs"), "");
  await fs.writeFile(paths.serviceFile, "");
  for (const b of bins) await fs.writeFile(path.join(paths.bin, b), "", { mode: 0o755 });
  for (const rel of runtimes) {
    const file = path.join(home, rel);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "", { mode: 0o755 });
  }
  await fs.mkdir(path.join(home, "bin"), { recursive: true });
  await fs.writeFile(path.join(home, "bin/python3"), "", { mode: 0o755 });
}

const byId = (j) => Object.fromEntries(j.checks.map((c) => [c.id, c]));

test("doctor on a healthy machine: all ok, exit 0", async (t) => {
  const { host, io } = await setup(t, { units: { "buzz-host.service": "active" } });
  await installFake(host, { runtimes: [".local/lib/buzz-host/npm/node_modules/.bin/claude-agent-acp", ".claude/.credentials.json"] });
  assert.equal(await runDoctor(["--json"], host, io), 0);
  const j = io.json();
  assert.equal(j.ok, true);
  assert.equal(j.summary.fail, 0);
  const c = byId(j);
  assert.equal(c["service-manager"].status, "ok");
  assert.equal(c.linger.status, "ok");
  assert.equal(c.install.status, "ok");
  assert.equal(c.config.status, "ok");
  assert.equal(c.server.status, "ok");
  assert.equal(c["port-token"].status, "ok");
  assert.equal(c["runtime-claude"].status, "ok");
  assert.match(c["runtime-claude"].message, /signed in/);
  assert.equal(c["runtime-codex"].status, "info");
  assert.equal(c.python.status, "ok");
  assert.equal(c["public-url"].status, "info");
  assert.ok(!("hint" in c.linger));
});

test("doctor: a stopped, half-installed machine fails with hints", async (t) => {
  const { host, io, state } = await setup(t, { config: null });
  state.linger = "no";
  await fs.mkdir(path.join(host.home, "bin"), { recursive: true });
  assert.equal(await runDoctor(["--json"], host, io), 1);
  const j = io.json();
  assert.equal(j.ok, false);
  const c = byId(j);
  assert.equal(c.linger.status, "warn");
  assert.match(c.linger.hint, /enable-linger tester/);
  for (const id of ["install", "config", "server", "binaries", "python"]) assert.equal(c[id].status, "fail", id);
  assert.match(c.install.hint, /buzz-host up/);
  assert.equal(c.runtimes.status, "warn");
  assert.equal(c["port-token"], undefined, "no port check while buzz-host is down");

  io.lines.length = 0;
  await runDoctor([], host, io);
  assert.match(io.text(), /^\[warn\] lingering is off for tester/m);
  assert.match(io.text(), /^ {8}-> run `sudo loginctl enable-linger tester`/m);
  assert.match(io.text(), /\d+ failure\(s\)$/m);
});

test("doctor: sign-in, port and config problems", async (t) => {
  const { host, io, state } = await setup(t, {
    config: { port: 8457, guestPort: 8467, allowLogins: ["me@example.com"], publicGuestUrl: "wss://box.example/x" },
    units: { "buzz-host.service": "active" },
  });
  await installFake(host, { runtimes: [".local/lib/buzz-host/npm/node_modules/.bin/codex-acp"] });
  state.health = new Set([8457]); // the token listener is dead
  assert.equal(await runDoctor(["--json"], host, io), 1);
  let c = byId(io.json());
  assert.equal(c["port-token"].status, "fail");
  assert.equal(c["port-tailnet"].status, "ok");
  assert.equal(c["runtime-codex"].status, "warn");
  assert.match(c["runtime-codex"].hint, /codex login/);
  assert.match(c["public-url"].message, /wss:\/\/box\.example\/x/);

  // OPENAI_API_KEY counts as a sign-in; a bad config is a failure.
  host.env.OPENAI_API_KEY = "sk-test";
  await fs.writeFile(host.paths.config, JSON.stringify({ allowLogins: "me" }));
  io.lines.length = 0;
  assert.equal(await runDoctor(["--json"], host, io), 1);
  c = byId(io.json());
  assert.equal(c["runtime-codex"].status, "ok");
  assert.match(c["runtime-codex"].message, /OPENAI_API_KEY/);
  assert.equal(c.config.status, "fail");
  assert.match(c.config.message, /allowLogins must list Tailscale logins/);
});

test("doctor (launchd): checks the gui domain and doesn't look at systemd or linger", async (t) => {
  const { host, io, state } = await setup(t, { platform: "darwin", units: { "com.buzz-host.server": "active" } });
  assert.equal(await runDoctor(["--json"], host, io), 1);
  const c = byId(io.json());
  assert.equal(c["service-manager"].status, "ok");
  assert.match(c["service-manager"].message, /launchd gui\//);
  assert.equal(c.linger, undefined);
  assert.ok(!state.calls.some((call) => call[0] === "systemctl" || call[0] === "loginctl"));
});

// ---------- the real entrypoint, in a throwaway HOME ----------

test("bin/buzz-host runs status/tokens/doctor with real subprocesses and a fake systemctl", async (t) => {
  const home = await tmp(t);
  const bin = path.join(home, "fakebin");
  await fs.mkdir(bin);
  await fs.writeFile(
    path.join(bin, "systemctl"),
    '#!/bin/sh\ncase "$2" in is-active) echo inactive; exit 3;; esac\nexit 0\n',
    { mode: 0o755 },
  );
  await fs.writeFile(path.join(bin, "loginctl"), "#!/bin/sh\necho Linger=yes\n", { mode: 0o755 });
  const env = { PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, XDG_RUNTIME_DIR: path.join(home, "run") };
  const cli = path.join(REPO, "bin/buzz-host");
  const exec = (args) => realRun(cli, args, { env }).then((r) => ({ code: 0, ...r }), (e) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }));

  const status = await exec(["status", "--json"]);
  assert.equal(status.code, 3);
  assert.equal(JSON.parse(status.stdout).server.state, "inactive");

  const made = await exec(["tokens", "create-admin", "--label", "e2e", "--json"]);
  assert.equal(made.code, 0);
  const { record } = JSON.parse(made.stdout);
  const list = JSON.parse((await exec(["tokens", "list", "--json"])).stdout);
  assert.deepEqual(list.tokens.map((x) => x.id), [record.id]);
  assert.equal((await exec(["tokens", "revoke", record.id])).code, 0);

  const doctor = await exec(["doctor", "--json"]);
  assert.equal(doctor.code, 1);
  assert.equal(JSON.parse(doctor.stdout).checks.find((c) => c.id === "server").status, "fail");

  const bad = await exec(["logs", "--bogus"]);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /unknown option --bogus/);
  assert.equal((await exec(["down", "nobody"])).code, 1);
});
