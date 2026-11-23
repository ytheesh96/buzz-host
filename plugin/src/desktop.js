// Agent desktop: in-app Viewport page, Settings section, and in-chat preview.
import { storedUrl } from "./config.js";
import { buildTurns } from "./activity.js";
import { novncClient } from "./generated/novnc-client.js";

const HEX_PUBKEY = /^[0-9a-f]{64}$/i;

export const VIEWPORT_PAGE_ID = "desktops";
export const VIEWPORT_PAGE_ICON =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="1"/><path d="M7 20h10M9 16v4M15 16v4"/></svg>',
  );

/** Parse route params for the Viewport page (`{ pubkey?, take? }`). Returns null if invalid. */
export function parseViewportRoute(params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) return null;
  const keys = Object.keys(params);
  if (keys.some((k) => k !== "pubkey" && k !== "take")) return null;
  const pubkey =
    typeof params.pubkey === "string" && HEX_PUBKEY.test(params.pubkey)
      ? params.pubkey.toLowerCase()
      : "";
  if (params.pubkey !== undefined && !pubkey) return null;
  if (
    params.take !== undefined &&
    typeof params.take !== "boolean" &&
    params.take !== "1" &&
    params.take !== "true"
  )
    return null;
  const take = params.take === true || params.take === "1" || params.take === "true";
  if (take && !pubkey) return null;
  return { pubkey, take };
}

export function validateViewportRoute(params) {
  return parseViewportRoute(params) !== null;
}

/** Target string for Buzz's native agent sidebar panel opened to its Activity tab. */
export function agentActivityPanelTarget(pubkey) {
  return typeof pubkey === "string" && HEX_PUBKEY.test(pubkey)
    ? `buzz:profile?agent=${pubkey.toLowerCase()}&tab=activity`
    : "";
}

/** Build a Buzz navigation target that opens the Viewport page inside the app. */
export function viewportPageTarget(pluginId, pubkey, { take = false } = {}) {
  const normalized = typeof pubkey === "string" && HEX_PUBKEY.test(pubkey) ? pubkey.toLowerCase() : "";
  const base = {
    version: 1,
    kind: "page",
    pluginId: pluginId || "local.buzz-host.viewport",
    pageId: VIEWPORT_PAGE_ID,
  };
  if (!normalized) return base;
  return {
    ...base,
    route: { version: 1, params: take ? { pubkey: normalized, take: true } : { pubkey: normalized } },
  };
}

/** "<agent> <turn> <live|done> <threadRoot>" per desktop agent working on this request. */
export function previewKeys(snap, channelId, messageId, agents) {
  if (!snap?.turns || !messageId || !agents.size) return "";
  const latest = new Map();
  for (const t of snap.turns) {
    if (t.channelId !== channelId || !agents.has(t.agent) || !t.triggeringEventIds?.includes(messageId)) continue;
    const prev = latest.get(t.agent);
    if (!prev || t.timestamp > prev.timestamp) latest.set(t.agent, t);
  }
  return [...latest.values()]
    .map((t) => `${t.agent} ${t.turnId} ${t.state === "working" ? "live" : "done"} ${t.threadRootId ?? ""}`)
    .join("\n");
}

function sortDesktopAgents(agents) {
  return [...agents].sort((a, b) => {
    const rank = (x) => (x.desktopRunning ? 0 : x.desktop ? 1 : 2);
    const diff = rank(a) - rank(b);
    if (diff !== 0) return diff;
    return String(a.name || a.pubkey).localeCompare(String(b.name || b.pubkey), "en");
  });
}

export function createDesktop({ React, client, ctx, uiKit, Btn, Icon, navigation, panels, pluginId }) {
  const { h, Note } = uiKit;
  const emptyPanels = () => [];
  const useNoopSplit = () => ({ ref: React.useRef(null), handle: null });
  const useSideSplit = panels?.ui?.useSplit ?? useNoopSplit;
  const PanelWorkspace = panels?.ui?.Workspace;

  // ----- Agent desktop: one inline live view per agent -----
  // Mounted directly inside Buzz's Viewport workspace page (never monitor-wide
  // browser fullscreen). Because we stay inside Buzz's normal page layout,
  // pressing Esc while in control passes directly to the remote desktop without
  // browser fullscreen interception or any Esc-to-exit binding.
  const viewers = new Map();
  function desktopViewer(pubkey) {
    let v = viewers.get(pubkey);
    if (!v) {
      v = createViewer(pubkey);
      viewers.set(pubkey, v);
    }
    return v;
  }
  ctx.effect(() => () => {
    for (const v of viewers.values()) v.dispose();
    viewers.clear();
  });

  function openDesktop(pubkey, { take = false } = {}) {
    if (!navigation?.open) return;
    void navigation.open(viewportPageTarget(pluginId, pubkey, { take }));
  }

  function createViewer(pubkey) {
    const screen = document.createElement("div");
    screen.setAttribute("data-buzz-host-desktop-stage", "");
    screen.style.cssText = "width:100%;height:100%;min-width:0;min-height:0;overflow:hidden;background:#000;outline:none";
    let rfb = null;
    let viewerId = "";
    let connecting = null;
    let state = { status: "off", mine: false, error: "", busy: "" };
    const listeners = new Set();
    const set = (patch) => {
      state = { ...state, ...patch };
      for (const l of listeners) l();
    };

    // While the user has control, keep Escape inside the remote desktop so no
    // Buzz ancestor listener intercepts it. noVNC's canvas handles keydown
    // first (target phase) and sends XK_ESCAPE to Xvnc before bubbling here.
    screen.addEventListener("keydown", (e) => {
      if (state.mine && e.key === "Escape") {
        e.stopPropagation();
      }
    });
    screen.addEventListener("pointerdown", () => {
      if (state.mine) rfb?.focus();
    });

    function repaint(r) {
      try {
        const d = r._display; // noVNC's Display: draw the whole back buffer again
        if (d?.width && d?.height) {
          d._damage(0, 0, d.width, d.height);
          d.flip();
        }
      } catch {}
    }
    function fit(r) {
      if (rfb !== r) return;
      try {
        r.scaleViewport = true; // rescales to the current box
      } catch {}
      repaint(r);
    }
    function refit() {
      const r = rfb;
      if (!r) return;
      // After layout, and again once any panel transition settles (WebKitGTK canvas repaint).
      requestAnimationFrame(() => requestAnimationFrame(() => fit(r)));
      setTimeout(() => fit(r), 250);
    }

    function connect() {
      if (rfb) return Promise.resolve();
      connecting ??= (async () => {
        set({ status: "connecting", error: "" });
        try {
          const v = await client.call("desktop.view", { pubkey }, { timeoutMs: 60000 });
          if (state.status !== "connecting") return; // disconnected meanwhile
          const { RFB } = novncClient();
          const r = new RFB(screen, `${storedUrl().replace(/\/+$/, "")}${v.path}`, { wsProtocols: ["binary"], shared: true });
          r.viewOnly = true;
          r.scaleViewport = true;
          r.resizeSession = false;
          r.background = "#000";
          r.addEventListener("connect", () => {
            if (rfb !== r) return;
            set({ status: "live" });
            refit();
          });
          r.addEventListener("disconnect", (e) => {
            if (rfb !== r) return;
            rfb = null;
            viewerId = "";
            set({
              status: "off",
              mine: false,
              error: e.detail?.clean
                ? ""
                : "The desktop view closed (the desktop stopped, another viewer took over, or the connection dropped).",
            });
          });
          rfb = r;
          viewerId = v.viewer;
        } catch (e) {
          set({ status: "off", error: String(e.message ?? e) });
          throw e;
        } finally {
          connecting = null;
        }
      })();
      return connecting;
    }

    function disconnect() {
      const r = rfb;
      rfb = null;
      viewerId = "";
      try {
        r?.disconnect(); // buzz-host hands control back when the view closes
      } catch {}
      set({ status: "off", mine: false });
    }

    async function lease(take) {
      if (!viewerId) return;
      const r = await client.call("desktop.lease", { pubkey, viewer: viewerId, take }, { timeoutMs: 20000 });
      if (rfb) rfb.viewOnly = !r.mine;
      set({ mine: r.mine });
      if (r.mine) rfb?.focus();
    }

    const act = (label, task) => {
      set({ busy: label, error: "" });
      return Promise.resolve()
        .then(task)
        .catch((e) => set({ error: String(e.message ?? e) }))
        .finally(() => set({ busy: "" }));
    };

    function open({ take = false } = {}) {
      return act(take ? "take" : "watch", async () => {
        await connect();
        if (take && !state.mine) await lease(true);
      });
    }

    const takeOver = () =>
      act("take", async () => {
        await connect();
        await lease(true);
      });

    const handBack = () =>
      act("back", async () => {
        await lease(false);
      });

    function attach(host) {
      if (!host) return () => {};
      if (screen.parentNode !== host) host.replaceChildren(screen);
      let observer = null;
      if (typeof ResizeObserver === "function") {
        observer = new ResizeObserver(() => refit());
        observer.observe(host);
      }
      refit();
      return () => {
        observer?.disconnect();
        if (screen.parentNode === host) screen.remove();
        disconnect();
      };
    }

    return {
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      snapshot: () => state,
      attach,
      refit,
      open,
      connect: () => open({ take: false }),
      disconnect,
      takeOver,
      handBack,
      dispose() {
        screen.remove();
        disconnect();
        listeners.clear();
      },
    };
  }

  // ----- Viewport workspace page (dock page alongside Agents and Shared notes) -----
  function ViewportPage({ navigation: pageNav }) {
    const rawParams = pageNav?.target?.kind === "page" ? pageNav.target.route?.params : undefined;
    const route = React.useMemo(() => parseViewportRoute(rawParams), [rawParams]);
    const entryId = pageNav?.entryId ?? "";
    const traversal = pageNav?.traversal === true;

    const [agents, setAgents] = React.useState([]);
    const [loading, setLoading] = React.useState(true);
    const [loadError, setLoadError] = React.useState("");
    const [selectedPubkey, setSelectedPubkey] = React.useState(() => route?.pubkey ?? "");
    const [sidebarOpen, setSidebarOpen] = React.useState(true);
    const [inspectorOpen, setInspectorOpen] = React.useState(false);
    const [actionBusy, setActionBusy] = React.useState("");
    const [actionError, setActionError] = React.useState("");
    const [autoOpen, setAutoOpen] = React.useState(() =>
      route?.pubkey ? { key: entryId || `init:${route.pubkey}`, pubkey: route.pubkey, take: !traversal && route.take } : null,
    );
    const stageRef = React.useRef(null);
    const initialSelectDone = React.useRef(Boolean(route?.pubkey));
    React.useSyncExternalStore(panels?.subscribe ?? noSubscribe, panels?.snapshot ?? emptyPanels);
    const relayScope = (() => {
      try {
        return ctx.reflect?.get?.("relay")?.snapshot?.()?.scope;
      } catch {
        return undefined;
      }
    })();
    const split = useSideSplit(relayScope, `${pluginId || "local.buzz-host.viewport"}:agent-sidebar`, 400, 300);

    const loadAgents = React.useCallback(async (signal) => {
      setLoading(true);
      try {
        const res = await client.call("list", {}, { signal, timeoutMs: 20000 });
        if (signal?.aborted) return [];
        let list = Array.isArray(res?.agents) ? res.agents : [];
        // Compatibility fallback if talking to an older buzz-host that omits desktopRunning on list.
        const needsProbe = list.filter((a) => a.desktop && a.desktopRunning === undefined);
        if (needsProbe.length) {
          const statuses = await Promise.all(
            needsProbe.map((a) =>
              client
                .call("desktop.status", { pubkey: a.pubkey }, { signal, timeoutMs: 15000 })
                .then((st) => [a.pubkey, st])
                .catch(() => [a.pubkey, null]),
            ),
          );
          if (signal?.aborted) return [];
          const byKey = new Map(statuses);
          list = list.map((a) => {
            const st = byKey.get(a.pubkey);
            return st ? { ...a, desktopRunning: st.running === true, desktopLease: st.lease ?? null } : a;
          });
        }
        const sorted = sortDesktopAgents(list);
        setAgents(sorted);
        setLoadError("");
        return sorted;
      } catch (e) {
        if (!signal?.aborted) setLoadError(String(e.message ?? e));
        return [];
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    }, []);

    React.useEffect(() => {
      const controller = new AbortController();
      void loadAgents(controller.signal).then((sorted) => {
        if (controller.signal.aborted || !sorted.length) return;
        if (!initialSelectDone.current) {
          initialSelectDone.current = true;
          const first = sorted[0];
          setSelectedPubkey(first.pubkey);
          // If an agent's desktop is already running, connect live automatically in watch mode.
          if (first.desktopRunning) {
            setAutoOpen({ key: `running:${first.pubkey}`, pubkey: first.pubkey, take: false });
          }
        }
      });
      return () => controller.abort();
    }, [loadAgents]);

    // Follow incoming route navigation (e.g. clicking Open or Take over from chat or Desktop tab).
    React.useEffect(() => {
      if (!route?.pubkey) return;
      initialSelectDone.current = true;
      setSelectedPubkey(route.pubkey);
      setActionError("");
      setAutoOpen({
        key: entryId || `route:${route.pubkey}:${route.take ? 1 : 0}`,
        pubkey: route.pubkey,
        take: !traversal && route.take,
      });
    }, [entryId, route?.pubkey, route?.take, traversal]);

    const selectedAgent = React.useMemo(
      () => agents.find((a) => a.pubkey === selectedPubkey) ?? null,
      [agents, selectedPubkey],
    );
    const activePubkey = selectedPubkey || "";
    const viewer = React.useMemo(() => (activePubkey ? desktopViewer(activePubkey) : null), [activePubkey]);
    const view = React.useSyncExternalStore(
      viewer ? viewer.subscribe : noSubscribe,
      viewer ? viewer.snapshot : () => OFF_VIEW,
    );

    // Attach the selected viewer's DOM stage inside Buzz's page and cleanly disconnect on switch/unmount.
    React.useEffect(() => {
      if (!viewer || !stageRef.current) return undefined;
      return viewer.attach(stageRef.current);
    }, [viewer]);

    // Trigger pending auto-open (from route navigation or selecting an already-running desktop).
    React.useEffect(() => {
      if (!autoOpen || !viewer || autoOpen.pubkey !== activePubkey) return;
      const intent = autoOpen;
      setAutoOpen(null);
      void viewer.open({ take: intent.take }).then(() => {
        // Reflect newly running desktop in the sidebar list.
        setAgents((prev) =>
          prev.map((a) => (a.pubkey === intent.pubkey ? { ...a, desktopRunning: true } : a)),
        );
      });
    }, [autoOpen, viewer, activePubkey]);

    // Keep sidebar running/lease badges in sync with live viewer state.
    React.useEffect(() => {
      if (!activePubkey) return;
      if (view.status === "live") {
        setAgents((prev) =>
          prev.map((a) =>
            a.pubkey === activePubkey
              ? { ...a, desktop: true, desktopRunning: true, desktopLease: view.mine ? { holder: "human" } : null }
              : a,
          ),
        );
      }
    }, [activePubkey, view.status, view.mine]);

    // Refit noVNC whenever the left or right sidebar toggles.
    React.useEffect(() => {
      viewer?.refit();
    }, [sidebarOpen, inspectorOpen, viewer]);

    const inspectorTarget = activePubkey ? agentActivityPanelTarget(activePubkey) : "";
    const inspectorPanel = inspectorTarget ? panels?.resolve?.(inspectorTarget) : undefined;
    const canInspect = Boolean(inspectorPanel && inspectorTarget);
    const showInspector = Boolean(inspectorOpen && canInspect);

    const selectAgent = (agent) => {
      setActionError("");
      setSelectedPubkey(agent.pubkey);
      if (agent.desktopRunning) {
        setAutoOpen({ key: `pick:${agent.pubkey}:${Date.now()}`, pubkey: agent.pubkey, take: false });
      }
    };

    const handleEnableDesktop = async () => {
      if (!activePubkey) return;
      setActionBusy("enable");
      setActionError("");
      try {
        await client.call("desktop.set", { pubkey: activePubkey, enabled: true }, { timeoutMs: 90000 });
        setAgents((prev) =>
          sortDesktopAgents(prev.map((a) => (a.pubkey === activePubkey ? { ...a, desktop: true } : a))),
        );
      } catch (e) {
        setActionError(String(e.message ?? e));
      } finally {
        setActionBusy("");
      }
    };

    const handleStopDesktop = async () => {
      if (!activePubkey) return;
      setActionBusy("stop");
      setActionError("");
      try {
        viewer?.disconnect();
        await client.call("desktop.stop", { pubkey: activePubkey }, { timeoutMs: 30000 });
        setAgents((prev) =>
          sortDesktopAgents(
            prev.map((a) =>
              a.pubkey === activePubkey ? { ...a, desktopRunning: false, desktopLease: null } : a,
            ),
          ),
        );
      } catch (e) {
        setActionError(String(e.message ?? e));
      } finally {
        setActionBusy("");
      }
    };

    const handleOpen = (take = false) => {
      if (!viewer) return;
      setActionError("");
      void viewer.open({ take });
    };

    const openSettings = () => {
      navigation?.open?.({ version: 1, kind: "settings", section: "plugins" });
    };

    const showStage = Boolean(viewer && (view.status === "live" || view.status === "connecting"));
    const working = Boolean(actionBusy || view.busy);
    const activeName = selectedAgent?.name || (activePubkey ? activePubkey.slice(0, 8) : "Viewport");
    const desktopEnabled = selectedAgent ? selectedAgent.desktop === true : Boolean(activePubkey);
    const desktopRunning = view.status === "live" || selectedAgent?.desktopRunning === true;
    const statusText =
      view.status === "live"
        ? view.mine
          ? "You have control"
          : "Watching"
        : view.status === "connecting"
          ? "Connecting…"
          : !selectedAgent
            ? ""
            : !desktopEnabled
              ? "Desktop off"
              : desktopRunning
                ? "Running"
                : "Stopped";

    const enabledAgents = agents.filter((a) => a.desktop);
    const disabledAgents = agents.filter((a) => !a.desktop);

    const renderAgentRow = (agent) => {
      const selected = agent.pubkey === activePubkey;
      const isLiveHere = selected && view.status === "live";
      const isMine = isLiveHere ? view.mine : agent.desktopLease?.holder === "human";
      const isRunning = isLiveHere || agent.desktopRunning === true;
      const dotColor = !agent.desktop
        ? "var(--text-subtle)"
        : isMine
          ? "var(--accent, #22c55e)"
          : isRunning
            ? "#22c55e"
            : "var(--text-subtle)";
      const sub = !agent.desktop
        ? "Desktop off"
        : isMine
          ? "You have control"
          : isRunning
            ? "Running"
            : "Stopped";
      return h(
        "button",
        {
          key: agent.pubkey,
          type: "button",
          "data-buzz-ui": "",
          "data-variant": "row",
          "data-selected": selected ? "" : undefined,
          "aria-current": selected ? "page" : undefined,
          className: "navigation-item",
          onClick: () => selectAgent(agent),
          style: { width: "100%", textAlign: "left" },
        },
        h("span", {
          "aria-hidden": "true",
          style: {
            width: 8,
            height: 8,
            borderRadius: 999,
            background: dotColor,
            flexShrink: 0,
            opacity: isRunning || isMine ? 1 : 0.45,
          },
        }),
        h(
          "span",
          { className: "navigation-item-label", style: { display: "grid", gap: 1, minWidth: 0 } },
          h(
            "span",
            { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
            agent.name || agent.pubkey.slice(0, 8),
          ),
          h("span", { className: "text-caption text-secondary" }, sub),
        ),
      );
    };

    return h(
      "div",
      {
        "data-buzz-viewport-page": "",
        style: {
          display: "flex",
          height: "100%",
          width: "100%",
          minHeight: 0,
          minWidth: 0,
          overflow: "hidden",
        },
      },
      // Left sidebar: agent desktop inventory
      sidebarOpen &&
        h(
          "aside",
          {
            "aria-label": "Agent desktops",
            style: {
              width: "16rem",
              flexShrink: 0,
              display: "flex",
              flexDirection: "column",
              minHeight: 0,
              borderInlineEnd: "1px solid var(--border-standard)",
              background: "var(--surface-panel, transparent)",
            },
          },
          h(
            "header",
            { "data-buzz-ui": "", className: "panel-header" },
            h(
              "div",
              { className: "panel-header-title" },
              h(
                "div",
                { className: "panel-header-label" },
                Icon &&
                  h(
                    "span",
                    { className: "panel-header-label-icon", "aria-hidden": "true" },
                    h(Icon, { name: "monitor", size: 16 }),
                  ),
                h("h2", null, "Viewport"),
              ),
            ),
            h(
              "div",
              { className: "panel-header-actions" },
              h(
                Btn,
                {
                  size: "sm",
                  variant: "ghost",
                  disabled: loading,
                  onClick: () => void loadAgents(),
                  title: "Refresh agent desktops",
                  "aria-label": "Refresh agent desktops",
                },
                Icon ? h(Icon, { name: "refresh", size: 14 }) : "Refresh",
              ),
            ),
          ),
          h(
            "div",
            {
              style: {
                flex: 1,
                minHeight: 0,
                overflowY: "auto",
                padding: "var(--space-2)",
                display: "flex",
                flexDirection: "column",
                gap: "var(--space-1)",
              },
            },
            loadError &&
              h(
                "div",
                { style: { padding: "var(--space-2)", display: "grid", gap: "var(--space-2)" } },
                h(Note, { tone: "error" }, loadError),
                h(
                  "div",
                  { style: { display: "flex", gap: "var(--space-2)", flexWrap: "wrap" } },
                  h(Btn, { size: "sm", onClick: () => void loadAgents() }, "Retry"),
                  navigation?.open && h(Btn, { size: "sm", variant: "ghost", onClick: openSettings }, "Plugin settings"),
                ),
              ),
            !loadError && loading && !agents.length && h("div", { style: { padding: "var(--space-3)" } }, h(Note, null, "Loading agents…")),
            !loadError &&
              !loading &&
              !agents.length &&
              h(
                "div",
                { style: { padding: "var(--space-3)", display: "grid", gap: "var(--space-2)" } },
                h(Note, null, "No self-hosted agents yet."),
                navigation?.open &&
                  h(Btn, { size: "sm", onClick: openSettings }, "Configure Remote Agents"),
              ),
            ...enabledAgents.map(renderAgentRow),
            disabledAgents.length > 0 &&
              h(
                "div",
                {
                  className: "text-caption text-secondary",
                  style: {
                    padding: "var(--space-3) var(--space-2) var(--space-1)",
                    fontWeight: 600,
                    letterSpacing: "0.02em",
                  },
                },
                "Desktop off",
              ),
            ...disabledAgents.map(renderAgentRow),
          ),
        ),

      // Right area: live inline desktop stage + optional Buzz agent Activity right sidebar
      h(
        "div",
        {
          ref: split.ref,
          style: {
            flex: 1,
            minWidth: 0,
            minHeight: 0,
            display: "flex",
            overflow: "hidden",
          },
        },
        h(
          "section",
          {
            "aria-label": "Remote desktop",
            style: {
              flex: 1,
              minWidth: 0,
              minHeight: 0,
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
            },
          },
          h(
            "header",
            {
              "data-buzz-ui": "",
              className: "panel-header",
              style: { flexWrap: "nowrap", gap: "var(--space-2)" },
            },
            h(
              "div",
              {
                className: "panel-header-title",
                style: { display: "flex", alignItems: "center", gap: "var(--space-2)", minWidth: 0, flex: "1 1 0", overflow: "hidden" },
              },
              h(
                Btn,
                {
                  size: "sm",
                  variant: "ghost",
                  onClick: () => setSidebarOpen((v) => !v),
                  title: sidebarOpen ? "Hide agent list" : "Show agent list",
                  "aria-label": sidebarOpen ? "Hide agent list" : "Show agent list",
                  "aria-pressed": sidebarOpen,
                  style: { flexShrink: 0 },
                },
                Icon ? h(Icon, { name: "sidebar", size: 16 }) : sidebarOpen ? "Hide list" : "Show list",
              ),
              canInspect
                ? h(
                    "button",
                    {
                      type: "button",
                      onClick: () => setInspectorOpen((v) => !v),
                      title: showInspector ? `Close ${activeName} sidebar` : `Open ${activeName} Activity sidebar`,
                      style: {
                        all: "unset",
                        cursor: "pointer",
                        minWidth: 0,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      },
                    },
                    h(
                      "h2",
                      {
                        className: "text-label text-primary",
                        style: { margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
                      },
                      activeName,
                    ),
                  )
                : h(
                    "h2",
                    {
                      className: "text-label text-primary",
                      style: { margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
                    },
                    activeName,
                  ),
              statusText &&
                h(
                  "span",
                  {
                    "data-buzz-viewport-status": view.mine ? "control" : view.status,
                    className: "text-caption",
                    style: {
                      padding: "2px 8px",
                      borderRadius: 999,
                      whiteSpace: "nowrap",
                      flexShrink: 0,
                      fontWeight: 500,
                      background: view.mine
                        ? "var(--accent-subtle, rgba(34,197,94,.16))"
                        : "var(--surface-inset, rgba(128,128,128,.14))",
                      color: view.mine ? "var(--text-primary)" : "var(--text-secondary)",
                    },
                  },
                  statusText,
                ),
            ),
            h(
              "div",
              {
                className: "panel-header-actions",
                style: { display: "flex", alignItems: "center", gap: "var(--space-1)", flexWrap: "nowrap", flexShrink: 0 },
              },
              view.status === "live" &&
                (view.mine
                  ? h(
                      Btn,
                      { size: "sm", variant: "outline", disabled: working, onClick: () => void viewer.handBack() },
                      view.busy === "back" ? "Handing back…" : "Hand back",
                    )
                  : h(
                      Btn,
                      { size: "sm", variant: "prominent", disabled: working, onClick: () => void viewer.takeOver() },
                      view.busy === "take" ? "Taking over…" : "Take over",
                    )),
              view.status === "off" &&
                activePubkey &&
                desktopEnabled &&
                h(
                  Btn,
                  { size: "sm", variant: "prominent", disabled: working, onClick: () => handleOpen(false) },
                  view.busy === "watch" ? "Opening…" : "Open desktop",
                ),
              activePubkey &&
                desktopEnabled &&
                desktopRunning &&
                h(
                  Btn,
                  { size: "sm", variant: "ghost", disabled: working, title: "Stop desktop", onClick: () => void handleStopDesktop() },
                  actionBusy === "stop" ? "Stopping…" : "Stop",
                ),
              canInspect &&
                h(
                  Btn,
                  {
                    size: "sm",
                    variant: showInspector ? "outline" : "ghost",
                    onClick: () => setInspectorOpen((v) => !v),
                    title: showInspector ? `Hide ${activeName} sidebar` : `Show ${activeName} sidebar`,
                    "aria-label": showInspector ? `Hide ${activeName} sidebar` : `Show ${activeName} sidebar`,
                    "aria-pressed": showInspector,
                    style: { flexShrink: 0 },
                  },
                  Icon ? h(Icon, { name: "sidebarRight", size: 16 }) : showInspector ? "Hide sidebar" : "Show sidebar",
                ),
            ),
          ),
          h(
            "div",
            {
              style: {
                flex: 1,
                minWidth: 0,
                minHeight: 0,
                position: "relative",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: showStage ? "#000" : "transparent",
                overflow: "hidden",
              },
            },
            // Dedicated DOM host for noVNC (React never manages children inside stageRef).
            h("div", {
              ref: stageRef,
              style: {
                position: "absolute",
                inset: 0,
                display: showStage ? "block" : "none",
              },
            }),
            view.status === "connecting" &&
              h(
                "div",
                {
                  className: "ui-card",
                  style: {
                    position: "relative",
                    zIndex: 1,
                    padding: "var(--space-3) var(--space-4)",
                    display: "flex",
                    alignItems: "center",
                    gap: "var(--space-2)",
                  },
                },
                h("span", { className: "text-body-sm text-secondary" }, `Connecting to ${activeName}’s desktop…`),
              ),
            !showStage &&
              h(
                "div",
                {
                  style: {
                    maxWidth: "28rem",
                    padding: "var(--space-6)",
                    display: "grid",
                    gap: "var(--space-3)",
                    textAlign: "center",
                    justifyItems: "center",
                  },
                },
                Icon &&
                  h(Icon, {
                    name: "monitor",
                    size: 36,
                    style: { color: "var(--text-subtle)" },
                  }),
                !activePubkey
                  ? h(
                      React.Fragment,
                      null,
                      h("h3", { style: { margin: 0 } }, "No agent desktop selected"),
                      h(
                        Note,
                        null,
                        "Select a self-hosted agent from the list to watch or take over its remote desktop inside Buzz.",
                      ),
                    )
                  : !desktopEnabled
                    ? h(
                        React.Fragment,
                        null,
                        h("h3", { style: { margin: 0 } }, `Desktop is off for ${activeName}`),
                        h(
                          Note,
                          null,
                          `Turn on Desktop to give ${activeName} its own Linux desktop (Xfce and a browser) on your server. Turning it on restarts ${activeName}.`,
                        ),
                        h(
                          Btn,
                          { variant: "prominent", disabled: working, onClick: () => void handleEnableDesktop() },
                          actionBusy === "enable" ? `Enabling for ${activeName}…` : "Turn on Desktop",
                        ),
                      )
                    : h(
                        React.Fragment,
                        null,
                        h("h3", { style: { margin: 0 } }, `${activeName}’s desktop`),
                        h(
                          Note,
                          null,
                          desktopRunning
                            ? "Running on your server. Connect to watch or take over directly inside Buzz."
                            : "Stopped. Opening it starts the desktop on your server.",
                        ),
                        h(
                          "div",
                          { style: { display: "flex", gap: "var(--space-2)", flexWrap: "wrap", justifyContent: "center" } },
                          h(
                            Btn,
                            { variant: "prominent", disabled: working, onClick: () => handleOpen(false) },
                            view.busy === "watch" ? "Opening…" : "Open desktop",
                          ),
                          h(
                            Btn,
                            { variant: "outline", disabled: working, onClick: () => handleOpen(true) },
                            view.busy === "take" ? "Taking over…" : "Take over",
                          ),
                        ),
                      ),
                (actionError || view.error) && h(Note, { tone: "error" }, actionError || view.error),
              ),
          ),
        ),
        showInspector &&
          h(
            "aside",
            {
              "aria-label": `${activeName} details`,
              "data-buzz-viewport-inspector": "",
              style: {
                position: "relative",
                width: "var(--secondary-panel-width, 25rem)",
                minWidth: "18rem",
                maxWidth: "55%",
                flexShrink: 0,
                display: "flex",
                flexDirection: "column",
                minHeight: 0,
                borderInlineStart: "1px solid var(--border-standard)",
                overflow: "hidden",
              },
            },
            split.handle,
            PanelWorkspace
              ? h(PanelWorkspace, {
                  label: `${activeName} details`,
                  value: inspectorTarget,
                  select: () => {},
                  items: [
                    {
                      id: inspectorTarget,
                      label: `${activeName} · Activity`,
                      close: () => setInspectorOpen(false),
                      content: h(inspectorPanel.component, {
                        key: inspectorTarget,
                        target: inspectorTarget,
                        close: () => setInspectorOpen(false),
                      }),
                    },
                  ],
                })
              : h(
                  "div",
                  { style: { flex: 1, minHeight: 0, overflow: "auto" } },
                  h(inspectorPanel.component, {
                    key: inspectorTarget,
                    target: inspectorTarget,
                    close: () => setInspectorOpen(false),
                  }),
                ),
          ),
      ),
    );
  }

  // ----- Desktop, in the agent's Settings / Desktop tab -----
  function DesktopSettings({ ui, agent }) {
    const pubkey = agent.pubkey;
    const name = agent.name || "the agent";
    const viewer = desktopViewer(pubkey);
    const view = React.useSyncExternalStore(viewer.subscribe, viewer.snapshot);
    const [info, setInfo] = React.useState();
    const [busy, setBusy] = React.useState("");
    const [error, setError] = React.useState("");
    const refresh = React.useCallback(
      async (signal) => {
        try {
          setInfo(await client.call("desktop.status", { pubkey }, { signal, timeoutMs: 30000 }));
          setError("");
        } catch (e) {
          if (!signal?.aborted) setError(String(e.message ?? e));
        }
      },
      [pubkey],
    );
    React.useEffect(() => {
      const controller = new AbortController();
      refresh(controller.signal);
      return () => controller.abort();
    }, [refresh]);
    const act = async (label, task) => {
      setBusy(label);
      setError("");
      try {
        await task();
      } catch (e) {
        setError(String(e.message ?? e));
      } finally {
        setBusy("");
      }
    };
    const toggle = () =>
      act("toggle", async () => {
        const enabled = !info.enabled;
        if (!enabled) viewer.disconnect();
        setInfo(await client.call("desktop.set", { pubkey, enabled }, { timeoutMs: 90000 }));
      });
    const stop = () =>
      act("stop", async () => {
        viewer.disconnect();
        await client.call("desktop.stop", { pubkey }, { timeoutMs: 30000 });
        await refresh();
      });

    const on = info?.enabled === true;
    const working = Boolean(busy || view.busy);
    const state = !info
      ? ""
      : info.lease?.holder === "human"
        ? " Someone has taken over."
        : info.running
          ? " Running now."
          : " Stopped; it starts when used.";
    const rows = [
      {
        key: "desktop",
        title: "Desktop",
        subtitle: error
          ? error
          : !info
            ? "Reading from buzz-host…"
            : busy === "toggle"
              ? `Restarting ${name}…`
              : on
                ? `${name} has its own Linux desktop on your server (Xfce and a browser) and uses it through computer tools, never your screen.${state} Turning it off stops it and restarts ${name}.`
                : `Off: ${name} has no computer tools. Turning it on restarts ${name} and adds about 65 tools to its sessions.`,
        trailing: info
          ? h(
              "button",
              {
                type: "button",
                role: "switch",
                "aria-checked": on,
                "aria-label": `Desktop for ${name}`,
                "data-buzz-ui": "",
                className: "buzz-switch-control",
                "data-checked": on ? "" : undefined,
                "data-unchecked": on ? undefined : "",
                "data-disabled": working ? "" : undefined,
                disabled: working,
                onClick: () => void toggle(),
              },
              h("span", { className: "buzz-switch-thumb", "data-checked": on ? "" : undefined }),
            )
          : error
            ? h(ui?.Button ?? "button", { size: "sm", type: "button", onClick: () => refresh() }, "Retry")
            : null,
      },
      on && {
        key: "open",
        title: "Open desktop",
        subtitle: "Opens in the Viewport page inside Buzz. Take over there to use it yourself, for example to sign in to a site for the agent.",
        action: { label: "Open", onClick: () => openDesktop(pubkey) },
      },
      on &&
        info.running && {
          key: "stop",
          title: "Stop desktop",
          subtitle: "Closes its apps and browser. It starts again the next time it's used.",
          action: { label: busy === "stop" ? "Stopping…" : "Stop", onClick: () => void stop() },
        },
    ].filter(Boolean);

    if (ui)
      return h(
        ui.SettingsGroup,
        null,
        ...rows.map((row) =>
          h(ui.PreferenceRow, {
            key: row.key,
            title: row.title,
            subtitle: row.subtitle,
            trailing:
              row.trailing ??
              (row.action && h(ui.Button, { size: "sm", disabled: working, onClick: row.action.onClick }, row.action.label)),
          }),
        ),
      );
    return h(
      "div",
      { style: { display: "grid", gap: "var(--space-2)" } },
      ...rows.map((row) =>
        h(
          "div",
          { key: row.key, style: { display: "flex", gap: "var(--space-3)", alignItems: "center", justifyContent: "space-between" } },
          h("div", { style: { display: "grid", gap: 2, minWidth: 0 } }, h("strong", null, row.title), h(Note, { tone: row.key === "desktop" && error ? "error" : undefined }, row.subtitle)),
          row.trailing ?? (row.action && h("button", { type: "button", disabled: working, onClick: row.action.onClick }, row.action.label)),
        ),
      ),
    );
  }

  // ----- In-chat preview of the agent's desktop -----
  const desktopAgents = (() => {
    let agents = new Set();
    let checkedAt = 0;
    let loading = null;
    const listeners = new Set();
    const load = () => {
      if (loading || Date.now() - checkedAt < 60000) return;
      loading = client
        .call("list", {}, { timeoutMs: 20000 })
        .then((r) => {
          const next = new Set(r.agents.filter((a) => a.desktop).map((a) => a.pubkey));
          checkedAt = Date.now();
          if (next.size !== agents.size || [...next].some((p) => !agents.has(p))) {
            agents = next;
            for (const l of listeners) l();
          }
        })
        .catch(() => (checkedAt = Date.now() - 45000)) // retry in about 15 s
        .finally(() => (loading = null));
    };
    return {
      subscribe(listener) {
        listeners.add(listener);
        load();
        return () => listeners.delete(listener);
      },
      snapshot: () => agents,
    };
  })();
  const stills = new Map(); // turnId -> the last still seen (survives a row remount)
  const turnStarts = new Map(); // turnId -> ms
  const noSubscribe = () => () => {};
  const OFF_VIEW = Object.freeze({ status: "off", mine: false, error: "", busy: "" });

  // Buzz's incoming-message geometry (Messages.module.css, hashed), so the card
  // lines up under the activity bubble; padding if a future Buzz renames it.
  let rowClasses;
  let rowLookedAt = 0;
  function messageRowClasses() {
    if (rowClasses || Date.now() - rowLookedAt < 5000) return rowClasses;
    rowLookedAt = Date.now();
    const modules = new Map();
    const scan = (rules) => {
      for (const rule of rules) {
        for (const [name, local, hash] of rule.selectorText?.matchAll(
          /\._(message|messageGutter|messageBody|messageContent|messageAvatar|messageBubble)_([a-z0-9]+)_\d+/g,
        ) ?? []) {
          const found = modules.get(hash) ?? {};
          found[local] ??= name.slice(1);
          modules.set(hash, found);
        }
        if (rule.cssRules) scan(rule.cssRules);
      }
    };
    for (const sheet of document.styleSheets) {
      try {
        scan(sheet.cssRules);
      } catch {}
    }
    rowClasses = [...modules.values()].find(
      (c) => c.message && c.messageGutter && c.messageBody && c.messageContent && c.messageAvatar && c.messageBubble,
    );
    return rowClasses;
  }
  function PreviewRow({ layout, children }) {
    const c = messageRowClasses();
    if (!c) return h("div", { style: { paddingInlineStart: "3.25rem", paddingBlock: "var(--space-1)" } }, children);
    return h(
      "div",
      { className: c.message, "data-layout": layout ?? "timeline", "data-stack-previous": "true" },
      h("span", { className: c.messageGutter }),
      h(
        "div",
        { className: c.messageBody },
        h(
          "div",
          { className: c.messageContent },
          h("div", { className: c.messageAvatar, "aria-hidden": "true" }),
          h("div", { className: c.messageBubble, style: { background: "none", padding: 0, border: "none", boxShadow: "none" } }, children),
        ),
      ),
    );
  }

  function DesktopPreview(props) {
    const { session, channelId, message } = props;
    const agents = React.useSyncExternalStore(desktopAgents.subscribe, desktopAgents.snapshot);
    const activity = session?.agentActivity;
    const keys = React.useSyncExternalStore(activity?.subscribe ?? noSubscribe, () =>
      previewKeys(activity?.snapshot(), channelId, message?.id, agents),
    );
    if (!keys) return null;
    return h(
      React.Fragment,
      null,
      ...keys.split("\n").map((k) => h(PreviewCard, { key: k.split(" ").slice(0, 2).join(" "), entry: k, session, channelId, layout: props.messageLayout })),
    );
  }

  function PreviewCard({ entry, session, channelId, layout }) {
    const [pubkey, turnId, phase, threadRootId] = entry.split(" ");
    const live = phase === "live";
    // When the turn started: from its activity records, else when first seen here.
    const since = React.useMemo(() => {
      if (!turnStarts.has(turnId)) {
        let at;
        try {
          at = buildTurns(session.agentActivity.snapshot().records, pubkey).find((t) => t.id === turnId)?.at;
        } catch {}
        turnStarts.set(turnId, Number.isFinite(at) ? at - 2000 : Date.now() - 5000);
      }
      return turnStarts.get(turnId);
    }, [turnId, pubkey, session]);
    const [still, setStill] = React.useState(() => stills.get(turnId));
    const [stopping, setStopping] = React.useState(false);
    const [error, setError] = React.useState("");

    React.useEffect(() => {
      if (!live) return undefined;
      let stopped = false;
      let timer;
      const tick = async () => {
        if (stopped) return;
        let wait = 2500;
        if (document.visibilityState !== "hidden") {
          try {
            const prev = stills.get(turnId);
            const r = await client.call(
              "desktop.snapshot",
              { pubkey, width: 480, since, etag: prev?.etag, channelId, threadRootId: threadRootId || undefined },
              { timeoutMs: 15000 },
            );
            if (stopped) return;
            if (r.running && r.lastUse?.at >= since && (r.image || (r.same && prev))) {
              const next = {
                ...prev,
                ...(r.image ? { image: r.image, etag: r.etag, width: r.width, height: r.height } : {}),
                at: r.at,
                lease: r.lease,
              };
              stills.set(turnId, next);
              setStill(next);
              wait = 1500;
            }
          } catch {
            wait = 5000;
          }
        }
        if (!stopped) timer = setTimeout(tick, wait);
      };
      tick();
      return () => {
        stopped = true;
        clearTimeout(timer);
      };
    }, [live, pubkey, turnId, since, channelId, threadRootId]);

    if (!still?.image) return null;
    const humanHas = still.lease?.holder === "human";
    const stop = async () => {
      setStopping(true);
      setError("");
      try {
        await client.call("interrupt", { pubkey, channelId, threadRootId: threadRootId || undefined }, { timeoutMs: 20000 });
      } catch (e) {
        setError(String(e.message ?? e));
      } finally {
        setStopping(false);
      }
    };
    const time = new Date(still.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    return h(
      PreviewRow,
      { layout },
      h(
        "div",
        {
          className: "ui-card",
          "data-buzz-host-preview": live ? "live" : "last",
          style: { display: "grid", gap: "var(--space-2)", padding: "var(--space-2)", width: "fit-content", maxWidth: "100%", minWidth: 0 },
        },
        h(
          "button",
          {
            type: "button",
            onClick: () => openDesktop(pubkey),
            title: "Open in Viewport",
            "aria-label": live ? "Open the agent's live desktop in Viewport" : "Open the agent's desktop in Viewport",
            style: {
              all: "unset",
              boxSizing: "border-box",
              cursor: "pointer",
              display: "block",
              position: "relative",
              width: live ? 320 : 200,
              maxWidth: "100%",
              aspectRatio: `${still.width} / ${still.height}`,
              borderRadius: "var(--radius-md, 8px)",
              overflow: "hidden",
              background: "#000",
            },
          },
          h("img", {
            src: still.image,
            alt: live ? "The agent's screen" : "The agent's screen when it finished",
            draggable: false,
            style: { display: "block", width: "100%", height: "100%", objectFit: "cover" },
          }),
          live &&
            h(
              "span",
              {
                style: {
                  position: "absolute", left: 6, top: 6, display: "inline-flex", gap: 4, alignItems: "center",
                  padding: "1px 6px", borderRadius: 999, background: "rgba(0,0,0,.6)", color: "#fff", fontSize: 11, lineHeight: "16px",
                },
              },
              h("span", { style: { width: 6, height: 6, borderRadius: 999, background: "#e5484d" } }),
              "Live",
            ),
        ),
        h(
          "div",
          { style: { display: "flex", gap: "var(--space-2)", alignItems: "center", flexWrap: "wrap", minWidth: 0 } },
          h("span", { className: "text-body-sm text-secondary", style: { flex: 1, minWidth: 0, whiteSpace: "nowrap" } },
            live ? (humanHas ? "You have control" : "Using its computer") : `Last screen · ${time}`),
          live && !humanHas && h(Btn, { size: "sm", variant: "prominent", onClick: () => openDesktop(pubkey, { take: true }) }, "Take over"),
          live && humanHas && h(Btn, { size: "sm", variant: "outline", onClick: () => openDesktop(pubkey) }, "Open"),
          live && h(Btn, { size: "sm", variant: "ghost", disabled: stopping, onClick: stop, "aria-label": "Stop the agent's turn" }, stopping ? "Stopping…" : "Stop"),
        ),
        error && h(Note, { tone: "error" }, error),
      ),
    );
  }

  return { desktopViewer, openDesktop, ViewportPage, DesktopSettings, DesktopPreview };
}
