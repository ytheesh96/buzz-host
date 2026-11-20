// Multi-worker control-socket routing between buzz-host and acp-proxy.
//
// With BUZZ_ACP_AGENTS > 1, buzz-acp spawns one acp-proxy subprocess per pool
// slot. Each binds its own Unix socket in `<runDir>/<pubkey>.d/<pid>.sock`
// (falling back to the legacy single `<runDir>/<pubkey>.sock`). This module
// discovers live worker sockets and aggregates state / cancel / new / compact
// cleanly across the whole pool.

import fs from "node:fs/promises";
import { createConnection } from "node:net";
import path from "node:path";

const STATE_PRIORITY = { unavailable: 0, idle: 1, active: 2, compacting: 3 };

/** Discover candidate control sockets for `pubkey` (per-worker dir + legacy). */
export async function listControlSockets(runDir, pubkey) {
  const sockets = [];
  const seen = new Set();
  const dirs = [path.join(runDir, `${pubkey.slice(0, 16)}.d`), path.join(runDir, `${pubkey}.d`)];
  for (const dirPath of dirs) {
    try {
      const entries = await fs.readdir(dirPath);
      for (const name of entries.filter((n) => n.endsWith(".sock")).sort()) {
        const full = path.join(dirPath, name);
        if (!seen.has(full)) {
          seen.add(full);
          sockets.push(full);
        }
      }
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
    }
  }
  const legacy = path.join(runDir, `${pubkey}.sock`);
  try {
    await fs.access(legacy);
    if (!seen.has(legacy)) sockets.push(legacy);
  } catch {}
  return sockets;
}

/** Send one JSON-line request to one Unix socket, returning { ok, sockPath, reply, dead }. */
export function querySocket(sockPath, request, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const sock = createConnection(sockPath);
    let buf = "";
    let done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      sock.destroy();
      finish(reject, new Error("The agent's runtime did not answer"));
    }, timeoutMs);
    timer.unref?.();
    sock.setEncoding("utf8");
    sock.on("connect", () => sock.write(`${JSON.stringify(request)}\n`));
    sock.on("data", (d) => {
      buf += d;
      const i = buf.indexOf("\n");
      if (i < 0) return;
      sock.end();
      try {
        finish(resolve, { ok: true, sockPath, reply: JSON.parse(buf.slice(0, i)) });
      } catch (error) {
        finish(reject, error);
      }
    });
    sock.on("error", (error) => {
      if (error?.code === "ENOENT" || error?.code === "ECONNREFUSED") {
        finish(resolve, { ok: false, sockPath, dead: true });
      } else {
        finish(reject, error);
      }
    });
    sock.on("close", () => {
      finish(resolve, { ok: false, sockPath, dead: true });
    });
  });
}

async function queryAll(sockets, request, timeoutMs) {
  const settled = await Promise.all(
    sockets.map((sockPath) =>
      querySocket(sockPath, request, timeoutMs).catch((error) => ({
        ok: false,
        sockPath,
        error,
      })),
    ),
  );
  const live = settled.filter((r) => r.ok);
  const errors = settled.filter((r) => r.error);
  if (!live.length && errors.length) throw errors[0].error;
  return live;
}

/** Route one control request across all live acp-proxy workers for `pubkey`. */
export async function proxyControl(
  runDir,
  pubkey,
  request,
  timeoutMs = 10_000,
  notRunning = { cancelled: false },
) {
  const sockets = await listControlSockets(runDir, pubkey);
  if (!sockets.length) return notRunning;

  const op = request?.op;

  if (op === "state") {
    const live = await queryAll(sockets, { ...request, detail: true }, timeoutMs);
    if (!live.length) return notRunning;
    let bestState = "unavailable";
    let hasSession = false;
    let lastUsed = 0;
    for (const { reply } of live) {
      const st = reply?.state ?? "unavailable";
      if ((STATE_PRIORITY[st] ?? 0) > (STATE_PRIORITY[bestState] ?? 0)) bestState = st;
      if (reply?.hasSession) {
        hasSession = true;
        if (Number(reply.lastUsed) > lastUsed) lastUsed = Number(reply.lastUsed);
      }
    }
    return { state: bestState, hasSession, lastUsed };
  }

  if (op === "cancel") {
    const live = await queryAll(sockets, request, timeoutMs);
    if (!live.length) return notRunning;
    const err = live.find((r) => r.reply?.error);
    if (err && !live.some((r) => r.reply?.cancelled)) return err.reply;
    return { cancelled: live.some((r) => !!r.reply?.cancelled) };
  }

  if (op === "new") {
    const states = await queryAll(
      sockets,
      { op: "state", channel: request.channel, root: request.root, detail: true },
      Math.min(timeoutMs, 5_000),
    );
    if (!states.length) return notRunning;
    if (states.some((r) => r.reply?.state === "active" || r.reply?.state === "compacting")) {
      return { error: "Wait for the turn to finish before starting a new session." };
    }
    const target = states[0].sockPath;
    const res = await querySocket(target, request, timeoutMs);
    return res.ok ? res.reply : notRunning;
  }

  if (op === "compact") {
    const states = await queryAll(
      sockets,
      { op: "state", channel: request.channel, root: request.root, detail: true },
      Math.min(timeoutMs, 5_000),
    );
    if (!states.length) return notRunning;
    if (states.some((r) => r.reply?.state === "active" || r.reply?.state === "compacting")) {
      return { error: "Wait for the turn to finish before compacting." };
    }
    const owners = states
      .filter((r) => r.reply?.hasSession)
      .sort((a, b) => Number(b.reply?.lastUsed || 0) - Number(a.reply?.lastUsed || 0));
    let target = owners[0]?.sockPath;
    if (!target) {
      // Legacy worker without hasSession field: fall back when there is one worker.
      const legacy = states.find((r) => r.reply && !Object.hasOwn(r.reply, "hasSession"));
      if (legacy) target = legacy.sockPath;
      else return { error: "No session here yet: it starts with the next message." };
    }
    const res = await querySocket(target, request, timeoutMs);
    return res.ok ? res.reply : notRunning;
  }

  // Fallback for any other op: send to first reachable socket.
  for (const sockPath of sockets) {
    const res = await querySocket(sockPath, request, timeoutMs);
    if (res.ok) return res.reply;
  }
  return notRunning;
}
