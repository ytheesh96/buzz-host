// A small still of an agent's desktop for the in-chat preview: one RFB
// connection to the desktop's own Xvnc socket (Unix, SecurityTypes None, see
// launcher.sh), one full Raw framebuffer update, a box-filter downscale and a
// PNG. Shared (ClientInit shared=1), so watchers and the agent's driver are
// untouched, and it never sends input. Pure Node: no image tools on the host.
//
// The picture goes only to buzz-host's own API (the owner's Buzz over
// Tailscale); it is never published to the relay.

import { createConnection } from "node:net";
import { createHash } from "node:crypto";
import zlib from "node:zlib";

const TIMEOUT_MS = 8000;
const MAX_FB_BYTES = 64 << 20;

/** Read one full frame from the RFB server at `socketPath`:
 *  { width, height, bgrx: Buffer } (4 bytes per pixel: B, G, R, unused). */
export function grabFrame(socketPath, { timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const sock = createConnection(socketPath);
    let buf = Buffer.alloc(0);
    let step = "version";
    let width = 0;
    let height = 0;
    let frame = null;
    let rects = 0;
    let done = false;
    const finish = (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      err ? reject(err) : resolve(value);
    };
    const timer = setTimeout(() => finish(new Error("snapshot: the desktop did not answer in time")), timeoutMs);
    const take = (n) => {
      const out = buf.subarray(0, n);
      buf = buf.subarray(n);
      return out;
    };

    function pump() {
      for (;;) {
        if (step === "version") {
          if (buf.length < 12) return;
          const v = take(12).toString("latin1");
          if (!/^RFB 003\.00[3-8]\n$/.test(v)) return finish(new Error(`snapshot: not an RFB server (${JSON.stringify(v)})`));
          sock.write("RFB 003.008\n");
          step = "security";
        } else if (step === "security") {
          if (buf.length < 1) return;
          const n = buf[0];
          if (n === 0) return finish(new Error("snapshot: the desktop refused the connection"));
          if (buf.length < 1 + n) return;
          const types = [...take(1 + n).subarray(1)];
          if (!types.includes(1)) return finish(new Error("snapshot: the desktop wants authentication"));
          sock.write(Buffer.from([1]));
          step = "securityResult";
        } else if (step === "securityResult") {
          if (buf.length < 4) return;
          if (take(4).readUInt32BE(0) !== 0) return finish(new Error("snapshot: the desktop refused the connection"));
          sock.write(Buffer.from([1])); // ClientInit: shared
          step = "serverInit";
        } else if (step === "serverInit") {
          if (buf.length < 24) return;
          const nameLen = buf.readUInt32BE(20);
          if (buf.length < 24 + nameLen) return;
          const init = take(24 + nameLen);
          width = init.readUInt16BE(0);
          height = init.readUInt16BE(2);
          if (!width || !height || width * height * 4 > MAX_FB_BYTES)
            return finish(new Error(`snapshot: unexpected desktop size ${width}x${height}`));
          frame = Buffer.alloc(width * height * 4);
          // SetPixelFormat: 32 bpp, depth 24, little-endian true colour, R<<16 G<<8 B.
          const pf = Buffer.alloc(20);
          pf[0] = 0;
          pf[4] = 32;
          pf[5] = 24;
          pf[6] = 0;
          pf[7] = 1;
          pf.writeUInt16BE(255, 8);
          pf.writeUInt16BE(255, 10);
          pf.writeUInt16BE(255, 12);
          pf[14] = 16;
          pf[15] = 8;
          pf[16] = 0;
          // SetEncodings: Raw only.
          const enc = Buffer.from([2, 0, 0, 1, 0, 0, 0, 0]);
          // FramebufferUpdateRequest: not incremental, the whole screen.
          const req = Buffer.alloc(10);
          req[0] = 3;
          req[1] = 0;
          req.writeUInt16BE(width, 6);
          req.writeUInt16BE(height, 8);
          sock.write(Buffer.concat([pf, enc, req]));
          step = "message";
        } else if (step === "message") {
          if (buf.length < 1) return;
          const type = buf[0];
          if (type === 0) {
            if (buf.length < 4) return;
            rects = take(4).readUInt16BE(2);
            if (rects === 0) return finish(null, { width, height, bgrx: frame });
            step = "rect";
          } else if (type === 2) {
            take(1); // Bell
          } else if (type === 3) {
            if (buf.length < 8) return;
            const len = buf.readUInt32BE(4);
            if (buf.length < 8 + len) return;
            take(8 + len); // ServerCutText
          } else {
            return finish(new Error(`snapshot: unexpected RFB message ${type}`));
          }
        } else if (step === "rect") {
          if (buf.length < 12) return;
          const x = buf.readUInt16BE(0);
          const y = buf.readUInt16BE(2);
          const w = buf.readUInt16BE(4);
          const hgt = buf.readUInt16BE(6);
          const encoding = buf.readInt32BE(8);
          if (encoding !== 0) return finish(new Error(`snapshot: unexpected encoding ${encoding}`));
          const size = w * hgt * 4;
          if (buf.length < 12 + size) return;
          const px = take(12 + size).subarray(12);
          if (x + w > width || y + hgt > height) return finish(new Error("snapshot: rectangle outside the screen"));
          for (let row = 0; row < hgt; row++)
            px.copy(frame, ((y + row) * width + x) * 4, row * w * 4, (row + 1) * w * 4);
          if (--rects === 0) return finish(null, { width, height, bgrx: frame });
        }
      }
    }

    sock.on("data", (d) => {
      buf = buf.length ? Buffer.concat([buf, d]) : d;
      try {
        pump();
      } catch (e) {
        finish(e);
      }
    });
    sock.on("error", (e) => finish(new Error(`snapshot: ${e.code === "ENOENT" ? "the desktop is not running" : e.message}`)));
    sock.on("close", () => finish(new Error("snapshot: the desktop closed the connection")));
  });
}

/** Box-filter `bgrx` (width x height) down by the integer `factor` to RGB. */
export function downscale({ width, height, bgrx }, factor) {
  const k = Math.max(1, Math.floor(factor));
  const w = Math.floor(width / k);
  const h = Math.floor(height / k);
  const rgb = Buffer.alloc(w * h * 3);
  const area = k * k;
  for (let oy = 0; oy < h; oy++) {
    for (let ox = 0; ox < w; ox++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let dy = 0; dy < k; dy++) {
        let i = ((oy * k + dy) * width + ox * k) * 4;
        for (let dx = 0; dx < k; dx++, i += 4) {
          b += bgrx[i];
          g += bgrx[i + 1];
          r += bgrx[i + 2];
        }
      }
      const o = (oy * w + ox) * 3;
      rgb[o] = Math.round(r / area);
      rgb[o + 1] = Math.round(g / area);
      rgb[o + 2] = Math.round(b / area);
    }
  }
  return { width: w, height: h, rgb };
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

/** 8-bit RGB PNG, Paeth-filtered rows (desktop gradients compress far better). */
export function encodePng({ width, height, rgb }) {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const out = y * (stride + 1);
    raw[out] = 4; // Paeth
    for (let x = 0; x < stride; x++) {
      const cur = rgb[y * stride + x];
      const a = x >= 3 ? rgb[y * stride + x - 3] : 0;
      const b = y > 0 ? rgb[(y - 1) * stride + x] : 0;
      const c = x >= 3 && y > 0 ? rgb[(y - 1) * stride + x - 3] : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      raw[out + 1 + x] = (cur - pred) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A PNG still about `width` pixels wide, and a tag that changes with the picture. */
export async function snapshot(socketPath, { width = 480 } = {}) {
  const fb = await grabFrame(socketPath);
  const small = downscale(fb, Math.max(1, Math.round(fb.width / Math.max(64, Math.min(width, fb.width)))));
  const etag = createHash("sha1").update(small.rgb).digest("hex").slice(0, 16);
  return { width: small.width, height: small.height, etag, png: encodePng(small) };
}
