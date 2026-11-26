// node --test server/service-manager.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import {
  agentPlist,
  createServiceManager,
  ensurePrivateDir,
  parseLaunchctlState,
  renderPlist,
  runDir,
  runtimeBase,
  tailFile,
  xmlEscape,
} from "./service-manager.mjs";

const PK = "ab".repeat(32);

/** A promisified-execFile stand-in that records calls and answers from `responder`. */
function fakeRun(responder = () => ({ stdout: "" })) {
  const calls = [];
  const run = async (cmd, args, opts) => {
    calls.push([cmd, ...args]);
    const out = responder(cmd, args, opts);
    if (out instanceof Error) throw out;
    return { stdout: "", stderr: "", ...out };
  };
  return { run, calls };
}

function execError(code, { stdout = "", stderr = "" } = {}) {
  return Object.assign(new Error(`exit ${code}`), { code, stdout, stderr });
}

async function tmpdir(t, prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

// ---------- linux (systemd --user) ----------

test("linux backend keeps the exact systemctl/journalctl calls", async () => {
  const { run, calls } = fakeRun((cmd, args) => {
    if (args.includes("is-active")) return { stdout: "active\n" };
    if (cmd === "journalctl") return { stdout: "2026-11-24T05:00:00+0000 host agent-run[1]: hi\n" };
    return {};
  });
  const sm = createServiceManager({ platform: "linux", run });
  assert.equal(sm.platform, "linux");
  assert.equal(sm.unit(PK), `buzz-agent@${PK}.service`);

  await sm.enableAndStart(PK);
  await sm.restart(PK);
  await sm.disableAndStop(PK);
  assert.equal(await sm.status(PK), "active");
  assert.match(await sm.logs(PK, 25), /hi/);

  const unit = `buzz-agent@${PK}.service`;
  assert.deepEqual(calls, [
    ["systemctl", "--user", "enable", "--now", unit],
    ["systemctl", "--user", "restart", unit],
    ["systemctl", "--user", "disable", "--now", unit],
    ["systemctl", "--user", "is-active", unit],
    ["journalctl", "--user", "-u", unit, "-n", "25", "--no-pager", "-o", "short-iso"],
  ]);
});

test("linux status/logs map failures like before", async () => {
  // is-active exits 3 with "inactive" on stdout; no stdout means unknown.
  let reply = execError(3, { stdout: "inactive\n" });
  const { run, calls } = fakeRun(() => reply);
  const sm = createServiceManager({ platform: "linux", run });
  assert.equal(await sm.status(PK), "inactive");
  reply = execError(1);
  assert.equal(await sm.status(PK), "unknown");
  // journalctl failures still return whatever stdout it produced.
  reply = execError(1, { stdout: "partial\n" });
  assert.equal(await sm.logs(PK), "partial\n");
  // lines are clamped to 1..500 and default to 80.
  reply = {};
  await sm.logs(PK, 10_000);
  await sm.logs(PK, 0);
  await sm.logs(PK, "junk");
  const ns = calls.filter((c) => c[0] === "journalctl").map((c) => c[c.indexOf("-n") + 1]);
  assert.deepEqual(ns.slice(-3), ["500", "80", "80"]);
  await assert.rejects(() => sm.restart("not-a-pubkey"), /Invalid agent pubkey/);
});

test("unsupported platforms fail loudly", () => {
  assert.throws(() => createServiceManager({ platform: "win32" }), /does not support win32/);
});

// ---------- run dir ----------

test("run dir: XDG_RUNTIME_DIR wins; macOS falls back to a short /tmp base", () => {
  assert.equal(runtimeBase({ platform: "linux", env: { XDG_RUNTIME_DIR: "/run/user/1000" }, uid: 1000 }), "/run/user/1000");
  assert.equal(runtimeBase({ platform: "linux", env: {}, uid: 1000 }), "/run/user/1000");
  assert.equal(runtimeBase({ platform: "darwin", env: {}, uid: 501 }), "/tmp/bh-501");
  assert.equal(runtimeBase({ platform: "darwin", env: { XDG_RUNTIME_DIR: "/tmp/x" }, uid: 501 }), "/tmp/x");
  assert.equal(runDir({ platform: "darwin", env: {}, uid: 501 }), "/tmp/bh-501/buzz-host");

  // The longest socket path buzz-host builds (sandbox agent control socket)
  // stays well under macOS's 104-byte sun_path, even for a large uid.
  const base = runDir({ platform: "darwin", env: {}, uid: 4_294_967_294 });
  const longest = [
    path.join(base, `${PK}.sock`),
    path.join(base, `${PK.slice(0, 16)}.d`, "worker-99.sock"),
    path.join(base, "sandbox", PK.slice(0, 16), "agent", "control.sock"),
    path.join(base, "desktop", PK.slice(0, 16), "rfb.sock"),
    path.join(base, "mcp.sock"),
  ];
  for (const p of longest) assert.ok(Buffer.byteLength(p) < 104, `${p} is ${Buffer.byteLength(p)} bytes`);
});

test("ensurePrivateDir creates 0700, tightens our own loose dir, refuses symlinks and other owners", async (t) => {
  const root = await tmpdir(t, "buzz-sm-priv-");
  const uid = process.getuid();
  const dir = path.join(root, "buzz-host-x");
  await ensurePrivateDir(dir, { uid });
  assert.equal((await fs.stat(dir)).mode & 0o777, 0o700);

  await fs.chmod(dir, 0o755);
  await ensurePrivateDir(dir, { uid });
  assert.equal((await fs.stat(dir)).mode & 0o777, 0o700);

  const link = path.join(root, "planted");
  await fs.symlink(dir, link);
  await assert.rejects(() => ensurePrivateDir(link, { uid }), /not a directory/);

  const file = path.join(root, "file");
  await fs.writeFile(file, "");
  await assert.rejects(() => ensurePrivateDir(file, { uid }), /not a directory/);

  await assert.rejects(() => ensurePrivateDir(dir, { uid: uid + 1 }), /owned by uid/);
});

// ---------- plist ----------

test("plists escape XML and render launchd types", () => {
  assert.equal(xmlEscape(`a&b<c>"d'e`), "a&amp;b&lt;c&gt;&quot;d&apos;e");
  const doc = renderPlist({ S: "<&>", B: true, F: false, I: 63, A: ["x", "y"], D: { K: "v" }, E: [], O: {}, U: undefined });
  assert.match(doc, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<!DOCTYPE plist/);
  assert.match(doc, /<key>S<\/key>\n\s*<string>&lt;&amp;&gt;<\/string>/);
  assert.match(doc, /<key>B<\/key>\n\s*<true\/>/);
  assert.match(doc, /<key>F<\/key>\n\s*<false\/>/);
  assert.match(doc, /<key>I<\/key>\n\s*<integer>63<\/integer>/);
  assert.match(doc, /<key>E<\/key>\n\s*<array\/>/);
  assert.match(doc, /<key>O<\/key>\n\s*<dict\/>/);
  assert.ok(!doc.includes("<key>U</key>"));
  assert.throws(() => renderPlist({ N: 1.5 }), /integers/);
});

test("agent plist runs agent-run, respawns only on crash, and carries env and log paths", () => {
  const home = "/Users/o'brien & co";
  const xml = agentPlist({
    pubkey: PK,
    libDir: `${home}/.local/lib/buzz-host`,
    home,
    runtimeDir: "/tmp/bh-501",
    logPath: `${home}/Library/Logs/buzz-host/agent-${PK}.log`,
    pathEnv: "/a:/b",
  });
  assert.ok(!xml.includes("o'brien & co"), "raw value must be escaped");
  assert.ok(xml.includes("o&apos;brien &amp; co"));
  assert.match(xml, new RegExp(`<key>Label</key>\\n\\s*<string>com\\.buzz-host\\.agent\\.${PK}</string>`));
  assert.match(xml, /<key>RunAtLoad<\/key>\n\s*<true\/>/);
  assert.match(xml, /<key>KeepAlive<\/key>\n\s*<dict>\n\s*<key>SuccessfulExit<\/key>\n\s*<false\/>/);
  assert.match(xml, /<key>BUZZ_HOST_AGENT<\/key>\n\s*<string>[0-9a-f]{64}<\/string>/);
  assert.match(xml, /<key>XDG_RUNTIME_DIR<\/key>\n\s*<string>\/tmp\/bh-501<\/string>/);
  assert.match(xml, /<key>PATH<\/key>\n\s*<string>\/a:\/b<\/string>/);
  assert.match(xml, /<string>[^<]*\/agent-run<\/string>\n\s*<string>[0-9a-f]{64}<\/string>/);
  assert.throws(() => agentPlist({ pubkey: "../evil" }), /Invalid agent pubkey/);
});

test("agent plist is a valid property list (python plistlib)", (t) => {
  const xml = agentPlist({
    pubkey: PK,
    libDir: "/Users/me/.local/lib/buzz-host",
    home: "/Users/me & <you>",
    runtimeDir: "/tmp/bh-501",
    logPath: "/Users/me/Library/Logs/buzz-host/a.log",
    pathEnv: "/usr/bin:/bin",
  });
  let parsed;
  try {
    parsed = JSON.parse(
      execFileSync(
        "python3",
        ["-I", "-c", "import json,plistlib,sys; print(json.dumps(plistlib.loads(sys.stdin.buffer.read())))"],
        { input: xml, encoding: "utf8" },
      ),
    );
  } catch (error) {
    if (error.code === "ENOENT") return t.skip("python3 not installed");
    throw error;
  }
  assert.equal(parsed.Label, `com.buzz-host.agent.${PK}`);
  assert.deepEqual(parsed.ProgramArguments, ["/Users/me/.local/lib/buzz-host/agent-run", PK]);
  assert.equal(parsed.EnvironmentVariables.HOME, "/Users/me & <you>");
  assert.equal(parsed.EnvironmentVariables.BUZZ_HOST_AGENT, PK);
  assert.deepEqual(parsed.KeepAlive, { SuccessfulExit: false });
  assert.equal(parsed.RunAtLoad, true);
  assert.equal(parsed.Umask, 0o077);
  assert.equal(parsed.StandardOutPath, parsed.StandardErrorPath);
});

test("server LaunchAgent template parses once deploy.sh fills it in", async (t) => {
  const tpl = await fs.readFile(new URL("./com.buzz-host.server.plist", import.meta.url), "utf8");
  for (const ph of ["__NODE__", "__LIB__", "__HOME__", "__RUNTIME_DIR__", "__LOG_DIR__"]) assert.ok(tpl.includes(ph), ph);
  const filled = tpl
    .replaceAll("__NODE__", "/opt/homebrew/bin/node")
    .replaceAll("__LIB__", "/Users/me/.local/lib/buzz-host")
    .replaceAll("__HOME__", "/Users/me")
    .replaceAll("__RUNTIME_DIR__", "/tmp/bh-501")
    .replaceAll("__LOG_DIR__", "/Users/me/Library/Logs/buzz-host");
  let parsed;
  try {
    parsed = JSON.parse(
      execFileSync(
        "python3",
        ["-I", "-c", "import json,plistlib,sys; print(json.dumps(plistlib.loads(sys.stdin.buffer.read())))"],
        { input: filled, encoding: "utf8" },
      ),
    );
  } catch (error) {
    if (error.code === "ENOENT") return t.skip("python3 not installed");
    throw error;
  }
  assert.equal(parsed.Label, "com.buzz-host.server");
  assert.deepEqual(parsed.ProgramArguments, ["/opt/homebrew/bin/node", "/Users/me/.local/lib/buzz-host/buzz-host.mjs"]);
  assert.equal(parsed.EnvironmentVariables.XDG_RUNTIME_DIR, "/tmp/bh-501");
  assert.deepEqual(parsed.KeepAlive, { SuccessfulExit: false });
});

// ---------- darwin (launchd) ----------

function darwinManager(t, root, responder, extra = {}) {
  const fake = fakeRun(responder);
  const sm = createServiceManager({
    platform: "darwin",
    run: fake.run,
    home: path.join(root, "home"),
    uid: 501,
    env: {},
    launchAgentsDir: path.join(root, "LaunchAgents"),
    logDir: path.join(root, "Logs"),
    unloadPollMs: 1,
    ...extra,
  });
  return { sm, calls: fake.calls };
}

test("darwin lifecycle: bootstrap, kickstart, bootout, with the plist on disk", async (t) => {
  const root = await tmpdir(t, "buzz-sm-darwin-");
  const label = `com.buzz-host.agent.${PK}`;
  const target = `gui/501/${label}`;
  let isLoaded = false;
  const { sm, calls } = darwinManager(t, root, (cmd, args) => {
    assert.equal(cmd, "launchctl");
    if (args[0] === "print") return isLoaded ? { stdout: "state = running\n" } : execError(113, { stderr: "Could not find service" });
    if (args[0] === "bootstrap") isLoaded = true;
    if (args[0] === "bootout") isLoaded = false;
    return {};
  });
  assert.equal(sm.platform, "darwin");
  assert.equal(sm.unit(PK), label);
  const plist = path.join(root, "LaunchAgents", `${label}.plist`);
  assert.equal(sm.plistPath(PK), plist);
  assert.equal(sm.logPath(PK), path.join(root, "Logs", `agent-${PK}.log`));

  assert.equal(await sm.status(PK), "inactive");
  await sm.enableAndStart(PK);
  const body = await fs.readFile(plist, "utf8");
  assert.match(body, /<key>XDG_RUNTIME_DIR<\/key>\n\s*<string>\/tmp\/bh-501<\/string>/);
  assert.match(body, new RegExp(`<string>${path.join(root, "home")}/\\.local/lib/buzz-host/agent-run</string>`));
  assert.match(body, /\/opt\/homebrew\/bin/);
  assert.equal((await fs.stat(plist)).mode & 0o777, 0o600);
  assert.equal(await sm.status(PK), "active");

  // enable again: already loaded, so no second bootstrap.
  await sm.enableAndStart(PK);
  await sm.restart(PK);
  await sm.disableAndStop(PK);
  await assert.rejects(() => fs.access(plist));
  // disabling twice is harmless (unloaded, file gone).
  await sm.disableAndStop(PK);

  assert.deepEqual(
    calls.filter((c) => c[1] !== "print"),
    [
      ["launchctl", "bootstrap", "gui/501", plist],
      ["launchctl", "kickstart", "-k", target],
      ["launchctl", "bootout", target],
    ],
  );
});

test("darwin restart of an unloaded agent loads it (writing the plist if missing)", async (t) => {
  const root = await tmpdir(t, "buzz-sm-darwin-restart-");
  const { sm, calls } = darwinManager(t, root, (_cmd, args) =>
    args[0] === "print" ? execError(113, { stderr: "Could not find service" }) : {},
  );
  await sm.restart(PK);
  await fs.access(sm.plistPath(PK));
  assert.deepEqual(calls.at(-1), ["launchctl", "bootstrap", "gui/501", sm.plistPath(PK)]);
});

test("darwin status maps launchctl print states to is-active words", async (t) => {
  assert.equal(parseLaunchctlState("\tstate = running\n\tpid = 42\n"), "active");
  assert.equal(parseLaunchctlState("\tstate = not running\n\tlast exit code = 0\n"), "inactive");
  assert.equal(parseLaunchctlState("\tstate = not running\n\tlast exit code = 1\n"), "failed");
  assert.equal(parseLaunchctlState("\tstate = spawn scheduled\n\tlast exit code = 1\n"), "activating");
  assert.equal(parseLaunchctlState("\tstate = waiting\n\tlast exit code = (never exited)\n"), "inactive");
  assert.equal(parseLaunchctlState("nothing useful"), "unknown");

  const root = await tmpdir(t, "buzz-sm-darwin-status-");
  let reply = execError(5, { stderr: "Bad request" });
  const { sm } = darwinManager(t, root, () => reply);
  assert.equal(await sm.status(PK), "unknown");
  reply = execError(113, { stdout: "Could not find service" });
  assert.equal(await sm.status(PK), "inactive");
});

test("darwin logs tail the last N lines of the agent's log file", async (t) => {
  const root = await tmpdir(t, "buzz-sm-darwin-logs-");
  const { sm, calls } = darwinManager(t, root, () => ({}));
  assert.equal(await sm.logs(PK), "", "no log yet");
  await fs.mkdir(path.dirname(sm.logPath(PK)), { recursive: true });
  const lines = Array.from({ length: 1000 }, (_, i) => `line ${i}`);
  await fs.writeFile(sm.logPath(PK), `${lines.join("\n")}\n`);
  assert.equal(await sm.logs(PK, 3), "line 997\nline 998\nline 999\n");
  assert.equal((await sm.logs(PK, 10_000)).split("\n").filter(Boolean).length, 500, "clamped to 500");
  assert.equal((await sm.logs(PK)).split("\n").filter(Boolean).length, 80, "default 80");
  assert.equal(calls.length, 0, "logs never shells out on macOS");
});

test("tailFile drops the partial first line when it reads only the file's end", async (t) => {
  const root = await tmpdir(t, "buzz-sm-tail-");
  const file = path.join(root, "big.log");
  // > 4 MiB so tailFile reads only the end, starting mid-line.
  const line = `${"x".repeat(1023)}\n`;
  await fs.writeFile(file, `${line.repeat(4200)}last one\n`);
  const out = await tailFile(file, 2);
  assert.equal(out, `${"x".repeat(1023)}\nlast one\n`);
  const many = (await tailFile(file, 100_000)).split("\n").filter(Boolean);
  assert.ok(many.every((l) => l === "x".repeat(1023) || l === "last one"), "no partial line");
  await fs.writeFile(file, "no newline at end");
  assert.equal(await tailFile(file, 5), "no newline at end\n");
});

test("darwin enableAndStart reloads a loaded agent only when its plist changed", async (t) => {
  const root = await tmpdir(t, "buzz-sm-darwin-reload-");
  let isLoaded = false;
  const responder = (_cmd, args) => {
    if (args[0] === "print") return isLoaded ? { stdout: "state = running\n" } : execError(113);
    if (args[0] === "bootstrap") isLoaded = true;
    if (args[0] === "bootout") isLoaded = false;
    return {};
  };
  const first = darwinManager(t, root, responder);
  await first.sm.enableAndStart(PK);
  await first.sm.enableAndStart(PK); // unchanged: nothing to do
  assert.deepEqual(first.calls.filter((c) => c[1] !== "print").map((c) => c[1]), ["bootstrap"]);

  // Same agent, new lib dir (e.g. a different install): plist differs -> reload.
  const second = darwinManager(t, root, responder, { libDir: path.join(root, "otherlib") });
  await second.sm.enableAndStart(PK);
  assert.deepEqual(second.calls.filter((c) => c[1] !== "print").map((c) => c[1]), ["bootout", "bootstrap"]);
  assert.match(await fs.readFile(second.sm.plistPath(PK), "utf8"), /otherlib\/agent-run/);
});

test("darwin disableAndStop waits for bootout to finish before removing the plist", async (t) => {
  const root = await tmpdir(t, "buzz-sm-darwin-bootout-");
  let state = "unloaded"; // unloaded -> loaded -> stopping (3 more polls) -> unloaded
  let stoppingPolls = 0;
  const { sm, calls } = darwinManager(t, root, (_cmd, args) => {
    if (args[0] === "print") {
      if (state === "stopping" && ++stoppingPolls > 3) state = "unloaded";
      return state === "unloaded" ? execError(113) : { stdout: "state = running\n" };
    }
    if (args[0] === "bootstrap") state = "loaded";
    if (args[0] === "bootout") state = "stopping";
    return {};
  });
  await sm.enableAndStart(PK);
  await sm.disableAndStop(PK);
  const after = calls.slice(calls.findIndex((c) => c[1] === "bootout") + 1);
  assert.equal(after.filter((c) => c[1] === "print").length, 4, "polled until the job was gone");
  await assert.rejects(() => fs.access(sm.plistPath(PK)));
});

// ---------- stop + the server unit (used by `buzz-host down/restart/status/logs`) ----------

test("linux: stop keeps the unit enabled; the server unit has start/stop/restart/status/logs", async () => {
  const { run, calls } = fakeRun((cmd, args) => {
    if (args.includes("is-active")) return execError(3, { stdout: "inactive\n" });
    if (cmd === "journalctl") return { stdout: "server line\n" };
    return {};
  });
  const sm = createServiceManager({ platform: "linux", run });
  await sm.stop(PK);
  assert.equal(sm.server.unit, "buzz-host.service");
  await sm.server.start();
  await sm.server.stop();
  await sm.server.restart();
  assert.equal(await sm.server.status(), "inactive");
  assert.equal(await sm.server.logs(5), "server line\n");
  assert.deepEqual(calls, [
    ["systemctl", "--user", "stop", `buzz-agent@${PK}.service`],
    ["systemctl", "--user", "start", "buzz-host.service"],
    ["systemctl", "--user", "stop", "buzz-host.service"],
    ["systemctl", "--user", "restart", "buzz-host.service"],
    ["systemctl", "--user", "is-active", "buzz-host.service"],
    ["journalctl", "--user", "-u", "buzz-host.service", "-n", "5", "--no-pager", "-o", "short-iso"],
  ]);
});

test("darwin: stop unloads but keeps the plist; the server unit is com.buzz-host.server", async (t) => {
  const root = await tmpdir(t, "buzz-sm-darwin-server-");
  const label = `com.buzz-host.agent.${PK}`;
  const loaded = new Set();
  const { sm, calls } = darwinManager(t, root, (cmd, args) => {
    const name = args[1]?.split("/").pop();
    if (args[0] === "print") return loaded.has(name) ? { stdout: "state = running\n" } : execError(113, { stderr: "Could not find service" });
    if (args[0] === "bootstrap") loaded.add(path.basename(args[2], ".plist"));
    if (args[0] === "bootout") loaded.delete(name);
    if (args[0] === "kickstart") assert.ok(loaded.has(args[2].split("/").pop()));
    return {};
  });
  const agentPlist = path.join(root, "LaunchAgents", `${label}.plist`);
  await sm.enableAndStart(PK);
  await sm.stop(PK);
  await fs.access(agentPlist);
  assert.equal(await sm.status(PK), "inactive");
  await sm.stop(PK); // already stopped: harmless

  const serverPlist = path.join(root, "LaunchAgents", "com.buzz-host.server.plist");
  assert.equal(sm.server.unit, "com.buzz-host.server");
  assert.equal(await sm.server.status(), "inactive");
  await sm.server.start(); // not loaded: bootstrap
  assert.equal(await sm.server.status(), "active");
  await sm.server.start(); // loaded: nothing
  await sm.server.restart(); // loaded: kickstart -k
  await sm.server.stop();
  await sm.server.stop();
  await sm.server.restart(); // not loaded: bootstrap
  assert.deepEqual(
    calls.filter((c) => c[1] !== "print" && c.join(" ").includes("com.buzz-host.server")),
    [
      ["launchctl", "bootstrap", "gui/501", serverPlist],
      ["launchctl", "kickstart", "-k", "gui/501/com.buzz-host.server"],
      ["launchctl", "bootout", "gui/501/com.buzz-host.server"],
      ["launchctl", "bootstrap", "gui/501", serverPlist],
    ],
  );

  await fs.mkdir(path.dirname(sm.server.logPath), { recursive: true });
  await fs.writeFile(sm.server.logPath, "a\nb\nc\n");
  assert.equal(await sm.server.logs(2), "b\nc\n");
});
