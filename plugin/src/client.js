// RPC client: one WebSocket to buzz-host, reopened on demand.
// When an access token is configured in localStorage, authenticates with
// `auth` immediately on WebSocket open before resolving queued RPCs.
import { storedToken, storedUrl } from "./config.js";

export function createClient() {
  let socket;
  let opening;
  let next = 1;
  const pending = new Map();
  const listeners = new Set();
  let state = { status: "idle", url: storedUrl(), error: "", session: null, epoch: 0 };
  const set = (patch) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  function fail(error) {
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    pending.clear();
  }
  function sendRaw(ws, method, params = {}, { signal, timeoutMs = 120000 } = {}) {
    if (signal?.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
    const id = next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`buzz-host did not answer ${method} in time`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      signal?.addEventListener(
        "abort",
        () => {
          if (!pending.delete(id)) return;
          clearTimeout(timer);
          reject(new DOMException("Aborted", "AbortError"));
        },
        { once: true },
      );
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  function open() {
    if (socket && socket.readyState === WebSocket.OPEN) return Promise.resolve(socket);
    if (opening) return opening;
    const url = storedUrl();
    const token = storedToken();
    if (!url) {
      const error = new Error(
        "No buzz-host server configured yet. Open Settings → Plugins → Remote Agents and paste your server URL or invite link.",
      );
      set({ status: "idle", url: "", error: error.message, session: null });
      return Promise.reject(error);
    }
    set({ status: "connecting", url, error: "" });
    opening = new Promise((resolve, reject) => {
      let settled = false;
      let ws;
      try {
        ws = new WebSocket(url);
      } catch (error) {
        opening = undefined;
        set({ status: "error", error: String(error.message ?? error), session: null });
        reject(error);
        return;
      }
      const timer = setTimeout(() => ws.close(), 20000);
      ws.onopen = async () => {
        clearTimeout(timer);
        if (token) {
          try {
            const auth = await sendRaw(ws, "auth", { token }, { timeoutMs: 15000 });
            socket = ws;
            opening = undefined;
            settled = true;
            set({
              status: "connected",
              error: "",
              session: {
                role: auth.role || "guest",
                label: auth.label ?? null,
                ownerPubkey: auth.ownerPubkey ?? null,
                limits: auth.limits ?? null,
              },
            });
            resolve(ws);
          } catch (error) {
            opening = undefined;
            settled = true;
            const err = error instanceof Error ? error : new Error(String(error));
            set({ status: "error", error: err.message, session: null });
            try {
              ws.close();
            } catch {}
            reject(err);
          }
          return;
        }
        socket = ws;
        opening = undefined;
        settled = true;
        set({ status: "connected", error: "" });
        resolve(ws);
      };
      ws.onmessage = (event) => {
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        const p = pending.get(message.id);
        if (!p) return;
        pending.delete(message.id);
        clearTimeout(p.timer);
        if (message.error) p.reject(new Error(message.error));
        else p.resolve(message.result);
      };
      ws.onclose = () => {
        clearTimeout(timer);
        const wasOpen = socket === ws;
        if (wasOpen) socket = undefined;
        if (!settled && opening && !wasOpen) {
          opening = undefined;
          settled = true;
          const error = new Error(
            token
              ? `Could not reach buzz-host at ${url}. Check that the server is up and the invite URL is correct.`
              : `Could not reach buzz-host at ${url}. Check that the server is up and this device is on the tailnet.`,
          );
          set({ status: "error", error: error.message, session: null });
          reject(error);
        } else if (wasOpen) {
          set({ status: "idle" });
        }
        fail(new Error("Connection to buzz-host closed"));
      };
    });
    return opening;
  }
  async function call(method, params = {}, options = {}) {
    if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const ws = await open();
    const result = await sendRaw(ws, method, params, options);
    if (method === "hello" && result && typeof result === "object") {
      set({
        session: {
          role: result.role || "admin",
          label: result.label ?? null,
          ownerPubkey: result.ownerPubkey ?? null,
          limits: result.limits ?? null,
          publicGuestUrl: result.publicGuestUrl ?? null,
        },
      });
    }
    return result;
  }
  return {
    call,
    snapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reconnect() {
      const old = socket;
      socket = undefined;
      opening = undefined;
      try {
        old?.close();
      } catch {}
      set({ url: storedUrl(), session: null, epoch: state.epoch + 1 });
      return open();
    },
    close() {
      socket?.close();
    },
  };
}
