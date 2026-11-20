// WebSocket <-> RFB bridge for watching an agent's desktop with noVNC.
//
// buzz-host does the HTTP upgrade (Tailscale login + origin checks, as for its
// JSON API) and hands the raw socket here. Binary frames carry RFB bytes both
// ways. Client->server bytes go through RfbClientFilter, which drops keyboard,
// pointer, clipboard and resize messages unless this viewer holds the lease
// (Take over). The server->client direction is untouched.
//
// When the viewer loses the lease to someone else, its socket is closed so its
// UI drops to view-only on reconnect.

import { createConnection } from "node:net";
import { createHash } from "node:crypto";
import { RfbClientFilter } from "./rfb-filter.mjs";
import { readLease, viewerMaySendInput, HUMAN } from "./lease.mjs";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_FRAME = 1 << 20;

export function frame(opcode, payload) {
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) head = Buffer.from([0x80 | opcode, 126, len >> 8, len & 255]);
  else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, payload]);
}

/** The 101 response for an upgrade request (for callers without their own). */
export function acceptUpgrade(req, socket) {
  const key = req.headers["sec-websocket-key"];
  const accept = createHash("sha1").update(key + GUID).digest("base64");
  const proto = (req.headers["sec-websocket-protocol"] ?? "").split(",").map((s) => s.trim());
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n` +
      (proto.includes("binary") ? "Sec-WebSocket-Protocol: binary\r\n" : "") +
      "\r\n",
  );
}

/**
 * Bridge an upgraded WebSocket to the desktop's RFB socket.
 * @param socket   the upgraded client socket
 * @param opts.rfbSocket  path of the desktop's rfb.sock
 * @param opts.leaseDir   the desktop's state dir (lease.json)
 * @param opts.viewerId   this viewer's lease id (a capability; keep it secret)
 */
export function bridge(socket, { rfbSocket, leaseDir, viewerId }) {
  const vnc = createConnection(rfbSocket);
  const filter = new RfbClientFilter(() => viewerMaySendInput(leaseDir, viewerId));
  let buffer = Buffer.alloc(0);
  let fragments = [];
  let closed = false;

  const close = (why) => {
    if (closed) return;
    closed = true;
    clearInterval(evictWatch);
    vnc.destroy();
    if (!socket.destroyed) socket.end(frame(8, Buffer.from([0x03, 0xe8, ...Buffer.from(why ?? "")].slice(0, 125))));
  };

  vnc.on("data", (d) => {
    // Split large framebuffer updates so no frame exceeds what clients buffer comfortably.
    for (let i = 0; i < d.length; i += MAX_FRAME) socket.write(frame(2, d.subarray(i, i + MAX_FRAME)));
  });
  vnc.on("close", () => close("desktop closed"));
  vnc.on("error", () => close("desktop unreachable"));

  // A viewer that held the lease and lost it to another viewer is disconnected.
  let held = viewerMaySendInput(leaseDir, viewerId);
  const evictWatch = setInterval(() => {
    const l = readLease(leaseDir);
    const now = l.holder === HUMAN && l.viewer_id === viewerId;
    if (held && !now && l.holder === HUMAN) close("another viewer took over");
    held = now;
  }, 500);

  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const fin = buffer[0] & 0x80;
      const opcode = buffer[0] & 0x0f;
      let len = buffer[1] & 0x7f;
      let off = 2;
      if (!(buffer[1] & 0x80)) return close("unmasked frame");
      if (len === 126) {
        if (buffer.length < 4) return;
        len = buffer.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buffer.length < 10) return;
        len = Number(buffer.readBigUInt64BE(2));
        off = 10;
      }
      if (len > MAX_FRAME) return close("frame too large");
      if (buffer.length < off + 4 + len) return;
      const mask = buffer.subarray(off, off + 4);
      const payload = Buffer.from(buffer.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      buffer = buffer.subarray(off + 4 + len);
      if (opcode === 8) return close();
      if (opcode === 9) {
        socket.write(frame(10, payload));
        continue;
      }
      if (opcode === 10) continue;
      if (opcode === 0 || opcode === 1 || opcode === 2) {
        fragments.push(payload);
        if (!fin) continue;
        const data = Buffer.concat(fragments);
        fragments = [];
        try {
          const out = filter.feed(data);
          if (out.length) vnc.write(out);
        } catch (e) {
          return close(e.message);
        }
      }
    }
  });
  socket.on("close", () => close());
  socket.on("error", () => close());
  return { close };
}

