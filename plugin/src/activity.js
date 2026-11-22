// Activity tab: turns rebuilt from the agent's observer frames.
// buzz-acp (BUZZ_ACP_RELAY_OBSERVER) publishes each turn's ACP traffic to the
// owner, encrypted; Buzz decrypts it into session.agentActivity records:
// { agent, createdAt, plaintext: {kind, channelId, sessionId, turnId, timestamp, payload} }.

export function parseFrame(record) {
  try {
    const f = JSON.parse(record.plaintext);
    return f && typeof f === "object" ? f : undefined;
  } catch {
    return undefined;
  }
}

export function promptRequest(text) {
  // The last <buzz-event>'s Content, as buzz-acp frames a turn's messages.
  const contents = [...text.matchAll(/^Content: ([\s\S]*?)\nTags: /gm)].map((m) => m[1]);
  if (contents.length) return contents[contents.length - 1].trim();
  return text.trim().split("\n").slice(-3).join("\n");
}

export function buildTurns(records, agent) {
  const turns = new Map();
  for (const record of records) {
    if (record.agent !== agent) continue;
    const f = parseFrame(record);
    if (!f?.turnId) continue;
    let t = turns.get(f.turnId);
    if (!t) {
      t = { id: f.turnId, channelId: f.channelId, at: Date.parse(f.startedAt || f.timestamp) || record.createdAt * 1000,
            request: "", reply: "", tools: new Map(), outcome: undefined, ended: false, promptIds: new Set() };
      turns.set(f.turnId, t);
    }
    t.channelId ||= f.channelId;
    const m = f.payload;
    if (f.kind === "turn_completed") t.ended = true;
    if (f.kind === "turn_error" || f.kind === "agent_panic") { t.ended = true; t.outcome = "error"; }
    if (!m || typeof m !== "object") continue;
    if (f.kind === "acp_write" && m.method === "session/prompt") {
      const text = (m.params?.prompt ?? []).map((b) => b?.text ?? "").join("\n");
      t.request = promptRequest(text) || t.request;
      if (m.id !== undefined) t.promptIds.add(m.id);
    } else if (f.kind === "acp_read" && m.method === "session/update") {
      const u = m.params?.update ?? {};
      if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") t.reply += u.content.text ?? "";
      else if (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") {
        const prev = t.tools.get(u.toolCallId) ?? { title: "", status: "pending", kind: "" };
        t.tools.set(u.toolCallId, {
          title: u.title || prev.title || u.kind || "tool",
          status: u.status || prev.status,
          kind: u.kind || prev.kind,
        });
      }
    } else if (f.kind === "acp_read" && m.id !== undefined && !m.method && t.promptIds.has(m.id)) {
      t.outcome = m.error ? "error" : m.result?.stopReason ?? t.outcome;
    }
  }
  return [...turns.values()].sort((a, b) => b.at - a.at);
}

export const OUTCOME = { end_turn: "done", cancelled: "stopped", max_tokens: "hit token limit", refusal: "refused", error: "failed" };

export function createActivity({ React, ctx, uiKit, relay = ctx.reflect?.get?.("relay") }) {
  const { h, Note } = uiKit;

  function useActivity() {
    const snap = React.useSyncExternalStore(
      relay?.subscribe ?? (() => () => {}),
      relay?.snapshot ?? (() => undefined),
    );
    const activity = snap?.session?.agentActivity;
    const data = React.useSyncExternalStore(
      activity?.subscribe ?? (() => () => {}),
      activity?.snapshot ?? (() => undefined),
    );
    return { status: snap?.status, data };
  }

  // Buzz's own Activity panel (the one Builderlab's hosted agents get), from
  // the local Buzz patch 0002-published-activity; this plugin's view otherwise.
  function ActivityTab(props) {
    let Published;
    try {
      Published = ctx.reflect.get("publishedActivity")?.component;
    } catch {}
    return typeof Published === "function" ? h(Published, props) : h(OwnActivityTab, props);
  }

  function OwnActivityTab({ agent, conversation, openConversation }) {
    const [all, setAll] = React.useState(false);
    const [open, setOpen] = React.useState(() => new Set());
    const { status, data } = useActivity();
    const turns = React.useMemo(
      () => (data?.records ? buildTurns(data.records, agent.pubkey) : []),
      [data?.records, agent.pubkey],
    );
    if (!relay) return h(Note, null, "Activity isn't available in this version of Buzz.");
    if (status !== "ready" || !data) return h(Note, null, "Activity shows once Buzz is connected.");
    if (data.status === "unavailable" || data.status === "disabled")
      return h(Note, null, "This community doesn't deliver agent activity here.");
    const here = !all && conversation ? turns.filter((t) => t.channelId === conversation.channelId) : turns;
    const fmt = (ms) => new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    return h(
      "div",
      { style: { display: "grid", gap: "var(--space-3)" } },
      h(Note, null,
        "Turns this agent published to you since Buzz connected (the relay doesn't keep older activity)." +
          (data.trimmed ? ` ${data.trimmed} older records were dropped.` : "")),
      conversation &&
        h("label", { style: { display: "flex", gap: "var(--space-2)", alignItems: "center" } },
          h("input", { type: "checkbox", checked: all, onChange: (e) => setAll(e.target.checked) }),
          "All conversations"),
      here.length === 0 && h(Note, null, conversation && !all ? "No activity in this conversation yet." : "No activity yet."),
      ...here.slice(0, 50).map((t) => {
        const expanded = open.has(t.id);
        const tools = [...t.tools.values()];
        const state = t.outcome ? OUTCOME[t.outcome] ?? t.outcome : t.ended ? "ended" : "working…";
        return h(
          "section",
          { key: t.id, className: "ui-card", style: { padding: "var(--space-2) var(--space-3)", display: "grid", gap: "var(--space-1)" } },
          h("div", { style: { display: "flex", gap: "var(--space-2)", alignItems: "baseline", flexWrap: "wrap" } },
            h("strong", null, fmt(t.at)),
            h("span", { className: "text-secondary" }, state),
            tools.length > 0 && h("span", { className: "text-secondary" }, `· ${tools.length} tool call${tools.length === 1 ? "" : "s"}`),
            openConversation && t.channelId &&
              h("button", { type: "button", style: { marginLeft: "auto" }, onClick: () => openConversation(t.channelId) }, "Open chat"),
          ),
          t.request && h("div", { style: { whiteSpace: "pre-wrap" } }, h("span", { className: "text-secondary" }, "Asked: "), t.request.slice(0, 400)),
          h("button", {
            type: "button",
            style: { justifySelf: "start" },
            onClick: () => setOpen((prev) => {
              const next = new Set(prev);
              next.has(t.id) ? next.delete(t.id) : next.add(t.id);
              return next;
            }),
          }, expanded ? "Hide steps" : "Show steps"),
          expanded && h("ol", { style: { margin: 0, paddingLeft: "1.25em", display: "grid", gap: 2 } },
            ...tools.map((tool, i) => h("li", { key: i },
              tool.title, " ", h("span", { className: "text-secondary" }, `(${tool.status})`))),
            tools.length === 0 && h("li", { className: "text-secondary" }, "No tool calls"),
          ),
          expanded && t.reply && h("div", { style: { whiteSpace: "pre-wrap", borderTop: "1px solid var(--border-standard)", paddingTop: "var(--space-1)" } },
            h("span", { className: "text-secondary" }, "Agent's text: "), t.reply.slice(0, 2000)),
        );
      }),
    );
  }

  return { ActivityTab, OwnActivityTab, useActivity };
}
