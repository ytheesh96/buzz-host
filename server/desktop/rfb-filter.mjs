// Byte-level RFB client->server gate for the desktop's WebSocket bridge.
// A port of Hermes's tools/bot_desktop/rfb_filter.py: noVNC's viewOnly is a UI
// hint, so the bridge parses the client stream and forwards input messages only
// while `allowInput()` says this viewer holds the lease. RFB messages do not
// align with WebSocket frames, so this is a stateful parser fed arbitrary
// chunks (RFC 6143 §7.5, plus TigerVNC's 150/248/251 and QEMU 255).
//
// Xvnc runs -SecurityTypes None, so the client handshake is fixed-size:
// 12-byte version, 1-byte security choice, 1-byte ClientInit (forced shared).

const INPUT = new Set([4, 5, 6, 251, 255]); // Key, Pointer, ClientCutText, SetDesktopSize, QEMU ext key
const FIXED = { 0: 20, 3: 10, 4: 8, 5: 6, 150: 10, 255: 12 };
export const MAX_CUT_TEXT = 256 * 1024; // keep in sync with launcher.sh -MaxCutText

export class RfbClientFilter {
  constructor(allowInput) {
    this.allowInput = allowInput;
    this.buf = Buffer.alloc(0);
    this.handshakeLeft = 14;
  }

  /** Feed client bytes; returns the bytes allowed to reach Xvnc. Throws on an
   *  unframeable stream (the bridge closes the connection). */
  feed(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out = [];
    if (this.handshakeLeft) {
      const take = Math.min(this.handshakeLeft, this.buf.length);
      if (take) {
        const head = Buffer.from(this.buf.subarray(0, take));
        if (this.handshakeLeft === take) head[take - 1] = 1; // ClientInit: always shared
        out.push(head);
        this.buf = this.buf.subarray(take);
        this.handshakeLeft -= take;
      }
      if (this.handshakeLeft) return Buffer.concat(out);
    }
    while (this.buf.length) {
      const len = this.messageLength();
      if (len === null || this.buf.length < len) break;
      const msg = this.buf.subarray(0, len);
      this.buf = this.buf.subarray(len);
      if (INPUT.has(msg[0]) && !this.allowInput()) continue;
      out.push(Buffer.from(msg));
    }
    return Buffer.concat(out);
  }

  messageLength() {
    const b = this.buf;
    const t = b[0];
    if (t in FIXED) return FIXED[t];
    if (t === 2) return b.length < 4 ? null : 4 + 4 * b.readUInt16BE(2); // SetEncodings
    if (t === 6) {
      if (b.length < 8) return null;
      const n = Math.abs(b.readInt32BE(4)); // negative = extended clipboard
      if (n > MAX_CUT_TEXT) throw new Error("clipboard message too large");
      return 8 + n;
    }
    if (t === 248) return b.length < 9 ? null : 9 + b[8]; // Fence
    if (t === 251) return b.length < 8 ? null : 8 + 16 * b[6]; // SetDesktopSize
    throw new Error(`unknown RFB client message type ${t}`);
  }
}
