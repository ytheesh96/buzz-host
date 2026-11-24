// Unit tests for the host-native agent launcher (`server/agent-run`) and its
// systemd template (`server/buzz-agent@.service`): the ACP lazy-pool defaults
// that keep idle workers out of RAM, and the unit settings that stop a clean
// SIGTERM stop from being recorded as a failure.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AGENT_RUN = path.join(REPO_ROOT, "server", "agent-run");
const UNIT_FILE = path.join(REPO_ROOT, "server", "buzz-agent@.service");
const PUBKEY = "a".repeat(64);

// Fake buzz-acp: records the env agent-run handed it, then exits. Only bash
// builtins, because agent-run replaces PATH with the buzz-host bin dirs.
const STUB = `#!/bin/bash
{
  printf 'BUZZ_ACP_LAZY_POOL=%s\\n' "\${BUZZ_ACP_LAZY_POOL-<unset>}"
  printf 'BUZZ_ACP_IDLE_POOL_SLEEP=%s\\n' "\${BUZZ_ACP_IDLE_POOL_SLEEP-<unset>}"
  printf 'BUZZ_ACP_AGENTS=%s\\n' "\${BUZZ_ACP_AGENTS-<unset>}"
} > "\${AGENT_RUN_CAPTURE:?}"
`;

function makeHome(t, { runtimeEnv = "" } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bh-agent-run-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const agentDir = path.join(home, ".local", "share", "buzz-host", "agents", PUBKEY);
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "auth.json"), '"auth-tag"\n');
  fs.writeFileSync(path.join(agentDir, "runtime.env"), runtimeEnv);
  fs.writeFileSync(path.join(agentDir, "key"), `${"b".repeat(64)}\n`);
  const bin = path.join(home, ".local", "lib", "buzz-host", "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "buzz-acp"), STUB, { mode: 0o755 });
  fs.mkdirSync(path.join(home, "buzz-agents", PUBKEY), { recursive: true });
  fs.mkdirSync(path.join(home, "run"), { recursive: true });
  return { home, capture: path.join(home, "capture.env") };
}

// Run agent-run against the throwaway HOME with an environment built from
// scratch, so the test does not inherit BUZZ_ACP_* from the developer's shell.
function runAgentRun(home, capture, extraEnv = {}) {
  const env = {
    HOME: home,
    PATH: "/usr/bin:/bin",
    XDG_RUNTIME_DIR: path.join(home, "run"),
    AGENT_RUN_CAPTURE: capture,
    ...extraEnv,
  };
  const result = spawnSync("bash", [AGENT_RUN, PUBKEY], {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(result.status, 0, `agent-run failed: ${result.stderr}`);
  const captured = fs.readFileSync(capture, "utf8");
  const envOut = {};
  for (const line of captured.trim().split("\n")) {
    const idx = line.indexOf("=");
    envOut[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return { env: envOut, stderr: result.stderr };
}

test("agent-run defaults to a lazy ACP pool with a 300s idle re-sleep", (t) => {
  const { home, capture } = makeHome(t);
  const { env } = runAgentRun(home, capture);
  assert.equal(env.BUZZ_ACP_LAZY_POOL, "true");
  assert.equal(env.BUZZ_ACP_IDLE_POOL_SLEEP, "300");
  assert.equal(env.BUZZ_ACP_AGENTS, "4");
});

test("agent-run keeps an explicitly configured idle re-sleep", (t) => {
  const { home, capture } = makeHome(t);
  const { env } = runAgentRun(home, capture, { BUZZ_ACP_IDLE_POOL_SLEEP: "60" });
  assert.equal(env.BUZZ_ACP_LAZY_POOL, "true");
  assert.equal(env.BUZZ_ACP_IDLE_POOL_SLEEP, "60");
});

// buzz-acp parses BUZZ_ACP_LAZY_POOL as a clap bool that only accepts
// "true"/"false"; "0" and "" are hard parse errors. agent-run must normalize
// an opt-out into an absent variable instead of passing it through.
for (const value of ["false", "0", "no", "off", "FALSE"]) {
  test(`agent-run opts out of the lazy pool on BUZZ_ACP_LAZY_POOL=${JSON.stringify(value)}`, (t) => {
    const { home, capture } = makeHome(t);
    const { env } = runAgentRun(home, capture, { BUZZ_ACP_LAZY_POOL: value });
    assert.equal(env.BUZZ_ACP_LAZY_POOL, "<unset>");
    assert.equal(env.BUZZ_ACP_IDLE_POOL_SLEEP, "<unset>");
    // Opting out of lazy pooling must not change how many workers a busy
    // agent may run.
    assert.equal(env.BUZZ_ACP_AGENTS, "4");
  });
}

for (const value of ["true", "1", "on"]) {
  test(`agent-run accepts BUZZ_ACP_LAZY_POOL=${JSON.stringify(value)} as enabled`, (t) => {
    const { home, capture } = makeHome(t);
    const { env } = runAgentRun(home, capture, { BUZZ_ACP_LAZY_POOL: value });
    assert.equal(env.BUZZ_ACP_LAZY_POOL, "true");
    assert.equal(env.BUZZ_ACP_IDLE_POOL_SLEEP, "300");
  });
}

test("agent-run falls back to an eager pool on an unrecognized value instead of crashing", (t) => {
  const { home, capture } = makeHome(t);
  const { env, stderr } = runAgentRun(home, capture, { BUZZ_ACP_LAZY_POOL: "banana" });
  assert.equal(env.BUZZ_ACP_LAZY_POOL, "<unset>");
  assert.equal(env.BUZZ_ACP_IDLE_POOL_SLEEP, "<unset>");
  assert.match(stderr, /unrecognized BUZZ_ACP_LAZY_POOL='banana'/);
});

test("agent-run replaces a non-numeric idle re-sleep with the default", (t) => {
  const { home, capture } = makeHome(t);
  const { env, stderr } = runAgentRun(home, capture, { BUZZ_ACP_IDLE_POOL_SLEEP: "soon" });
  assert.equal(env.BUZZ_ACP_LAZY_POOL, "true");
  assert.equal(env.BUZZ_ACP_IDLE_POOL_SLEEP, "300");
  assert.match(stderr, /not a number; using 300/);
});

test("agent-run honours the lazy-pool opt-out from the agent's runtime.env", (t) => {
  const { home, capture } = makeHome(t, { runtimeEnv: "export BUZZ_ACP_LAZY_POOL=false\n" });
  const { env } = runAgentRun(home, capture);
  assert.equal(env.BUZZ_ACP_LAZY_POOL, "<unset>");
  assert.equal(env.BUZZ_ACP_IDLE_POOL_SLEEP, "<unset>");
});

test("agent-run still rejects a malformed pubkey with exit 78", (t) => {
  const { home, capture } = makeHome(t);
  const result = spawnSync("bash", [AGENT_RUN, "not-a-pubkey"], {
    env: { HOME: home, PATH: "/usr/bin:/bin", AGENT_RUN_CAPTURE: capture },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(result.status, 78);
  assert.match(result.stderr, /bad pubkey/);
});

function unitDirectives(text) {
  const directives = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    if (line.startsWith("[")) continue;
    const idx = line.indexOf("=");
    assert.notEqual(idx, -1, `not a directive: ${line}`);
    directives.push([line.slice(0, idx), line.slice(idx + 1)]);
  }
  return directives;
}

test("buzz-agent@.service treats a SIGTERM stop as success", () => {
  const directives = unitDirectives(fs.readFileSync(UNIT_FILE, "utf8"));
  const values = (key) => directives.filter(([k]) => k === key).map(([, v]) => v);
  // 128 + SIGTERM(15): what `systemctl --user stop` records for agent-run.
  assert.deepEqual(values("SuccessExitStatus"), ["143"]);
  // An explicit bad-pubkey/unactivated condition stays a failure that the
  // restart loop must not retry.
  assert.deepEqual(values("RestartPreventExitStatus"), ["78"]);
});

test("buzz-agent@.service keeps its sandboxed memory and umask settings", () => {
  const directives = unitDirectives(fs.readFileSync(UNIT_FILE, "utf8"));
  const values = (key) => directives.filter(([k]) => k === key).map(([, v]) => v);
  assert.deepEqual(values("UMask"), ["0077"]);
  assert.deepEqual(values("MemoryMax"), ["4G"]);
  // MemoryHigh must throttle below the point where the kernel OOM-kills.
  assert.deepEqual(values("MemoryHigh"), ["2G"]);
  assert.deepEqual(values("ExecStart"), ["%h/.local/lib/buzz-host/agent-run %i"]);
  assert.deepEqual(values("Restart"), ["always"]);
  // Replies to an agent's unit file are line-oriented: a trailing `#` would
  // become part of the value, so no directive may contain one.
  for (const [key, value] of directives) {
    assert.ok(!value.includes("#"), `${key}= value must not contain a '#'`);
  }
});
