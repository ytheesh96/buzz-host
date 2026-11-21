import test, { after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { grabFrame, downscale, encodePng, snapshot } from "./snapshot.mjs";

// A fake Xvnc: RFB 3.8, SecurityTypes None, a W x H screen whose pixel (x, y)
// is R = x, G = y, B = 7, sent as two Raw rectangles (top and bottom halves).
function fakeServer(sockPath, W, H, { bellFirst = false } = {}) {
  const seen = { clientInit: null, encodings: null };
  const server = net.createServer((c) => {
    let buf = Buffer.alloc(0);
    let step = "version";
    c.write("RFB 003.008\n");
    c.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (step === "version" && buf.length >= 12) {
          buf = buf.subarray(12);
          c.write(Buffer.from([1, 1])); // one type: None
          step = "sec";
        } else if (step === "sec" && buf.length >= 1) {
          buf = buf.subarray(1);
          c.write(Buffer.from([0, 0, 0, 0]));
          step = "init";
        } else if (step === "init" && buf.length >= 1) {
          seen.clientInit = buf[0];
          buf = buf.subarray(1);
          const si = Buffer.alloc(24 + 4);
          si.writeUInt16BE(W, 0);
          si.writeUInt16BE(H, 2);
          si.writeUInt32BE(4, 20);
          si.write("test", 24);
          c.write(si);
          step = "msgs";
        } else if (step === "msgs" && buf.length >= 20 + 8 + 10) {
          seen.encodings = buf.readInt32BE(20 + 4);
          buf = buf.subarray(38);
          if (bellFirst) c.write(Buffer.from([2]));
          const rect = (y0, h) => {
            const head = Buffer.alloc(12);
            head.writeUInt16BE(0, 0);
            head.writeUInt16BE(y0, 2);
            head.writeUInt16BE(W, 4);
            head.writeUInt16BE(h, 6);
            head.writeInt32BE(0, 8);
            const px = Buffer.alloc(W * h * 4);
            for (let y = 0; y < h; y++)
              for (let x = 0; x < W; x++) {
                const i = (y * W + x) * 4;
                px[i] = 7; // B
                px[i + 1] = y0 + y; // G
                px[i + 2] = x; // R
              }
            return Buffer.concat([head, px]);
          };
          const top = Math.floor(H / 2);
          const msg = Buffer.concat([Buffer.from([0, 0, 0, 2]), rect(0, top), rect(top, H - top)]);
          // Dribble it out to exercise partial reads.
          c.write(msg.subarray(0, 7));
          setTimeout(() => c.write(msg.subarray(7)), 5);
          step = "done";
        } else return;
      }
    });
  });
  return new Promise((resolve) => server.listen(sockPath, () => resolve({ server, seen })));
}

// Temp dirs made by this file, removed when it finishes.
const tmpDirs = [];
after(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});
const tmpSock = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "snap-"));
  tmpDirs.push(d);
  return path.join(d, "rfb.sock");
};

/** Inflate and un-filter an RGB PNG from encodePng (Paeth rows only). */
function decodePng(png) {
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  let off = 8;
  let width = 0;
  let height = 0;
  const idat = [];
  while (off < png.length) {
    const len = png.readUInt32BE(off);
    const type = png.subarray(off + 4, off + 8).toString("latin1");
    const data = png.subarray(off + 8, off + 8 + len);
    const crc = png.readUInt32BE(off + 8 + len);
    assert.equal(crc, zlib.crc32(png.subarray(off + 4, off + 8 + len)) >>> 0, `${type} CRC`);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
    }
    if (type === "IDAT") idat.push(data);
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * 3;
  const rgb = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    assert.equal(raw[y * (stride + 1)], 4);
    for (let x = 0; x < stride; x++) {
      const a = x >= 3 ? rgb[y * stride + x - 3] : 0;
      const b = y > 0 ? rgb[(y - 1) * stride + x] : 0;
      const c = x >= 3 && y > 0 ? rgb[(y - 1) * stride + x - 3] : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      rgb[y * stride + x] = (raw[y * (stride + 1) + 1 + x] + pred) & 0xff;
    }
  }
  return { width, height, rgb };
}

test("grabFrame reads a shared Raw frame sent in parts and rectangles", async () => {
  const sock = tmpSock();
  const { server, seen } = await fakeServer(sock, 40, 30, { bellFirst: true });
  try {
    const f = await grabFrame(sock);
    assert.equal(f.width, 40);
    assert.equal(f.height, 30);
    assert.equal(seen.clientInit, 1, "shared ClientInit");
    assert.equal(seen.encodings, 0, "Raw only");
    const at = (x, y) => [f.bgrx[(y * 40 + x) * 4 + 2], f.bgrx[(y * 40 + x) * 4 + 1], f.bgrx[(y * 40 + x) * 4]];
    assert.deepEqual(at(0, 0), [0, 0, 7]);
    assert.deepEqual(at(39, 29), [39, 29, 7]);
    assert.deepEqual(at(5, 20), [5, 20, 7]);
  } finally {
    server.close();
  }
});

test("downscale averages k x k boxes and encodePng round-trips", () => {
  const W = 8;
  const H = 4;
  const bgrx = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      bgrx[i] = 10;
      bgrx[i + 1] = y * 10;
      bgrx[i + 2] = x * 10;
    }
  const small = downscale({ width: W, height: H, bgrx }, 2);
  assert.equal(small.width, 4);
  assert.equal(small.height, 2);
  // Box (0,0)-(1,1): R mean of 0,10 = 5; G mean of 0,10 = 5; B 10.
  assert.deepEqual([...small.rgb.subarray(0, 3)], [5, 5, 10]);
  const back = decodePng(encodePng(small));
  assert.equal(back.width, 4);
  assert.equal(back.height, 2);
  assert.deepEqual([...back.rgb], [...small.rgb]);
});

test("snapshot scales to about the asked width and tags the picture", async () => {
  const sock = tmpSock();
  const { server } = await fakeServer(sock, 400, 250);
  try {
    const s = await snapshot(sock, { width: 100 });
    assert.equal(s.width, 100);
    assert.equal(s.height, 62);
    assert.match(s.etag, /^[0-9a-f]{16}$/);
    const img = decodePng(s.png);
    assert.equal(img.width, 100);
    const s2 = await snapshot(sock, { width: 100 });
    assert.equal(s2.etag, s.etag, "same picture, same tag");
  } finally {
    server.close();
  }
});

test("a missing desktop socket is a clear error", async () => {
  await assert.rejects(grabFrame(path.join(os.tmpdir(), "no-such-dir-xyz", "rfb.sock")), /not running/);
});
