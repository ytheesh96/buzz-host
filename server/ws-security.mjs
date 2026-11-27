// Pure helpers for the public Funnel guest WebSocket listener.
//
// Extracted from buzz-host.mjs so they can be unit-tested without starting the
// server: message-size accumulation, client-IP extraction from Funnel headers,
// guest connection accounting, and the unauthenticated idle guard.

/** Max bytes for one complete (possibly fragmented) WebSocket message. */
export const MAX_MESSAGE_BYTES = 1 << 20;
/** A guest socket that has not authenticated within this window is closed. */
export const GUEST_IDLE_TIMEOUT_MS = 15_000;
/** Hard cap on concurrent guest sockets (RPC + desktop views). */
export const MAX_GUEST_SOCKETS = 64;
/** Cap on guest sockets that have not authenticated yet. */
export const MAX_UNAUTHENTICATED_GUEST_SOCKETS = 16;

/**
 * Accumulates fragmented message payloads under a total byte cap.
 * `push` returns false (after resetting) when the cap would be exceeded.
 */
export function createFragmentBuffer({ maxBytes = MAX_MESSAGE_BYTES } = {}) {
  let fragments = [];
  let bytes = 0;
  return {
    get bytes() {
      return bytes;
    },
    get count() {
      return fragments.length;
    },
    push(payload) {
      const size = payload?.length ?? 0;
      if (bytes + size > maxBytes) {
        fragments = [];
        bytes = 0;
        return false;
      }
      fragments.push(payload);
      bytes += size;
      return true;
    },
    /** Concatenated message bytes; resets the buffer. */
    take() {
      const out = fragments.length === 1 ? fragments[0] : Buffer.concat(fragments);
      fragments = [];
      bytes = 0;
      return out;
    },
    reset() {
      fragments = [];
      bytes = 0;
    },
  };
}

/**
 * CSV header -> one IP. Funnel appends the peer address it saw, so the
 * rightmost non-empty entry is the closest to us; anything to its left is
 * client-supplied and spoofable.
 */
/** True for 127.0.0.0/8, ::1 and IPv4-mapped loopback (how Node reports a local peer). */
export function isLoopbackAddress(address) {
  const value = String(address ?? "").trim().toLowerCase();
  const v4 = value.startsWith("::ffff:") ? value.slice(7) : value;
  return value === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

export function clientIpFromForwardedFor(headerValue, fallback = "unknown") {
  const raw = Array.isArray(headerValue) ? headerValue.join(",") : String(headerValue ?? "");
  const parts = raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length) return parts[parts.length - 1];
  return fallback || "unknown";
}

/**
 * Counts guest sockets. `admit()` returns a handle (or null when over a cap);
 * each handle is `authenticate()`d at most once and `release()`d once.
 */
export function createGuestSocketRegistry({
  maxSockets = MAX_GUEST_SOCKETS,
  maxUnauthenticated = MAX_UNAUTHENTICATED_GUEST_SOCKETS,
} = {}) {
  let total = 0;
  let unauthenticated = 0;
  return {
    get total() {
      return total;
    },
    get unauthenticated() {
      return unauthenticated;
    },
    admit() {
      if (total >= maxSockets || unauthenticated >= maxUnauthenticated) return null;
      total += 1;
      unauthenticated += 1;
      let authed = false;
      let released = false;
      return {
        authenticate() {
          if (released || authed) return;
          authed = true;
          unauthenticated -= 1;
        },
        release() {
          if (released) return;
          released = true;
          total -= 1;
          if (!authed) unauthenticated -= 1;
        },
      };
    },
    reset() {
      total = 0;
      unauthenticated = 0;
    },
  };
}

/**
 * One-shot idle timer. Timers/clock are injectable so tests need no real wait.
 */
export function createIdleWatch({
  timeoutMs = GUEST_IDLE_TIMEOUT_MS,
  onTimeout,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let handle = null;
  let settled = false;
  return {
    arm() {
      if (settled || !(timeoutMs > 0)) return;
      handle = setTimer(() => {
        handle = null;
        if (settled) return;
        settled = true;
        onTimeout?.();
      }, timeoutMs);
      handle?.unref?.();
    },
    /** Idle no longer matters (authenticated, or the socket is gone). */
    cancel() {
      settled = true;
      if (handle) {
        clearTimer(handle);
        handle = null;
      }
    },
    get pending() {
      return handle !== null;
    },
  };
}
