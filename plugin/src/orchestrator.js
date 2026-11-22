// Orchestrator section in Settings (Solo-chat workers).

export const ORCH_LIVE_STATUSES = new Set(["queued", "starting", "running"]);

export function createOrchestrator({ React, client, uiKit }) {
  const { h, Note } = uiKit;

  function OrchestratorSettings({ ui, agent }) {
    const pubkey = agent.pubkey;
    const name = agent.name || "the agent";
    const [info, setInfo] = React.useState();
    const [busy, setBusy] = React.useState("");
    const [error, setError] = React.useState("");
    const refresh = React.useCallback(
      async (signal) => {
        try {
          setInfo(await client.call("orchestrator.tasks", { pubkey }, { signal, timeoutMs: 30000 }));
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
        await client.call("orchestrator.set", { pubkey, enabled }, { timeoutMs: 90000 });
        await refresh();
      });
    const stopAll = () =>
      act("stop", async () => {
        const live = (info?.tasks ?? []).filter((t) => ORCH_LIVE_STATUSES.has(t.status));
        await Promise.all(live.map((t) => client.call("orchestrator.cancel", { pubkey, taskId: t.taskId }, { timeoutMs: 20000 })));
        await refresh();
      });

    const on = info?.enabled === true;
    const tasks = info?.tasks ?? [];
    const liveCount = tasks.filter((t) => ORCH_LIVE_STATUSES.has(t.status)).length;
    const working = Boolean(busy);
    const state = !info
      ? ""
      : liveCount > 0
        ? ` ${liveCount} worker${liveCount === 1 ? "" : "s"} active now.`
        : tasks.length > 0
          ? ` ${tasks.length} recent task${tasks.length === 1 ? "" : "s"}.`
          : " No worker tasks yet.";

    const rows = [
      {
        key: "orchestrator",
        title: "Orchestrator",
        subtitle: error
          ? error
          : !info
            ? "Reading from buzz-host…"
            : busy === "toggle"
              ? `Restarting ${name}…`
              : on
                ? `${name} delegates tasks as real Solo chats (on itself or any Omarchy agent) across Claude, Codex, Hermes, and Antigravity.${state} Turning it off restarts ${name}.`
                : `Off: ${name} has no orchestration tools. Turning it on restarts ${name} and adds 7 orch_* tools to its sessions.`,
        trailing: info
          ? h(
              "button",
              {
                type: "button",
                role: "switch",
                "aria-checked": on,
                "aria-label": `Orchestrator for ${name}`,
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
      liveCount > 0 && {
        key: "stop-workers",
        title: "Stop active workers",
        subtitle: `Cancels all ${liveCount} running or queued worker task${liveCount === 1 ? "" : "s"} for ${name}.`,
        action: { label: busy === "stop" ? "Stopping…" : "Stop all", onClick: () => void stopAll() },
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
          h(
            "div",
            { style: { display: "grid", gap: 2, minWidth: 0 } },
            h("strong", null, row.title),
            h(Note, { tone: row.key === "orchestrator" && error ? "error" : undefined }, row.subtitle),
          ),
          row.trailing ?? (row.action && h("button", { type: "button", disabled: working, onClick: row.action.onClick }, row.action.label)),
        ),
      ),
    );
  }

  return { OrchestratorSettings };
}
