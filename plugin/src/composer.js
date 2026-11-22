// Composer integration: model catalog caching, runtime/effort sync, and session controls.

// How long the composer keeps buzz-host's model list; while buzz-host is
// still probing other runtimes, briefly, so their models show up soon.
// Per-conversation entries are revalidated in the background after a short
// interval so mid-chat /runtime, /model, /effort and composer switches reflect
// quickly without showing a loading spinner.
export const CATALOG_TTL = 5 * 60_000;
export const CATALOG_RETRY_MS = 15_000;
export const CHAT_CATALOG_REFRESH_MS = 2_000;
export const CATALOG_CACHE_CAP = 200;

/** Cache key for an agent's composer catalog, scoped to conversation and optional runtime preview. */
export function catalogKey(pubkey, place, runtime) {
  const base = place?.channelId ? `${pubkey}|${place.channelId}|${place.root ?? ""}` : pubkey;
  return runtime ? `${base}|rt:${runtime}` : base;
}

/** RPC params for buzz-host's `catalog` method. */
export function catalogParams(pubkey, place, runtime) {
  return {
    pubkey,
    ...(place?.channelId ? { channelId: place.channelId, threadRootId: place.root ?? null } : {}),
    ...(runtime ? { runtime } : {}),
  };
}

/** buzz-host's catalog answer as Buzz's `Models`, and how long to keep it.
 * Models are the agent's own runtime's, then (grouped by runtime, ids
 * "<runtime>::<model>") other signed-in runtimes'; a pick of one moves the
 * chat to that runtime. With an older buzz-host, the answer as it is. */
export function composerModels(answer) {
  const { runtimesPending, ...models } = answer ?? {};
  return { models, ttlMs: runtimesPending ? CATALOG_RETRY_MS : CATALOG_TTL };
}

export function createComposer({ client, ctx }) {
  // Buzz asks again whenever the agents a draft mentions (or its conversation
  // place) change; buzz-host probes the runtime only when its own cache is
  // empty or old.
  const catalogCache = new Map();
  const catalogNotify = new Set();
  function notifyCatalog() {
    for (const listener of [...catalogNotify]) listener();
  }
  function invalidateCatalog(pubkey, place) {
    if (place?.channelId) {
      const base = catalogKey(pubkey, place);
      const rtPrefix = `${base}|rt:`;
      for (const k of [...catalogCache.keys()]) {
        if (k === base || k.startsWith(rtPrefix)) catalogCache.delete(k);
      }
    } else {
      const prefix = `${pubkey}|`;
      for (const k of [...catalogCache.keys()]) {
        if (k === pubkey || k.startsWith(prefix)) catalogCache.delete(k);
      }
    }
    notifyCatalog();
  }
  function setCatalogEntry(key, entry) {
    catalogCache.delete(key);
    catalogCache.set(key, entry);
    if (catalogCache.size > CATALOG_CACHE_CAP) {
      const oldest = catalogCache.keys().next().value;
      if (oldest !== undefined) catalogCache.delete(oldest);
    }
  }
  if (typeof ctx.agents.registerTab === "function") {
    // Hidden tab whose subscribe() bumps Buzz's agents snapshot so open
    // composers re-read hostedModels() immediately after settings.set or a
    // per-chat runtime/model/effort switch on buzz-host.
    ctx.agents.registerTab({
      id: "catalog-sync",
      title: "Catalog sync",
      when: () => false,
      component: () => null,
      subscribe: (listener) => {
        catalogNotify.add(listener);
        return () => catalogNotify.delete(listener);
      },
    });
  }
  function hostedModels(agent, place, runtime) {
    const key = catalogKey(agent.pubkey, place, runtime);
    const hit = catalogCache.get(key);
    const now = Date.now();
    const fresh = Boolean(hit?.value && now - hit.at < hit.ttlMs);
    const shouldRefresh =
      fresh &&
      Boolean(place?.channelId) &&
      !hit.pending &&
      now - (hit.checkedAt ?? hit.at) >= CHAT_CATALOG_REFRESH_MS;
    if (fresh && !shouldRefresh) return hit.value;
    if (hit?.pending) return hit.value ?? hit.pending;
    const prevValue = hit?.value;
    const pending = client
      .call("catalog", catalogParams(agent.pubkey, place, runtime), { timeoutMs: 180000 })
      .then((answer) => {
        const { models: value, ttlMs } = composerModels(answer);
        if (catalogCache.get(key)?.pending === pending) {
          const ts = Date.now();
          setCatalogEntry(key, { at: ts, checkedAt: ts, value, ttlMs });
          if (prevValue && JSON.stringify(prevValue) !== JSON.stringify(value)) {
            notifyCatalog();
          }
          // Other runtimes still being probed: have Buzz read again then.
          if (ttlMs < CATALOG_TTL) setTimeout(notifyCatalog, ttlMs + 100);
        }
        return value;
      })
      .catch((error) => {
        if (catalogCache.get(key)?.pending === pending) {
          if (prevValue)
            setCatalogEntry(key, { at: hit.at, checkedAt: Date.now(), value: prevValue, ttlMs: hit.ttlMs });
          else catalogCache.delete(key);
        }
        if (!prevValue) throw error;
      });
    setCatalogEntry(key, { ...(hit ?? {}), pending });
    return prevValue ?? pending;
  }

  // Buzz reads a conversation's session state synchronously and often: answer
  // with what buzz-host last said, and ask buzz-host again every few seconds
  // for the conversations Buzz is still reading (each notify makes it read).
  const hostedSessions = (() => {
    const known = new Map();
    const knownChat = new Map();
    const asked = new Map();
    const listeners = new Set();
    let timer;
    let polling = false;
    const keyOf = (pubkey, place) => `${pubkey}|${place.channelId}|${place.root ?? ""}`;
    const emit = () => {
      for (const listener of [...listeners]) listener();
    };
    const fetchState = async (a) => {
      try {
        const r = await client.call(
          "session.state",
          { pubkey: a.pubkey, channelId: a.channelId, threadRootId: a.root ?? null },
          { timeoutMs: 10000 },
        );
        if (r?.chat && typeof r.chat === "object") {
          const k = keyOf(a.pubkey, a);
          const sig = JSON.stringify(r.chat);
          const prev = knownChat.get(k);
          knownChat.delete(k);
          knownChat.set(k, sig);
          if (knownChat.size > CATALOG_CACHE_CAP) {
            const oldest = knownChat.keys().next().value;
            if (oldest !== undefined) knownChat.delete(oldest);
          }
          if (prev !== undefined && prev !== sig) {
            invalidateCatalog(a.pubkey, { channelId: a.channelId, root: a.root });
          }
        }
        return r?.state ?? "unavailable";
      } catch {
        return "unavailable";
      }
    };
    const schedule = (ms) => {
      clearTimeout(timer);
      timer = undefined;
      if (!asked.size || !listeners.size) return;
      const busy = [...known.values()].some((s) => s === "active" || s === "compacting");
      timer = setTimeout(poll, ms ?? (busy ? 2000 : 5000));
    };
    async function poll() {
      if (polling) return;
      polling = true;
      try {
        const now = Date.now();
        await Promise.all(
          [...asked].map(async ([key, a]) => {
            if (now - a.at > 30000) {
              asked.delete(key);
              return;
            }
            known.set(key, await fetchState(a));
          }),
        );
      } finally {
        polling = false;
      }
      emit();
      schedule();
    }
    return {
      scope: () => "thread",
      state(agent, place) {
        const key = keyOf(agent.pubkey, place);
        const first = !asked.has(key);
        asked.set(key, { pubkey: agent.pubkey, channelId: place.channelId, root: place.root, at: Date.now() });
        if (first && !polling) schedule(0);
        return known.get(key) ?? "unavailable";
      },
      async run(agent, place, action) {
        const key = keyOf(agent.pubkey, place);
        if (action === "compact") {
          known.set(key, "compacting");
          emit();
          schedule(2000);
        }
        try {
          await client.call(
            "session.control",
            { pubkey: agent.pubkey, channelId: place.channelId, threadRootId: place.root ?? null, action },
            { timeoutMs: action === "compact" ? 17 * 60_000 : 20000 },
          );
        } finally {
          known.set(key, await fetchState({ pubkey: agent.pubkey, channelId: place.channelId, root: place.root }));
          emit();
        }
      },
      subscribe(listener) {
        listeners.add(listener);
        if (listeners.size === 1) schedule();
        return () => {
          listeners.delete(listener);
          if (!listeners.size) schedule();
        };
      },
    };
  })();

  return { invalidateCatalog, hostedModels, hostedSessions };
}
