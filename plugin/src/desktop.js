// Agent desktop: full-screen noVNC viewer, Settings section, and in-chat preview.
import { storedUrl } from "./config.js";
import { buildTurns } from "./activity.js";
import { novncClient } from "./generated/novnc-client.js";

const XK_ESCAPE = 0xff1b;

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

export function createDesktop({ React, client, ctx, uiKit, Btn }) {
  const { h, Note } = uiKit;

  // ----- Agent desktop: one full-screen live view per agent -----
  // Opened from the in-chat preview or the agent's Settings: a noVNC view in
  // an overlay on document.body (outside every panel, scroll container and
  // transform), owned here rather than by React. After it is placed it is
  // refitted: noVNC rescaled to the overlay and its back buffer drawn again,
  // since WebKitGTK shows a newly placed canvas black until it is drawn.
  // Buzz's webview takes Esc to leave monitor-wide full screen, so the
  // toolbar has an Esc button that sends it to the agent's desktop instead.
  // Closing it closes the view, and buzz-host then hands control back.
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

  function createViewer(pubkey) {
    const screen = document.createElement("div");
    screen.style.cssText = "width:100%;height:100%;min-width:0;min-height:0;overflow:hidden;background:#000";
    let rfb = null;
    let viewerId = "";
    let connecting = null;
    let overlay = null;
    let bar = null;
    let native = false; // the overlay holds the monitor-wide full screen
    let state = { status: "off", mine: false, full: false, error: "", busy: "" };
    const listeners = new Set();
    const set = (patch) => {
      state = { ...state, ...patch };
      for (const l of listeners) l();
      renderBar();
    };

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
      // After the new parent's layout, and again once a full-screen transition settled.
      requestAnimationFrame(() => requestAnimationFrame(() => fit(r)));
      setTimeout(() => fit(r), 450);
    }

    function connect() {
      if (rfb) return Promise.resolve();
      connecting ??= (async () => {
        set({ status: "connecting", error: "" });
        try {
          const v = await client.call("desktop.view", { pubkey }, { timeoutMs: 60000 });
          if (state.status !== "connecting") return; // closed meanwhile
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
              error: e.detail?.clean ? "" : "The desktop view closed (the desktop stopped, another viewer took over, or the connection dropped).",
            });
            if (state.full) exitFull();
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

    function onFullscreenChange() {
      if (!document.fullscreenElement && native) {
        native = false;
        exitFull(); // Esc, F11 or the window manager left full screen
      }
    }
    /** Call from the click itself: monitor-wide full screen needs its user activation. */
    function enterFull({ take = false } = {}) {
      if (!state.full) {
        overlay ??= buildOverlay();
        document.body.appendChild(overlay);
        document.addEventListener("fullscreenchange", onFullscreenChange);
        set({ full: true });
        overlay.firstChild.appendChild(screen);
        refit();
        // If the webview refuses, the overlay still covers the whole Buzz window.
        if (overlay.requestFullscreen && !document.fullscreenElement)
          overlay.requestFullscreen().then(
            () => {
              native = true;
              refit();
            },
            () => (native = false),
          );
      }
      return act(take ? "take" : "watch", async () => {
        await connect();
        if (take && !state.mine) await lease(true);
      });
    }
    function exitFull() {
      if (!state.full) return;
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      if (native && document.fullscreenElement) document.exitFullscreen().catch(() => {});
      native = false;
      overlay?.remove();
      screen.remove();
      set({ full: false });
      disconnect();
    }
    const takeOver = () => act("take", async () => {
      await connect();
      await lease(true);
    });
    const handBack = () => act("back", async () => {
      await lease(false);
      exitFull();
    });

    function buildOverlay() {
      const el = document.createElement("div");
      el.setAttribute("data-buzz-host-desktop", "");
      el.style.cssText = "position:fixed;inset:0;z-index:2147483000;background:#000;display:flex;flex-direction:column";
      const stage = document.createElement("div");
      stage.style.cssText = "flex:1;min-width:0;min-height:0;position:relative";
      bar = document.createElement("div");
      bar.className = "ui-card";
      bar.style.cssText =
        "position:absolute;top:8px;left:50%;transform:translateX(-50%);z-index:1;display:flex;gap:8px;align-items:center;" +
        "padding:4px 8px;max-width:calc(100% - 16px);opacity:.35;transition:opacity 150ms;box-shadow:0 2px 12px rgba(0,0,0,.5)";
      bar.addEventListener("mouseenter", () => (bar.style.opacity = "1"));
      bar.addEventListener("mouseleave", () => (bar.style.opacity = ".35"));
      el.append(stage, bar);
      return el;
    }
    // Buzz's Button markup (its stylesheet is global), as plain DOM: the
    // overlay lives on document.body, outside React.
    function barButton(label, variant, onClick, key, title) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "buzz-button";
      b.setAttribute("data-buzz-ui", "");
      b.setAttribute("data-variant", variant);
      b.setAttribute("data-size", "sm");
      b.setAttribute("data-button-shape", "capsule");
      if (title) b.title = title;
      if (state.busy) {
        b.disabled = true;
        b.setAttribute("data-disabled", "");
      }
      const text = document.createElement("span");
      text.className = "buzz-button-label";
      text.textContent = state.busy === key ? "…" : label;
      b.append(text);
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        onClick();
      });
      return b;
    }
    function renderBar() {
      if (!bar || !state.full) return;
      const label = document.createElement("span");
      label.className = state.error ? "text-body-sm text-danger" : "text-body-sm text-secondary";
      label.style.cssText = "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0";
      label.textContent = state.error || (state.status !== "live" ? "Connecting…" : state.mine ? "You have control" : "Watching");
      const parts = [label];
      if (state.status === "live") {
        if (state.mine) {
          parts.push(barButton("Hand back", "outline", handBack, "back"));
          parts.push(
            barButton("Esc", "ghost", () => rfb?.sendKey(XK_ESCAPE, "Escape"), "esc", "Send Esc to the agent's desktop (your Esc key leaves full screen)"),
          );
        } else parts.push(barButton("Take over", "prominent", takeOver, "take"));
      }
      parts.push(barButton("Exit full screen", "ghost", exitFull, "exit"));
      bar.replaceChildren(...parts);
    }

    return {
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      snapshot: () => state,
      connect: () => act("watch", connect),
      disconnect,
      enterFull,
      exitFull,
      takeOver: () => enterFull({ take: true }),
      handBack,
      dispose() {
        exitFull();
        disconnect();
        listeners.clear();
      },
    };
  }

  // ----- Desktop, in the agent's Settings -----
  // The agent's own desktop on the server (buzz-host desktop/): its computer
  // tools drive it, and the in-chat preview shows it while a turn uses them.
  // Here: turn it on or off (that restarts the agent), open it full screen
  // (watch, or take over, for example to sign in to a site for the agent),
  // and stop it. With `ui` (Buzz's agentUi) as Buzz's own setting rows.
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
    // Also after full screen closes: opening it may have started the desktop.
    React.useEffect(() => {
      if (view.full) return undefined;
      const controller = new AbortController();
      refresh(controller.signal);
      return () => controller.abort();
    }, [refresh, view.full]);
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
        if (!enabled) viewer.exitFull();
        setInfo(await client.call("desktop.set", { pubkey, enabled }, { timeoutMs: 90000 }));
      });
    const stop = () =>
      act("stop", async () => {
        viewer.exitFull();
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
        subtitle: "Full screen. Take over there to use it yourself, for example to sign in to a site for the agent.",
        // Synchronous in the click: monitor-wide full screen needs its user activation.
        action: { label: view.busy === "watch" || view.busy === "take" ? "Opening…" : "Open", onClick: () => void viewer.enterFull() },
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
  // A card under the activity bubble of a request a remote agent is working
  // on, once that turn uses its computer tools. buzz-host records each
  // computer-tool call; the turn, its chat and its request come from Buzz's
  // own activity, so the card shows only where the agent is working. It shows
  // a small still of the agent's screen every ~1.5 s, sent by buzz-host to this
  // Buzz over Tailscale and never through the relay. Click: full screen,
  // watching. Take over: full screen with control. Stop: stops that turn, as
  // Buzz's own Stop does. When the turn ends it stays as the last screen seen.
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
    const viewer = desktopViewer(pubkey);
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
            onClick: () => viewer.enterFull(),
            title: "Watch full screen",
            "aria-label": live ? "Watch the agent's screen full screen" : "Open the agent's screen full screen",
            style: {
              all: "unset",
              boxSizing: "border-box",
              cursor: "zoom-in",
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
          live && !humanHas && h(Btn, { size: "sm", variant: "prominent", onClick: () => viewer.takeOver() }, "Take over"),
          live && humanHas && h(Btn, { size: "sm", variant: "outline", onClick: () => viewer.enterFull() }, "Open"),
          live && h(Btn, { size: "sm", variant: "ghost", disabled: stopping, onClick: stop, "aria-label": "Stop the agent's turn" }, stopping ? "Stopping…" : "Stop"),
        ),
        error && h(Note, { tone: "error" }, error),
      ),
    );
  }

  return { desktopViewer, DesktopSettings, DesktopPreview };
}
