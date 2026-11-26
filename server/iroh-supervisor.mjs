// Supervises the optional `buzz-host-iroh` Rust sidecar so buzz-host's token
// listener (guestPort) is reachable over Iroh QUIC without opening inbound
// ports or requiring Tailscale.
//
// Safe no-op when `config.iroh === false`, `config.guestPort` is unset, or the
// `buzz-host-iroh` binary is not installed yet.

import { spawn as defaultSpawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_IROH_BIN = path.resolve(HERE, "..", "iroh-bridge", "target", "release", "buzz-host-iroh");

const DEFAULT_INITIAL_BACKOFF_MS = 1_000;
const DEFAULT_MAX_BACKOFF_MS = 30_000;
const DEFAULT_STABLE_RUN_MS = 30_000;
const DEFAULT_STOP_TIMEOUT_MS = 5_000;

function isExecutableFile(filePath, fsImpl = fs) {
  if (!filePath || typeof filePath !== "string") return false;
  try {
    const st = fsImpl.statSync(filePath);
    if (!st.isFile()) return false;
    fsImpl.accessSync(filePath, fsImpl.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the `buzz-host-iroh` binary path in priority order:
 *   1. `config.irohBin`
 *   2. `<libDir>/bin/buzz-host-iroh`
 *   3. `<repo>/iroh-bridge/target/release/buzz-host-iroh`
 * Returns the first executable file found, or `null`.
 */
export function resolveIrohBin({ config = {}, libDir = "", repoBin = REPO_IROH_BIN, fsImpl = fs } = {}) {
  const candidates = [];
  if (typeof config.irohBin === "string" && config.irohBin.trim()) {
    candidates.push(config.irohBin.trim());
  }
  if (libDir) {
    candidates.push(path.join(libDir, "bin", "buzz-host-iroh"));
  }
  if (repoBin) {
    candidates.push(repoBin);
  }
  for (const candidate of candidates) {
    if (isExecutableFile(candidate, fsImpl)) return candidate;
  }
  return null;
}

/**
 * Read and validate `$RUN_DIR/iroh-addr.json`.
 * Returns `{ nodeId, endpointAddr, updatedAt }` or `null` if unavailable/invalid.
 */
export function readIrohAddrFile(addrFile, fsImpl = fs) {
  if (!addrFile) return null;
  try {
    const raw = fsImpl.readFileSync(addrFile, "utf8");
    const parsed = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.nodeId !== "string" ||
      !parsed.nodeId.trim() ||
      typeof parsed.endpointAddr !== "string" ||
      !parsed.endpointAddr.trim()
    ) {
      return null;
    }
    return {
      nodeId: parsed.nodeId.trim(),
      endpointAddr: parsed.endpointAddr.trim(),
      updatedAt: Number.isFinite(parsed.updatedAt) ? parsed.updatedAt : 0,
    };
  } catch {
    return null;
  }
}

export function createIrohSupervisor({
  config = {},
  libDir = "",
  configDir = "",
  runDir = "",
  keyFile = configDir ? path.join(configDir, "iroh.key") : "",
  addrFile = runDir ? path.join(runDir, "iroh-addr.json") : "",
  repoBin = REPO_IROH_BIN,
  env = process.env,
  spawn = defaultSpawn,
  fsImpl = fs,
  log = console,
  initialBackoffMs = DEFAULT_INITIAL_BACKOFF_MS,
  maxBackoffMs = DEFAULT_MAX_BACKOFF_MS,
  stableRunMs = DEFAULT_STABLE_RUN_MS,
  stopTimeoutMs = DEFAULT_STOP_TIMEOUT_MS,
} = {}) {
  let active = false;
  let stopping = false;
  let child = null;
  let childStartedAt = 0;
  let restartTimer = null;
  let backoffMs = initialBackoffMs;
  let resolvedBin = null;
  let stopPromise = null;

  function buildArgs() {
    const args = [
      "--target",
      `127.0.0.1:${config.guestPort}`,
      "--key-file",
      keyFile,
      "--addr-file",
      addrFile,
    ];
    if (Number.isInteger(config.irohMaxStreams) && config.irohMaxStreams > 0) {
      args.push("--max-streams", String(config.irohMaxStreams));
    }
    return args;
  }

  function scheduleRestart() {
    if (!active || stopping || restartTimer) return;
    const delay = backoffMs;
    backoffMs = Math.min(Math.max(delay * 2, initialBackoffMs), maxBackoffMs);
    log.warn?.(`buzz-host iroh: restarting in ${delay}ms`);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (!active || stopping) return;
      launch();
    }, delay);
    restartTimer.unref?.();
  }

  function launch() {
    if (!active || stopping || child) return;
    if (!resolvedBin) return;
    const args = buildArgs();
    childStartedAt = Date.now();
    let proc;
    try {
      proc = spawn(resolvedBin, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env,
      });
    } catch (error) {
      log.error?.(`buzz-host iroh: failed to spawn ${resolvedBin}: ${error.message}`);
      scheduleRestart();
      return;
    }
    child = proc;

    const pipeLines = (stream, write) => {
      if (!stream) return;
      let buf = "";
      stream.setEncoding?.("utf8");
      stream.on("data", (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (line) write(line);
        }
      });
      stream.on("end", () => {
        const line = buf.trim();
        if (line) write(line);
      });
    };
    pipeLines(proc.stdout, (line) => log.log?.(line));
    pipeLines(proc.stderr, (line) => log.log?.(line));

    let handled = false;
    const onDone = (reason) => {
      if (handled) return;
      handled = true;
      const aliveMs = Date.now() - childStartedAt;
      if (child === proc) child = null;
      if (stopping || !active) return;
      if (aliveMs >= stableRunMs) {
        backoffMs = initialBackoffMs;
      }
      log.warn?.(`buzz-host iroh: exited unexpectedly (${reason})`);
      scheduleRestart();
    };

    proc.once("error", (error) => {
      onDone(`error: ${error.message}`);
    });
    proc.once("exit", (code, signal) => {
      const detail = signal ? `signal ${signal}` : `code ${code}`;
      onDone(detail);
    });
  }

  function start() {
    if (active) return true;
    if (config.iroh === false) {
      log.log?.("buzz-host iroh: disabled in config (iroh: false)");
      return false;
    }
    if (!Number.isInteger(config.guestPort) || config.guestPort <= 0) {
      log.log?.("buzz-host iroh: guestPort is not configured; bridge not started");
      return false;
    }
    if (!keyFile || !addrFile) {
      log.log?.("buzz-host iroh: keyFile/addrFile not configured; bridge not started");
      return false;
    }
    resolvedBin = resolveIrohBin({ config, libDir, repoBin, fsImpl });
    if (!resolvedBin) {
      log.log?.("buzz-host iroh: buzz-host-iroh binary not found; running without Iroh bridge");
      return false;
    }
    active = true;
    stopping = false;
    backoffMs = initialBackoffMs;
    log.log?.(`buzz-host iroh: starting ${resolvedBin} -> 127.0.0.1:${config.guestPort}`);
    launch();
    return true;
  }

  function stop() {
    if (stopPromise) return stopPromise;
    stopping = true;
    active = false;
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    const proc = child;
    if (!proc) {
      try {
        if (addrFile) fsImpl.unlinkSync(addrFile);
      } catch {}
      return Promise.resolve();
    }
    stopPromise = new Promise((resolve) => {
      let finished = false;
      let killTimer = null;
      const finish = () => {
        if (finished) return;
        finished = true;
        if (killTimer) clearTimeout(killTimer);
        if (child === proc) child = null;
        try {
          if (addrFile) fsImpl.unlinkSync(addrFile);
        } catch {}
        stopPromise = null;
        resolve();
      };
      if (proc.exitCode !== null || proc.signalCode !== null) {
        finish();
        return;
      }
      proc.once("exit", finish);
      proc.once("error", finish);
      try {
        proc.kill("SIGTERM");
      } catch {
        finish();
        return;
      }
      killTimer = setTimeout(() => {
        if (finished) return;
        log.warn?.(`buzz-host iroh: did not exit after ${stopTimeoutMs}ms; sending SIGKILL`);
        try {
          proc.kill("SIGKILL");
        } catch {
          finish();
        }
      }, stopTimeoutMs);
      killTimer.unref?.();
    });
    return stopPromise;
  }

  return {
    start,
    stop,
    currentAddr: () => readIrohAddrFile(addrFile, fsImpl),
    isRunning: () => Boolean(child && child.exitCode === null && child.signalCode === null),
    addrFile,
    keyFile,
  };
}

/**
 * Supervises one `buzz-host-iroh connect` loopback forwarder for a peer link.
 * Resolves `waitReady()` with the local `ws://127.0.0.1:<port>` URL once the
 * child emits its `{"listen":"127.0.0.1:<port>","nodeId":"..."}` ready line.
 * Rejects immediately with `code = "IDENTITY_MISMATCH"` if the child refuses
 * the endpoint address due to a pinned node-id mismatch.
 */
export function createIrohLinkSupervisor({
  addr,
  nodeId,
  config = {},
  libDir = "",
  repoBin = REPO_IROH_BIN,
  env = process.env,
  spawn = defaultSpawn,
  fsImpl = fs,
  log = console,
  stopTimeoutMs = DEFAULT_STOP_TIMEOUT_MS,
} = {}) {
  let child = null;
  let stopping = false;
  let listenUrl = "";
  let stopPromise = null;
  let readyPromise = null;

  function start() {
    if (readyPromise) return readyPromise;
    const bin = resolveIrohBin({ config, libDir, repoBin, fsImpl });
    if (!bin) {
      return Promise.reject(Object.assign(new Error("buzz-host-iroh binary not found"), { code: "NO_IROH_BIN" }));
    }
    if (!addr || !nodeId) {
      return Promise.reject(new Error("addr and nodeId are required for iroh connect"));
    }
    stopping = false;
    const args = ["connect", "--addr", String(addr), "--node-id", String(nodeId), "--listen", "127.0.0.1:0"];
    if (Number.isInteger(config.irohMaxStreams) && config.irohMaxStreams > 0) {
      args.push("--max-streams", String(config.irohMaxStreams));
    }
    readyPromise = new Promise((resolve, reject) => {
      let settled = false;
      let stderrTail = "";
      const finish = (err, url) => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve(url);
      };
      let proc;
      try {
        proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], env });
      } catch (error) {
        finish(error);
        return;
      }
      child = proc;

      let outBuf = "";
      proc.stdout?.setEncoding?.("utf8");
      proc.stdout?.on("data", (chunk) => {
        outBuf += chunk;
        let idx;
        while ((idx = outBuf.indexOf("\n")) >= 0) {
          const line = outBuf.slice(0, idx).trim();
          outBuf = outBuf.slice(idx + 1);
          if (!line) continue;
          try {
            const parsed = JSON.parse(line);
            if (typeof parsed?.listen === "string" && parsed.listen) {
              listenUrl = `ws://${parsed.listen}`;
              finish(null, listenUrl);
            }
          } catch {
            log.log?.(line);
          }
        }
      });

      proc.stderr?.setEncoding?.("utf8");
      proc.stderr?.on("data", (chunk) => {
        stderrTail = (stderrTail + chunk).slice(-2048);
        for (const raw of String(chunk).split("\n")) {
          const line = raw.trim();
          if (line) log.log?.(line);
        }
      });

      proc.once("error", (error) => {
        if (child === proc) child = null;
        finish(error);
      });
      proc.once("exit", (code, signal) => {
        if (child === proc) child = null;
        if (!settled) {
          const detail = stderrTail.trim() || (signal ? `signal ${signal}` : `exit code ${code}`);
          const err = new Error(`buzz-host-iroh connect failed: ${detail}`);
          if (/node id mismatch/i.test(detail)) err.code = "IDENTITY_MISMATCH";
          finish(err);
        }
      });
    });
    return readyPromise;
  }

  function stop() {
    if (stopPromise) return stopPromise;
    stopping = true;
    const proc = child;
    if (!proc) return Promise.resolve();
    stopPromise = new Promise((resolve) => {
      let done = false;
      let killTimer = null;
      const finish = () => {
        if (done) return;
        done = true;
        if (killTimer) clearTimeout(killTimer);
        if (child === proc) child = null;
        stopPromise = null;
        resolve();
      };
      if (proc.exitCode !== null || proc.signalCode !== null) {
        finish();
        return;
      }
      proc.once("exit", finish);
      proc.once("error", finish);
      try {
        proc.kill("SIGTERM");
      } catch {
        finish();
        return;
      }
      killTimer = setTimeout(() => {
        if (done) return;
        try {
          proc.kill("SIGKILL");
        } catch {
          finish();
        }
      }, stopTimeoutMs);
      killTimer.unref?.();
    });
    return stopPromise;
  }

  return {
    start,
    stop,
    url: () => listenUrl,
    isRunning: () => !stopping && Boolean(child && child.exitCode === null && child.signalCode === null),
  };
}
