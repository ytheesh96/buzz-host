#!/usr/bin/env node
// Container entrypoint for sandboxed buzz-host agents.
//
// 1. Starts a localhost TCP -> Unix socket bridge (127.0.0.1:<port> <-> /run/buzz-sandbox/proxy.sock)
//    so Hermes, Claude Code, and Antigravity reach the host-side credential proxy
//    using ordinary http://127.0.0.1:<port>/... URLs without exposing any host port.
// 2. Spawns /opt/buzz-host/bin/buzz-acp in /workspace and forwards termination signals.

import { createConnection, createServer } from "node:net";
import { spawn } from "node:child_process";

const proxySock = process.env.BUZZ_SANDBOX_PROXY_SOCK || "/run/buzz-sandbox/proxy.sock";
const proxyPort = Number(process.env.BUZZ_SANDBOX_PROXY_PORT || 18461);
const buzzAcp = process.env.BUZZ_SANDBOX_ACP_BIN || "/opt/buzz-host/bin/buzz-acp";

const bridge = createServer((client) => {
  const upstream = createConnection(proxySock);
  client.pipe(upstream);
  upstream.pipe(client);
  const cleanup = () => {
    client.destroy();
    upstream.destroy();
  };
  client.on("error", cleanup);
  upstream.on("error", cleanup);
});

await new Promise((resolve, reject) => {
  bridge.once("error", reject);
  bridge.listen(proxyPort, "127.0.0.1", resolve);
});

const child = spawn(buzzAcp, [], {
  cwd: "/workspace",
  env: process.env,
  stdio: "inherit",
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (!child.killed) child.kill(signal);
  bridge.close();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

child.on("exit", (code, signal) => {
  bridge.close();
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
