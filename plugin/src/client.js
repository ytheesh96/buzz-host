// RPC client: one WebSocket to buzz-host, reopened on demand.
import { storedUrl } from "./config.js";

export function createClient() {
  let socket;
  let opening;
  let next = 1;
  const pending = new Map();
  const listeners = new Set();
  let state = { status: "idle", url: storedUrl(), error: "" };
  const set = (patch) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  function fail(error) {
    for (const [, p] of pending) p.reject(error);
    pending.clear();
  }
  function open() {
    if (socket && socket.readyState === WebSocket.OPEN) return Promise.resolve(socket);
    if (opening) return opening;
    const url = storedUrl();
    set({ status: "connecting", url, error: "" });
    opening = new Promise((resolve, reject) => {
      let ws;
      try {
        ws = new WebSocket(url);
      } catch (error) {
        opening = undefined;
        set({ status: "error", error: String(error.message ?? error) });
        reject(error);
        return;
      }
      const timer = setTimeout(() => ws.close(), 20000);
      ws.onopen = () => {
        clearTimeout(timer);
        socket = ws;
        opening = undefined;
        set({ status: "connected" });
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
        if (opening && !wasOpen) {
          opening = undefined;
          const error = new Error(
            `Could not reach buzz-host at ${url}. Check that the server is up and this device is on the tailnet.`,
          );
          set({ status: "error", error: error.message });
          reject(error);
        } else set({ status: "idle" });
        fail(new Error("Connection to buzz-host closed"));
      };
    });
    return opening;
  }
  async function call(method, params = {}, { signal, timeoutMs = 120000 } = {}) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const ws = await open();
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
  return {
    call,
    snapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reconnect() {
      socket?.close();
      socket = undefined;
      set({ url: storedUrl() });
      return open();
    },
    close() {
      socket?.close();
    },
  };
}
