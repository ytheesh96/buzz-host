// `buzz-host up` against a temporary HOME: the real deploy.sh installs the
// files, systemctl/launchctl/loginctl/npm are faked, health is faked.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createTokenStore } from "../server/auth.mjs";
import { main, usage } from "./main.mjs";
import { bytesToHex, hexToBytes, schnorr, sha256 } from "../server/noble.mjs";
import { connectUrl, formatHuman, parseUpArgs, tailscaleServe, up } from "./up.mjs";

const realRun = promisify(execFile);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** A bundle-shaped root: the repo parts deploy.sh reads, plus VERSION/BUNDLE_ID, fake bin/ and node. */
async function makeBundle(dir, { version = "1.0.0", bundleId = `${version} linux-x64 test`, acp = "acp-1" } = {}) {
  await fs.mkdir(dir, { recursive: true });
  for (const item of ["deploy.sh", "server", "hermes-plugin", "agy-plugin", "cli"])
    await fs.cp(path.join(REPO, item), path.join(dir, item), { recursive: true });
  await fs.writeFile(path.join(dir, "VERSION"), `${version}\n`);
  await fs.writeFile(path.join(dir, "BUNDLE_ID"), `${bundleId}\n`);
  await fs.mkdir(path.join(dir, "bin"), { recursive: true });
  for (const name of ["buzz-acp", "buzz", "buzz-host-iroh"])
    await fs.writeFile(path.join(dir, "bin", name), `#!/bin/sh\necho ${name} ${name === "buzz-acp" ? acp : ""}\n`, { mode: 0o755 });
  await fs.writeFile(path.join(dir, "bin/buzz-acp.version"), `${acp} +6 patches\n`);
  await fs.mkdir(path.join(dir, "node/bin"), { recursive: true });
  await fs.writeFile(path.join(dir, "node/bin/node"), "#!/bin/sh\n", { mode: 0o755 });
  return dir;
}

async function tmp(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bh-up-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Fake service tools. `bash` (deploy.sh) runs for real unless `fakeDeploy`.
 * `state.active` / `state.loaded` say whether buzz-host is running.
 */
function fakeRun({ state, calls, fakeDeploy }) {
  return async (cmd, args, options = {}) => {
    calls.push([cmd, ...args]);
    if (cmd === "bash") {
      if (fakeDeploy) return fakeDeploy(options.env);
      return realRun(cmd, args, options);
    }
    if (cmd === "systemctl") {
      const sub = args[1];
      if (sub === "is-active") {
        if (state.active) return { stdout: "active\n", stderr: "" };
        throw Object.assign(new Error("inactive"), { stdout: "inactive\n" });
      }
      if (sub === "restart") state.active = true;
      return { stdout: "", stderr: "" };
    }
    if (cmd === "loginctl") {
      if (args[0] === "show-user") return { stdout: `Linger=${state.linger ? "yes" : "no"}\n`, stderr: "" };
      if (state.lingerFails) throw Object.assign(new Error("denied"), { stderr: "Access denied" });
      state.linger = true;
      return { stdout: "", stderr: "" };
    }
    if (cmd === "launchctl") {
      if (args[0] === "print") {
        if (state.loaded) return { stdout: "state = running\n", stderr: "" };
        throw Object.assign(new Error("Could not find service"), { code: 113 });
      }
      if (args[0] === "bootstrap") state.loaded = true;
      if (args[0] === "bootout") state.loaded = false;
      return { stdout: "", stderr: "" };
    }
    if (cmd === "tailscale") {
      if (!state.tailscale) throw Object.assign(new Error("spawn tailscale ENOENT"), { code: "ENOENT" });
      return state.tailscale(args);
    }
    if (cmd.endsWith("npm")) {
      state.npm = args;
      return { stdout: "", stderr: "" };
    }
    throw new Error(`unexpected command ${cmd}`);
  };
}

function deps(t, { root, home, state, calls, platform = "linux", fakeDeploy, logs = [] }) {
  return {
    root,
    home,
    platform,
    uid: 1000,
    user: "tester",
    env: { PATH: process.env.PATH, HOME: home, XDG_RUNTIME_DIR: path.join(home, "run") },
    run: fakeRun({ state, calls, fakeDeploy }),
    fetchImpl: async () => ({ ok: true, status: 200 }),
    log: (line) => logs.push(line),
    irohWaitMs: 0,
    healthTimeoutMs: 1_000,
  };
}

const names = (calls, cmd) => calls.filter((c) => c[0] === cmd).map((c) => c.slice(1).join(" "));

test("first up installs, writes a token-only config, starts buzz-host and prints the contract", async (t) => {
  const dir = await tmp(t);
  const root = await makeBundle(path.join(dir, "bundle"));
  const home = path.join(dir, "home");
  await fs.mkdir(home);
  const state = {};
  const calls = [];
  const { result, service, installed } = await up({ adapters: false }, deps(t, { root, home, state, calls }));

  assert.deepEqual(Object.keys(result).sort(), ["token", "url", "version"]);
  assert.equal(result.version, "1.0.0");
  assert.equal(result.url, "ws://127.0.0.1:8467");
  assert.match(result.token, /^bha_[0-9a-f]{48}$/);
  assert.equal(service, "started");
  assert.ok(installed.includes("files") && installed.includes("buzz-acp") && installed.includes("node"));

  const config = JSON.parse(await fs.readFile(path.join(home, ".config/buzz-host/config.json"), "utf8"));
  assert.deepEqual(config, { port: 8457, guestPort: 8467, publicGuestUrl: "" });
  assert.equal((await fs.stat(path.join(home, ".config/buzz-host/config.json"))).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.join(home, ".config/buzz-host/up-token.json"))).mode & 0o777, 0o600);

  const lib = path.join(home, ".local/lib/buzz-host");
  await fs.access(path.join(lib, "buzz-host.mjs"));
  await fs.access(path.join(lib, "agent-run"));
  assert.equal(await fs.readFile(path.join(lib, "bin/buzz-acp.version"), "utf8"), "acp-1 +6 patches\n");
  assert.equal(await fs.readlink(path.join(lib, "bin/node")), path.join(root, "node/bin/node"));
  const unit = await fs.readFile(path.join(home, ".config/systemd/user/buzz-host.service"), "utf8");
  assert.match(unit, new RegExp(`^ExecStart=${path.join(root, "node/bin/node")} %h/\\.local/lib/buzz-host/buzz-host\\.mjs$`, "m"));
  await fs.access(path.join(home, ".config/systemd/user/buzz-agent@.service"));

  assert.deepEqual(names(calls, "loginctl"), ["show-user tester -p Linger", "enable-linger tester"]);
  assert.deepEqual(names(calls, "systemctl"), [
    "--user daemon-reload",
    "--user enable buzz-host.service",
    "--user is-active buzz-host.service",
    "--user restart buzz-host.service",
  ]);
  // Agents are never touched.
  assert.ok(!calls.some((c) => c.join(" ").includes("buzz-agent@")));

  // The token is a live admin token in tokens.json.
  const store = createTokenStore({ filePath: path.join(home, ".local/share/buzz-host/tokens.json") });
  assert.equal((await store.verify(result.token)).role, "admin");
});

test("re-running up with the same bundle changes nothing and restarts nothing", async (t) => {
  const dir = await tmp(t);
  const root = await makeBundle(path.join(dir, "bundle"));
  const home = path.join(dir, "home");
  await fs.mkdir(home);
  const state = {};
  const first = await up({ adapters: false }, deps(t, { root, home, state, calls: [] }));
  const lib = path.join(home, ".local/lib/buzz-host");
  const before = (await fs.stat(path.join(lib, "buzz-host.mjs"))).mtimeMs;

  const calls = [];
  const second = await up({ adapters: false }, deps(t, { root, home, state, calls }));
  assert.equal(second.service, "running");
  assert.deepEqual(second.installed, []);
  assert.deepEqual(second.result, first.result);
  assert.equal(names(calls, "bash").length, 0, "deploy.sh does not run again");
  assert.ok(!names(calls, "systemctl").some((c) => c.includes("restart")));
  assert.deepEqual(names(calls, "loginctl"), ["show-user tester -p Linger"]);
  assert.equal((await fs.stat(path.join(lib, "buzz-host.mjs"))).mtimeMs, before);
  const tokens = JSON.parse(await fs.readFile(path.join(home, ".local/share/buzz-host/tokens.json"), "utf8")).tokens;
  assert.equal(tokens.length, 1, "no second token");
});

test("a new bundle upgrades in place, keeps buzz-acp.prev, and restarts only buzz-host", async (t) => {
  const dir = await tmp(t);
  const home = path.join(dir, "home");
  await fs.mkdir(home);
  const state = {};
  const v1 = await makeBundle(path.join(dir, "v1"));
  const first = await up({ adapters: false }, deps(t, { root: v1, home, state, calls: [] }));
  const v2 = await makeBundle(path.join(dir, "v2"), { version: "1.1.0", acp: "acp-2" });
  const calls = [];
  const second = await up({ adapters: false }, deps(t, { root: v2, home, state, calls }));
  assert.equal(second.service, "restarted");
  assert.equal(second.result.version, "1.1.0");
  assert.equal(second.result.token, first.result.token);
  assert.equal(names(calls, "bash").length, 1);
  assert.deepEqual(
    names(calls, "systemctl").filter((c) => /restart|stop|start/.test(c)),
    ["--user restart buzz-host.service"],
  );
  const bin = path.join(home, ".local/lib/buzz-host/bin");
  assert.match(await fs.readFile(path.join(bin, "buzz-acp"), "utf8"), /acp-2/);
  assert.match(await fs.readFile(path.join(bin, "buzz-acp.prev"), "utf8"), /acp-1/);
  assert.equal(await fs.readlink(path.join(bin, "node")), path.join(v2, "node/bin/node"));
});

test("a revoked saved token is replaced; --url is saved and printed", async (t) => {
  const dir = await tmp(t);
  const root = await makeBundle(path.join(dir, "bundle"));
  const home = path.join(dir, "home");
  await fs.mkdir(home);
  const state = {};
  const first = await up({ adapters: false }, deps(t, { root, home, state, calls: [] }));
  const store = createTokenStore({ filePath: path.join(home, ".local/share/buzz-host/tokens.json") });
  const saved = JSON.parse(await fs.readFile(path.join(home, ".config/buzz-host/up-token.json"), "utf8"));
  await store.revoke(saved.id);

  const calls = [];
  const url = "wss://box.example.ts.net/_buzz-host";
  const second = await up({ adapters: false, url }, deps(t, { root, home, state, calls }));
  assert.notEqual(second.result.token, first.result.token);
  assert.equal((await store.verify(second.result.token)).role, "admin");
  assert.equal(await store.verify(first.result.token), null);
  assert.equal(second.result.url, url);
  const config = JSON.parse(await fs.readFile(path.join(home, ".config/buzz-host/config.json"), "utf8"));
  assert.equal(config.publicGuestUrl, url);
  assert.equal(second.service, "restarted", "a config change restarts buzz-host");
});

test("an existing config is kept; a missing guestPort is added", async (t) => {
  const dir = await tmp(t);
  const root = await makeBundle(path.join(dir, "bundle"));
  const home = path.join(dir, "home");
  await fs.mkdir(path.join(home, ".config/buzz-host"), { recursive: true });
  const existing = { port: 9000, allowLogins: ["me@example.com"], allowCommunities: ["wss://relay.example"] };
  await fs.writeFile(path.join(home, ".config/buzz-host/config.json"), JSON.stringify(existing));
  const { result } = await up({ adapters: false, service: false }, deps(t, { root, home, state: {}, calls: [] }));
  const config = JSON.parse(await fs.readFile(path.join(home, ".config/buzz-host/config.json"), "utf8"));
  assert.deepEqual(config, { ...existing, guestPort: 8467 });
  // No publicGuestUrl in an existing config: the local token listener.
  assert.equal(result.url, "ws://127.0.0.1:8467");
});

test("--no-service touches no service manager; a failed linger only warns", async (t) => {
  const dir = await tmp(t);
  const root = await makeBundle(path.join(dir, "bundle"));
  const home = path.join(dir, "home");
  await fs.mkdir(home);
  const calls = [];
  const out = await up({ adapters: false, service: false }, deps(t, { root, home, state: {}, calls }));
  assert.equal(out.service, "skipped");
  assert.deepEqual(names(calls, "systemctl"), []);
  assert.deepEqual(names(calls, "loginctl"), []);

  const logs = [];
  const state = { lingerFails: true };
  const again = await up({ adapters: false }, deps(t, { root, home, state, calls: [], logs }));
  assert.equal(again.service, "started");
  assert.ok(logs.some((l) => /could not enable lingering/.test(l)));
});

test("the iroh node id becomes `pubkey` once the endpoint is up", async (t) => {
  const dir = await tmp(t);
  const root = await makeBundle(path.join(dir, "bundle"));
  const home = path.join(dir, "home");
  await fs.mkdir(path.join(home, "run/buzz-host"), { recursive: true });
  await fs.writeFile(path.join(home, "run/buzz-host/iroh-addr.json"), JSON.stringify({ nodeId: "ab".repeat(32), endpointAddr: "x" }));
  const { result } = await up({ adapters: false }, deps(t, { root, home, state: {}, calls: [] }));
  assert.equal(result.pubkey, "ab".repeat(32));
});

test("darwin: the LaunchAgent is bootstrapped once, then left alone", async (t) => {
  const dir = await tmp(t);
  const root = await makeBundle(path.join(dir, "bundle"));
  const home = path.join(dir, "home");
  await fs.mkdir(home);
  // deploy.sh's macOS branch can't run on a Linux test host: stand in for it.
  const fakeDeploy = async (env) => {
    assert.equal(env.BUZZ_HOST_SKIP_RESTART, "1");
    assert.equal(env.BUZZ_HOST_NODE, path.join(root, "node/bin/node"));
    await fs.mkdir(path.join(home, ".local/lib/buzz-host"), { recursive: true });
    await fs.writeFile(path.join(home, ".local/lib/buzz-host/buzz-host.mjs"), "");
    await fs.mkdir(path.join(home, "Library/LaunchAgents"), { recursive: true });
    await fs.writeFile(path.join(home, "Library/LaunchAgents/com.buzz-host.server.plist"), "<plist/>");
    return { stdout: "", stderr: "" };
  };
  const state = {};
  const calls = [];
  const first = await up({ adapters: false }, deps(t, { root, home, state, calls, platform: "darwin", fakeDeploy }));
  assert.equal(first.service, "started");
  assert.deepEqual(names(calls, "launchctl"), [
    "print gui/1000/com.buzz-host.server",
    `bootstrap gui/1000 ${path.join(home, "Library/LaunchAgents/com.buzz-host.server.plist")}`,
  ]);
  assert.deepEqual(names(calls, "loginctl"), []);
  const again = [];
  const second = await up({ adapters: false }, deps(t, { root, home, state, calls: again, platform: "darwin", fakeDeploy }));
  assert.equal(second.service, "running");
  assert.deepEqual(names(again, "launchctl"), ["print gui/1000/com.buzz-host.server"]);
});

test("missing ACP adapters are npm-installed with the bundle's npm, once", async (t) => {
  const dir = await tmp(t);
  const root = await makeBundle(path.join(dir, "bundle"));
  const home = path.join(dir, "home");
  await fs.mkdir(home);
  const state = {};
  const calls = [];
  await up({ service: false }, deps(t, { root, home, state, calls }));
  const npmCall = calls.find((c) => c[0].endsWith("npm"));
  assert.equal(npmCall[0], path.join(root, "node/bin/npm"));
  assert.ok(npmCall.includes("@agentclientprotocol/claude-agent-acp@^0.107.0"));
  assert.ok(npmCall.includes(path.join(home, ".local/lib/buzz-host/npm")));
  // Pretend npm installed them: the next run doesn't call npm.
  for (const name of ["@agentclientprotocol/claude-agent-acp", "@agentclientprotocol/codex-acp"]) {
    const d = path.join(home, ".local/lib/buzz-host/npm/node_modules", name);
    await fs.mkdir(d, { recursive: true });
    await fs.writeFile(path.join(d, "package.json"), "{}");
  }
  const again = [];
  await up({ service: false }, deps(t, { root, home, state, calls: again }));
  assert.ok(!again.some((c) => c[0].endsWith("npm")));
});

test("argument parsing and the command table", async () => {
  assert.deepEqual(parseUpArgs(["--json", "--guest-port", "9467", "--no-linger"]), {
    json: true, force: false, service: true, linger: false, adapters: true, guestPort: 9467,
  });
  assert.throws(() => parseUpArgs(["--url", "https://x"]), /ws:\/\/ or wss:\/\//);
  assert.throws(() => parseUpArgs(["--guest-port", "0"]), /port number/);
  assert.throws(() => parseUpArgs(["--bogus"]), /unknown option/);
  assert.equal(connectUrl({ guestPort: 1, publicGuestUrl: " wss://a/b " }), "wss://a/b");
  assert.match(usage(), /^ {2}up {2}/m);
  assert.match(usage(), /^ {2}version {2}/m);
  assert.equal(await main(["nope"]).catch(() => "threw"), 2);
});

test("bin/buzz-host runs the CLI through a symlink", async (t) => {
  const dir = await tmp(t);
  const link = path.join(dir, "buzz-host");
  await fs.symlink(path.join(REPO, "bin/buzz-host"), link);
  const { stdout } = await realRun(link, ["--help"], { env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin` } });
  assert.match(stdout, /Usage: buzz-host <command>/);
});

// ---------- --tailscale-serve, --lan, --owner/--relay/--owner-proof ----------

const tsStatus = (over = {}) =>
  JSON.stringify({ BackendState: "Running", Self: { DNSName: "box.tail1234.ts.net." }, CertDomains: ["box.tail1234.ts.net"], ...over });

test("--tailscale-serve: serves the token listener on the tailnet name and saves the wss URL", async (t) => {
  const dir = await tmp(t);
  const root = await makeBundle(path.join(dir, "bundle"));
  const home = path.join(dir, "home");
  await fs.mkdir(home);
  const served = [];
  const state = {
    tailscale: async (args) => {
      if (args[0] === "status") return { stdout: tsStatus(), stderr: "" };
      served.push(args);
      return { stdout: "", stderr: "" };
    },
  };
  const opts = parseUpArgs(["--tailscale-serve", "--tailscale-path", "/bh", "--guest-port", "9467"]);
  const { result, config } = await up({ ...opts, adapters: false, service: false }, deps(t, { root, home, state, calls: [] }));
  assert.deepEqual(served, [["serve", "--bg", "--set-path", "/bh", "http://127.0.0.1:9467"]]);
  assert.equal(result.url, "wss://box.tail1234.ts.net/bh");
  assert.equal(config.publicGuestUrl, "wss://box.tail1234.ts.net/bh");
  assert.equal(config.guestHost, undefined, "buzz-host itself stays on loopback");
  assert.doesNotMatch(formatHuman({ result, service: "skipped", installed: [] }), /127\.0\.0\.1 URL directly/);

  // The default path, and the existing config's guestPort wins over --guest-port.
  served.length = 0;
  await up({ ...parseUpArgs(["--tailscale-serve"]), adapters: false, service: false }, deps(t, { root, home, state, calls: [] }));
  assert.deepEqual(served, [["serve", "--bg", "--set-path", "/_buzz-host", "http://127.0.0.1:9467"]]);

  assert.throws(() => parseUpArgs(["--tailscale-path", "/x"]), /only applies with --tailscale-serve/);
  assert.throws(() => parseUpArgs(["--tailscale-serve", "--url", "wss://x"]), /drop --url/);
  assert.throws(() => parseUpArgs(["--tailscale-serve", "--tailscale-path", "nope"]), /must be a path/);
});

test("--tailscale-serve errors say what to fix", async () => {
  const serve = (tailscale) =>
    tailscaleServe({
      run: async (cmd, args, opts) => (tailscale ? tailscale(args, opts) : Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))),
      guestPort: 8467,
      log() {},
    });
  const fail = (stderr) => Promise.reject(Object.assign(new Error("exit 1"), { stderr }));
  await assert.rejects(serve(null), /needs the tailscale CLI/);
  await assert.rejects(serve(() => fail("failed to connect to local tailscaled; it doesn't appear to be running")), /tailscaled is not running/);
  await assert.rejects(serve(() => ({ stdout: tsStatus({ BackendState: "NeedsLogin" }) })), /not logged in.*tailscale up/);
  await assert.rejects(serve(() => ({ stdout: tsStatus({ Self: { DNSName: "box." } }) })), /MagicDNS/);
  await assert.rejects(serve(() => ({ stdout: tsStatus({ CertDomains: [] }) })), /HTTPS Certificates/);
  const withServe = (onServe) => (args) => (args[0] === "status" ? { stdout: tsStatus() } : onServe());
  await assert.rejects(serve(withServe(() => fail("Access denied: serve config denied"))), /sudo tailscale set --operator=\$USER/);
  await assert.rejects(
    serve(withServe(() => fail("Serve is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/serve?node=abc\n"))),
    /enable it at https:\/\/login\.tailscale\.com\/f\/serve\?node=abc/,
  );
  assert.equal(await serve(withServe(() => ({ stdout: "" }))), "wss://box.tail1234.ts.net/_buzz-host");
});

test("--lan / --no-lan set guestHost and restart; the LAN note warns", async (t) => {
  const dir = await tmp(t);
  const root = await makeBundle(path.join(dir, "bundle"));
  const home = path.join(dir, "home");
  await fs.mkdir(home);
  const state = {};
  await up({ adapters: false }, deps(t, { root, home, state, calls: [] }));
  const readConfig = async () => JSON.parse(await fs.readFile(path.join(home, ".config/buzz-host/config.json"), "utf8"));
  assert.equal((await readConfig()).guestHost, undefined);
  const logs = [];
  const lan = await up({ ...parseUpArgs(["--lan"]), adapters: false }, deps(t, { root, home, state, calls: [], logs }));
  assert.equal((await readConfig()).guestHost, "0.0.0.0");
  assert.equal(lan.service, "restarted");
  assert.ok(logs.some((l) => /connections from your LAN.*access token/.test(l)));
  const again = await up({ ...parseUpArgs(["--lan"]), adapters: false }, deps(t, { root, home, state, calls: [] }));
  assert.equal(again.service, "running", "same setting: no restart");
  await up({ ...parseUpArgs(["--no-lan"]), adapters: false }, deps(t, { root, home, state, calls: [] }));
  assert.equal((await readConfig()).guestHost, "127.0.0.1");
});

test("--owner/--relay/--owner-proof: saved for zero-agent discovery; bad proofs refused", async (t) => {
  const dir = await tmp(t);
  const root = await makeBundle(path.join(dir, "bundle"));
  const home = path.join(dir, "home");
  await fs.mkdir(home);
  const ownerSecret = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
  const owner = bytesToHex(schnorr.getPublicKey(hexToBytes(ownerSecret)));
  const readConfig = async () => JSON.parse(await fs.readFile(path.join(home, ".config/buzz-host/config.json"), "utf8"));
  const run = (argv) => up({ ...parseUpArgs(argv), adapters: false, service: false }, deps(t, { root, home, state: {}, calls: [] }));

  const first = await run(["--owner", owner, "--relay", "wss://relay.example", "--relay", "wss://relay.example"]);
  assert.match(first.machinePubkey, /^[0-9a-f]{64}$/);
  let config = await readConfig();
  assert.equal(config.ownerPubkey, owner);
  assert.deepEqual(config.discoveryRelays, ["wss://relay.example"]);
  assert.match(formatHuman(first), new RegExp(`waiting for your attestation of this machine's key ${first.machinePubkey}`));

  const sign = (target) =>
    JSON.stringify(["auth", owner, "", bytesToHex(schnorr.sign(sha256(new TextEncoder().encode(`nostr:agent-auth:${target}:`)), hexToBytes(ownerSecret)))]);
  await assert.rejects(run(["--owner-proof", sign("ab".repeat(32))]), /does not attest this machine's key/);
  await assert.rejects(run(["--owner-proof", "{}"]), /JSON Buzz prints/);
  const second = await run(["--owner-proof", sign(first.machinePubkey), "--relay", "wss://two.example"]);
  assert.equal(second.machinePubkey, first.machinePubkey, "the machine key is kept");
  config = await readConfig();
  assert.deepEqual(config.ownerAuth.slice(0, 3), ["auth", owner, ""]);
  assert.deepEqual(config.discoveryRelays, ["wss://relay.example", "wss://two.example"]);
  assert.doesNotMatch(formatHuman(second), /waiting for your attestation/);

  // A different owner drops the old owner's relays and proof.
  await run(["--owner", "ab".repeat(32)]);
  config = await readConfig();
  assert.equal(config.ownerPubkey, "ab".repeat(32));
  assert.equal(config.ownerAuth, undefined);
  assert.deepEqual(config.discoveryRelays, []);

  assert.throws(() => parseUpArgs(["--owner", "npub1nope"]), /not a Nostr public key/);
  assert.throws(() => parseUpArgs(["--relay", "https://x"]), /wss:\/\//);
});
