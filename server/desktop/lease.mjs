// Who may drive an agent's desktop: the agent (default) or exactly one human viewer.
//
// Same model and on-disk shape as Hermes's tools/bot_desktop/lease.py, so the
// two stay comparable: <desktopDir>/lease.json = {holder, viewer_id, since,
// reason, epoch}. The lease is read by the computer MCP (refuses every action,
// screenshots included, while a human holds: they may be typing a password),
// by the RFB bridge (drops input from viewers that do not hold it) and by
// buzz-host's desktop.lease API (Take over / Hand back).
//
// Fail closed: a lease file that exists but cannot be read or parsed counts as
// "a human holds", so a torn write never lets the agent act on a screen a
// person may be using. The next successful write repairs it.
//
// Writes are serialised with an O_EXCL lock file (Node has no flock); a lock
// older than LOCK_STALE_MS is a crashed writer's and is broken.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const AGENT = "agent";
export const HUMAN = "human";
const LOCK_STALE_MS = 5000;

export class HumanHasControl extends Error {
  constructor() {
    super(
      "A human has taken over this desktop (they may be entering a credential). Screen actions " +
        "and screenshots are refused until they hand control back. Tell the user what you need in your reply.",
    );
    this.name = "HumanHasControl";
  }
}

const fresh = () => ({ holder: AGENT, viewer_id: null, since: Date.now() / 1000, reason: "", epoch: 0 });
const closed = (reason) => ({ holder: HUMAN, viewer_id: "unreadable-lease", since: 0, reason, epoch: -1 });

export const leasePath = (dir) => path.join(dir, "lease.json");

/** The current lease of the desktop in `dir`. Never throws. */
export function readLease(dir) {
  let raw;
  try {
    raw = fs.readFileSync(leasePath(dir), "utf8");
  } catch (e) {
    return e.code === "ENOENT" ? fresh() : closed("lease file unreadable");
  }
  let d;
  try {
    d = JSON.parse(raw.replace(/^﻿/, ""));
  } catch {
    return closed("lease file corrupt");
  }
  if (!d || typeof d !== "object" || (d.holder !== AGENT && d.holder !== HUMAN) || !Number.isInteger(d.epoch))
    return closed("lease file corrupt");
  return {
    holder: d.holder,
    viewer_id: typeof d.viewer_id === "string" ? d.viewer_id : null,
    since: typeof d.since === "number" ? d.since : 0,
    reason: typeof d.reason === "string" ? d.reason : "",
    epoch: d.epoch,
  };
}

/** The lease as anything outside buzz-host may see it: the holder's viewer id
 *  is a capability, so only a short hash of it is shown. */
export function publicView(lease) {
  const { viewer_id, ...rest } = lease;
  return {
    ...rest,
    viewer_hash: viewer_id ? crypto.createHash("sha256").update(viewer_id).digest("hex").slice(0, 12) : null,
  };
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withLock(dir, fn) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = path.join(dir, "lease.lock");
  const deadline = Date.now() + 3000;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lock, "wx", 0o600));
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.rmSync(lock, { force: true });
      } catch {}
      if (Date.now() > deadline) throw new Error("lease: timed out waiting for lease.lock");
      sleepSync(10);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

function transition(dir, mutate) {
  return withLock(dir, () => {
    const lease = readLease(dir);
    if (!mutate(lease)) return lease;
    lease.epoch = Math.max(lease.epoch, 0) + 1;
    const tmp = leasePath(dir) + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(lease), { mode: 0o600 });
    fs.renameSync(tmp, leasePath(dir));
    return lease;
  });
}

/** Human `viewerId` takes control. Last writer wins: a second viewer evicts the first. */
export function acquire(dir, viewerId, reason = "") {
  if (!viewerId) throw new Error("lease: viewer id required");
  return transition(dir, (l) => {
    if (l.holder === HUMAN && l.viewer_id === viewerId) return false;
    Object.assign(l, { holder: HUMAN, viewer_id: viewerId, since: Date.now() / 1000, reason });
    return true;
  });
}

/** Give control back to the agent. With `viewerId`, only that holder may
 *  release; with `epoch`, only that lease generation is released. */
export function release(dir, { viewerId = null, epoch = null } = {}) {
  return transition(dir, (l) => {
    if (epoch !== null && l.epoch !== epoch) return false;
    if (viewerId !== null && l.holder === HUMAN && l.viewer_id !== viewerId) return false;
    if (l.holder === AGENT) return false;
    Object.assign(l, { holder: AGENT, viewer_id: null, since: Date.now() / 1000, reason: "" });
    return true;
  });
}

export const viewerMaySendInput = (dir, viewerId) => {
  const l = readLease(dir);
  return l.holder === HUMAN && l.viewer_id === viewerId;
};

/** The lease as of now, or throws HumanHasControl. */
export function assertAgentMayAct(dir) {
  const l = readLease(dir);
  if (l.holder === HUMAN) throw new HumanHasControl();
  return l;
}
