// Multi-machine RPC client: manages one pooled WebSocket per configured buzz-host
// machine, routing calls automatically by `options.machineId`, `params.pubkey`
// (via the agent-to-machine map), or the active/primary machine.
// When an access token is configured, authenticates with `auth` immediately on
// WebSocket open before resolving queued RPCs.
import {
  ACTIVE_MACHINE_KEY,
  MACHINES_CHANGED_EVENT,
  MACHINES_KEY,
  TOKEN_KEY,
  URL_KEY,
  activeMachine,
  machineById,
  machineForAgent,
  machineWssUrl,
  mergeStoredAgentHosts,
  setStoredAgentHost,
  storedMachines,
  storedToken,
  storedUrl,
} from "./config.js";

function createMachineSocket({ id, url, token, onState }) {
  let socket;
  let opening;
  let next = 1;
  const pending = new Map();
  let state = { id, status: "idle", url, token, error: "", session: null };

  const set = (patch) => {
    state = { ...state, ...patch };
    onState?.(state);
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
    const reqId = next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(reqId);
        reject(new Error(`buzz-host did not answer ${method} in time`));
      }, timeoutMs);
      pending.set(reqId, { resolve, reject, timer });
      signal?.addEventListener(
        "abort",
        () => {
          if (!pending.delete(reqId)) return;
          clearTimeout(timer);
          reject(new DOMException("Aborted", "AbortError"));
        },
        { once: true },
      );
      ws.send(JSON.stringify({ id: reqId, method, params }));
    });
  }

  function open() {
    if (socket && socket.readyState === WebSocket.OPEN) return Promise.resolve(socket);
    if (opening) return opening;
    if (!url) {
      const error = new Error(
        "No buzz-host server configured yet. Open Settings → Agent setup → Machines and paste your server URL or pairing link.",
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
              ? `Could not reach buzz-host at ${url}. Check that the server is up and the pairing URL is correct.`
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
          platform: result.platform ?? null,
          capabilities: result.capabilities ?? null,
          publicGuestUrl: result.publicGuestUrl ?? null,
        },
      });
    }
    return result;
  }

  function close() {
    const old = socket;
    socket = undefined;
    opening = undefined;
    try {
      old?.close();
    } catch {}
    fail(new Error("Connection to buzz-host closed"));
  }

  return {
    id,
    url,
    token,
    call,
    open,
    close,
    snapshot: () => state,
  };
}

export function createClient() {
  const pool = new Map();
  const listeners = new Set();

  const fallbackTarget = () => {
    const primary = activeMachine();
    if (primary) {
      return { id: primary.id, url: machineWssUrl(primary), token: primary.token || "" };
    }
    return { id: "default", url: storedUrl(), token: storedToken() };
  };

  let state = {
    status: "idle",
    url: fallbackTarget().url,
    machineId: fallbackTarget().id,
    error: "",
    session: null,
    epoch: 0,
  };

  const emit = () => {
    for (const listener of [...listeners]) listener();
  };

  const set = (patch) => {
    state = { ...state, ...patch };
    emit();
  };

  function resolveTarget(params = {}, options = {}) {
    if (options?.machineId) {
      const hit = machineById(options.machineId);
      if (hit) return { id: hit.id, url: machineWssUrl(hit), token: hit.token || "" };
    }
    if (params && typeof params.pubkey === "string" && params.pubkey) {
      const owner = machineForAgent(params.pubkey);
      if (owner) return { id: owner.id, url: machineWssUrl(owner), token: owner.token || "" };
    }
    return fallbackTarget();
  }

  function getSocket(target) {
    const existing = pool.get(target.id);
    if (existing && existing.url === target.url && existing.token === target.token) {
      return existing;
    }
    if (existing) {
      existing.close();
      pool.delete(target.id);
    }
    const created = createMachineSocket({
      id: target.id,
      url: target.url,
      token: target.token,
      onState(nextState) {
        const current = fallbackTarget();
        if (nextState.id === current.id) {
          set({
            status: nextState.status,
            url: nextState.url,
            machineId: nextState.id,
            error: nextState.error,
            session: nextState.session,
          });
        }
      },
    });
    pool.set(target.id, created);
    return created;
  }

  function syncPoolWithStorage() {
    const machines = storedMachines();
    const byId = new Map(machines.map((m) => [m.id, m]));
    for (const [id, conn] of [...pool.entries()]) {
      const fresh = byId.get(id);
      if (!fresh || machineWssUrl(fresh) !== conn.url || (fresh.token || "") !== conn.token) {
        conn.close();
        pool.delete(id);
      }
    }
    const primary = fallbackTarget();
    const primaryConn = pool.get(primary.id);
    set({
      url: primary.url,
      machineId: primary.id,
      status: primaryConn?.snapshot().status ?? "idle",
      error: primaryConn?.snapshot().error ?? "",
      session: primaryConn?.snapshot().session ?? null,
      epoch: state.epoch + 1,
    });
  }

  const onStorage = (event) => {
    if (
      event.key === null ||
      event.key === MACHINES_KEY ||
      event.key === ACTIVE_MACHINE_KEY ||
      event.key === URL_KEY ||
      event.key === TOKEN_KEY
    ) {
      syncPoolWithStorage();
    }
  };
  const onMachinesChanged = () => syncPoolWithStorage();

  if (typeof window !== "undefined") {
    window.addEventListener("storage", onStorage);
    window.addEventListener(MACHINES_CHANGED_EVENT, onMachinesChanged);
  }

  async function callAllList(params = {}, options = {}) {
    const machines = storedMachines();
    if (!machines.length) return { agents: [], errors: [] };
    const settled = await Promise.allSettled(
      machines.map(async (machine) => {
        const target = { id: machine.id, url: machineWssUrl(machine), token: machine.token || "" };
        if (!target.url) return { machine, agents: [] };
        const conn = getSocket(target);
        const res = await conn.call("list", params, options);
        const rawAgents = Array.isArray(res?.agents) ? res.agents : [];
        mergeStoredAgentHosts(
          machine.id,
          rawAgents.map((a) => a.pubkey).filter(Boolean),
        );
        const sessionCaps = conn.snapshot().session?.capabilities;
        const platform = machine.platform ?? conn.snapshot().session?.platform ?? undefined;
        const desktopSupported =
          machine.capabilities?.desktop !== undefined
            ? machine.capabilities.desktop !== false
            : sessionCaps?.desktop !== undefined
              ? sessionCaps.desktop !== false
              : platform !== "darwin";
        return {
          machine,
          agents: rawAgents.map((a) => ({
            ...a,
            machineId: machine.id,
            machineName: machine.name,
            machinePlatform: platform,
            desktopSupported,
          })),
        };
      }),
    );
    const agents = [];
    const seen = new Set();
    const errors = [];
    for (let i = 0; i < settled.length; i++) {
      const outcome = settled[i];
      const machine = machines[i];
      if (outcome.status === "fulfilled") {
        for (const agent of outcome.value.agents) {
          const key = String(agent.pubkey || "").toLowerCase();
          if (!key || seen.has(key)) continue;
          seen.add(key);
          agents.push(agent);
        }
      } else {
        errors.push({
          machineId: machine.id,
          machineName: machine.name,
          error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
        });
      }
    }
    if (!agents.length && errors.length === machines.length) {
      throw new Error(errors[0].error);
    }
    return { agents, errors };
  }

  async function call(method, params = {}, options = {}) {
    if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (method === "list" && options.allMachines) {
      return callAllList(params, options);
    }
    const target = resolveTarget(params, options);
    const conn = getSocket(target);
    const result = await conn.call(method, params, options);
    if (method === "provision" && result?.pubkey) {
      setStoredAgentHost(result.pubkey, target.id);
    }
    if (method === "list" && Array.isArray(result?.agents)) {
      mergeStoredAgentHosts(
        target.id,
        result.agents.map((a) => a.pubkey).filter(Boolean),
      );
    }
    return result;
  }

  return {
    call,
    snapshot: () => state,
    sessionFor(machineId) {
      const target = machineId ? machineById(machineId) : activeMachine();
      const id = target?.id ?? "default";
      return pool.get(id)?.snapshot().session ?? null;
    },
    machineFor(pubkeyOrId) {
      return machineForAgent(pubkeyOrId) ?? machineById(pubkeyOrId) ?? activeMachine();
    },
    urlForAgent(pubkey) {
      const machine = machineForAgent(pubkey) ?? activeMachine();
      return (machine && machineWssUrl(machine)) || storedUrl();
    },
    listMachines: () => storedMachines(),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reconnect(machineId) {
      if (machineId) {
        const target = resolveTarget({}, { machineId });
        const existing = pool.get(target.id);
        if (existing) {
          existing.close();
          pool.delete(target.id);
        }
        set({ epoch: state.epoch + 1 });
        return getSocket(target).open();
      }
      for (const conn of pool.values()) conn.close();
      pool.clear();
      const target = fallbackTarget();
      set({ url: target.url, machineId: target.id, session: null, epoch: state.epoch + 1 });
      return getSocket(target).open();
    },
    close() {
      if (typeof window !== "undefined") {
        window.removeEventListener("storage", onStorage);
        window.removeEventListener(MACHINES_CHANGED_EVENT, onMachinesChanged);
      }
      for (const conn of pool.values()) conn.close();
      pool.clear();
    },
  };
}
