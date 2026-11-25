import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createIrohSupervisor, readIrohAddrFile, resolveIrohBin } from "./iroh-supervisor.mjs";

function makeTempDir(t, prefix = "bh-iroh-sup-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeExecutable(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, { mode: 0o755 });
  fs.chmodSync(filePath, 0o755);
  return filePath;
}

async function waitFor(predicate, { timeoutMs = 4000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = predicate();
    if (val) return val;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("timed out waiting for condition");
}

function captureLogs() {
  const lines = [];
  return {
    lines,
    log: {
      log: (m) => lines.push(["log", String(m)]),
      warn: (m) => lines.push(["warn", String(m)]),
      error: (m) => lines.push(["error", String(m)]),
    },
  };
}

test("resolveIrohBin honors priority: config.irohBin -> libDir/bin -> repoBin", (t) => {
  const dir = makeTempDir(t);
  const customBin = writeExecutable(path.join(dir, "custom", "buzz-host-iroh"), "#!/bin/sh\n");
  const libDir = path.join(dir, "lib");
  const libBin = writeExecutable(path.join(libDir, "bin", "buzz-host-iroh"), "#!/bin/sh\n");
  const repoBin = writeExecutable(path.join(dir, "repo", "buzz-host-iroh"), "#!/bin/sh\n");

  assert.equal(resolveIrohBin({ config: { irohBin: customBin }, libDir, repoBin }), customBin);
  assert.equal(resolveIrohBin({ config: { irohBin: path.join(dir, "missing") }, libDir, repoBin }), libBin);
  assert.equal(resolveIrohBin({ config: {}, libDir: path.join(dir, "empty-lib"), repoBin }), repoBin);
  assert.equal(
    resolveIrohBin({ config: {}, libDir: path.join(dir, "empty-lib"), repoBin: path.join(dir, "nope") }),
    null,
  );
});

test("supervisor is a safe no-op when disabled, guestPort missing, or binary absent", async (t) => {
  const dir = makeTempDir(t);
  const fakeBin = writeExecutable(path.join(dir, "buzz-host-iroh"), "#!/bin/sh\nsleep 10\n");

  // Disabled via config.iroh === false
  {
    const { log, lines } = captureLogs();
    const sup = createIrohSupervisor({
      config: { iroh: false, guestPort: 8458, irohBin: fakeBin },
      configDir: dir,
      runDir: dir,
      log,
    });
    assert.equal(sup.start(), false);
    assert.equal(sup.isRunning(), false);
    assert.equal(sup.currentAddr(), null);
    assert.ok(lines.some(([, m]) => m.includes("disabled")));
    await sup.stop();
  }

  // guestPort not set
  {
    const { log, lines } = captureLogs();
    const sup = createIrohSupervisor({
      config: { irohBin: fakeBin },
      configDir: dir,
      runDir: dir,
      log,
    });
    assert.equal(sup.start(), false);
    assert.ok(lines.some(([, m]) => m.includes("guestPort")));
    await sup.stop();
  }

  // Binary absent
  {
    const { log, lines } = captureLogs();
    const sup = createIrohSupervisor({
      config: { guestPort: 8458 },
      libDir: path.join(dir, "no-lib"),
      repoBin: path.join(dir, "no-repo-bin"),
      configDir: dir,
      runDir: dir,
      log,
    });
    assert.equal(sup.start(), false);
    assert.ok(lines.some(([, m]) => m.includes("not found")));
    await sup.stop();
  }
});

test("readIrohAddrFile parses valid JSON and returns null on missing or malformed files", (t) => {
  const dir = makeTempDir(t);
  const addrFile = path.join(dir, "iroh-addr.json");

  assert.equal(readIrohAddrFile(addrFile), null);
  fs.writeFileSync(addrFile, "{bad json");
  assert.equal(readIrohAddrFile(addrFile), null);
  fs.writeFileSync(addrFile, JSON.stringify({ nodeId: "abc" }));
  assert.equal(readIrohAddrFile(addrFile), null);

  fs.writeFileSync(
    addrFile,
    JSON.stringify({ nodeId: "node123", endpointAddr: "ZW5kcG9pbnQ", updatedAt: 1700000000 }),
  );
  assert.deepEqual(readIrohAddrFile(addrFile), {
    nodeId: "node123",
    endpointAddr: "ZW5kcG9pbnQ",
    updatedAt: 1700000000,
  });
});

test("supervisor passes expected CLI args, exposes currentAddr(), and stops cleanly on SIGTERM", async (t) => {
  const dir = makeTempDir(t);
  const argsFile = path.join(dir, "seen-args.json");
  const script = writeExecutable(
    path.join(dir, "fake-iroh"),
    `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(args));
const addrIdx = args.indexOf("--addr-file");
const addrFile = addrIdx >= 0 ? args[addrIdx + 1] : "";
if (addrFile) {
  fs.writeFileSync(addrFile, JSON.stringify({
    nodeId: "fake-node-id",
    endpointAddr: "ZmFrZS1hZGRy",
    updatedAt: 1234567890,
  }));
}
process.on("SIGTERM", () => {
  if (addrFile) { try { fs.unlinkSync(addrFile); } catch {} }
  process.exit(0);
});
setInterval(() => {}, 1000);
`,
  );

  const { log } = captureLogs();
  const sup = createIrohSupervisor({
    config: { guestPort: 8458, irohBin: script, irohMaxStreams: 64 },
    configDir: path.join(dir, "cfg"),
    runDir: path.join(dir, "run"),
    log,
  });
  fs.mkdirSync(path.join(dir, "cfg"), { recursive: true });
  fs.mkdirSync(path.join(dir, "run"), { recursive: true });

  t.after(() => sup.stop());

  assert.equal(sup.start(), true);
  assert.equal(sup.start(), true); // idempotent

  const addr = await waitFor(() => sup.currentAddr());
  assert.deepEqual(addr, {
    nodeId: "fake-node-id",
    endpointAddr: "ZmFrZS1hZGRy",
    updatedAt: 1234567890,
  });

  const seenArgs = JSON.parse(fs.readFileSync(argsFile, "utf8"));
  assert.deepEqual(seenArgs, [
    "--target",
    "127.0.0.1:8458",
    "--key-file",
    path.join(dir, "cfg", "iroh.key"),
    "--addr-file",
    path.join(dir, "run", "iroh-addr.json"),
    "--max-streams",
    "64",
  ]);
  assert.equal(sup.isRunning(), true);

  await sup.stop();
  assert.equal(sup.isRunning(), false);
  assert.equal(sup.currentAddr(), null);
});

test("supervisor restarts with exponential backoff on unexpected exit", async (t) => {
  const dir = makeTempDir(t);
  const countFile = path.join(dir, "starts.txt");
  const script = writeExecutable(
    path.join(dir, "crashy-iroh"),
    `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(countFile)}, Date.now() + "\\n");
process.exit(1);
`,
  );

  const { log, lines } = captureLogs();
  const sup = createIrohSupervisor({
    config: { guestPort: 8458, irohBin: script },
    configDir: dir,
    runDir: dir,
    log,
    initialBackoffMs: 40,
    maxBackoffMs: 200,
    stableRunMs: 10_000,
  });
  t.after(() => sup.stop());

  assert.equal(sup.start(), true);
  await waitFor(() => {
    if (!fs.existsSync(countFile)) return false;
    const count = fs.readFileSync(countFile, "utf8").trim().split("\n").filter(Boolean).length;
    return count >= 3;
  });
  await sup.stop();

  const restartLogs = lines
    .filter(([lvl, m]) => lvl === "warn" && m.includes("restarting in"))
    .map(([, m]) => Number(m.match(/(\d+)ms/)?.[1]));
  assert.ok(restartLogs.length >= 2, `expected backoff logs, got ${JSON.stringify(restartLogs)}`);
  assert.equal(restartLogs[0], 40);
  assert.equal(restartLogs[1], 80);
});

test("supervisor escalates SIGTERM to SIGKILL if child ignores SIGTERM", async (t) => {
  const dir = makeTempDir(t);
  const readyFile = path.join(dir, "ready");
  const script = writeExecutable(
    path.join(dir, "stubborn-iroh"),
    `#!${process.execPath}
const fs = require("node:fs");
process.on("SIGTERM", () => {});
fs.writeFileSync(${JSON.stringify(readyFile)}, "ok");
setInterval(() => {}, 1000);
`,
  );

  const { log, lines } = captureLogs();
  const sup = createIrohSupervisor({
    config: { guestPort: 8458, irohBin: script },
    configDir: dir,
    runDir: dir,
    log,
    stopTimeoutMs: 120,
  });
  t.after(() => sup.stop());

  assert.equal(sup.start(), true);
  await waitFor(() => fs.existsSync(readyFile));

  await sup.stop();
  assert.equal(sup.isRunning(), false);
  assert.ok(lines.some(([lvl, m]) => lvl === "warn" && m.includes("SIGKILL")));
});
