// Omarchy agents: a Buzz remote agent type backed by buzz-host.
//
// Buzz calls provision → activate (with the owner's NIP-OA attestation) and
// later profile / instructions / remove. buzz-host, on the server, keeps each
// agent's key and runs it with buzz-acp, so agents answer while this computer
// is closed. Transport is JSON over wss:// (tailscale serve), the only
// non-Buzz network scheme the app's CSP allows.

export const inject = ["react", "agents", "settingsCards", "conversation"];

const URL_KEY = "local.buzz-host.url";
const DEFAULT_URL = "wss://omarchy.tail65c5a9.ts.net:8447";
const RUNTIMES = [
  { id: "claude", title: "Claude Code" },
  { id: "codex", title: "Codex" },
  { id: "hermes", title: "Hermes" },
  { id: "antigravity", title: "Antigravity" },
];
const EMPTY = { runtime: "claude", model: "", instructions: "", profile: "" };

function storedUrl() {
  try {
    return localStorage.getItem(URL_KEY) || DEFAULT_URL;
  } catch {
    return DEFAULT_URL;
  }
}

// ---------- RPC client: one socket, reopened on demand ----------

function createClient() {
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

// ---------- small UI kit on host tokens ----------

function ui(React) {
  const h = React.createElement;
  const control = {
    font: "inherit",
    color: "var(--text-standard)",
    background: "var(--surface-inset)",
    border: "1px solid var(--border-standard)",
    borderRadius: "var(--radius-control)",
    padding: "var(--space-1) var(--space-2)",
    minWidth: 0,
  };
  const Row = ({ label, hint, children }) =>
    h(
      "label",
      { style: { display: "grid", gap: "var(--space-1)" } },
      h("span", { style: { fontWeight: 600 } }, label),
      children,
      hint && h("span", { className: "text-body-sm text-secondary" }, hint),
    );
  const Select = ({ value, onChange, options, disabled }) =>
    h(
      "select",
      { value, disabled, style: control, onChange: (e) => onChange(e.target.value) },
      options.map((o) => h("option", { key: o.value, value: o.value }, o.label)),
    );
  const Text = (props) => h("input", { ...props, style: { ...control, ...props.style } });
  const Area = (props) =>
    h("textarea", {
      rows: 8,
      ...props,
      style: { ...control, resize: "vertical", fontFamily: "inherit", ...props.style },
    });
  const Note = ({ tone, children }) =>
    h(
      "p",
      {
        role: tone === "error" ? "alert" : undefined,
        className: "m-0 text-body-sm " + (tone === "error" ? "text-danger" : "text-secondary"),
        style: { margin: 0, whiteSpace: "pre-wrap" },
      },
      children,
    );
  return { h, Row, Select, Text, Area, Note, control };
}

// Model choices for a runtime (for Hermes, its profile's): loaded from
// buzz-host, free text as fallback.
function useModels(React, client, runtime, profile = "") {
  const key = `${runtime}\n${runtime === "hermes" ? profile : ""}`;
  const [state, setState] = React.useState({ key, models: undefined, error: "" });
  React.useEffect(() => {
    const controller = new AbortController();
    setState({ key, models: undefined, error: "" });
    client
      .call("models", { runtime, profile: runtime === "hermes" ? profile : "" }, { signal: controller.signal, timeoutMs: 60000 })
      .then(
        (r) => !controller.signal.aborted && setState({ key, models: r.models, error: "" }),
        (e) =>
          !controller.signal.aborted &&
          setState({ key, models: [], error: String(e.message ?? e) }),
      );
    return () => controller.abort();
  }, [client, key]);
  return state.key === key ? state : { key, models: undefined, error: "" };
}

// The server's Hermes profiles, from `hermes profile list`.
function useProfiles(React, client, enabled) {
  const [state, setState] = React.useState({ profiles: undefined, error: "" });
  React.useEffect(() => {
    if (!enabled) return undefined;
    const controller = new AbortController();
    client.call("hermes.profiles", {}, { signal: controller.signal, timeoutMs: 60000 }).then(
      (r) => !controller.signal.aborted && setState({ profiles: r.profiles, error: "" }),
      (e) => !controller.signal.aborted && setState({ profiles: [], error: String(e.message ?? e) }),
    );
    return () => controller.abort();
  }, [client, enabled]);
  return state;
}

/** Buzz's Hermes plugin's profile field: the default profile, then the others. */
function ProfileField({ React, client, value, onChange, disabled }) {
  const { h, Select, Note } = ui(React);
  const { profiles, error } = useProfiles(React, client, true);
  const rows = (profiles ?? []).filter((row) => row.name !== "default");
  const main = profiles?.find((row) => row.name === "default");
  const label = (row, name) => (row?.model ? `${name} (${row.model})` : name);
  const options = [{ value: "", label: label(main, "Default profile") }].concat(
    rows.map((row) => ({ value: row.name, label: label(row, row.name) })),
  );
  if (value && !rows.some((row) => row.name === value))
    options.push({ value, label: profiles ? `${value} (not on the server)` : value });
  return h(
    "div",
    { style: { display: "grid", gap: "var(--space-1)" } },
    h(Select, { value: value || "", disabled: disabled || profiles === undefined, options, onChange }),
    error && h(Note, null, `Profile list unavailable: ${error}`),
  );
}
const PROFILE_HINT = "Which Hermes home runs this agent: its config, memory, skills and provider.";

// Hermes ids name their provider: "nous:anthropic/claude-opus-5.5",
// "opencode-go:deepseek-v4.1-flash", "custom:<name>:<model>".
function providerOf(id) {
  const parts = id.split(":");
  if (parts.length < 2) return undefined;
  return parts[0] === "custom" && parts.length > 2 ? `${parts[0]}:${parts[1]}` : parts[0];
}
function groupByProvider(models) {
  if (!models?.length || models.filter((m) => providerOf(m.id)).length < models.length * 0.8) return undefined;
  const groups = new Map();
  for (const m of models) {
    const key = providerOf(m.id) ?? "other";
    const [label, rest] = m.name && m.name.includes(" · ") ? m.name.split(" · ", 2) : [key, undefined];
    if (!groups.has(key)) groups.set(key, { key, label, models: [] });
    groups.get(key).models.push({ id: m.id, label: rest ?? m.id.slice(key.length + 1) });
  }
  return [...groups.values()].sort((x, y) => x.label.localeCompare(y.label));
}

function ModelField({ React, client, runtime, profile, value, onChange, disabled }) {
  const { h, Select, Text, Note } = ui(React);
  const { models, error } = useModels(React, client, runtime, profile);
  const [typing, setTyping] = React.useState(false);
  const [providerPick, setProviderPick] = React.useState("");
  React.useEffect(() => {
    setTyping(false);
    setProviderPick("");
  }, [runtime, profile]);
  const known = models?.length ? models : undefined;
  const listed = !value || known?.some((m) => m.id === value);
  const pick = known && !typing && listed;
  const groups = pick ? groupByProvider(known) : undefined;
  const provider = (value && providerOf(value)) || providerPick;
  const group = groups?.find((g) => g.key === provider);
  const input = h(Text, {
    value,
    disabled,
    placeholder:
      models === undefined ? "Loading models… (blank = runtime default)" : "Model id (blank = runtime default)",
    onChange: (e) => onChange(e.target.value),
  });
  let body;
  if (!pick) body = input;
  else if (groups)
    body = h(
      "div",
      { style: { display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 2fr)", gap: "var(--space-2)" } },
      h(Select, {
        value: provider,
        disabled,
        onChange: (next) => {
          if (next === "__custom") return setTyping(true);
          setProviderPick(next);
          if (next !== providerOf(value || "")) onChange("");
        },
        options: [
          { value: "", label: "Provider: runtime default" },
          ...groups.map((g) => ({ value: g.key, label: `${g.label} (${g.models.length})` })),
          { value: "__custom", label: "Other model id…" },
        ],
      }),
      h(Select, {
        value: value || "",
        disabled: disabled || !group,
        onChange,
        options: group
          ? [{ value: "", label: "Choose a model" }, ...group.models.map((m) => ({ value: m.id, label: m.label }))]
          : [{ value: "", label: value ? value : "Runtime default" }],
      }),
    );
  else
    body = h(Select, {
      value: value || "",
      disabled,
      onChange: (next) => (next === "__custom" ? setTyping(true) : onChange(next)),
      options: [
        { value: "", label: "Runtime default" },
        ...known.map((m) => ({ value: m.id, label: m.name === m.id ? m.id : `${m.name} (${m.id})` })),
        { value: "__custom", label: "Other…" },
      ],
    });
  return h(
    "div",
    { style: { display: "grid", gap: "var(--space-1)" } },
    body,
    error && h(Note, null, `Model list unavailable: ${error}`),
  );
}

// ---------- Activity: turns rebuilt from the agent's observer frames ----------
// buzz-acp (BUZZ_ACP_RELAY_OBSERVER) publishes each turn's ACP traffic to the
// owner, encrypted; Buzz decrypts it into session.agentActivity records:
// { agent, createdAt, plaintext: {kind, channelId, sessionId, turnId, timestamp, payload} }.
function parseFrame(record) {
  try {
    const f = JSON.parse(record.plaintext);
    return f && typeof f === "object" ? f : undefined;
  } catch {
    return undefined;
  }
}
function promptRequest(text) {
  // The last <buzz-event>'s Content, as buzz-acp frames a turn's messages.
  const contents = [...text.matchAll(/^Content: ([\s\S]*?)\nTags: /gm)].map((m) => m[1]);
  if (contents.length) return contents[contents.length - 1].trim();
  return text.trim().split("\n").slice(-3).join("\n");
}
function buildTurns(records, agent) {
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
const OUTCOME = { end_turn: "done", cancelled: "stopped", max_tokens: "hit token limit", refusal: "refused", error: "failed" };

export function apply(ctx) {
  const React = ctx.react;
  const { h, Row, Select, Area, Note, Text, control } = ui(React);
  const client = createClient();
  ctx.effect(() => () => client.close());

  const runtimeOptions = RUNTIMES.map((r) => ({ value: r.id, label: r.title }));
  const asConfig = (value) => ({ ...EMPTY, ...(value && typeof value === "object" ? value : {}) });

  // ----- Buzz's own controls -----
  // Local Buzz patch 0004-agent-ui-for-plugins provides Buzz's setting
  // components as ctx.reflect.get("agentUi"); without it, this plugin's own.
  const agentUi = () => {
    try {
      const value = ctx.reflect?.get?.("agentUi");
      return value?.version === 1 ? value : undefined;
    } catch {
      return undefined;
    }
  };
  const one = (options) => [{ label: "", options }];

  /** buzz-host's models as ModelPicker choices: Hermes ids grouped by provider. */
  function modelChoices(models) {
    const groups = groupByProvider(models);
    if (groups)
      return {
        byFamily: true,
        models: groups.flatMap((g) => g.models.map((m) => ({ id: m.id, label: m.label, family: g.label }))),
      };
    // The runtime's own "default" entry is the picker's Runtime default.
    return {
      byFamily: false,
      models: (models ?? []).filter((m) => m.id !== "default").map((m) => ({ id: m.id, label: m.name || m.id })),
    };
  }

  function profileOptions(profiles, value) {
    const rows = (profiles ?? []).filter((row) => row.name !== "default");
    const main = profiles?.find((row) => row.name === "default");
    const options = [
      { value: "", label: "Default profile", ...(main?.model ? { description: main.model } : {}) },
      ...rows.map((row) => ({ value: row.name, label: row.name, ...(row.model ? { description: row.model } : {}) })),
    ];
    if (value && !rows.some((row) => row.name === value))
      options.push({ value, label: value, description: profiles ? "Not on the server" : undefined });
    return options;
  }

  /** Runtime, Hermes profile and Model rows, for a SettingsGroup. */
  function RuntimeRows({ ui, draft, onChange, disabled }) {
    const { models, error } = useModels(React, client, draft.runtime, draft.profile);
    const hermes = draft.runtime === "hermes";
    const { profiles, error: profileError } = useProfiles(React, client, hermes);
    const choice = modelChoices(models);
    return h(
      React.Fragment,
      null,
      h(ui.Select, {
        label: "Runtime",
        variant: "preference",
        value: draft.runtime,
        disabled,
        groups: one(RUNTIMES.map((r) => ({ value: r.id, label: r.title }))),
        onValueChange: (runtime) => onChange({ ...draft, runtime, model: "", profile: "" }),
      }),
      hermes &&
        h(ui.Select, {
          label: "Hermes profile",
          variant: "preference",
          value: draft.profile || "",
          disabled: disabled || profiles === undefined,
          ...(profileError ? { description: `Profile list unavailable: ${profileError}` } : {}),
          groups: one(profileOptions(profiles, draft.profile)),
          onValueChange: (profile) => onChange({ ...draft, profile }),
        }),
      h(ui.ModelPicker, {
        label: "Model",
        models: choice.models,
        groupByFamily: choice.byFamily,
        value: draft.model,
        allowCustomModel: true,
        defaultLabel: "Runtime default",
        defaultDescription: "The model this runtime uses on the server",
        loading: models === undefined,
        disabled,
        ...(error ? { description: `Model list unavailable: ${error}` } : {}),
        onChange: (model) => onChange({ ...draft, model }),
      }),
    );
  }

  /** What an agent runs with, read from buzz-host. */
  function useRunsWith(pubkey) {
    const [state, setState] = React.useState({ text: "Reading…" });
    React.useEffect(() => {
      const controller = new AbortController();
      client.call("settings.get", { pubkey }, { signal: controller.signal }).then(
        (s) => {
          if (controller.signal.aborted) return;
          const runtime = RUNTIMES.find((r) => r.id === s.runtime)?.title ?? s.runtime;
          const text = [runtime, s.profile && `profile ${s.profile}`, s.model || "runtime default"].filter(Boolean).join(" · ");
          setState({ text });
        },
        (e) => !controller.signal.aborted && setState({ text: String(e.message ?? e) }),
      );
      return () => controller.abort();
    }, [pubkey]);
    return state.text;
  }

  // ----- creation fields -----
  // New agent: Buzz's Harness row with Runtime, Hermes profile and Model rows
  // (CreateConfiguration), then Instructions (Create), as Buzz's hosted types
  // lay them out. In Buzz's review of an agent's proposed edit (local Buzz
  // patch 0003), only the name and, when proposed, the instructions change,
  // so the rest shows as it is.
  function CreateConfiguration({ agent, config, onChange, disabled, harnessControl, onReadyChange }) {
    React.useEffect(() => onReadyChange?.(true), [onReadyChange]);
    const ui = agentUi();
    if (agent) return h(RunsWith, { ui, agent, harnessControl });
    const draft = asConfig(config);
    if (!ui)
      return h(
        "div",
        { style: { display: "grid", gap: "var(--space-3)" } },
        harnessControl,
        h(CreateFields, { config, onChange, disabled, part: "runtime" }),
      );
    return h(
      "div",
      { className: "grid gap-2" },
      h(ui.SettingsGroup, null, harnessControl, h(RuntimeRows, { ui, draft, onChange, disabled })),
      h("p", { className: "m-0 text-body-sm text-secondary" }, "Runs on your server with buzz-acp and uses that machine's sign-ins."),
    );
  }

  function RunsWith({ ui, agent, harnessControl }) {
    const text = useRunsWith(agent.pubkey);
    const hint = "Unchanged by this review; change it in the agent's Settings tab.";
    if (!ui)
      return h("div", { style: { display: "grid", gap: "var(--space-3)" } }, harnessControl, h(Row, { label: "Runs with", hint }, h(Note, null, text)));
    return h(
      ui.SettingsGroup,
      null,
      harnessControl,
      h(ui.PreferenceRow, {
        title: "Runs with",
        subtitle: hint,
        trailing: h("span", { className: "text-body-sm text-secondary" }, text),
      }),
    );
  }

  function Create({ agent, proposal, config, onChange, disabled }) {
    const ui = agentUi();
    const draft = asConfig(config);
    const set = (instructions) => onChange({ ...draft, instructions });
    if (agent && proposal) {
      if (proposal.instructions === undefined)
        return ui
          ? h(ui.SettingsGroup, null, h(ui.PreferenceRow, { title: "Instructions", subtitle: "Unchanged by this proposal." }))
          : h(Row, { label: "Instructions" }, h(Note, null, "Unchanged by this proposal."));
      return ui
        ? h(ui.AgentInstructions, {
            value: draft.instructions,
            disabled,
            description: "Proposed; edit before saving if you like.",
            onChange: set,
          })
        : h(
            Row,
            { label: "Instructions", hint: "Proposed; edit before saving if you like." },
            h(Area, { value: draft.instructions, disabled, placeholder: "No instructions", onChange: (e) => set(e.target.value) }),
          );
    }
    if (agent) return null;
    return ui
      ? h(ui.AgentInstructions, { creation: true, value: draft.instructions, disabled, onChange: set })
      : h(CreateFields, { config, onChange, disabled, part: "instructions" });
  }

  /** This plugin's own fields, for a Buzz without agentUi. */
  function CreateFields({ config, onChange, disabled, part }) {
    const draft = asConfig(config);
    const change = (patch) => onChange({ ...draft, ...patch });
    if (part === "instructions")
      return h(
        Row,
        { label: "Instructions" },
        h(Area, {
          value: draft.instructions,
          disabled,
          placeholder: "What should this agent do?",
          onChange: (e) => change({ instructions: e.target.value }),
        }),
      );
    return h(
      "div",
      { style: { display: "grid", gap: "var(--space-3)" } },
      h(
        Row,
        { label: "Runtime", hint: "Runs on the server with buzz-acp; uses that machine's sign-ins." },
        h(Select, {
          value: draft.runtime,
          disabled,
          options: runtimeOptions,
          onChange: (runtime) => change({ runtime, model: "", profile: "" }),
        }),
      ),
      draft.runtime === "hermes" &&
        h(
          Row,
          { label: "Hermes profile", hint: PROFILE_HINT },
          h(ProfileField, { React, client, value: draft.profile, disabled, onChange: (profile) => change({ profile }) }),
        ),
      h(
        Row,
        { label: "Model" },
        h(ModelField, {
          React,
          client,
          runtime: draft.runtime,
          profile: draft.profile,
          value: draft.model,
          disabled,
          onChange: (model) => change({ model }),
        }),
      ),
    );
  }

  // ----- settings tab for an existing agent -----
  // Buzz splits a type's settings tab (splitSettings) into Identity (runtime,
  // model and instructions, as Buzz's harnesses show them) and Settings (the
  // server, restart, logs and the agent's details).
  function SettingsTab(props) {
    const ui = agentUi();
    return ui ? h(NativeSettings, { ...props, ui }) : h(OwnSettings, props);
  }

  /** The agent's saved settings and instructions on buzz-host. */
  function useHosted(pubkey) {
    const [loaded, setLoaded] = React.useState();
    const [error, setError] = React.useState("");
    const [revision, setRevision] = React.useState(0);
    React.useEffect(() => {
      const controller = new AbortController();
      const { signal } = controller;
      setError("");
      Promise.all([
        client.call("settings.get", { pubkey }, { signal }),
        client.call("instructions.get", { pubkey }, { signal }),
      ]).then(
        ([s, i]) =>
          !signal.aborted &&
          setLoaded({ runtime: s.runtime, model: s.model ?? "", profile: s.profile ?? "", instructions: i.instructions, status: s.status }),
        (e) => !signal.aborted && setError(String(e.message ?? e)),
      );
      return () => controller.abort();
    }, [pubkey, revision]);
    return { loaded, setLoaded, error, retry: () => setRevision((r) => r + 1) };
  }

  function NativeSettings({ ui, agent, settingsSection, settingsContent, settingsHost }) {
    const pubkey = agent.pubkey;
    const form = React.useId();
    const { loaded, setLoaded, error: loadError, retry } = useHosted(pubkey);
    const [draft, setDraft] = React.useState();
    const [busy, setBusy] = React.useState("");
    const [error, setError] = React.useState("");
    const [notice, setNotice] = React.useState("");
    const [logs, setLogs] = React.useState();
    React.useEffect(() => setDraft(loaded), [loaded]);
    const runtimeSide = settingsSection === "runtime";
    const act = async (label, task) => {
      setBusy(label);
      setError("");
      setNotice("");
      try {
        await task();
      } catch (e) {
        setError(String(e.message ?? e));
      } finally {
        setBusy("");
      }
    };
    const messages = h(
      React.Fragment,
      null,
      (error || loadError) && h("p", { role: "alert", className: "buzz-field-error" }, error || loadError),
      notice && h("p", { role: "status", className: "m-0 text-body-sm text-secondary" }, notice),
    );
    if (!draft || !loaded)
      return h(
        "div",
        { className: "grid gap-4" },
        loadError
          ? h("div", { className: "grid gap-2 justify-items-start" }, messages, h(ui.Button, { onClick: retry }, "Retry"))
          : h("p", { role: "status", className: "m-0 text-body-sm text-secondary" }, "Loading from buzz-host…"),
        runtimeSide && settingsContent,
      );
    if (runtimeSide) {
      const host = client.snapshot().url.replace(/^wss:\/\//, "").replace(/:\d+$/, "");
      return h(
        "div",
        { className: "grid gap-4" },
        messages,
        h(
          ui.SettingsGroup,
          null,
          h(ui.PreferenceRow, {
            title: "Server",
            subtitle: `buzz-host on ${host}`,
            trailing: h("span", { className: "text-body-sm text-secondary" }, `Service ${loaded.status}`),
          }),
          h(ui.PreferenceRow, { title: "Sessions", subtitle: "One session per thread; Solo chats and DMs keep one." }),
          h(ui.PreferenceRow, {
            title: "Restart",
            subtitle: "A turn in progress is cut short.",
            trailing: h(
              ui.Button,
              {
                size: "sm",
                disabled: !!busy,
                onClick: () =>
                  act("restart", async () => {
                    const r = await client.call("restart", { pubkey });
                    setLoaded({ ...loaded, status: r.status });
                    setNotice("Restarted.");
                  }),
              },
              busy === "restart" ? "Restarting…" : "Restart",
            ),
          }),
          h(ui.PreferenceRow, {
            title: "Logs",
            subtitle: "The agent's recent service log on the server.",
            trailing: h(
              ui.Button,
              {
                size: "sm",
                disabled: !!busy,
                onClick: () =>
                  logs !== undefined
                    ? setLogs(undefined)
                    : act("logs", async () => setLogs((await client.call("logs", { pubkey, lines: 120 })).text)),
              },
              logs !== undefined ? "Hide logs" : busy === "logs" ? "Loading…" : "Show logs",
            ),
          }),
        ),
        logs !== undefined &&
          h(
            "pre",
            {
              className: "m-0 text-caption",
              style: {
                maxHeight: 360,
                overflow: "auto",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                padding: "var(--space-3)",
                borderRadius: "var(--radius-control)",
                background: "var(--surface-inset)",
                border: "1px solid var(--border-standard)",
              },
            },
            logs || "(no log lines)",
          ),
        h(DesktopSettings, { ui, agent }),
        h(OrchestratorSettings, { ui, agent }),
        settingsContent,
      );
    }
    const runtimeChanged =
      draft.runtime !== loaded.runtime || draft.model.trim() !== loaded.model || draft.profile !== loaded.profile;
    const instructionsChanged = draft.instructions !== loaded.instructions;
    const dirty = runtimeChanged || instructionsChanged;
    const save = () =>
      act("save", async () => {
        if (instructionsChanged)
          await client.call("instructions.set", { pubkey, instructions: draft.instructions, base: loaded.instructions });
        let status = loaded.status;
        if (runtimeChanged) {
          status = (
            await client.call("settings.set", { pubkey, runtime: draft.runtime, model: draft.model.trim(), profile: draft.profile })
          ).status;
          invalidateCatalog(pubkey);
        }
        setLoaded({ ...draft, model: draft.model.trim(), status });
        setNotice("Saved. The agent restarted with the new settings.");
      });
    return h(
      "form",
      {
        id: form,
        className: "grid gap-4 [container-type:inline-size]",
        onSubmit: (event) => {
          event.preventDefault();
          if (dirty && !busy) void save();
        },
      },
      messages,
      h(
        ui.SettingsGroup,
        null,
        settingsHost?.typeControl?.(dirty),
        h(RuntimeRows, { ui, draft, disabled: !!busy, onChange: setDraft }),
      ),
      h(ui.AgentInstructions, {
        value: draft.instructions,
        disabled: !!busy,
        description: "Saving restarts the agent; a turn in progress is cut short.",
        onChange: (instructions) => setDraft({ ...draft, instructions }),
      }),
      h(ui.AgentSaveButton, { form, saving: busy === "save", dirty, disabled: !dirty || !!busy }),
    );
  }

  /** This plugin's own settings form, for a Buzz without agentUi. */
  function OwnSettings({ agent, settingsSection, settingsContent }) {
    if (settingsSection === "runtime") return settingsContent ?? null;
    const [loaded, setLoaded] = React.useState();
    const [draft, setDraft] = React.useState();
    const [busy, setBusy] = React.useState("");
    const [error, setError] = React.useState("");
    const [notice, setNotice] = React.useState("");
    const [logs, setLogs] = React.useState();
    const [revision, setRevision] = React.useState(0);
    const pubkey = agent.pubkey;
    React.useEffect(() => {
      const controller = new AbortController();
      const { signal } = controller;
      setError("");
      Promise.all([
        client.call("settings.get", { pubkey }, { signal }),
        client.call("instructions.get", { pubkey }, { signal }),
      ]).then(
        ([s, i]) => {
          if (signal.aborted) return;
          const value = { runtime: s.runtime, model: s.model ?? "", profile: s.profile ?? "", instructions: i.instructions, status: s.status };
          setLoaded(value);
          setDraft(value);
        },
        (e) => !signal.aborted && setError(String(e.message ?? e)),
      );
      return () => controller.abort();
    }, [pubkey, revision]);
    const act = async (label, task) => {
      setBusy(label);
      setError("");
      setNotice("");
      try {
        await task();
      } catch (e) {
        setError(String(e.message ?? e));
      } finally {
        setBusy("");
      }
    };
    if (!draft)
      return h(
        "div",
        { style: { display: "grid", gap: "var(--space-3)" } },
        h(Note, { tone: error ? "error" : undefined }, error || "Loading from buzz-host…"),
        error && h("button", { type: "button", onClick: () => setRevision((r) => r + 1) }, "Retry"),
        !settingsSection && settingsContent,
      );
    const runtimeChanged =
      draft.runtime !== loaded.runtime || draft.model.trim() !== loaded.model || draft.profile !== loaded.profile;
    const instructionsChanged = draft.instructions !== loaded.instructions;
    const dirty = runtimeChanged || instructionsChanged;
    const save = () =>
      act("save", async () => {
        if (instructionsChanged)
          await client.call("instructions.set", {
            pubkey,
            instructions: draft.instructions,
            base: loaded.instructions,
          });
        let status = loaded.status;
        if (runtimeChanged) {
          status = (
            await client.call("settings.set", { pubkey, runtime: draft.runtime, model: draft.model.trim(), profile: draft.profile })
          ).status;
          invalidateCatalog(pubkey);
        }
        const value = { ...draft, model: draft.model.trim(), status };
        setLoaded(value);
        setDraft(value);
        setNotice("Saved. The agent restarted with the new settings.");
      });
    return h(
      "div",
      { style: { display: "grid", gap: "var(--space-4)" } },
      h(
        Note,
        null,
        `Runs on buzz-host (${client.snapshot().url.replace(/^wss:\/\//, "")})${loaded.runtime === "hermes" ? ` · Hermes profile ${loaded.profile || "default"}` : ""} · service ${loaded.status}. One session per thread.`,
      ),
      h(
        Row,
        { label: "Runtime" },
        h(Select, {
          value: draft.runtime,
          disabled: !!busy,
          options: runtimeOptions,
          onChange: (runtime) => setDraft({ ...draft, runtime, model: "", profile: "" }),
        }),
      ),
      draft.runtime === "hermes" &&
        h(
          Row,
          { label: "Hermes profile", hint: `${PROFILE_HINT} Changing it restarts the agent with that profile's memory.` },
          h(ProfileField, {
            React,
            client,
            value: draft.profile,
            disabled: !!busy,
            onChange: (profile) => setDraft({ ...draft, profile }),
          }),
        ),
      h(
        Row,
        { label: "Model" },
        h(ModelField, {
          React,
          client,
          runtime: draft.runtime,
          profile: draft.profile,
          value: draft.model,
          disabled: !!busy,
          onChange: (model) => setDraft({ ...draft, model }),
        }),
      ),
      h(
        Row,
        { label: "Instructions", hint: "Saving restarts the agent; a turn in progress is cut short." },
        h(Area, {
          value: draft.instructions,
          disabled: !!busy,
          rows: 12,
          onChange: (e) => setDraft({ ...draft, instructions: e.target.value }),
        }),
      ),
      error && h(Note, { tone: "error" }, error),
      notice && h(Note, null, notice),
      h(
        "div",
        { style: { display: "flex", gap: "var(--space-2)", flexWrap: "wrap" } },
        h("button", { type: "button", disabled: !dirty || !!busy, onClick: save }, busy === "save" ? "Saving…" : "Save"),
        h(
          "button",
          { type: "button", disabled: !dirty || !!busy, onClick: () => setDraft(loaded) },
          "Discard",
        ),
        h(
          "button",
          {
            type: "button",
            disabled: !!busy,
            onClick: () =>
              act("restart", async () => {
                const r = await client.call("restart", { pubkey });
                setLoaded({ ...loaded, status: r.status });
                setNotice("Restarted.");
              }),
          },
          busy === "restart" ? "Restarting…" : "Restart",
        ),
        h(
          "button",
          {
            type: "button",
            disabled: !!busy,
            onClick: () =>
              logs !== undefined
                ? setLogs(undefined)
                : act("logs", async () => setLogs((await client.call("logs", { pubkey, lines: 120 })).text)),
          },
          logs !== undefined ? "Hide logs" : busy === "logs" ? "Loading…" : "Show logs",
        ),
      ),
      logs !== undefined &&
        h(
          "pre",
          {
            style: {
              ...control,
              margin: 0,
              maxHeight: 360,
              overflow: "auto",
              fontSize: "var(--text-caption)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            },
          },
          logs || "(no log lines)",
        ),
      h(DesktopSettings, { agent }),
      h(OrchestratorSettings, { agent }),
      !settingsSection && settingsContent,
    );
  }

  // ----- Activity tab -----
  const relay = ctx.reflect?.get?.("relay");
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

  // ----- Agent desktop: one full-screen live view per agent -----
  // Opened from the in-chat preview or the agent's Settings: a noVNC view in
  // an overlay on document.body (outside every panel, scroll container and
  // transform), owned here rather than by React. After it is placed it is
  // refitted: noVNC rescaled to the overlay and its back buffer drawn again,
  // since WebKitGTK shows a newly placed canvas black until it is drawn.
  // Buzz's webview takes Esc to leave monitor-wide full screen, so the
  // toolbar has an Esc button that sends it to the agent's desktop instead.
  // Closing it closes the view, and buzz-host then hands control back.
  const XK_ESCAPE = 0xff1b;
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
  // A card under the activity bubble of a request an Omarchy agent is working
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

  /** "<agent> <turn> <live|done> <threadRoot>" per desktop agent working on this request. */
  function previewKeys(snap, channelId, messageId, agents) {
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

  // ----- Orchestrator, in Settings and as an in-chat worker card -----
  const ORCH_LIVE_STATUSES = new Set(["queued", "starting", "running"]);
  const ORCH_RUNTIME_TITLES = {
    claude: "Claude Code",
    codex: "Codex",
    hermes: "Hermes",
    antigravity: "Antigravity",
  };
  const orchRuntimeTitle = (id) => ORCH_RUNTIME_TITLES[id] ?? (id || "Worker");
  const orchBadgeText = (task) =>
    [orchRuntimeTitle(task?.runtime), task?.model || "", task?.effort || ""].filter(Boolean).join(" · ");
  function orchFormatElapsed(ms) {
    const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
    const hr = Math.floor(m / 60);
    return `${hr}h ${String(m % 60).padStart(2, "0")}m`;
  }
  function orchStatusMeta(status) {
    switch (status) {
      case "queued":
        return { label: "Queued", color: "var(--text-secondary)", bg: "var(--surface-inset)" };
      case "starting":
        return { label: "Starting", color: "var(--accent, #3b82f6)", bg: "rgba(59, 130, 246, 0.12)" };
      case "running":
        return { label: "Running", color: "var(--accent, #3b82f6)", bg: "rgba(59, 130, 246, 0.14)" };
      case "completed":
        return { label: "Done", color: "#30a46c", bg: "rgba(48, 164, 108, 0.14)" };
      case "failed":
        return { label: "Failed", color: "#e5484d", bg: "rgba(229, 72, 77, 0.14)" };
      case "timed_out":
        return { label: "Timed out", color: "#e5484d", bg: "rgba(229, 72, 77, 0.14)" };
      case "cancelled":
        return { label: "Stopped", color: "var(--text-secondary)", bg: "var(--surface-inset)" };
      case "interrupted":
        return { label: "Interrupted", color: "#d97706", bg: "rgba(217, 119, 6, 0.14)" };
      default:
        return { label: String(status || "Unknown"), color: "var(--text-secondary)", bg: "var(--surface-inset)" };
    }
  }
  function orchSelectTasks(tasks, { messageId, since, live = false }) {
    const list = Array.isArray(tasks) ? tasks : [];
    const exact = messageId ? list.filter((t) => t.originEventId === messageId) : [];
    const chosen = exact.length
      ? exact
      : live
        ? list.filter(
            (t) =>
              !t.originEventId &&
              (ORCH_LIVE_STATUSES.has(t.status) || (Number.isFinite(since) && (t.createdAt || t.startedAt || 0) >= since)),
          )
        : [];
    return [...chosen].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  }

  // Coalesce concurrent/rapid orchestrator.tasks RPCs for the same agent+chat
  // across multiple rendered message rows in the channel.
  const orchChatFetches = new Map(); // key -> { at, promise }
  function fetchOrchChatTasks(pubkey, channelId, threadRootId) {
    const key = `${pubkey}:${channelId || ""}:${threadRootId || ""}`;
    const hit = orchChatFetches.get(key);
    if (hit && Date.now() - hit.at < 1000) return hit.promise;
    const promise = client
      .call("orchestrator.tasks", { pubkey, channelId, threadRootId: threadRootId || undefined }, { timeoutMs: 15000 })
      .catch((err) => {
        if (orchChatFetches.get(key)?.promise === promise) orchChatFetches.delete(key);
        throw err;
      });
    orchChatFetches.set(key, { at: Date.now(), promise });
    return promise;
  }

  const orchestratorAgents = (() => {
    let agents = new Set();
    let checkedAt = 0;
    let loading = null;
    const listeners = new Set();
    const notify = () => {
      for (const l of listeners) l();
    };
    const load = () => {
      if (loading || Date.now() - checkedAt < 60000) return;
      loading = client
        .call("list", {}, { timeoutMs: 20000 })
        .then((r) => {
          const next = new Set(r.agents.filter((a) => a.orchestrate).map((a) => a.pubkey));
          checkedAt = Date.now();
          if (next.size !== agents.size || [...next].some((p) => !agents.has(p))) {
            agents = next;
            notify();
          }
        })
        .catch(() => (checkedAt = Date.now() - 45000))
        .finally(() => (loading = null));
    };
    return {
      subscribe(listener) {
        listeners.add(listener);
        load();
        return () => listeners.delete(listener);
      },
      snapshot: () => agents,
      set(pubkey, enabled) {
        const next = new Set(agents);
        if (enabled) next.add(pubkey);
        else next.delete(pubkey);
        agents = next;
        checkedAt = Date.now();
        notify();
      },
    };
  })();
  const orchTasksCache = new Map(); // turnId -> tasks[]

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
        const r = await client.call("orchestrator.set", { pubkey, enabled }, { timeoutMs: 90000 });
        orchestratorAgents.set(pubkey, r.enabled === true);
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
                ? `${name} can delegate tasks to ephemeral ACP workers on Claude, Codex, Hermes, and Antigravity in your chats.${state} Turning it off restarts ${name}.`
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

  function OrchestratorCard(props) {
    const { session, channelId, message } = props;
    const agents = React.useSyncExternalStore(orchestratorAgents.subscribe, orchestratorAgents.snapshot);
    const activity = session?.agentActivity;
    const keys = React.useSyncExternalStore(activity?.subscribe ?? noSubscribe, () =>
      previewKeys(activity?.snapshot(), channelId, message?.id, agents),
    );
    if (!keys) return null;
    return h(
      React.Fragment,
      null,
      ...keys.split("\n").map((k) =>
        h(OrchestratorTurnCard, {
          key: k.split(" ").slice(0, 2).join(" "),
          entry: k,
          session,
          channelId,
          messageId: message?.id || "",
          layout: props.messageLayout,
        }),
      ),
    );
  }

  function OrchestratorTurnCard({ entry, session, channelId, messageId, layout }) {
    const [pubkey, turnId, phase, threadRootId] = entry.split(" ");
    const live = phase === "live";
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
    const [tasks, setTasks] = React.useState(() => orchTasksCache.get(turnId) ?? []);
    const [expanded, setExpanded] = React.useState(() => new Set());
    const [fullTasks, setFullTasks] = React.useState(() => new Map());
    const [loadingFull, setLoadingFull] = React.useState(() => new Set());
    const [stoppingIds, setStoppingIds] = React.useState(() => new Set());
    const [error, setError] = React.useState("");
    const [now, setNow] = React.useState(() => Date.now());
    const mountedRef = React.useRef(true);
    const expandedRef = React.useRef(expanded);
    expandedRef.current = expanded;
    const fullTasksRef = React.useRef(fullTasks);
    fullTasksRef.current = fullTasks;
    const loadingFullRef = React.useRef(new Set());

    React.useEffect(() => {
      mountedRef.current = true;
      return () => {
        mountedRef.current = false;
      };
    }, []);

    const loadFull = React.useCallback(
      async (taskId) => {
        if (loadingFullRef.current.has(taskId)) return;
        loadingFullRef.current.add(taskId);
        if (mountedRef.current) setLoadingFull((prev) => new Set(prev).add(taskId));
        try {
          const r = await client.call("orchestrator.tasks", { pubkey, taskId, full: true }, { timeoutMs: 15000 });
          if (!mountedRef.current) return;
          const full = r.task ?? (r.tasks ?? []).find((t) => t.taskId === taskId);
          if (full) {
            setFullTasks((prev) => {
              const next = new Map(prev);
              next.set(taskId, full);
              return next;
            });
          }
        } catch (e) {
          if (mountedRef.current) setError(String(e.message ?? e));
        } finally {
          loadingFullRef.current.delete(taskId);
          if (mountedRef.current) {
            setLoadingFull((prev) => {
              const next = new Set(prev);
              next.delete(taskId);
              return next;
            });
          }
        }
      },
      [pubkey],
    );

    const hasLiveTask = tasks.some((t) => ORCH_LIVE_STATUSES.has(t.status));

    React.useEffect(() => {
      let stopped = false;
      let timer;
      const tick = async () => {
        if (stopped) return;
        let wait = 2500;
        let keepPolling = live;
        if (document.visibilityState !== "hidden") {
          try {
            const r = await fetchOrchChatTasks(pubkey, channelId, threadRootId);
            if (stopped) return;
            const selected = orchSelectTasks(r.tasks, { messageId, since, live });
            orchTasksCache.set(turnId, selected);
            setTasks(selected);
            setError("");
            const anyLive = selected.some((t) => ORCH_LIVE_STATUSES.has(t.status));
            keepPolling = live || anyLive;
            if (selected.length > 0) wait = 1500;
            for (const tid of expandedRef.current) {
              const match = selected.find((t) => t.taskId === tid);
              const prevFull = fullTasksRef.current.get(tid);
              if (
                match &&
                (ORCH_LIVE_STATUSES.has(match.status) ||
                  !prevFull ||
                  prevFull.status !== match.status ||
                  prevFull.updatedAt !== match.updatedAt)
              ) {
                void loadFull(tid);
              }
            }
          } catch {
            wait = 5000;
          }
        }
        if (!stopped && keepPolling) timer = setTimeout(tick, wait);
      };
      tick();
      return () => {
        stopped = true;
        clearTimeout(timer);
      };
    }, [live, pubkey, turnId, channelId, threadRootId, messageId, since, loadFull]);

    React.useEffect(() => {
      if (!hasLiveTask) return undefined;
      const id = setInterval(() => setNow(Date.now()), 1000);
      return () => clearInterval(id);
    }, [hasLiveTask]);

    if (!tasks.length) return null;

    const toggleExpand = (taskId) => {
      const opening = !expandedRef.current.has(taskId);
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(taskId)) next.delete(taskId);
        else next.add(taskId);
        return next;
      });
      if (opening) void loadFull(taskId);
    };

    const cancelTask = async (taskId) => {
      setStoppingIds((prev) => new Set(prev).add(taskId));
      setError("");
      try {
        const r = await client.call("orchestrator.cancel", { pubkey, taskId }, { timeoutMs: 20000 });
        if (r?.task) {
          setTasks((prev) => {
            const next = prev.map((t) => (t.taskId === taskId ? { ...t, ...r.task } : t));
            orchTasksCache.set(turnId, next);
            return next;
          });
        }
      } catch (e) {
        setError(String(e.message ?? e));
      } finally {
        setStoppingIds((prev) => {
          const next = new Set(prev);
          next.delete(taskId);
          return next;
        });
      }
    };

    const liveCount = tasks.filter((t) => ORCH_LIVE_STATUSES.has(t.status)).length;
    const doneCount = tasks.length - liveCount;
    const headerSummary = [
      liveCount ? `${liveCount} running` : "",
      doneCount ? `${doneCount} finished` : "",
    ]
      .filter(Boolean)
      .join(" · ");

    return h(
      PreviewRow,
      { layout },
      h(
        "div",
        {
          className: "ui-card",
          "data-buzz-host-orchestrator": liveCount > 0 ? "live" : "done",
          style: {
            display: "grid",
            gap: "var(--space-2)",
            padding: "var(--space-2) var(--space-3)",
            width: "min(560px, 100%)",
            maxWidth: "100%",
            minWidth: 0,
          },
        },
        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: "var(--space-2)", justifyContent: "space-between", minWidth: 0 } },
          h(
            "span",
            { className: "text-body-sm", style: { display: "inline-flex", alignItems: "center", gap: 6, fontWeight: 600 } },
            liveCount > 0 && h("span", { style: { width: 7, height: 7, borderRadius: 999, background: "#3b82f6" } }),
            "Workers",
          ),
          h("span", { className: "text-caption text-secondary" }, headerSummary),
        ),
        ...tasks.map((task) => {
          const isLive = ORCH_LIVE_STATUSES.has(task.status);
          const st = orchStatusMeta(task.status);
          const isExpanded = expanded.has(task.taskId);
          const full = fullTasks.get(task.taskId);
          const isStopping = stoppingIds.has(task.taskId);
          const elapsed =
            isLive && task.startedAt
              ? Math.max(task.elapsedMs || 0, now - task.startedAt)
              : task.elapsedMs || (task.endedAt && task.startedAt ? task.endedAt - task.startedAt : 0);
          const stepText = task.error
            ? task.error
            : task.latestStep?.title
              ? `${task.latestStep.kind === "tool" ? "Tool: " : task.latestStep.kind === "thought" ? "Thinking: " : ""}${task.latestStep.title}`
              : task.status === "queued"
                ? "Waiting for a worker slot…"
                : task.status === "starting"
                  ? "Starting worker session…"
                  : "";
          const transcript = full?.transcript ?? task.transcript ?? [];
          const resultText = full?.result?.text ?? task.result?.text ?? "";

          return h(
            "div",
            {
              key: task.taskId,
              style: {
                display: "grid",
                gap: 4,
                padding: "var(--space-2)",
                borderRadius: "var(--radius-control, 8px)",
                background: "var(--surface-inset)",
                border: "1px solid var(--border-standard)",
                minWidth: 0,
              },
            },
            h(
              "div",
              { style: { display: "flex", alignItems: "center", gap: "var(--space-2)", flexWrap: "wrap", minWidth: 0 } },
              h(
                "span",
                {
                  className: "text-caption",
                  style: {
                    padding: "1px 6px",
                    borderRadius: 999,
                    background: "var(--surface-raised, rgba(127,127,127,0.14))",
                    fontWeight: 500,
                    whiteSpace: "nowrap",
                  },
                },
                orchBadgeText(task),
              ),
              h(
                "span",
                {
                  className: "text-body-sm",
                  style: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 500 },
                  title: task.label || task.taskId,
                },
                task.label || task.taskId,
              ),
              h(
                "span",
                {
                  className: "text-caption",
                  style: {
                    padding: "1px 6px",
                    borderRadius: 999,
                    color: st.color,
                    background: st.bg,
                    fontWeight: 500,
                    whiteSpace: "nowrap",
                  },
                },
                st.label,
              ),
              h("span", { className: "text-caption text-secondary", style: { whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" } }, orchFormatElapsed(elapsed)),
              isLive &&
                h(
                  Btn,
                  {
                    size: "sm",
                    variant: "ghost",
                    disabled: isStopping,
                    onClick: () => void cancelTask(task.taskId),
                    "aria-label": `Stop worker ${task.label || task.taskId}`,
                  },
                  isStopping ? "Stopping…" : "Stop",
                ),
              h(
                Btn,
                {
                  size: "sm",
                  variant: "ghost",
                  onClick: () => toggleExpand(task.taskId),
                  "aria-expanded": isExpanded,
                },
                isExpanded ? "Hide" : "Transcript",
              ),
            ),
            (stepText || task.steerQueued > 0) &&
              h(
                "div",
                {
                  className: task.error ? "text-caption text-danger" : "text-caption text-secondary",
                  style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 },
                  title: stepText,
                },
                stepText,
                task.steerQueued > 0 ? `${stepText ? " · " : ""}${task.steerQueued} follow-up queued` : "",
              ),
            isExpanded &&
              h(
                "div",
                {
                  style: {
                    display: "grid",
                    gap: 4,
                    marginTop: 4,
                    padding: "var(--space-2)",
                    borderRadius: "var(--radius-sm, 6px)",
                    background: "var(--surface-base, rgba(0,0,0,0.12))",
                    maxHeight: 240,
                    overflow: "auto",
                  },
                },
                loadingFull.has(task.taskId) && !full
                  ? h("span", { className: "text-caption text-secondary" }, "Loading transcript…")
                  : transcript.length > 0
                    ? transcript.map((entry, idx) =>
                        h(
                          "div",
                          {
                            key: `${entry.at || 0}-${idx}`,
                            className: "text-caption",
                            style: { whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "var(--font-mono, monospace)" },
                          },
                          h("span", { className: "text-secondary" }, `[${entry.kind || "event"}] `),
                          entry.text || "",
                        ),
                      )
                    : resultText
                      ? h(
                          "pre",
                          {
                            className: "m-0 text-caption",
                            style: { whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "var(--font-mono, monospace)" },
                          },
                          resultText,
                        )
                      : h("span", { className: "text-caption text-secondary" }, "No transcript entries yet."),
              ),
          );
        }),
        error && h(Note, { tone: "error" }, error),
      ),
    );
  }

  // ----- Attention tab -----
  // buzz-host runs Buzz's Attention for the agent. This tab renders the same
  // markup and classes as Buzz's own Attention tab (bundled plugin
  // buzz.watching, buzz-app src/bundled/watching), whose stylesheet the app
  // loads globally, so a remote agent's tab looks and behaves like a local
  // one's: Interest cards with a status menu, a Triggers / Sources / Responds
  // in / Status table, rows that open to Watch details and Activity, and
  // delete confirmations. buzz-host adds the on/off switch (a remote agent
  // restarts to gain or lose its tools) and a list of recent wakes.
  const ICONS = {
    chat: ["M3 20l1.3 -3.9c-2.324 -3.437 -1.426 -7.872 2.1 -10.374c3.526 -2.501 8.59 -2.296 11.845 .48c3.255 2.777 3.695 7.266 1.029 10.501c-2.666 3.235 -7.615 4.215 -11.574 2.293l-4.7 1"],
    clock: ["M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0", "M12 12l3 2", "M12 7v5"],
    hash: ["M5 9l14 0", "M5 15l14 0", "M11 4l-4 16", "M17 4l-4 16"],
    lock: ["M5 13a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v6a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2v-6", "M11 16a1 1 0 1 0 2 0a1 1 0 0 0 -2 0", "M8 11v-4a4 4 0 1 1 8 0v4"],
    bolt: ["M13 3l0 7l6 0l-8 11l0 -7l-6 0l8 -11"],
    caret: ["M9 6l6 6l-6 6"],
    gear: [
      "M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.066 2.573c.94 1.543 -.826 3.31 -2.37 2.37a1.724 1.724 0 0 0 -2.572 1.065c-.426 1.756 -2.924 1.756 -3.35 0a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37a1.724 1.724 0 0 0 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1 .608 2.296 .07 2.572 -1.065",
      "M9 12a3 3 0 1 0 6 0a3 3 0 0 0 -6 0",
    ],
    circle: ["M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0"],
    x: ["M18 6l-12 12", "M6 6l12 12"],
  };
  /** A Tabler outline icon, as Buzz's icon set renders it (size in px → rem). */
  const Icon = ({ name, size = 16, filled = false, style, className }) =>
    h(
      "svg",
      {
        xmlns: "http://www.w3.org/2000/svg",
        width: `${size / 16}rem`,
        height: `${size / 16}rem`,
        viewBox: "0 0 24 24",
        fill: filled ? "currentColor" : "none",
        stroke: filled ? "none" : "currentColor",
        strokeWidth: filled ? 0 : 2,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        "aria-hidden": "true",
        style,
        className,
      },
      ...ICONS[name].map((d, i) => h("path", { key: i, d })),
    );
  /** Buzz's Button: Base UI button with the design system's data attributes. */
  const Btn = ({ variant = "subtle", size = "md", children, style, ...props }) =>
    h(
      "button",
      {
        type: "button",
        "data-buzz-ui": "",
        className: "buzz-button",
        "data-variant": variant,
        "data-size": size,
        "data-button-shape": "capsule",
        "data-disabled": props.disabled ? "" : undefined,
        style,
        ...props,
      },
      h("span", { className: "buzz-button-label" }, children),
    );
  /** Closes on a click outside `ref` or Escape; `close` gets "outside" or "escape". */
  function useDismiss(open, ref, close) {
    React.useEffect(() => {
      if (!open) return undefined;
      const down = (event) => {
        if (ref.current && !ref.current.contains(event.target)) close("outside");
      };
      const key = (event) => event.key === "Escape" && close("escape");
      document.addEventListener("pointerdown", down, true);
      document.addEventListener("keydown", key);
      return () => {
        document.removeEventListener("pointerdown", down, true);
        document.removeEventListener("keydown", key);
      };
    }, [open, ref, close]);
  }
  /** Buzz's compact menu: a heading, then items; `items` are {label, onClick, tone, disabled} or "separator" / {note}. */
  function Menu({ trigger, label, heading, items }) {
    const [open, setOpen] = React.useState(false);
    const [hover, setHover] = React.useState(-1);
    const ref = React.useRef(null);
    const close = React.useCallback(() => setOpen(false), []);
    useDismiss(open, ref, close);
    return h(
      "span",
      { ref, style: { position: "relative", display: "inline-flex" } },
      trigger({ onClick: () => setOpen(!open), "aria-expanded": open, "aria-haspopup": "menu" }),
      open &&
        h(
          "div",
          { className: "buzz-menu-positioner", style: { position: "absolute", insetInlineEnd: 0, insetBlockStart: "calc(100% + var(--space-1))" } },
          h(
            "div",
            { "data-buzz-ui": "", "data-size": "compact", className: "buzz-menu-popup text-body-sm", role: "menu", "aria-label": label },
            h(
              "div",
              { role: "group" },
              h("div", { className: "buzz-menu-group-label" }, heading),
              ...items.map((item, i) =>
                item === "separator"
                  ? h("div", { key: i, role: "separator", className: "buzz-menu-separator" })
                  : item.note
                    ? h("p", { key: i, className: "buzz-menu-note text-body-sm" }, item.note)
                    : h(
                        "div",
                        {
                          key: i,
                          role: "menuitem",
                          tabIndex: -1,
                          className: "buzz-menu-item",
                          "data-tone": item.tone,
                          "data-disabled": item.disabled ? "" : undefined,
                          "aria-disabled": item.disabled || undefined,
                          "data-highlighted": hover === i ? "" : undefined,
                          onMouseEnter: () => setHover(i),
                          onMouseLeave: () => setHover(-1),
                          onClick: () => {
                            if (item.disabled) return;
                            setOpen(false);
                            item.onClick();
                          },
                        },
                        item.label,
                      ),
              ),
            ),
          ),
        ),
    );
  }
  /** Buzz's Popover (Base UI, side bottom, offset 8): opens from its trigger
   * aligned to `align`, shifts or flips to stay in the window, takes focus,
   * and closes on Escape (focus back to the trigger) or a click outside. Base
   * UI renders it in a portal, so the panel around the tab never clips it;
   * without one, it is `position: fixed` at the trigger, kept there on scroll. */
  function Popover({ trigger, label, align = "end", children }) {
    const [open, setOpen] = React.useState(false);
    const [starting, setStarting] = React.useState(false);
    const [side, setSide] = React.useState("bottom");
    const ref = React.useRef(null);
    const positioner = React.useRef(null);
    const popup = React.useRef(null);
    const close = React.useCallback((reason) => {
      setOpen(false);
      if (reason === "escape") ref.current?.querySelector("button")?.focus();
    }, []);
    useDismiss(open, ref, close);
    const place = React.useCallback(() => {
      const box = positioner.current;
      if (!box || !ref.current) return;
      const anchor = ref.current.getBoundingClientRect();
      const { width, height } = box.getBoundingClientRect();
      const margin = 8;
      const offset = 8;
      const x = Math.max(margin, Math.min(align === "end" ? anchor.right - width : anchor.left, window.innerWidth - margin - width));
      const below = anchor.bottom + offset;
      const flip = below + height > window.innerHeight - margin && anchor.top - offset - height >= margin;
      const y = flip ? anchor.top - offset - height : below;
      box.style.left = `${x}px`;
      box.style.top = `${y}px`;
      // A transformed ancestor makes `fixed` relative to itself: correct by where it landed.
      const landed = box.getBoundingClientRect();
      if (landed.left !== x || landed.top !== y) {
        box.style.left = `${2 * x - landed.left}px`;
        box.style.top = `${2 * y - landed.top}px`;
      }
      setSide(flip ? "top" : "bottom");
    }, [align]);
    React.useLayoutEffect(() => {
      if (!open) return undefined;
      place();
      popup.current?.focus({ preventScroll: true });
      const frame = requestAnimationFrame(() => setStarting(false));
      window.addEventListener("scroll", place, true);
      window.addEventListener("resize", place);
      return () => {
        cancelAnimationFrame(frame);
        window.removeEventListener("scroll", place, true);
        window.removeEventListener("resize", place);
      };
    }, [open, place]);
    const toggle = () => {
      if (open) return close();
      setSide("bottom");
      setStarting(true);
      setOpen(true);
    };
    return h(
      "span",
      { ref, style: { position: "relative", display: "inline-flex", minWidth: 0, maxWidth: "100%" } },
      trigger({ onClick: toggle, "aria-expanded": open, "aria-haspopup": "dialog" }),
      open &&
        h(
          "div",
          { ref: positioner, className: "buzz-popover-positioner", style: { position: "fixed", left: 0, top: 0 } },
          h(
            "div",
            {
              ref: popup,
              role: "dialog",
              "aria-label": label,
              tabIndex: -1,
              "data-buzz-ui": "",
              "data-size": "default",
              "data-padding": "content",
              "data-side": side,
              "data-align": align,
              "data-open": "",
              "data-starting-style": starting ? "" : undefined,
              className: "buzz-popover-popup text-body ",
              style: { "--available-width": "calc(100vw - 16px)", "--available-height": "70vh", outline: "none" },
              // Stop Escape here, so it closes the popover and not the panel around it.
              onKeyDown: (event) => {
                if (event.key !== "Escape") return;
                event.stopPropagation();
                close("escape");
              },
            },
            children,
          ),
        ),
    );
  }
  /** Buzz's AlertDialog, for deletes. */
  const Confirm = ({ title, description, pending, error, onCancel, onConfirm }) =>
    h(
      React.Fragment,
      null,
      h("div", { "data-buzz-ui": "", "data-alert-dialog": "", className: "buzz-dialog-backdrop", onClick: onCancel }),
      h(
        "div",
        { "data-buzz-ui": "", className: "buzz-dialog gap-0", "data-size": "compact", "data-height": "content", role: "alertdialog", "aria-label": title },
        h(
          "header",
          { className: "buzz-dialog-header" },
          h(
            "div",
            { className: "buzz-dialog-heading" },
            h("h2", { className: "text-label" }, title),
            h("p", { className: "buzz-dialog-description" }, description),
          ),
          h(
            "button",
            {
              type: "button",
              "aria-label": "Close",
              "data-buzz-ui": "",
              className: "buzz-button",
              "data-variant": "subtle",
              "data-size": "compact",
              "data-button-shape": "icon",
              "data-icon-variant": "subtle",
              "data-icon-size": "compact",
              "data-icon-shape": "control",
              disabled: pending,
              onClick: onCancel,
            },
            h("span", { className: "buzz-button-label" }, h(Icon, { name: "x" })),
          ),
        ),
        error && h("div", { className: "buzz-dialog-body buzz-dialog-content flex flex-col gap-4" }, h("p", { role: "alert", className: "text-body-sm text-danger" }, error)),
        h(
          "div",
          { className: "buzz-dialog-actions" },
          h(Btn, { disabled: pending, onClick: onCancel, autoFocus: true }, "Cancel"),
          h(Btn, { variant: "destructive", disabled: pending, onClick: onConfirm }, pending ? "Deleting…" : "Delete"),
        ),
      ),
    );
  /** The status pill: a citrus dot when active. */
  const StatusPill = ({ active, label, ...props }) =>
    h(
      Btn,
      { variant: "subtle", size: "xs", style: { paddingInlineStart: "var(--space-2)" }, "aria-label": label, ...props },
      h(
        "span",
        { className: "attention-pill-icon" },
        h(Icon, {
          name: "circle",
          size: 12,
          filled: true,
          className: active ? undefined : "text-subtle",
          style: active ? { color: "var(--affordance-accent-prominent)" } : undefined,
        }),
      ),
      h("span", null, active ? "Active" : "Paused"),
    );
  /** Buzz's sonar illustration: rings, sweep, signals and the agent's picture. */
  function Sonar({ picture, name, size = "small" }) {
    const s = size === "large"
      ? { size: 160, avatar: 48, rings: 6, dot: 6, neutral: 4 }
      : { size: 64, avatar: 32, rings: 4, dot: 4, neutral: 2 };
    const signals = React.useMemo(
      () =>
        Array.from({ length: 12 }, (_, slot) => {
          const angle = ((slot + 0.15 + Math.random() * 0.7) / 12) * Math.PI * 2;
          const radius = 0.28 + Math.random() * 0.15;
          return { slot, angle, radius };
        }),
      [],
    );
    return h(
      "div",
      {
        className: "attention-sonar",
        "data-size": size,
        "aria-hidden": "true",
        style: {
          inlineSize: s.size,
          blockSize: s.size,
          "--sonar-period": "8s",
          "--sonar-avatar-size": `${s.avatar}px`,
          "--sonar-beam": "300deg",
          "--sonar-sweep-opacity": 0.16,
          "--sonar-ring-opacity": 0.16,
          "--sonar-dot-size": `${s.dot}px`,
          "--sonar-neutral-size": `${s.neutral}px`,
          "--sonar-dot-opacity": 1,
          "--sonar-dot-scale": 0.15,
          "--sonar-dot-ease": "cubic-bezier(0.43, 1, 0.32, 2)",
        },
      },
      ...Array.from({ length: s.rings }, (_, i) => h("div", { key: `r${i}`, className: "attention-sonar-ring", style: { inset: `${(i / s.rings) * 50}%` } })),
      h("div", { key: "sweep", className: "attention-sonar-sweep", "data-accent": "citrus", "data-palette": "citrus" }),
      ...signals.map(({ slot, angle, radius }) =>
        h(
          "div",
          {
            key: `s${slot}`,
            className: "attention-sonar-signal",
            "data-accent": "citrus",
            "data-citrus": slot % 2 === 1 || undefined,
            style: { left: `${50 + Math.sin(angle) * radius * 100}%`, top: `${50 - Math.cos(angle) * radius * 100}%`, "--sonar-delay": `${(angle / (Math.PI * 2)) * 8}s` },
          },
          h("span", { className: "attention-sonar-dot" }),
        ),
      ),
      h(
        "div",
        { key: "agent", className: "attention-sonar-agent" },
        h(
          "span",
          { className: "attention-sonar-portrait" },
          picture
            ? h("img", { src: picture, alt: "", style: { inlineSize: "100%", blockSize: "100%", objectFit: "cover", borderRadius: "inherit" } })
            : h("span", { className: "text-label" }, (name || "?").slice(0, 1)),
        ),
      ),
    );
  }
  /** Buzz's channel list, for names and icons, from the relay session. */
  function useChannels() {
    const none = React.useCallback(() => () => {}, []);
    const snap = React.useSyncExternalStore(relay?.subscribe ?? none, relay?.snapshot ?? (() => undefined));
    const queries = snap?.status === "ready" ? snap.session?.channels : undefined;
    React.useEffect(() => {
      try {
        return queries?.ensureList?.();
      } catch {
        return undefined;
      }
    }, [queries]);
    const empty = React.useMemo(() => ({ channels: [] }), []);
    const list = React.useSyncExternalStore(
      queries?.subscribeList ?? none,
      queries?.list ?? (() => empty),
    );
    return list?.channels ?? [];
  }
  const relative = (at) => {
    if (!at) return "";
    const secs = Math.round(Date.now() / 1000 - at);
    if (secs < 60) return "just now";
    if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
    if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
    return new Date(at * 1000).toLocaleDateString([], { month: "short", day: "numeric" });
  };
  const titleOf = (id) => id.replace(/[-_]+/g, " ").replace(/^./, (c) => c.toUpperCase());
  /** Buzz's presentation.ts: an id as words, and a heading's plain text. */
  const words = (id) => id.replace(/-(?:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}|[a-f0-9]{32,64})$/i, "").replace(/[-_]+/g, " ");
  const plain = (value) => value.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/^#+\s*/, "").replace(/\*\*|__|`/g, "").trim();
  /** Buzz's timer line: "Once · today 4:16 AM (in 2m)" or "Every 1h · 3 runs". */
  function schedule(w) {
    if (w.maxOccurrences === 1 && w.nextDue) {
      const next = new Date(w.nextDue * 1000);
      const day = next.toDateString() === new Date().toDateString() ? "today" : next.toLocaleDateString();
      const time = next.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      const minutes = Math.ceil(Math.abs(w.nextDue - Date.now() / 1000) / 60);
      return `Once · ${day} ${time} (${w.nextDue > Date.now() / 1000 ? `in ${minutes}m` : `${minutes}m ago`})`;
    }
    const s = w.interval;
    const every = s % 3600 === 0 ? `${s / 3600}h` : s % 60 === 0 ? `${s / 60}m` : `${s}s`;
    return `Every ${every}${w.maxOccurrences ? ` · ${w.maxOccurrences} runs` : ""}`;
  }
  const WAKE_OUTCOME = { ok: "done", error: "failed", cancelled: "stopped", timeout: "timed out", lost: "lost", dropped: "dropped (busy)" };

  // ----- Instructions, rendered as Buzz renders them -----
  // Buzz shows an Interest's instructions with react-markdown (its
  // InstructionsMarkdown): GFM, raw HTML shown as text, its link policy, compact
  // headings and its Markdown stylesheet. The same parser is bundled at the end
  // of this file (markdownParser()); this turns its tree into the elements
  // react-markdown makes from it (mdast-util-to-hast), under Buzz's classes.
  const MD_CLASS = "attention-markdown text-body-sm text-secondary";
  const MD_CHARS = 100_000; // MAX_MARKDOWN_LENGTH
  const MD_DEPTH = 100; // MAX_MARKDOWN_DEPTH
  const MD_CELLS = 10_000; // DOCUMENT_RENDER_CELLS
  const mdUrl = (url) => (/^(https?:|mailto:|buzz:|nostr:|#)/i.test(url ?? "") ? url : "");
  /** Buzz's Markdown stylesheet is a CSS module, so its class names carry a
   * build hash (`_document_m4s2h_1`): read them from the loaded stylesheet.
   * Without them the instructions keep the Attention tab's own styles. */
  let mdClasses;
  let mdLookedAt = 0;
  function markdownClasses() {
    if (mdClasses || Date.now() - mdLookedAt < 5000) return mdClasses ?? {};
    mdLookedAt = Date.now();
    const modules = new Map();
    const scan = (rules) => {
      for (const rule of rules) {
        for (const [name, local, hash] of rule.selectorText?.matchAll(/\._(document|compact|imageAlt|source)_([a-z0-9]+)_\d+/g) ?? []) {
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
    mdClasses = [...modules.values()].find((c) => c.document && c.compact && c.imageAlt);
    return mdClasses ?? {};
  }
  /** Parsed as remark-parse with remark-gfm does, or undefined past Buzz's limits. */
  function parseInstructions(text) {
    if (text.length > MD_CHARS) return undefined;
    let tree;
    try {
      const { fromMarkdown, gfm, gfmFromMarkdown } = markdownParser();
      tree = fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
    } catch {
      return undefined;
    }
    let cells = 0;
    const pending = [{ node: tree, depth: 0 }];
    while (pending.length) {
      const { node, depth } = pending.pop();
      if (depth > MD_DEPTH) return undefined;
      if (node.type === "table") cells += (node.children[0]?.children.length ?? 0) * node.children.length;
      for (const child of node.children ?? []) pending.push({ node: child, depth: depth + 1 });
    }
    return cells > MD_CELLS ? undefined : tree;
  }
  /** Buzz's observeTableOverflow: marks a table wider than its column. */
  const observeTable = (table) => {
    if (!table || typeof ResizeObserver === "undefined") return undefined;
    const update = () => {
      const overflow = String(table.scrollWidth > table.clientWidth);
      if (table.dataset.overflow !== overflow) table.dataset.overflow = overflow;
    };
    update();
    const resize = new ResizeObserver(update);
    resize.observe(table);
    const content = new MutationObserver(update);
    content.observe(table, { childList: true, characterData: true, subtree: true });
    return () => {
      resize.disconnect();
      content.disconnect();
    };
  };
  /** InstructionsMarkdown's link. A person (`nostr:npub…`) shows as their name:
   * Buzz opens profiles only from tabs its host gives an opener, and an agent
   * type's tabs get none. */
  const mdLink = (href, children, key) =>
    !href || /^nostr:npub1[023456789acdefghjklmnpqrstuvwxyz]+$/.test(href)
      ? h("span", { key }, ...children)
      : h("a", { key, href, target: "_blank", rel: "noreferrer" }, ...children);
  const looseItem = (item) => (item.spread ?? null) === null ? item.children.length > 1 : item.spread;
  const looseList = (list) => Boolean(list.spread) || list.children.some(looseItem);
  /** mdast → React, as mdast-util-to-hast and react-markdown build it. */
  function renderMarkdown(tree, classes) {
    const definitions = new Map();
    const footnotes = new Map();
    const order = [];
    const uses = new Map();
    const normalize = (id) => String(id).replace(/[\t\n\r ]+/g, " ").trim().toLowerCase().toUpperCase();
    (function collect(node) {
      if (node.type === "definition" && !definitions.has(normalize(node.identifier))) definitions.set(normalize(node.identifier), node);
      if (node.type === "footnoteDefinition" && !footnotes.has(normalize(node.identifier))) footnotes.set(normalize(node.identifier), node);
      for (const child of node.children ?? []) collect(child);
    })(tree);
    const all = (node, loose) => (node.children ?? []).map((child, i) => one(child, i, node, loose));
    /** to-hast's wrap: line endings between blocks (and around them, if loose). */
    const wrap = (nodes, loose) => {
      const out = [];
      nodes.filter((n) => n !== null).forEach((n, i) => out.push(...(i || loose ? ["\n"] : []), n));
      if (loose && out.length) out.push("\n");
      return out;
    };
    const text = (value) => String(value).replace(/[ \t]*(\r?\n|\r)[ \t]*/g, "$1");
    const revert = (node, key) => {
      const suffix = node.referenceType === "full" ? `[${node.label || node.identifier}]` : node.referenceType === "collapsed" ? "[]" : "";
      if (node.type === "imageReference") return `![${node.alt ?? ""}]${suffix}`;
      return h(React.Fragment, { key }, "[", ...all(node), `]${suffix}`);
    };
    function item(node, key, list) {
      const loose = list ? looseList(list) : looseItem(node);
      const results = all(node, loose);
      const kids = [];
      node.children.forEach((child, i) => {
        if (loose || i !== 0 || child.type !== "paragraph") kids.push("\n");
        if (child.type === "paragraph" && !loose) kids.push(...[results[i]].flat());
        else kids.push(results[i]);
      });
      if (typeof node.checked === "boolean") {
        const box = h("input", { key: "check", type: "checkbox", checked: node.checked, disabled: true });
        const first = node.children[0];
        if (first?.type === "paragraph") {
          const at = loose ? 1 : kids.findIndex((k) => k !== "\n");
          const p = kids[at];
          const inner = loose && p ? [p.props.children ?? []].flat() : [];
          if (loose && p) kids[at] = h("p", { key: p.key }, box, inner.length ? " " : null, ...inner);
          else kids.splice(Math.max(at, 0), 0, box, " ");
        } else kids.unshift(box);
      }
      if (node.children.length && (loose || node.children.at(-1).type !== "paragraph")) kids.push("\n");
      return h("li", { key, className: typeof node.checked === "boolean" ? "task-list-item" : undefined }, ...kids);
    }
    function one(node, key, parent, loose) {
      switch (node.type) {
        case "paragraph":
          // A tight list item holds its paragraphs' contents (see item).
          return parent?.type === "listItem" && loose === false ? all(node) : h("p", { key }, ...all(node));
        case "heading":
          return h(`h${node.depth}`, { key }, ...all(node));
        case "thematicBreak":
          return h("hr", { key });
        case "blockquote":
          return h("blockquote", { key }, ...wrap(all(node), true));
        case "list":
          return h(
            node.ordered ? "ol" : "ul",
            {
              key,
              start: node.ordered && typeof node.start === "number" && node.start !== 1 ? node.start : undefined,
              className: node.children.some((c) => typeof c.checked === "boolean") ? "contains-task-list" : undefined,
            },
            ...node.children.map((child, i) => item(child, i, node)),
          );
        case "listItem":
          return item(node, key);
        case "code": {
          const lang = node.lang?.split(/\s+/)[0];
          return h("pre", { key }, h("code", { className: lang ? `language-${lang}` : undefined }, node.value ? `${node.value}\n` : ""));
        }
        case "table": {
          const [head, ...rows] = node.children;
          const row = (r, i, cell) =>
            h(
              "tr",
              { key: i },
              ...(node.align ?? r.children).map((_, c) =>
                h(cell, { key: c, style: node.align?.[c] ? { textAlign: node.align[c] } : undefined }, ...(r.children[c] ? all(r.children[c]) : [])),
              ),
            );
          return h(
            "table",
            { key, ref: observeTable },
            head && h("thead", null, row(head, 0, "th")),
            rows.length > 0 && h("tbody", null, ...rows.map((r, i) => row(r, i, "td"))),
          );
        }
        case "html":
          return text(node.value); // literal, as Buzz shows raw HTML
        case "text":
          return text(node.value);
        case "break":
          return [h("br", { key }), "\n"];
        case "emphasis":
          return h("em", { key }, ...all(node));
        case "strong":
          return h("strong", { key }, ...all(node));
        case "delete":
          return h("del", { key }, ...all(node));
        case "inlineCode":
          return h("code", { key }, node.value.replace(/\r?\n|\r/g, " "));
        case "link":
          return mdLink(mdUrl(node.url), all(node), key);
        case "linkReference": {
          const def = definitions.get(normalize(node.identifier));
          return def ? mdLink(mdUrl(def.url), all(node), key) : revert(node, key);
        }
        case "image":
        case "imageReference":
          if (node.type === "imageReference" && !definitions.has(normalize(node.identifier))) return revert(node, key);
          return node.alt ? h("span", { key, className: classes.imageAlt }, node.alt) : null;
        case "footnoteReference": {
          const id = normalize(node.identifier);
          if (!order.includes(id)) order.push(id);
          uses.set(id, (uses.get(id) ?? 0) + 1);
          const slug = encodeURIComponent(id.toLowerCase());
          return h("sup", { key }, mdLink(`#user-content-fn-${slug}`, [String(order.indexOf(id) + 1)]));
        }
        case "definition":
        case "footnoteDefinition":
          return null;
        default:
          return node.children ? h("div", { key }, ...all(node)) : node.value != null ? text(node.value) : null;
      }
    }
    const body = wrap(all(tree));
    if (order.length) {
      const notes = order
        .filter((id) => footnotes.has(id))
        .map((id) => {
          const slug = encodeURIComponent(id.toLowerCase());
          const back = Array.from({ length: uses.get(id) ?? 1 }, (_, n) =>
            mdLink(`#user-content-fnref-${slug}${n ? `-${n + 1}` : ""}`, ["↩", n ? h("sup", { key: "n" }, String(n + 1)) : null], `b${n}`),
          );
          const content = all(footnotes.get(id));
          const last = footnotes.get(id).children.at(-1);
          if (last?.type === "paragraph" && content.length) {
            const p = content.at(-1);
            content[content.length - 1] = h("p", { key: p.key }, ...[p.props.children ?? []].flat(), " ", ...back);
          } else content.push(" ", ...back);
          return h("li", { key: id, id: `user-content-fn-${slug}` }, ...content);
        });
      body.push(
        h(
          "section",
          { key: "footnotes", "data-footnotes": "true", className: "footnotes" },
          h("h2", { className: "sr-only", id: "footnote-label" }, "Footnotes"),
          h("ol", null, ...notes),
        ),
      );
    }
    return body;
  }
  /** Buzz's InstructionsMarkdown: the document at its compact scale, or its
   * wrapped source past the size, depth or table limits. */
  function InstructionsMarkdown({ text }) {
    const tree = React.useMemo(() => parseInstructions(text), [text]);
    const classes = markdownClasses();
    if (!tree)
      return h(
        "div",
        { className: [classes.document, MD_CLASS].filter(Boolean).join(" ") },
        h("pre", { className: classes.source, style: classes.source ? undefined : { whiteSpace: "pre-wrap" } }, h("code", null, text)),
      );
    return h("div", { className: [classes.document, classes.compact, MD_CLASS].filter(Boolean).join(" ") }, ...renderMarkdown(tree, classes));
  }

  function WatchRow({ w, interestPaused, agentName, name, channelOf, openConversation, act, busy }) {
    const [open, setOpen] = React.useState(false);
    const [confirming, setConfirming] = React.useState(false);
    const [error, setError] = React.useState("");
    const timer = w.type === "timer";
    const spent = timer && w.status === "spent";
    const active = w.enabled && !interestPaused && !spent && w.status !== "completed";
    // A nameless watch is labelled by its Interest, as in Buzz.
    const label = timer ? schedule(w) : plain(w.name || words(w.interest));
    const type = w.type === "event" ? "Messages" : timer ? "Schedule" : "Function";
    const destination = w.channel
      ? h(
          Btn,
          {
            variant: "outline",
            size: "xs",
            title: `Delivers to ${name(w.channel)}`,
            "aria-label": `Open reference ${name(w.channel)}`,
            onClick: () => openConversation?.(w.channel),
          },
          h(
            "span",
            { className: "attention-destination-label" },
            h(Icon, { name: channelOf(w.channel) }),
            h("span", { className: "attention-channel-name" }, `${name(w.channel)}${w.root ? " thread" : ""}`),
          ),
        )
      : h("span", { className: "text-caption text-subtle" }, "Independent turn");
    const technical =
      w.type === "event" &&
      Boolean(w.authors?.length || w.excludeAuthors?.length || w.kinds?.length !== 1 || w.kinds[0] !== 9);
    const meta = (rows) =>
      h(
        "dl",
        { className: "attention-expanded-meta text-body-sm" },
        ...rows.filter(Boolean).map(([dt, dd]) => h("div", { key: dt }, h("dt", { className: "text-subtle" }, dt), h("dd", null, dd))),
      );
    const watched = w.type === "event" ? (w.channels === "all" ? "all joined channels" : w.channels.map(name).join(", ")) : "";
    return h(
      "li",
      {
        className: "attention-card",
        "data-expanded": open || undefined,
        "data-disabled": !w.enabled || undefined,
        "data-paused": spent || !w.enabled ? "" : undefined,
      },
      h(
        "div",
        { className: "attention-table-row" },
        h(
          "button",
          { className: "attention-heading", type: "button", "aria-label": `Details for ${label}`, "aria-expanded": open, onClick: () => setOpen(!open) },
          h(Icon, { name: timer ? "clock" : "chat" }),
          h("span", { className: "attention-title text-body-sm text-primary", title: label }, label),
        ),
        !timer &&
          h(
            "div",
            { className: "attention-reference" },
            h(
              "div",
              { className: "attention-reference-item" },
              h(
                Popover,
                {
                  label: `Source details for ${label}`,
                  trigger: (props) =>
                    h(
                      Btn,
                      {
                        variant: "outline",
                        size: "xs",
                        style: { paddingInlineStart: "var(--space-2)" },
                        "aria-label": `Source details for ${label}`,
                        ...props,
                      },
                      h("span", { className: "attention-pill-icon" }, h(Icon, { name: w.type === "event" ? "hash" : "bolt", size: 12 })),
                      h(
                        "span",
                        { className: "attention-reference-label" },
                        w.type !== "event"
                          ? type
                          : w.channels === "all"
                            ? "All channels"
                            : w.channels.length === 1
                              ? name(w.channels[0])
                              : `${w.channels.length} channels`,
                      ),
                    ),
                },
                h(
                  "div",
                  { className: "attention-popover-content" },
                  w.type === "event"
                    ? h(
                        "dl",
                        { className: "attention-expanded-meta attention-channel-table text-body-sm" },
                        h(
                          "div",
                          null,
                          h("dt", { className: "text-subtle" }, "Watches"),
                          h(
                            "dd",
                            null,
                            w.channels === "all"
                              ? "All joined channels"
                              : w.channels.map((channel) =>
                                  h("div", { key: channel, className: "attention-destination-label" }, h(Icon, { name: channelOf(channel) }), name(channel)),
                                ),
                          ),
                        ),
                        h(
                          "div",
                          null,
                          h("dt", { className: "text-subtle" }, "Delivers to"),
                          h("dd", null, w.channel ? `${name(w.channel)}${w.root ? " thread" : ""}` : "Independent turn"),
                        ),
                      )
                    : h(
                        "dl",
                        { className: "attention-expanded-meta attention-channel-table text-body-sm" },
                        h("div", null, h("dt", { className: "text-caption text-subtle" }, type), h("dd", null, w.summary)),
                      ),
                ),
              ),
            ),
          ),
        h("div", { className: "attention-destination" }, destination),
        h(
          "div",
          { className: "attention-status" },
          h(Menu, {
            label: `Watch status for ${label}`,
            heading: "Trigger",
            trigger: (props) => h(StatusPill, { active, label: `Watch status for ${label}`, ...props }),
            items: [
              {
                label: w.enabled ? "Pause" : "Resume",
                disabled: busy || (timer && !w.enabled),
                onClick: () => act(`we:${w.id}`, "attention.edit", { op: "enableWatch", id: w.id, enabled: !w.enabled }).catch((e) => setError(e.message)),
              },
              "separator",
              { label: "Delete", tone: "danger", disabled: busy, onClick: () => setConfirming(true) },
              interestPaused && { note: "This interest is paused. Resume it to run enabled watches." },
              timer && !w.enabled && { note: `Ask ${agentName} to set this timer’s next run.` },
            ].filter(Boolean),
          }),
        ),
      ),
      confirming &&
        h(Confirm, {
          title: timer ? "Delete this timer?" : "Delete this watch?",
          description: `This deletes the ${timer ? "timer" : "watch"}. The agent will stop watching for this trigger. This cannot be undone.`,
          pending: busy,
          error,
          onCancel: () => setConfirming(false),
          onConfirm: () =>
            act(`rw:${w.id}`, "attention.edit", { op: "removeWatch", id: w.id })
              .then(() => setConfirming(false))
              .catch((e) => setError(e.message)),
        }),
      !confirming && error && h("p", { role: "alert", className: "text-body-sm text-danger" }, error),
      open &&
        h(
          "div",
          { className: "attention-expansion" },
          h(
            "div",
            { className: "attention-details" },
            h(
              "details",
              { className: "attention-watch-details" },
              h(
                "summary",
                { className: "attention-disclosure text-body-sm text-subtle", "aria-label": `Watch details for ${label}` },
                h("span", { className: "attention-disclosure-icon" }, h(Icon, { name: "gear" })),
                h("span", { className: "whitespace-nowrap" }, "Watch details"),
                h("span", { className: "attention-detail-preview" }, `${type} · ${w.type === "event" ? (w.classifier ? "Filtered messages" : "All messages") : timer ? label : w.summary}`),
                h(Icon, { name: "caret" }),
              ),
              h(
                "div",
                { className: "attention-configuration" },
                meta([
                  ["Source", type],
                  ["Runs in", w.channel ? `${name(w.channel)}${w.root ? " thread" : ""}` : "Independent turn"],
                  w.lastWokeAt && ["Last woke", relative(w.lastWokeAt)],
                ]),
                meta([
                  [
                    "Trigger",
                    w.type === "event"
                      ? `New messages in ${watched}${w.classifier ? ", filtered for relevance" : ""}.`
                      : timer
                        ? `${label}. ${w.prompt}`
                        : w.summary,
                  ],
                ]),
                w.type === "event" &&
                  (technical || w.classifier || w.isReply != null) &&
                  meta([
                    [
                      "Filters",
                      h(
                        "div",
                        { className: "text-body-sm" },
                        w.isReply != null && h("p", null, w.isReply ? "Replies only" : "Top-level messages only"),
                        w.classifier && h("p", null, "A relevance question (not run on this host: matching messages pass unchecked)"),
                        technical &&
                          h(
                            "details",
                            null,
                            h("summary", { className: "attention-disclosure text-body-sm text-subtle" }, "Technical filters", h(Icon, { name: "caret" })),
                            h(
                              "pre",
                              { className: "text-caption text-standard" },
                              JSON.stringify({ kinds: w.kinds?.length ? w.kinds : "all", authors: w.authors, exclude_authors: w.excludeAuthors }, null, 2),
                            ),
                          ),
                      ),
                    ],
                  ]),
                (w.catchingUp || w.waiting > 0) &&
                  meta([["On this host", [w.catchingUp && "catching up on missed messages", w.waiting > 0 && `${w.waiting} waiting`].filter(Boolean).join(" · ")]]),
              ),
            ),
            h(
              "details",
              { className: "attention-watch-activity" },
              h(
                "summary",
                { className: "attention-disclosure text-body-sm text-subtle", "aria-label": `Show activity for ${label}` },
                h("span", { className: "attention-disclosure-icon" }, h(Icon, { name: "clock" })),
                "Activity",
                h(
                  "span",
                  { className: "attention-detail-preview" },
                  w.activity?.length ? `${w.activity.length} event${w.activity.length === 1 ? "" : "s"}` : "No activity yet",
                ),
                h(Icon, { name: "caret" }),
              ),
              h(
                "ol",
                { className: "attention-timeline", "aria-label": `Activity for ${label}` },
                ...(w.activity ?? []).map((entry, i) =>
                  h(
                    "li",
                    { key: i, className: "attention-timeline-event" },
                    h(
                      "div",
                      { className: "attention-activity-row" },
                      h(Icon, { name: timer ? "clock" : "chat" }),
                      h(
                        "span",
                        { className: "attention-activity-summary text-body-sm text-secondary" },
                        (entry.type === "catch-up" ? `Caught up on ${entry.count} missed message${entry.count === 1 ? "" : "s"}${entry.skipped ? " (older skipped)" : ""} · ` : "") +
                          (entry.text || "Recorded event") +
                          (entry.outcome && entry.outcome !== "ok" ? ` · ${WAKE_OUTCOME[entry.outcome] ?? entry.outcome}` : !entry.outcome ? " · running…" : ""),
                      ),
                      h("span", { className: "attention-activity-time text-caption text-subtle" }, relative(entry.at)),
                    ),
                  ),
                ),
                !w.activity?.length && h("li", null, h("p", { className: "text-body-sm text-subtle" }, "No activity yet")),
              ),
            ),
          ),
        ),
    );
  }

  function InterestCard({ interest, watches, agentName, name, channelOf, openConversation, act, busy }) {
    const [confirming, setConfirming] = React.useState(false);
    const [error, setError] = React.useState("");
    const label = interest.title || titleOf(interest.id);
    const remove = () =>
      act(`ri:${interest.id}`, "attention.edit", { op: "removeInterest", id: interest.id })
        .then(() => setConfirming(false))
        .catch((e) => setError(e.message));
    const firstLine = interest.instructions.split("\n").find((line) => line.trim() && !/^#+\s/.test(line)) || interest.instructions.split("\n").find((l) => l.trim()) || "";
    return h(
      "div",
      { "data-buzz-ui": "", className: "buzz-settings-group", "data-layout": "cards" },
      h(
        "section",
        { className: "attention-interest", "aria-label": `Interest ${label}` },
        h(
          "div",
          { className: "attention-interest-head" },
          h("h4", { className: "text-label" }, label),
          h(
            "div",
            { className: "attention-actions" },
            h(Menu, {
              label: `Interest status for ${label}`,
              heading: "Interest",
              trigger: (props) => h(StatusPill, { active: !interest.paused, label: `Interest status for ${label}`, ...props }),
              items: [
                {
                  label: interest.paused ? "Resume" : "Pause",
                  disabled: busy,
                  onClick: () => act(`pause:${interest.id}`, "attention.edit", { op: "pause", id: interest.id, paused: !interest.paused }).catch((e) => setError(e.message)),
                },
                "separator",
                { label: "Delete", tone: "danger", disabled: busy, onClick: () => (watches.length ? setConfirming(true) : void remove()) },
              ],
            }),
          ),
        ),
        interest.summary && h("p", { className: "attention-interest-summary text-body-sm text-subtle" }, interest.summary),
        watches.length > 0
          ? h(
              "div",
              { className: "attention-column-headings text-caption text-subtle" },
              h("h5", { className: "text-caption" }, "Triggers"),
              h("span", null, "Sources"),
              h("span", null, "Responds in"),
              h("span", null, "Status"),
            )
          : h(
              React.Fragment,
              null,
              h("h5", { className: "attention-section-label text-caption text-subtle" }, "Triggers"),
              h("p", { className: "text-body-sm text-subtle" }, "No watches yet, so nothing wakes this interest."),
            ),
        h(
          "ul",
          { className: "attention-list", "aria-label": `${label} watches` },
          ...watches.map((w) =>
            h(WatchRow, { key: w.id, w, interestPaused: interest.paused, agentName, name, channelOf, openConversation, act, busy }),
          ),
        ),
        h("h5", { className: "attention-section-label text-caption text-subtle" }, "Instructions"),
        h(
          "details",
          { className: "attention-instructions" },
          h(
            "summary",
            { className: "attention-disclosure text-body-sm text-subtle" },
            h("span", { className: "attention-disclosure-icon" }, h(Icon, { name: "bolt" })),
            h("span", { className: "attention-instructions-preview" }, plain(firstLine)),
            h(Icon, { name: "caret" }),
          ),
          h(InstructionsMarkdown, { text: interest.instructions }),
        ),
        error && h("p", { role: "alert", className: "text-body-sm text-danger" }, error),
      ),
      confirming &&
        h(Confirm, {
          title: `Delete ${label}?`,
          description: "This deletes the interest and all its watches. The agent will stop watching for these triggers. This cannot be undone.",
          pending: busy,
          error,
          onCancel: () => setConfirming(false),
          onConfirm: remove,
        }),
    );
  }

  // Buzz's own Attention tab (local Buzz patch 0005-attention-tab-for-hosted),
  // fed from buzz-host, which keeps the agent's attention in Buzz's record
  // format; this plugin's own tab otherwise.
  function AttentionTab(props) {
    let factory;
    try {
      const provided = ctx.reflect?.get?.("attentionTab");
      factory = provided?.version === 1 ? provided : undefined;
    } catch {}
    return factory ? h(NativeAttention, { ...props, factory }) : h(OwnAttentionTab, props);
  }

  /** buzz-host's view of one agent's Attention, as the source Buzz's tab
   * reads: snapshot (the agent in `running`, with its attention fields),
   * subscribe (polls while shown) and save (Buzz's AgentChange edits); and
   * `setting`, Buzz's Attention row for it: where it runs, and its switch. */
  function hostedAttention(pubkey) {
    let view;
    let agent;
    let error = "";
    let busy = false;
    let snapshot = Object.freeze({ status: "loading", classifier: "unavailable", running: [], agents: [] });
    let state = Object.freeze({ view, error });
    const listeners = new Set();
    let timer;
    const emit = () => {
      for (const listener of [...listeners]) listener();
    };
    const build = () => {
      state = Object.freeze({ view, error, busy });
      if (!view || !agent) return;
      const r = view.record;
      const shown = Object.freeze({
        ...agent,
        attention: r.attention,
        skipped: r.skipped ?? {},
        timers: r.timers ?? {},
        ...(r.attentionHistory ? { attentionHistory: r.attentionHistory } : {}),
        ...(r.sourceRuns ? { sourceRuns: r.sourceRuns } : {}),
      });
      // buzz-host runs no message filters yet (Buzz then says so above them).
      snapshot = Object.freeze({ status: "ready", classifier: "unavailable", running: [shown], agents: [shown] });
    };
    const changed = () => {
      build();
      emit();
    };
    const refresh = async () => {
      try {
        view = await client.call("attention.view", { pubkey }, { timeoutMs: 30000 });
        error = "";
      } catch (e) {
        error = String(e.message ?? e);
      }
      changed();
    };
    const subscribe = (listener) => {
      listeners.add(listener);
      if (listeners.size === 1) {
        void refresh();
        timer = setInterval(refresh, 10000);
      }
      return () => {
        listeners.delete(listener);
        if (!listeners.size) clearInterval(timer);
      };
    };
    // Turning it on or off restarts the agent, so its sessions gain or lose the tools.
    const toggle = async () => {
      if (busy || !view) return;
      busy = true;
      error = "";
      changed();
      try {
        await client.call("attention.set", { pubkey, enabled: !view.enabled }, { timeoutMs: 90000 });
      } catch (e) {
        error = String(e.message ?? e);
      }
      busy = false;
      await refresh();
    };
    const setting = (shown) => {
      const name = shown.name || "the agent";
      const on = view?.enabled === true;
      const work = on && view && (view.queued > 0 || view.inFlight.length > 0) ? ` ${view.inFlight.length} running · ${view.queued} waiting.` : "";
      return {
        subtitle: error
          ? error
          : busy
            ? `Restarting ${name}…`
            : on
              ? `Let ${name} watch for updates and check in on a schedule. Runs on your server, also while this computer is off.${work}`
              : `Off: ${name} has no Attention tools, and its saved watches and timers wake nothing. Turning it on restarts ${name}.`,
        trailing: h(
          "button",
          {
            type: "button",
            role: "switch",
            "aria-checked": on,
            "aria-label": `Attention for ${name}`,
            "data-buzz-ui": "",
            className: "buzz-switch-control",
            "data-checked": on ? "" : undefined,
            "data-unchecked": on ? undefined : "",
            "data-disabled": busy ? "" : undefined,
            disabled: busy,
            onClick: () => void toggle(),
          },
          h("span", { className: "buzz-switch-thumb", "data-checked": on ? "" : undefined }),
        ),
      };
    };
    return {
      source: {
        snapshot: () => snapshot,
        subscribe,
        async save(_key, change) {
          view = await client.call("attention.change", { pubkey, change }, { timeoutMs: 60000 });
          changed();
        },
      },
      setting,
      state: () => state,
      subscribe,
      setAgent(next) {
        if (next === agent) return;
        agent = next;
        changed();
      },
    };
  }

  function NativeAttention({ agent, factory }) {
    const pubkey = agent.pubkey;
    const store = React.useMemo(() => hostedAttention(pubkey), [pubkey]);
    const Tab = React.useMemo(() => factory.create(store.source, store.setting), [factory, store]);
    React.useEffect(() => store.setAgent(agent), [store, agent]);
    const { view, error } = React.useSyncExternalStore(store.subscribe, store.state, store.state);
    const page = (children) =>
      h("section", { "data-buzz-ui": "", className: "attention-page", "aria-label": "Attention on your server" }, h("div", { className: "attention-content" }, children));
    return h(
      React.Fragment,
      null,
      !view && error && page(h("p", { role: "alert", className: "text-body-sm text-danger" }, error)),
      h(Tab, { agent: { key: agent.key } }),
      view?.history.length > 0 &&
        page(
          h(
            "details",
            { className: "attention-watch-activity" },
            h(
              "summary",
              { className: "attention-disclosure text-body-sm text-subtle" },
              h("span", { className: "attention-disclosure-icon" }, h(Icon, { name: "clock" })),
              "Recent wakes on your server",
              h("span", { className: "attention-detail-preview" }, `${view.history.length}`),
              h(Icon, { name: "caret" }),
            ),
            h(
              "ol",
              { className: "attention-timeline" },
              ...view.history.slice(0, 30).map((wake, i) =>
                h(
                  "li",
                  { key: wake.id ?? i, className: "attention-timeline-event" },
                  h(
                    "div",
                    { className: "attention-activity-row" },
                    h(Icon, { name: wake.type === "timer" ? "clock" : "chat" }),
                    h(
                      "span",
                      { className: "attention-activity-summary text-body-sm text-secondary" },
                      `${wake.type === "timer" ? "Timer" : wake.type === "catch-up" ? `Catch-up (${wake.count} missed)` : "Watch"} ${String(wake.slug).replace(/^watch\//, "")} · ${wake.outcome ? WAKE_OUTCOME[wake.outcome] ?? wake.outcome : "running…"}${wake.text ? ` · ${wake.text}` : ""}`,
                    ),
                    h("span", { className: "attention-activity-time text-caption text-subtle" }, relative(wake.at)),
                  ),
                ),
              ),
            ),
          ),
        ),
    );
  }

  function OwnAttentionTab({ agent, openConversation }) {
    const pubkey = agent.pubkey;
    const [state, setState] = React.useState();
    const [error, setError] = React.useState("");
    const [busy, setBusy] = React.useState("");
    const channels = useChannels();
    const load = React.useCallback(
      async (signal) => {
        try {
          setState(await client.call("attention.get", { pubkey }, { signal, timeoutMs: 30000 }));
          setError("");
        } catch (e) {
          if (!signal?.aborted) setError(e.message);
        }
      },
      [pubkey],
    );
    React.useEffect(() => {
      const controller = new AbortController();
      void load(controller.signal);
      const timer = setInterval(() => void load(controller.signal), 15000);
      return () => {
        controller.abort();
        clearInterval(timer);
      };
    }, [load]);
    /** Runs a buzz-host call; rejects with its error (callers show it in place). */
    const act = async (key, method, params) => {
      setBusy(key);
      try {
        setState(await client.call(method, { pubkey, ...params }, { timeoutMs: 90000 }));
        setError("");
      } finally {
        setBusy("");
      }
    };
    const find = (id) => channels.find((channel) => channel.id === id);
    const name = (id) => find(id)?.name ?? `Channel ${id.slice(0, 8)}`;
    const channelOf = (id) => {
      const c = find(id);
      return c?.channelType === "solo" || c?.channelType === "dm" ? "chat" : c?.private ? "lock" : "hash";
    };
    const agentName = agent.name || "the agent";
    const page = (children) =>
      h("section", { "data-buzz-ui": "", className: "attention-page", "aria-label": "Attention" }, h("div", { className: "attention-content" }, children));
    if (!state) return page(h("p", { className: "text-body-sm text-secondary", role: error ? "alert" : "status" }, error || "Loading watches…"));
    const byInterest = new Map(state.interests.map((i) => [i.id, []]));
    for (const w of state.watches) byInterest.get(w.interest)?.push(w);
    const empty = !state.interests.length && !state.orphans.length;
    const toggle = () =>
      act("enable", "attention.set", { enabled: !state.enabled }).catch((e) => setError(e.message));
    return page(
      h(
        "div",
        { className: "attention-agent" },
        h(
          "div",
          { "data-buzz-ui": "", className: "buzz-settings-group", "data-layout": "cards" },
          h(
            "section",
            { className: "attention-setting", "aria-label": "Attention settings" },
            state.enabled && !empty && h(Sonar, { name: agentName, picture: agent.picture }),
            h(
              "div",
              { "data-buzz-ui": "", className: "buzz-preference-row", "data-variant": "default" },
              h(
                "div",
                { className: "buzz-preference-row-content" },
                h("div", { className: "buzz-preference-row-label" }, "Attention"),
                h(
                  "span",
                  { className: "buzz-preference-row-description" },
                  busy === "enable"
                    ? `Restarting ${agentName}…`
                    : state.enabled
                      ? `Let ${agentName} watch for updates and check in on a schedule. Runs on your server, also while this computer is off.`
                      : `Off: ${agentName} has no Attention tools, and its saved watches and timers wake nothing. Turning it on restarts ${agentName}.`,
                ),
              ),
              h(
                "div",
                { className: "buzz-preference-row-trailing" },
                h(
                  "button",
                  {
                    type: "button",
                    role: "switch",
                    "aria-checked": state.enabled,
                    "aria-label": `Attention for ${agentName}`,
                    "data-buzz-ui": "",
                    className: "buzz-switch-control",
                    "data-checked": state.enabled ? "" : undefined,
                    "data-unchecked": state.enabled ? undefined : "",
                    "data-disabled": busy ? "" : undefined,
                    disabled: !!busy,
                    onClick: toggle,
                  },
                  h("span", { className: "buzz-switch-thumb", "data-checked": state.enabled ? "" : undefined }),
                ),
              ),
            ),
          ),
        ),
        error && h("p", { role: "alert", className: "text-body-sm text-danger" }, error),
        state.enabled && (state.queued > 0 || state.inFlight.length > 0) &&
          h("p", { className: "text-body-sm text-secondary" }, `${state.inFlight.length} running · ${state.queued} waiting`),
        ...state.interests.map((interest) =>
          h(InterestCard, {
            key: interest.id,
            interest,
            watches: byInterest.get(interest.id) ?? [],
            agentName,
            name,
            channelOf,
            openConversation,
            act,
            busy: !!busy,
          }),
        ),
        state.orphans.length > 0 &&
          h(
            "section",
            { className: "attention-card" },
            h("h4", { className: "text-label" }, "Stray watches"),
            h("p", { className: "text-body-sm text-subtle" }, "These saved watches have no matching Interest. Remove them and create watches under an Interest."),
            ...state.orphans.map((id) =>
              h(
                "div",
                { key: id, className: "attention-agent-head" },
                h("span", { className: "text-body-sm" }, `watch/${id}`),
                h(Btn, { size: "sm", variant: "ghost", disabled: !!busy, onClick: () => act(`rw:${id}`, "attention.edit", { op: "removeWatch", id }).catch((e) => setError(e.message)) }, `Delete watch/${id}`),
              ),
            ),
          ),
        state.enabled && empty &&
          h(
            "section",
            { "aria-label": "Start watching" },
            h(
              "div",
              { "data-buzz-ui": "", className: "buzz-empty-state" },
              h(
                "div",
                { className: "buzz-empty-state-content" },
                h("span", { className: "buzz-empty-state-icon", "aria-hidden": "true" }, h(Sonar, { name: agentName, picture: agent.picture, size: "large" })),
                h(
                  "div",
                  { className: "buzz-empty-state-copy" },
                  h("h3", { className: "buzz-empty-state-title" }, "Attention"),
                  h(
                    "p",
                    { className: "buzz-empty-state-description" },
                    `Attention lets ${agentName} watch for messages and updates across Buzz, then act or notify you based on your instructions. Send ${agentName} a message to get started.`,
                  ),
                ),
              ),
            ),
          ),
        state.history.length > 0 &&
          h(
            "details",
            { className: "attention-watch-activity" },
            h(
              "summary",
              { className: "attention-disclosure text-body-sm text-subtle" },
              h("span", { className: "attention-disclosure-icon" }, h(Icon, { name: "clock" })),
              "Recent wakes on your server",
              h("span", { className: "attention-detail-preview" }, `${state.history.length}`),
              h(Icon, { name: "caret" }),
            ),
            h(
              "ol",
              { className: "attention-timeline" },
              ...state.history.slice(0, 30).map((wake, i) =>
                h(
                  "li",
                  { key: wake.id ?? i, className: "attention-timeline-event" },
                  h(
                    "div",
                    { className: "attention-activity-row" },
                    h(Icon, { name: wake.type === "timer" ? "clock" : "chat" }),
                    h(
                      "span",
                      { className: "attention-activity-summary text-body-sm text-secondary" },
                      `${wake.type === "timer" ? "Timer" : wake.type === "catch-up" ? `Catch-up (${wake.count} missed)` : "Watch"} ${String(wake.slug).replace(/^watch\//, "")} · ${wake.outcome ? WAKE_OUTCOME[wake.outcome] ?? wake.outcome : "running…"}${wake.text ? ` · ${wake.text}` : ""}`,
                    ),
                    h("span", { className: "attention-activity-time text-caption text-subtle" }, relative(wake.at)),
                  ),
                ),
              ),
            ),
          ),
      ),
    );
  }

  // ----- Buzz's composer: model, effort and session controls -----
  // Local Buzz patch 0006-models-for-hosted lets a hosted type offer `models`
  // and `sessionControls`; stock Buzz refuses `models` on a hosted type, so
  // the type registers again without them there (see the register below).

  // Buzz asks again whenever the agents a draft mentions change; buzz-host
  // probes the runtime only when its own cache is empty or old.
  const catalogCache = new Map();
  const catalogNotify = new Set();
  const CATALOG_TTL = 5 * 60_000;
  function invalidateCatalog(pubkey) {
    catalogCache.delete(pubkey);
    for (const listener of [...catalogNotify]) listener();
  }
  if (typeof ctx.agents.registerTab === "function") {
    // Hidden tab whose subscribe() bumps Buzz's agents snapshot so open
    // composers re-read hostedModels() immediately after settings.set changes
    // an agent's runtime, profile, or model on buzz-host.
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
  function hostedModels(agent) {
    const key = agent.pubkey;
    const hit = catalogCache.get(key);
    if (hit?.value && Date.now() - hit.at < CATALOG_TTL) return hit.value;
    if (hit?.pending) return hit.value ?? hit.pending;
    const pending = client
      .call("catalog", { pubkey: agent.pubkey }, { timeoutMs: 180000 })
      .then((value) => {
        if (catalogCache.get(key)?.pending === pending)
          catalogCache.set(key, { at: Date.now(), value });
        return value;
      })
      .catch((error) => {
        if (catalogCache.get(key)?.pending === pending) {
          if (hit?.value) catalogCache.set(key, hit);
          else catalogCache.delete(key);
        }
        throw error;
      });
    catalogCache.set(key, { ...(hit ?? {}), pending });
    return hit?.value ?? pending;
  }

  // Buzz reads a conversation's session state synchronously and often: answer
  // with what buzz-host last said, and ask buzz-host again every few seconds
  // for the conversations Buzz is still reading (each notify makes it read).
  const hostedSessions = (() => {
    const known = new Map();
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

  const omarchyType = {
    id: "omarchy",
    title: "Omarchy",
    description: "Hosted on your own server with buzz-host; keeps answering while this computer is off.",
    defaults: () => ({ config: { ...EMPTY } }),
    adopt: (carry, saved) => ({ ...asConfig(saved), instructions: carry.instructions ?? asConfig(saved).instructions }),
    carry: (config) => ({ instructions: asConfig(config).instructions }),
    summary: () => "Runs on your server",
    Create,
    CreateConfiguration,
    tabs: [
      { id: "activity", title: "Activity", role: "activity", component: ActivityTab },
      { id: "attention", title: "Attention", component: AttentionTab },
      { id: "settings", title: "Settings", role: "settings", splitSettings: true, component: SettingsTab },
    ],
    remote: {
      async provision({ name, picture, community, config, signal }) {
        const c = asConfig(config);
        return client.call(
          "provision",
          { name, picture, community, config: { runtime: c.runtime, model: c.model.trim(), profile: c.runtime === "hermes" ? c.profile : "", instructions: c.instructions } },
          { signal },
        );
      },
      async activate({ pubkey, name, community, auth, config, signal }) {
        const c = config === undefined ? undefined : asConfig(config);
        await client.call(
          "activate",
          {
            pubkey,
            name,
            community,
            auth,
            ...(c ? { config: { runtime: c.runtime, model: c.model.trim(), profile: c.runtime === "hermes" ? c.profile : "", instructions: c.instructions } } : {}),
          },
          { signal, timeoutMs: 180000 },
        );
      },
      async profile({ pubkey, community, name, picture, signal }) {
        await client.call("profile", { pubkey, community, name, picture }, { signal });
      },
      // Buzz's Stop for a turn in one conversation (channel + thread root).
      async interrupt({ pubkey, channelId, threadRootId, signal }) {
        const r = await client.call("interrupt", { pubkey, channelId, threadRootId }, { signal, timeoutMs: 20000 });
        return !!r.cancelled;
      },
      instructions: {
        async get({ pubkey, signal }) {
          return (await client.call("instructions.get", { pubkey }, { signal })).instructions;
        },
        async set({ pubkey, instructions, signal }) {
          await client.call("instructions.set", { pubkey, instructions }, { signal });
        },
      },
      async remove({ pubkey, signal }) {
        await client.call("remove", { pubkey }, { signal });
      },
    },
  };
  try {
    ctx.agents.register({ ...omarchyType, models: hostedModels, sessionControls: hostedSessions });
  } catch (error) {
    // Stock Buzz: "A hosted agent type has … no run, models or timeoutMs".
    if (!/models/.test(String(error?.message ?? error))) throw error;
    ctx.agents.register(omarchyType);
  }

  // The in-chat desktop preview, after Buzz's own activity bubble (order 0).
  ctx.conversation.registerAccessory({
    id: "desktop-preview",
    title: "Agent desktop preview",
    placement: "response",
    order: 10,
    component: DesktopPreview,
  });

  // The in-chat orchestrator worker card, right after the desktop preview.
  ctx.conversation.registerAccessory({
    id: "orchestrator-tasks",
    title: "Orchestrator workers",
    placement: "response",
    order: 11,
    component: OrchestratorCard,
  });

  // ----- Settings → Omarchy agents: server address and status -----
  ctx.settingsCards.register({
    id: "server",
    title: "Omarchy agents",
    group: "Plugins",
    component: function ServerCard() {
      const state = React.useSyncExternalStore(client.subscribe, client.snapshot);
      const [url, setUrl] = React.useState(storedUrl());
      const [info, setInfo] = React.useState();
      const [error, setError] = React.useState("");
      const check = async () => {
        setError("");
        setInfo(undefined);
        try {
          try {
            localStorage.setItem(URL_KEY, url.trim() || DEFAULT_URL);
          } catch {}
          await client.reconnect();
          const [hello, list] = await Promise.all([client.call("hello"), client.call("list")]);
          setInfo({ hello, list });
        } catch (e) {
          setError(String(e.message ?? e));
        }
      };
      React.useEffect(() => {
        void check();
        // biome-ignore lint: check once on open
      }, []);
      return h(
        "div",
        { style: { display: "grid", gap: "var(--space-3)" } },
        h(
          Note,
          null,
          "Agents of type Omarchy run on your server with buzz-host. Create them in Agents → New agent → Harness → Remote → Omarchy. In a chat, tag the agent with /model, /effort, /new, /stop, /status or /help to control that chat (or thread).",
        ),
        h(
          Row,
          { label: "Server", hint: "A wss:// address published with tailscale serve." },
          h(Text, { value: url, onChange: (e) => setUrl(e.target.value) }),
        ),
        h(
          "div",
          { style: { display: "flex", gap: "var(--space-2)" } },
          h("button", { type: "button", onClick: () => void check() }, "Save and check"),
        ),
        h(Note, { tone: error ? "error" : undefined }, error || `Connection: ${state.status}`),
        info &&
          h(
            Note,
            null,
            `Host ${info.hello.host} · runtimes: ${info.hello.runtimes
              .map((r) => `${r.title}${r.available ? "" : " (missing)"}`)
              .join(", ")}\n` +
              (info.list.agents.length
                ? info.list.agents
                    .map((a) => `• ${a.name} — ${a.runtime}${a.model ? `/${a.model}` : ""} — ${a.status}`)
                    .join("\n")
                : "No agents yet."),
          ),
      );
    },
  });
}

// ---------- GENERATED by plugin/build-markdown.mjs from buzz-app 51d63954 2026-11-13. Do not edit; rerun it. ----------
// Buzz's Markdown parser: mdast-util-from-markdown 2.0.3, micromark-extension-gfm 3.0.0, mdast-util-gfm 3.1.0
// (MIT, by Titus Wormer), as react-markdown and remark-gfm run it in Buzz.
function markdownParser() {
  return (markdownParser.loaded ??= (() => {
return (function(e){Object.defineProperty(e,Symbol.toStringTag,{value:`Module`});var t=Object.defineProperty,n=(e,n)=>{let r={};for(var i in e)t(r,i,{get:e[i],enumerable:!0});return n||t(r,Symbol.toStringTag,{value:`Module`}),r};let r={};function i(e,t){let n=t||r;return a(e,typeof n.includeImageAlt!=`boolean`||n.includeImageAlt,typeof n.includeHtml!=`boolean`||n.includeHtml)}function a(e,t,n){if(s(e)){if(`value`in e)return e.type===`html`&&!n?``:e.value;if(t&&`alt`in e&&e.alt)return e.alt;if(`children`in e)return o(e.children,t,n)}return Array.isArray(e)?o(e,t,n):``}function o(e,t,n){let r=[],i=-1;for(;++i<e.length;)r[i]=a(e[i],t,n);return r.join(``)}function s(e){return!!(e&&typeof e==`object`)}let c=document.createElement(`i`);function l(e){let t=`&`+e+`;`;c.innerHTML=t;let n=c.textContent;return n.charCodeAt(n.length-1)===59&&e!==`semi`?!1:n!==t&&n}function u(e,t,n,r){let i=e.length,a=0,o;if(t=t<0?-t>i?0:i+t:t>i?i:t,n=n>0?n:0,r.length<1e4)o=Array.from(r),o.unshift(t,n),e.splice(...o);else for(n&&e.splice(t,n);a<r.length;)o=r.slice(a,a+1e4),o.unshift(t,0),e.splice(...o),a+=1e4,t+=1e4}function d(e,t){return e.length>0?(u(e,e.length,0,t),e):t}let f={}.hasOwnProperty;function p(e){let t={},n=-1;for(;++n<e.length;)m(t,e[n]);return t}function m(e,t){let n;for(n in t){let r=(f.call(e,n)?e[n]:void 0)||(e[n]={}),i=t[n],a;if(i)for(a in i){f.call(r,a)||(r[a]=[]);let e=i[a];h(r[a],Array.isArray(e)?e:e?[e]:[])}}}function h(e,t){let n=-1,r=[];for(;++n<t.length;)(t[n].add===`after`?e:r).push(t[n]);u(e,0,0,r)}function g(e,t){let n=Number.parseInt(e,t);return n<9||n===11||n>13&&n<32||n>126&&n<160||n>55295&&n<57344||n>64975&&n<65008||(n&65535)==65535||(n&65535)==65534||n>1114111?`�`:String.fromCodePoint(n)}function _(e){return e.replace(/[\t\n\r ]+/g,` `).replace(/^ | $/g,``).toLowerCase().toUpperCase()}let v=A(/[A-Za-z]/),y=A(/[\dA-Za-z]/),b=A(/[#-'*+\--9=?A-Z^-~]/);function x(e){return e!==null&&(e<32||e===127)}let S=A(/\d/),C=A(/[\dA-Fa-f]/),w=A(/[!-/:-@[-`{-~]/);function T(e){return e!==null&&e<-2}function E(e){return e!==null&&(e<0||e===32)}function D(e){return e===-2||e===-1||e===32}let O=A(/\p{P}|\p{S}/u),k=A(/\s/);function A(e){return t;function t(t){return t!==null&&t>-1&&e.test(String.fromCharCode(t))}}function j(e,t,n,r){let i=r?r-1:1/0,a=0;return o;function o(r){return D(r)?(e.enter(n),s(r)):t(r)}function s(r){return D(r)&&a++<i?(e.consume(r),s):(e.exit(n),t(r))}}let M={tokenize:N};function N(e){let t=e.attempt(this.parser.constructs.contentInitial,r,i),n;return t;function r(n){if(n===null){e.consume(n);return}return e.enter(`lineEnding`),e.consume(n),e.exit(`lineEnding`),j(e,t,`linePrefix`)}function i(t){return e.enter(`paragraph`),a(t)}function a(t){let r=e.enter(`chunkText`,{contentType:`text`,previous:n});return n&&(n.next=r),n=r,o(t)}function o(t){if(t===null){e.exit(`chunkText`),e.exit(`paragraph`),e.consume(t);return}return T(t)?(e.consume(t),e.exit(`chunkText`),a):(e.consume(t),o)}}let P={tokenize:I},F={tokenize:ee};function I(e){let t=this,n=[],r=0,i,a,o;return s;function s(i){if(r<n.length){let a=n[r];return t.containerState=a[1],e.attempt(a[0].continuation,c,l)(i)}return l(i)}function c(e){if(r++,t.containerState._closeFlow){t.containerState._closeFlow=void 0,i&&y();let n=t.events.length,a=n,o;for(;a--;)if(t.events[a][0]===`exit`&&t.events[a][1].type===`chunkFlow`){o=t.events[a][1].end;break}v(r);let s=n;for(;s<t.events.length;)t.events[s][1].end={...o},s++;return u(t.events,a+1,0,t.events.slice(n)),t.events.length=s,l(e)}return s(e)}function l(a){if(r===n.length){if(!i)return p(a);if(i.currentConstruct&&i.currentConstruct.concrete)return h(a);t.interrupt=!(!i.currentConstruct||i._gfmTableDynamicInterruptHack)}return t.containerState={},e.check(F,d,f)(a)}function d(e){return i&&y(),v(r),p(e)}function f(e){return t.parser.lazy[t.now().line]=r!==n.length,o=t.now().offset,h(e)}function p(n){return t.containerState={},e.attempt(F,m,h)(n)}function m(e){return r++,n.push([t.currentConstruct,t.containerState]),p(e)}function h(n){if(n===null){i&&y(),v(0),e.consume(n);return}return i||=t.parser.flow(t.now()),e.enter(`chunkFlow`,{_tokenizer:i,contentType:`flow`,previous:a}),g(n)}function g(n){if(n===null){_(e.exit(`chunkFlow`),!0),v(0),e.consume(n);return}return T(n)?(e.consume(n),_(e.exit(`chunkFlow`)),r=0,t.interrupt=void 0,s):(e.consume(n),g)}function _(e,n){let s=t.sliceStream(e);if(n&&s.push(null),e.previous=a,a&&(a.next=e),a=e,i.defineSkip(e.start),i.write(s),t.parser.lazy[e.start.line]){let e=i.events.length;for(;e--;)if(i.events[e][1].start.offset<o&&(!i.events[e][1].end||i.events[e][1].end.offset>o))return;let n=t.events.length,a=n,s,c;for(;a--;)if(t.events[a][0]===`exit`&&t.events[a][1].type===`chunkFlow`){if(s){c=t.events[a][1].end;break}s=!0}for(v(r),e=n;e<t.events.length;)t.events[e][1].end={...c},e++;u(t.events,a+1,0,t.events.slice(n)),t.events.length=e}}function v(r){let i=n.length;for(;i-->r;){let r=n[i];t.containerState=r[1],r[0].exit.call(t,e)}n.length=r}function y(){i.write([null]),a=void 0,i=void 0,t.containerState._closeFlow=void 0}}function ee(e,t,n){return j(e,e.attempt(this.parser.constructs.document,t,n),`linePrefix`,this.parser.constructs.disable.null.includes(`codeIndented`)?void 0:4)}function L(e){if(e===null||E(e)||k(e))return 1;if(O(e))return 2}function R(e,t,n){let r=[],i=-1;for(;++i<e.length;){let a=e[i].resolveAll;a&&!r.includes(a)&&(t=a(t,n),r.push(a))}return t}let z={name:`attention`,resolveAll:B,tokenize:V};function B(e,t){let n=-1,r,i,a,o,s,c,l,f;for(;++n<e.length;)if(e[n][0]===`enter`&&e[n][1].type===`attentionSequence`&&e[n][1]._close){for(r=n;r--;)if(e[r][0]===`exit`&&e[r][1].type===`attentionSequence`&&e[r][1]._open&&t.sliceSerialize(e[r][1]).charCodeAt(0)===t.sliceSerialize(e[n][1]).charCodeAt(0)){if((e[r][1]._close||e[n][1]._open)&&(e[n][1].end.offset-e[n][1].start.offset)%3&&!((e[r][1].end.offset-e[r][1].start.offset+e[n][1].end.offset-e[n][1].start.offset)%3))continue;c=e[r][1].end.offset-e[r][1].start.offset>1&&e[n][1].end.offset-e[n][1].start.offset>1?2:1;let p={...e[r][1].end},m={...e[n][1].start};H(p,-c),H(m,c),o={type:c>1?`strongSequence`:`emphasisSequence`,start:p,end:{...e[r][1].end}},s={type:c>1?`strongSequence`:`emphasisSequence`,start:{...e[n][1].start},end:m},a={type:c>1?`strongText`:`emphasisText`,start:{...e[r][1].end},end:{...e[n][1].start}},i={type:c>1?`strong`:`emphasis`,start:{...o.start},end:{...s.end}},e[r][1].end={...o.start},e[n][1].start={...s.end},l=[],e[r][1].end.offset-e[r][1].start.offset&&(l=d(l,[[`enter`,e[r][1],t],[`exit`,e[r][1],t]])),l=d(l,[[`enter`,i,t],[`enter`,o,t],[`exit`,o,t],[`enter`,a,t]]),l=d(l,R(t.parser.constructs.insideSpan.null,e.slice(r+1,n),t)),l=d(l,[[`exit`,a,t],[`enter`,s,t],[`exit`,s,t],[`exit`,i,t]]),e[n][1].end.offset-e[n][1].start.offset?(f=2,l=d(l,[[`enter`,e[n][1],t],[`exit`,e[n][1],t]])):f=0,u(e,r-1,n-r+3,l),n=r+l.length-f-2;break}}for(n=-1;++n<e.length;)e[n][1].type===`attentionSequence`&&(e[n][1].type=`data`);return e}function V(e,t){let n=this.parser.constructs.attentionMarkers.null,r=this.previous,i=L(r),a;return o;function o(t){return a=t,e.enter(`attentionSequence`),s(t)}function s(o){if(o===a)return e.consume(o),s;let c=e.exit(`attentionSequence`),l=L(o),u=!l||l===2&&i||n.includes(o),d=!i||i===2&&l||n.includes(r);return c._open=!!(a===42?u:u&&(i||!d)),c._close=!!(a===42?d:d&&(l||!u)),t(o)}}function H(e,t){e.column+=t,e.offset+=t,e._bufferIndex+=t}let te={name:`autolink`,tokenize:ne};function ne(e,t,n){let r=0;return i;function i(t){return e.enter(`autolink`),e.enter(`autolinkMarker`),e.consume(t),e.exit(`autolinkMarker`),e.enter(`autolinkProtocol`),a}function a(t){return v(t)?(e.consume(t),o):t===64?n(t):l(t)}function o(e){return e===43||e===45||e===46||y(e)?(r=1,s(e)):l(e)}function s(t){return t===58?(e.consume(t),r=0,c):(t===43||t===45||t===46||y(t))&&r++<32?(e.consume(t),s):(r=0,l(t))}function c(r){return r===62?(e.exit(`autolinkProtocol`),e.enter(`autolinkMarker`),e.consume(r),e.exit(`autolinkMarker`),e.exit(`autolink`),t):r===null||r===32||r===60||x(r)?n(r):(e.consume(r),c)}function l(t){return t===64?(e.consume(t),u):b(t)?(e.consume(t),l):n(t)}function u(e){return y(e)?d(e):n(e)}function d(n){return n===46?(e.consume(n),r=0,u):n===62?(e.exit(`autolinkProtocol`).type=`autolinkEmail`,e.enter(`autolinkMarker`),e.consume(n),e.exit(`autolinkMarker`),e.exit(`autolink`),t):f(n)}function f(t){if((t===45||y(t))&&r++<63){let n=t===45?f:d;return e.consume(t),n}return n(t)}}let U={partial:!0,tokenize:re};function re(e,t,n){return r;function r(t){return D(t)?j(e,i,`linePrefix`)(t):i(t)}function i(e){return e===null||T(e)?t(e):n(e)}}let ie={continuation:{tokenize:oe},exit:se,name:`blockQuote`,tokenize:ae};function ae(e,t,n){let r=this;return i;function i(t){if(t===62){let n=r.containerState;return n.open||=(e.enter(`blockQuote`,{_container:!0}),!0),e.enter(`blockQuotePrefix`),e.enter(`blockQuoteMarker`),e.consume(t),e.exit(`blockQuoteMarker`),a}return n(t)}function a(n){return D(n)?(e.enter(`blockQuotePrefixWhitespace`),e.consume(n),e.exit(`blockQuotePrefixWhitespace`),e.exit(`blockQuotePrefix`),t):(e.exit(`blockQuotePrefix`),t(n))}}function oe(e,t,n){let r=this;return i;function i(t){return D(t)?j(e,a,`linePrefix`,r.parser.constructs.disable.null.includes(`codeIndented`)?void 0:4)(t):a(t)}function a(r){return e.attempt(ie,t,n)(r)}}function se(e){e.exit(`blockQuote`)}let ce={name:`characterEscape`,tokenize:le};function le(e,t,n){return r;function r(t){return e.enter(`characterEscape`),e.enter(`escapeMarker`),e.consume(t),e.exit(`escapeMarker`),i}function i(r){return w(r)?(e.enter(`characterEscapeValue`),e.consume(r),e.exit(`characterEscapeValue`),e.exit(`characterEscape`),t):n(r)}}let ue={name:`characterReference`,tokenize:de};function de(e,t,n){let r=this,i=0,a,o;return s;function s(t){return e.enter(`characterReference`),e.enter(`characterReferenceMarker`),e.consume(t),e.exit(`characterReferenceMarker`),c}function c(t){return t===35?(e.enter(`characterReferenceMarkerNumeric`),e.consume(t),e.exit(`characterReferenceMarkerNumeric`),u):(e.enter(`characterReferenceValue`),a=31,o=y,d(t))}function u(t){return t===88||t===120?(e.enter(`characterReferenceMarkerHexadecimal`),e.consume(t),e.exit(`characterReferenceMarkerHexadecimal`),e.enter(`characterReferenceValue`),a=6,o=C,d):(e.enter(`characterReferenceValue`),a=7,o=S,d(t))}function d(s){if(s===59&&i){let i=e.exit(`characterReferenceValue`);return o===y&&!l(r.sliceSerialize(i))?n(s):(e.enter(`characterReferenceMarker`),e.consume(s),e.exit(`characterReferenceMarker`),e.exit(`characterReference`),t)}return o(s)&&i++<a?(e.consume(s),d):n(s)}}let W={partial:!0,tokenize:me},fe={concrete:!0,name:`codeFenced`,tokenize:pe};function pe(e,t,n){let r=this,i={partial:!0,tokenize:x},a=0,o=0,s;return c;function c(e){return l(e)}function l(t){let n=r.events[r.events.length-1];return a=n&&n[1].type===`linePrefix`?n[2].sliceSerialize(n[1],!0).length:0,s=t,e.enter(`codeFenced`),e.enter(`codeFencedFence`),e.enter(`codeFencedFenceSequence`),u(t)}function u(t){return t===s?(o++,e.consume(t),u):o<3?n(t):(e.exit(`codeFencedFenceSequence`),D(t)?j(e,d,`whitespace`)(t):d(t))}function d(n){return n===null||T(n)?(e.exit(`codeFencedFence`),r.interrupt?t(n):e.check(W,h,b)(n)):(e.enter(`codeFencedFenceInfo`),e.enter(`chunkString`,{contentType:`string`}),f(n))}function f(t){return t===null||T(t)?(e.exit(`chunkString`),e.exit(`codeFencedFenceInfo`),d(t)):D(t)?(e.exit(`chunkString`),e.exit(`codeFencedFenceInfo`),j(e,p,`whitespace`)(t)):t===96&&t===s?n(t):(e.consume(t),f)}function p(t){return t===null||T(t)?d(t):(e.enter(`codeFencedFenceMeta`),e.enter(`chunkString`,{contentType:`string`}),m(t))}function m(t){return t===null||T(t)?(e.exit(`chunkString`),e.exit(`codeFencedFenceMeta`),d(t)):t===96&&t===s?n(t):(e.consume(t),m)}function h(t){return e.attempt(i,b,g)(t)}function g(t){return e.enter(`lineEnding`),e.consume(t),e.exit(`lineEnding`),_}function _(t){return a>0&&D(t)?j(e,v,`linePrefix`,a+1)(t):v(t)}function v(t){return t===null||T(t)?e.check(W,h,b)(t):(e.enter(`codeFlowValue`),y(t))}function y(t){return t===null||T(t)?(e.exit(`codeFlowValue`),v(t)):(e.consume(t),y)}function b(n){return e.exit(`codeFenced`),t(n)}function x(e,t,n){let i=0;return a;function a(t){return e.enter(`lineEnding`),e.consume(t),e.exit(`lineEnding`),c}function c(t){return e.enter(`codeFencedFence`),D(t)?j(e,l,`linePrefix`,r.parser.constructs.disable.null.includes(`codeIndented`)?void 0:4)(t):l(t)}function l(t){return t===s?(e.enter(`codeFencedFenceSequence`),u(t)):n(t)}function u(t){return t===s?(i++,e.consume(t),u):i>=o?(e.exit(`codeFencedFenceSequence`),D(t)?j(e,d,`whitespace`)(t):d(t)):n(t)}function d(r){return r===null||T(r)?(e.exit(`codeFencedFence`),t(r)):n(r)}}}function me(e,t,n){let r=this;return i;function i(t){return t===null?n(t):(e.enter(`lineEnding`),e.consume(t),e.exit(`lineEnding`),a)}function a(e){return r.parser.lazy[r.now().line]?n(e):t(e)}}let G={name:`codeIndented`,tokenize:ge},he={partial:!0,tokenize:_e};function ge(e,t,n){let r=this;return i;function i(t){return e.enter(`codeIndented`),j(e,a,`linePrefix`,5)(t)}function a(e){let t=r.events[r.events.length-1];return t&&t[1].type===`linePrefix`&&t[2].sliceSerialize(t[1],!0).length>=4?o(e):n(e)}function o(t){return t===null?c(t):T(t)?e.attempt(he,o,c)(t):(e.enter(`codeFlowValue`),s(t))}function s(t){return t===null||T(t)?(e.exit(`codeFlowValue`),o(t)):(e.consume(t),s)}function c(n){return e.exit(`codeIndented`),t(n)}}function _e(e,t,n){let r=this;return i;function i(t){return r.parser.lazy[r.now().line]?n(t):T(t)?(e.enter(`lineEnding`),e.consume(t),e.exit(`lineEnding`),i):j(e,a,`linePrefix`,5)(t)}function a(e){let a=r.events[r.events.length-1];return a&&a[1].type===`linePrefix`&&a[2].sliceSerialize(a[1],!0).length>=4?t(e):T(e)?i(e):n(e)}}let ve={name:`codeText`,previous:be,resolve:ye,tokenize:xe};function ye(e){let t=e.length-4,n=3,r,i;if((e[n][1].type===`lineEnding`||e[n][1].type===`space`)&&(e[t][1].type===`lineEnding`||e[t][1].type===`space`)){for(r=n;++r<t;)if(e[r][1].type===`codeTextData`){e[n][1].type=`codeTextPadding`,e[t][1].type=`codeTextPadding`,n+=2,t-=2;break}}for(r=n-1,t++;++r<=t;)i===void 0?r!==t&&e[r][1].type!==`lineEnding`&&(i=r):(r===t||e[r][1].type===`lineEnding`)&&(e[i][1].type=`codeTextData`,r!==i+2&&(e[i][1].end=e[r-1][1].end,e.splice(i+2,r-i-2),t-=r-i-2,r=i+2),i=void 0);return e}function be(e){return e!==96||this.events[this.events.length-1][1].type===`characterEscape`}function xe(e,t,n){let r=0,i,a;return o;function o(t){return e.enter(`codeText`),e.enter(`codeTextSequence`),s(t)}function s(t){return t===96?(e.consume(t),r++,s):(e.exit(`codeTextSequence`),c(t))}function c(t){return t===null?n(t):t===32?(e.enter(`space`),e.consume(t),e.exit(`space`),c):t===96?(a=e.enter(`codeTextSequence`),i=0,u(t)):T(t)?(e.enter(`lineEnding`),e.consume(t),e.exit(`lineEnding`),c):(e.enter(`codeTextData`),l(t))}function l(t){return t===null||t===32||t===96||T(t)?(e.exit(`codeTextData`),c(t)):(e.consume(t),l)}function u(n){return n===96?(e.consume(n),i++,u):i===r?(e.exit(`codeTextSequence`),e.exit(`codeText`),t(n)):(a.type=`codeTextData`,l(n))}}var Se=class{constructor(e){this.left=e?[...e]:[],this.right=[]}get(e){if(e<0||e>=this.left.length+this.right.length)throw RangeError("Cannot access index `"+e+"` in a splice buffer of size `"+(this.left.length+this.right.length)+"`");return e<this.left.length?this.left[e]:this.right[this.right.length-e+this.left.length-1]}get length(){return this.left.length+this.right.length}shift(){return this.setCursor(0),this.right.pop()}slice(e,t){let n=t??1/0;return n<this.left.length?this.left.slice(e,n):e>this.left.length?this.right.slice(this.right.length-n+this.left.length,this.right.length-e+this.left.length).reverse():this.left.slice(e).concat(this.right.slice(this.right.length-n+this.left.length).reverse())}splice(e,t,n){let r=t||0;this.setCursor(Math.trunc(e));let i=this.right.splice(this.right.length-r,1/0);return n&&K(this.left,n),i.reverse()}pop(){return this.setCursor(1/0),this.left.pop()}push(e){this.setCursor(1/0),this.left.push(e)}pushMany(e){this.setCursor(1/0),K(this.left,e)}unshift(e){this.setCursor(0),this.right.push(e)}unshiftMany(e){this.setCursor(0),K(this.right,e.reverse())}setCursor(e){if(!(e===this.left.length||e>this.left.length&&this.right.length===0||e<0&&this.left.length===0)){if(e<this.left.length){let t=this.left.splice(e,1/0);K(this.right,t.reverse())}else{let t=this.right.splice(this.left.length+this.right.length-e,1/0);K(this.left,t.reverse())}}}};function K(e,t){let n=0;if(t.length<1e4)e.push(...t);else for(;n<t.length;)e.push(...t.slice(n,n+1e4)),n+=1e4}function Ce(e){let t={},n=-1,r,i,a,o,s,c,l,d=new Se(e);for(;++n<d.length;){for(;n in t;)n=t[n];if(r=d.get(n),n&&r[1].type===`chunkFlow`&&d.get(n-1)[1].type===`listItemPrefix`&&(c=r[1]._tokenizer.events,a=0,a<c.length&&c[a][1].type===`lineEndingBlank`&&(a+=2),a<c.length&&c[a][1].type===`content`))for(;++a<c.length&&c[a][1].type!==`content`;)c[a][1].type===`chunkText`&&(c[a][1]._isInFirstContentOfListItem=!0,a++);if(r[0]===`enter`)r[1].contentType&&(Object.assign(t,we(d,n)),n=t[n],l=!0);else if(r[1]._container){for(a=n,i=void 0;a--;)if(o=d.get(a),o[1].type===`lineEnding`||o[1].type===`lineEndingBlank`)o[0]===`enter`&&(i&&(d.get(i)[1].type=`lineEndingBlank`),o[1].type=`lineEnding`,i=a);else if(o[1].type!==`linePrefix`&&o[1].type!==`listItemIndent`)break;i&&(r[1].end={...d.get(i)[1].start},s=d.slice(i,n),s.unshift(r),d.splice(i,n-i+1,s))}}return u(e,0,1/0,d.slice(0)),!l}function we(e,t){let n=e.get(t)[1],r=e.get(t)[2],i=t-1,a=[],o=n._tokenizer;o||(o=r.parser[n.contentType](n.start),n._contentTypeTextTrailing&&(o._contentTypeTextTrailing=!0));let s=o.events,c=[],l={},u,d,f=-1,p=n,m=0,h=0,g=[h];for(;p;){for(;e.get(++i)[1]!==p;);a.push(i),p._tokenizer||(u=r.sliceStream(p),p.next||u.push(null),d&&o.defineSkip(p.start),p._isInFirstContentOfListItem&&(o._gfmTasklistFirstContentOfListItem=!0),o.write(u),p._isInFirstContentOfListItem&&(o._gfmTasklistFirstContentOfListItem=void 0)),d=p,p=p.next}for(p=n;++f<s.length;)s[f][0]===`exit`&&s[f-1][0]===`enter`&&s[f][1].type===s[f-1][1].type&&s[f][1].start.line!==s[f][1].end.line&&(h=f+1,g.push(h),p._tokenizer=void 0,p.previous=void 0,p=p.next);for(o.events=[],p?(p._tokenizer=void 0,p.previous=void 0):g.pop(),f=g.length;f--;){let t=s.slice(g[f],g[f+1]),n=a.pop();c.push([n,n+t.length-1]),e.splice(n,2,t)}for(c.reverse(),f=-1;++f<c.length;)l[m+c[f][0]]=m+c[f][1],m+=c[f][1]-c[f][0]-1;return l}let Te={resolve:De,tokenize:Oe},Ee={partial:!0,tokenize:ke};function De(e){return Ce(e),e}function Oe(e,t){let n;return r;function r(t){return e.enter(`content`),n=e.enter(`chunkContent`,{contentType:`content`}),i(t)}function i(t){return t===null?a(t):T(t)?e.check(Ee,o,a)(t):(e.consume(t),i)}function a(n){return e.exit(`chunkContent`),e.exit(`content`),t(n)}function o(t){return e.consume(t),e.exit(`chunkContent`),n.next=e.enter(`chunkContent`,{contentType:`content`,previous:n}),n=n.next,i}}function ke(e,t,n){let r=this;return i;function i(t){return e.exit(`chunkContent`),e.enter(`lineEnding`),e.consume(t),e.exit(`lineEnding`),j(e,a,`linePrefix`)}function a(i){if(i===null||T(i))return n(i);let a=r.events[r.events.length-1];return!r.parser.constructs.disable.null.includes(`codeIndented`)&&a&&a[1].type===`linePrefix`&&a[2].sliceSerialize(a[1],!0).length>=4?t(i):e.interrupt(r.parser.constructs.flow,n,t)(i)}}function Ae(e,t,n,r,i,a,o,s,c){let l=c||1/0,u=0;return d;function d(t){return t===60?(e.enter(r),e.enter(i),e.enter(a),e.consume(t),e.exit(a),f):t===null||t===32||t===41||x(t)?n(t):(e.enter(r),e.enter(o),e.enter(s),e.enter(`chunkString`,{contentType:`string`}),h(t))}function f(n){return n===62?(e.enter(a),e.consume(n),e.exit(a),e.exit(i),e.exit(r),t):(e.enter(s),e.enter(`chunkString`,{contentType:`string`}),p(n))}function p(t){return t===62?(e.exit(`chunkString`),e.exit(s),f(t)):t===null||t===60||T(t)?n(t):(e.consume(t),t===92?m:p)}function m(t){return t===60||t===62||t===92?(e.consume(t),p):p(t)}function h(i){return!u&&(i===null||i===41||E(i))?(e.exit(`chunkString`),e.exit(s),e.exit(o),e.exit(r),t(i)):u<l&&i===40?(e.consume(i),u++,h):i===41?(e.consume(i),u--,h):i===null||i===32||i===40||x(i)?n(i):(e.consume(i),i===92?g:h)}function g(t){return t===40||t===41||t===92?(e.consume(t),h):h(t)}}function je(e,t,n,r,i,a){let o=this,s=0,c;return l;function l(t){return e.enter(r),e.enter(i),e.consume(t),e.exit(i),e.enter(a),u}function u(l){return s>999||l===null||l===91||l===93&&!c||l===94&&!s&&`_hiddenFootnoteSupport`in o.parser.constructs?n(l):l===93?(e.exit(a),e.enter(i),e.consume(l),e.exit(i),e.exit(r),t):T(l)?(e.enter(`lineEnding`),e.consume(l),e.exit(`lineEnding`),u):(e.enter(`chunkString`,{contentType:`string`}),d(l))}function d(t){return t===null||t===91||t===93||T(t)||s++>999?(e.exit(`chunkString`),u(t)):(e.consume(t),c||=!D(t),t===92?f:d)}function f(t){return t===91||t===92||t===93?(e.consume(t),s++,d):d(t)}}function Me(e,t,n,r,i,a){let o;return s;function s(t){return t===34||t===39||t===40?(e.enter(r),e.enter(i),e.consume(t),e.exit(i),o=t===40?41:t,c):n(t)}function c(n){return n===o?(e.enter(i),e.consume(n),e.exit(i),e.exit(r),t):(e.enter(a),l(n))}function l(t){return t===o?(e.exit(a),c(o)):t===null?n(t):T(t)?(e.enter(`lineEnding`),e.consume(t),e.exit(`lineEnding`),j(e,l,`linePrefix`)):(e.enter(`chunkString`,{contentType:`string`}),u(t))}function u(t){return t===o||t===null||T(t)?(e.exit(`chunkString`),l(t)):(e.consume(t),t===92?d:u)}function d(t){return t===o||t===92?(e.consume(t),u):u(t)}}function q(e,t){let n;return r;function r(i){return T(i)?(e.enter(`lineEnding`),e.consume(i),e.exit(`lineEnding`),n=!0,r):D(i)?j(e,r,n?`linePrefix`:`lineSuffix`)(i):t(i)}}let Ne={name:`definition`,tokenize:Fe},Pe={partial:!0,tokenize:Ie};function Fe(e,t,n){let r=this,i;return a;function a(t){return e.enter(`definition`),o(t)}function o(t){return je.call(r,e,s,n,`definitionLabel`,`definitionLabelMarker`,`definitionLabelString`)(t)}function s(t){return i=_(r.sliceSerialize(r.events[r.events.length-1][1]).slice(1,-1)),t===58?(e.enter(`definitionMarker`),e.consume(t),e.exit(`definitionMarker`),c):n(t)}function c(t){return E(t)?q(e,l)(t):l(t)}function l(t){return Ae(e,u,n,`definitionDestination`,`definitionDestinationLiteral`,`definitionDestinationLiteralMarker`,`definitionDestinationRaw`,`definitionDestinationString`)(t)}function u(t){return e.attempt(Pe,d,d)(t)}function d(t){return D(t)?j(e,f,`whitespace`)(t):f(t)}function f(a){return a===null||T(a)?(e.exit(`definition`),r.parser.defined.push(i),t(a)):n(a)}}function Ie(e,t,n){return r;function r(t){return E(t)?q(e,i)(t):n(t)}function i(t){return Me(e,a,n,`definitionTitle`,`definitionTitleMarker`,`definitionTitleString`)(t)}function a(t){return D(t)?j(e,o,`whitespace`)(t):o(t)}function o(e){return e===null||T(e)?t(e):n(e)}}let Le={name:`hardBreakEscape`,tokenize:Re};function Re(e,t,n){return r;function r(t){return e.enter(`hardBreakEscape`),e.consume(t),i}function i(r){return T(r)?(e.exit(`hardBreakEscape`),t(r)):n(r)}}let ze={name:`headingAtx`,resolve:Be,tokenize:Ve};function Be(e,t){let n=e.length-2,r=3,i,a;return e[r][1].type===`whitespace`&&(r+=2),n-2>r&&e[n][1].type===`whitespace`&&(n-=2),e[n][1].type===`atxHeadingSequence`&&(r===n-1||n-4>r&&e[n-2][1].type===`whitespace`)&&(n-=r+1===n?2:4),n>r&&(i={type:`atxHeadingText`,start:e[r][1].start,end:e[n][1].end},a={type:`chunkText`,start:e[r][1].start,end:e[n][1].end,contentType:`text`},u(e,r,n-r+1,[[`enter`,i,t],[`enter`,a,t],[`exit`,a,t],[`exit`,i,t]])),e}function Ve(e,t,n){let r=0;return i;function i(t){return e.enter(`atxHeading`),a(t)}function a(t){return e.enter(`atxHeadingSequence`),o(t)}function o(t){return t===35&&r++<6?(e.consume(t),o):t===null||E(t)?(e.exit(`atxHeadingSequence`),s(t)):n(t)}function s(n){return n===35?(e.enter(`atxHeadingSequence`),c(n)):n===null||T(n)?(e.exit(`atxHeading`),t(n)):D(n)?j(e,s,`whitespace`)(n):(e.enter(`atxHeadingText`),l(n))}function c(t){return t===35?(e.consume(t),c):(e.exit(`atxHeadingSequence`),s(t))}function l(t){return t===null||t===35||E(t)?(e.exit(`atxHeadingText`),s(t)):(e.consume(t),l)}}let He=`address.article.aside.base.basefont.blockquote.body.caption.center.col.colgroup.dd.details.dialog.dir.div.dl.dt.fieldset.figcaption.figure.footer.form.frame.frameset.h1.h2.h3.h4.h5.h6.head.header.hr.html.iframe.legend.li.link.main.menu.menuitem.nav.noframes.ol.optgroup.option.p.param.search.section.summary.table.tbody.td.tfoot.th.thead.title.tr.track.ul`.split(`.`),Ue=[`pre`,`script`,`style`,`textarea`],We={concrete:!0,name:`htmlFlow`,resolveTo:qe,tokenize:Je},Ge={partial:!0,tokenize:Xe},Ke={partial:!0,tokenize:Ye};function qe(e){let t=e.length;for(;t--&&(e[t][0]!==`enter`||e[t][1].type!==`htmlFlow`););return t>1&&e[t-2][1].type===`linePrefix`&&(e[t][1].start=e[t-2][1].start,e[t+1][1].start=e[t-2][1].start,e.splice(t-2,2)),e}function Je(e,t,n){let r=this,i,a,o,s,c;return l;function l(e){return u(e)}function u(t){return e.enter(`htmlFlow`),e.enter(`htmlFlowData`),e.consume(t),d}function d(s){return s===33?(e.consume(s),f):s===47?(e.consume(s),a=!0,h):s===63?(e.consume(s),i=3,r.interrupt?t:B):v(s)?(e.consume(s),o=String.fromCharCode(s),g):n(s)}function f(a){return a===45?(e.consume(a),i=2,p):a===91?(e.consume(a),i=5,s=0,m):v(a)?(e.consume(a),i=4,r.interrupt?t:B):n(a)}function p(i){return i===45?(e.consume(i),r.interrupt?t:B):n(i)}function m(i){return i===`CDATA[`.charCodeAt(s++)?(e.consume(i),s===6?r.interrupt?t:N:m):n(i)}function h(t){return v(t)?(e.consume(t),o=String.fromCharCode(t),g):n(t)}function g(s){if(s===null||s===47||s===62||E(s)){let c=s===47,l=o.toLowerCase();return!c&&!a&&Ue.includes(l)?(i=1,r.interrupt?t(s):N(s)):He.includes(o.toLowerCase())?(i=6,c?(e.consume(s),_):r.interrupt?t(s):N(s)):(i=7,r.interrupt&&!r.parser.lazy[r.now().line]?n(s):a?b(s):x(s))}return s===45||y(s)?(e.consume(s),o+=String.fromCharCode(s),g):n(s)}function _(i){return i===62?(e.consume(i),r.interrupt?t:N):n(i)}function b(t){return D(t)?(e.consume(t),b):j(t)}function x(t){return t===47?(e.consume(t),j):t===58||t===95||v(t)?(e.consume(t),S):D(t)?(e.consume(t),x):j(t)}function S(t){return t===45||t===46||t===58||t===95||y(t)?(e.consume(t),S):C(t)}function C(t){return t===61?(e.consume(t),w):D(t)?(e.consume(t),C):x(t)}function w(t){return t===null||t===60||t===61||t===62||t===96?n(t):t===34||t===39?(e.consume(t),c=t,O):D(t)?(e.consume(t),w):k(t)}function O(t){return t===c?(e.consume(t),c=null,A):t===null||T(t)?n(t):(e.consume(t),O)}function k(t){return t===null||t===34||t===39||t===47||t===60||t===61||t===62||t===96||E(t)?C(t):(e.consume(t),k)}function A(e){return e===47||e===62||D(e)?x(e):n(e)}function j(t){return t===62?(e.consume(t),M):n(t)}function M(t){return t===null||T(t)?N(t):D(t)?(e.consume(t),M):n(t)}function N(t){return t===45&&i===2?(e.consume(t),ee):t===60&&i===1?(e.consume(t),L):t===62&&i===4?(e.consume(t),V):t===63&&i===3?(e.consume(t),B):t===93&&i===5?(e.consume(t),z):T(t)&&(i===6||i===7)?(e.exit(`htmlFlowData`),e.check(Ge,H,P)(t)):t===null||T(t)?(e.exit(`htmlFlowData`),P(t)):(e.consume(t),N)}function P(t){return e.check(Ke,F,H)(t)}function F(t){return e.enter(`lineEnding`),e.consume(t),e.exit(`lineEnding`),I}function I(t){return t===null||T(t)?P(t):(e.enter(`htmlFlowData`),N(t))}function ee(t){return t===45?(e.consume(t),B):N(t)}function L(t){return t===47?(e.consume(t),o=``,R):N(t)}function R(t){if(t===62){let n=o.toLowerCase();return Ue.includes(n)?(e.consume(t),V):N(t)}return v(t)&&o.length<8?(e.consume(t),o+=String.fromCharCode(t),R):N(t)}function z(t){return t===93?(e.consume(t),B):N(t)}function B(t){return t===62?(e.consume(t),V):t===45&&i===2?(e.consume(t),B):N(t)}function V(t){return t===null||T(t)?(e.exit(`htmlFlowData`),H(t)):(e.consume(t),V)}function H(n){return e.exit(`htmlFlow`),t(n)}}function Ye(e,t,n){let r=this;return i;function i(t){return T(t)?(e.enter(`lineEnding`),e.consume(t),e.exit(`lineEnding`),a):n(t)}function a(e){return r.parser.lazy[r.now().line]?n(e):t(e)}}function Xe(e,t,n){return r;function r(r){return e.enter(`lineEnding`),e.consume(r),e.exit(`lineEnding`),e.attempt(U,t,n)}}let Ze={name:`htmlText`,tokenize:Qe};function Qe(e,t,n){let r=this,i,a,o;return s;function s(t){return e.enter(`htmlText`),e.enter(`htmlTextData`),e.consume(t),c}function c(t){return t===33?(e.consume(t),l):t===47?(e.consume(t),C):t===63?(e.consume(t),x):v(t)?(e.consume(t),k):n(t)}function l(t){return t===45?(e.consume(t),u):t===91?(e.consume(t),a=0,m):v(t)?(e.consume(t),b):n(t)}function u(t){return t===45?(e.consume(t),p):n(t)}function d(t){return t===null?n(t):t===45?(e.consume(t),f):T(t)?(o=d,R(t)):(e.consume(t),d)}function f(t){return t===45?(e.consume(t),p):d(t)}function p(e){return e===62?L(e):e===45?f(e):d(e)}function m(t){return t===`CDATA[`.charCodeAt(a++)?(e.consume(t),a===6?h:m):n(t)}function h(t){return t===null?n(t):t===93?(e.consume(t),g):T(t)?(o=h,R(t)):(e.consume(t),h)}function g(t){return t===93?(e.consume(t),_):h(t)}function _(t){return t===62?L(t):t===93?(e.consume(t),_):h(t)}function b(t){return t===null||t===62?L(t):T(t)?(o=b,R(t)):(e.consume(t),b)}function x(t){return t===null?n(t):t===63?(e.consume(t),S):T(t)?(o=x,R(t)):(e.consume(t),x)}function S(e){return e===62?L(e):x(e)}function C(t){return v(t)?(e.consume(t),w):n(t)}function w(t){return t===45||y(t)?(e.consume(t),w):O(t)}function O(t){return T(t)?(o=O,R(t)):D(t)?(e.consume(t),O):L(t)}function k(t){return t===45||y(t)?(e.consume(t),k):t===47||t===62||E(t)?A(t):n(t)}function A(t){return t===47?(e.consume(t),L):t===58||t===95||v(t)?(e.consume(t),M):T(t)?(o=A,R(t)):D(t)?(e.consume(t),A):L(t)}function M(t){return t===45||t===46||t===58||t===95||y(t)?(e.consume(t),M):N(t)}function N(t){return t===61?(e.consume(t),P):T(t)?(o=N,R(t)):D(t)?(e.consume(t),N):A(t)}function P(t){return t===null||t===60||t===61||t===62||t===96?n(t):t===34||t===39?(e.consume(t),i=t,F):T(t)?(o=P,R(t)):D(t)?(e.consume(t),P):(e.consume(t),I)}function F(t){return t===i?(e.consume(t),i=void 0,ee):t===null?n(t):T(t)?(o=F,R(t)):(e.consume(t),F)}function I(t){return t===null||t===34||t===39||t===60||t===61||t===96?n(t):t===47||t===62||E(t)?A(t):(e.consume(t),I)}function ee(e){return e===47||e===62||E(e)?A(e):n(e)}function L(r){return r===62?(e.consume(r),e.exit(`htmlTextData`),e.exit(`htmlText`),t):n(r)}function R(t){return e.exit(`htmlTextData`),e.enter(`lineEnding`),e.consume(t),e.exit(`lineEnding`),z}function z(t){return D(t)?j(e,B,`linePrefix`,r.parser.constructs.disable.null.includes(`codeIndented`)?void 0:4)(t):B(t)}function B(t){return e.enter(`htmlTextData`),o(t)}}let $e={name:`labelEnd`,resolveAll:rt,resolveTo:it,tokenize:at},et={tokenize:ot},tt={tokenize:st},nt={tokenize:ct};function rt(e){let t=-1,n=[];for(;++t<e.length;){let r=e[t][1];if(n.push(e[t]),r.type===`labelImage`||r.type===`labelLink`||r.type===`labelEnd`){let e=r.type===`labelImage`?4:2;r.type=`data`,t+=e}}return e.length!==n.length&&u(e,0,e.length,n),e}function it(e,t){let n=e.length,r=0,i,a,o,s;for(;n--;)if(i=e[n][1],a){if(i.type===`link`||i.type===`labelLink`&&i._inactive)break;e[n][0]===`enter`&&i.type===`labelLink`&&(i._inactive=!0)}else if(o){if(e[n][0]===`enter`&&(i.type===`labelImage`||i.type===`labelLink`)&&!i._balanced&&(a=n,i.type!==`labelLink`)){r=2;break}}else i.type===`labelEnd`&&(o=n);let c={type:e[a][1].type===`labelLink`?`link`:`image`,start:{...e[a][1].start},end:{...e[e.length-1][1].end}},l={type:`label`,start:{...e[a][1].start},end:{...e[o][1].end}},f={type:`labelText`,start:{...e[a+r+2][1].end},end:{...e[o-2][1].start}};return s=[[`enter`,c,t],[`enter`,l,t]],s=d(s,e.slice(a+1,a+r+3)),s=d(s,[[`enter`,f,t]]),s=d(s,R(t.parser.constructs.insideSpan.null,e.slice(a+r+4,o-3),t)),s=d(s,[[`exit`,f,t],e[o-2],e[o-1],[`exit`,l,t]]),s=d(s,e.slice(o+1)),s=d(s,[[`exit`,c,t]]),u(e,a,e.length,s),e}function at(e,t,n){let r=this,i=r.events.length,a,o;for(;i--;)if((r.events[i][1].type===`labelImage`||r.events[i][1].type===`labelLink`)&&!r.events[i][1]._balanced){a=r.events[i][1];break}return s;function s(t){return a?a._inactive?d(t):(o=r.parser.defined.includes(_(r.sliceSerialize({start:a.end,end:r.now()}))),e.enter(`labelEnd`),e.enter(`labelMarker`),e.consume(t),e.exit(`labelMarker`),e.exit(`labelEnd`),c):n(t)}function c(t){return t===40?e.attempt(et,u,o?u:d)(t):t===91?e.attempt(tt,u,o?l:d)(t):o?u(t):d(t)}function l(t){return e.attempt(nt,u,d)(t)}function u(e){return t(e)}function d(e){return a._balanced=!0,n(e)}}function ot(e,t,n){return r;function r(t){return e.enter(`resource`),e.enter(`resourceMarker`),e.consume(t),e.exit(`resourceMarker`),i}function i(t){return E(t)?q(e,a)(t):a(t)}function a(t){return t===41?u(t):Ae(e,o,s,`resourceDestination`,`resourceDestinationLiteral`,`resourceDestinationLiteralMarker`,`resourceDestinationRaw`,`resourceDestinationString`,32)(t)}function o(t){return E(t)?q(e,c)(t):u(t)}function s(e){return n(e)}function c(t){return t===34||t===39||t===40?Me(e,l,n,`resourceTitle`,`resourceTitleMarker`,`resourceTitleString`)(t):u(t)}function l(t){return E(t)?q(e,u)(t):u(t)}function u(r){return r===41?(e.enter(`resourceMarker`),e.consume(r),e.exit(`resourceMarker`),e.exit(`resource`),t):n(r)}}function st(e,t,n){let r=this;return i;function i(t){return je.call(r,e,a,o,`reference`,`referenceMarker`,`referenceString`)(t)}function a(e){return r.parser.defined.includes(_(r.sliceSerialize(r.events[r.events.length-1][1]).slice(1,-1)))?t(e):n(e)}function o(e){return n(e)}}function ct(e,t,n){return r;function r(t){return e.enter(`reference`),e.enter(`referenceMarker`),e.consume(t),e.exit(`referenceMarker`),i}function i(r){return r===93?(e.enter(`referenceMarker`),e.consume(r),e.exit(`referenceMarker`),e.exit(`reference`),t):n(r)}}let lt={name:`labelStartImage`,resolveAll:$e.resolveAll,tokenize:ut};function ut(e,t,n){let r=this;return i;function i(t){return e.enter(`labelImage`),e.enter(`labelImageMarker`),e.consume(t),e.exit(`labelImageMarker`),a}function a(t){return t===91?(e.enter(`labelMarker`),e.consume(t),e.exit(`labelMarker`),e.exit(`labelImage`),o):n(t)}function o(e){return e===94&&`_hiddenFootnoteSupport`in r.parser.constructs?n(e):t(e)}}let dt={name:`labelStartLink`,resolveAll:$e.resolveAll,tokenize:ft};function ft(e,t,n){let r=this;return i;function i(t){return e.enter(`labelLink`),e.enter(`labelMarker`),e.consume(t),e.exit(`labelMarker`),e.exit(`labelLink`),a}function a(e){return e===94&&`_hiddenFootnoteSupport`in r.parser.constructs?n(e):t(e)}}let pt={name:`lineEnding`,tokenize:mt};function mt(e,t){return n;function n(n){return e.enter(`lineEnding`),e.consume(n),e.exit(`lineEnding`),j(e,t,`linePrefix`)}}let ht={name:`thematicBreak`,tokenize:gt};function gt(e,t,n){let r=0,i;return a;function a(t){return e.enter(`thematicBreak`),o(t)}function o(e){return i=e,s(e)}function s(a){return a===i?(e.enter(`thematicBreakSequence`),c(a)):r>=3&&(a===null||T(a))?(e.exit(`thematicBreak`),t(a)):n(a)}function c(t){return t===i?(e.consume(t),r++,c):(e.exit(`thematicBreakSequence`),D(t)?j(e,s,`whitespace`)(t):s(t))}}let J={continuation:{tokenize:bt},exit:St,name:`list`,tokenize:yt},_t={partial:!0,tokenize:Ct},vt={partial:!0,tokenize:xt};function yt(e,t,n){let r=this,i=r.events[r.events.length-1],a=i&&i[1].type===`linePrefix`?i[2].sliceSerialize(i[1],!0).length:0,o=0;return s;function s(t){let i=r.containerState.type||(t===42||t===43||t===45?`listUnordered`:`listOrdered`);if(i===`listUnordered`?!r.containerState.marker||t===r.containerState.marker:S(t)){if(r.containerState.type||(r.containerState.type=i,e.enter(i,{_container:!0})),i===`listUnordered`)return e.enter(`listItemPrefix`),t===42||t===45?e.check(ht,n,l)(t):l(t);if(!r.interrupt||t===49)return e.enter(`listItemPrefix`),e.enter(`listItemValue`),c(t)}return n(t)}function c(t){return S(t)&&++o<10?(e.consume(t),c):(!r.interrupt||o<2)&&(r.containerState.marker?t===r.containerState.marker:t===41||t===46)?(e.exit(`listItemValue`),l(t)):n(t)}function l(t){return e.enter(`listItemMarker`),e.consume(t),e.exit(`listItemMarker`),r.containerState.marker=r.containerState.marker||t,e.check(U,r.interrupt?n:u,e.attempt(_t,f,d))}function u(e){return r.containerState.initialBlankLine=!0,a++,f(e)}function d(t){return D(t)?(e.enter(`listItemPrefixWhitespace`),e.consume(t),e.exit(`listItemPrefixWhitespace`),f):n(t)}function f(n){return r.containerState.size=a+r.sliceSerialize(e.exit(`listItemPrefix`),!0).length,t(n)}}function bt(e,t,n){let r=this;return r.containerState._closeFlow=void 0,e.check(U,i,a);function i(n){return r.containerState.furtherBlankLines=r.containerState.furtherBlankLines||r.containerState.initialBlankLine,j(e,t,`listItemIndent`,r.containerState.size+1)(n)}function a(n){return r.containerState.furtherBlankLines||!D(n)?(r.containerState.furtherBlankLines=void 0,r.containerState.initialBlankLine=void 0,o(n)):(r.containerState.furtherBlankLines=void 0,r.containerState.initialBlankLine=void 0,e.attempt(vt,t,o)(n))}function o(i){return r.containerState._closeFlow=!0,r.interrupt=void 0,j(e,e.attempt(J,t,n),`linePrefix`,r.parser.constructs.disable.null.includes(`codeIndented`)?void 0:4)(i)}}function xt(e,t,n){let r=this;return j(e,i,`listItemIndent`,r.containerState.size+1);function i(e){let i=r.events[r.events.length-1];return i&&i[1].type===`listItemIndent`&&i[2].sliceSerialize(i[1],!0).length===r.containerState.size?t(e):n(e)}}function St(e){e.exit(this.containerState.type)}function Ct(e,t,n){let r=this;return j(e,i,`listItemPrefixWhitespace`,r.parser.constructs.disable.null.includes(`codeIndented`)?void 0:5);function i(e){let i=r.events[r.events.length-1];return!D(e)&&i&&i[1].type===`listItemPrefixWhitespace`?t(e):n(e)}}let wt={name:`setextUnderline`,resolveTo:Tt,tokenize:Et};function Tt(e,t){let n=e.length,r,i,a;for(;n--;)if(e[n][0]===`enter`){if(e[n][1].type===`content`){r=n;break}e[n][1].type===`paragraph`&&(i=n)}else e[n][1].type===`content`&&e.splice(n,1),!a&&e[n][1].type===`definition`&&(a=n);let o={type:`setextHeading`,start:{...e[r][1].start},end:{...e[e.length-1][1].end}};return e[i][1].type=`setextHeadingText`,a?(e.splice(i,0,[`enter`,o,t]),e.splice(a+1,0,[`exit`,e[r][1],t]),e[r][1].end={...e[a][1].end}):e[r][1]=o,e.push([`exit`,o,t]),e}function Et(e,t,n){let r=this,i;return a;function a(t){let a=r.events.length,s;for(;a--;)if(r.events[a][1].type!==`lineEnding`&&r.events[a][1].type!==`linePrefix`&&r.events[a][1].type!==`content`){s=r.events[a][1].type===`paragraph`;break}return!r.parser.lazy[r.now().line]&&(r.interrupt||s)?(e.enter(`setextHeadingLine`),i=t,o(t)):n(t)}function o(t){return e.enter(`setextHeadingLineSequence`),s(t)}function s(t){return t===i?(e.consume(t),s):(e.exit(`setextHeadingLineSequence`),D(t)?j(e,c,`lineSuffix`)(t):c(t))}function c(r){return r===null||T(r)?(e.exit(`setextHeadingLine`),t(r)):n(r)}}let Dt={tokenize:Ot};function Ot(e){let t=this,n=e.attempt(U,r,e.attempt(this.parser.constructs.flowInitial,i,j(e,e.attempt(this.parser.constructs.flow,i,e.attempt(Te,i)),`linePrefix`)));return n;function r(r){if(r===null){e.consume(r);return}return e.enter(`lineEndingBlank`),e.consume(r),e.exit(`lineEndingBlank`),t.currentConstruct=void 0,n}function i(r){if(r===null){e.consume(r);return}return e.enter(`lineEnding`),e.consume(r),e.exit(`lineEnding`),t.currentConstruct=void 0,n}}let kt={resolveAll:Nt()},At=Mt(`string`),jt=Mt(`text`);function Mt(e){return{resolveAll:Nt(e===`text`?Pt:void 0),tokenize:t};function t(t){let n=this,r=this.parser.constructs[e],i=t.attempt(r,a,o);return a;function a(e){return c(e)?i(e):o(e)}function o(e){if(e===null){t.consume(e);return}return t.enter(`data`),t.consume(e),s}function s(e){return c(e)?(t.exit(`data`),i(e)):(t.consume(e),s)}function c(e){if(e===null)return!0;let t=r[e],i=-1;if(t)for(;++i<t.length;){let e=t[i];if(!e.previous||e.previous.call(n,n.previous))return!0}return!1}}}function Nt(e){return t;function t(t,n){let r=-1,i;for(;++r<=t.length;)i===void 0?t[r]&&t[r][1].type===`data`&&(i=r,r++):(!t[r]||t[r][1].type!==`data`)&&(r!==i+2&&(t[i][1].end=t[r-1][1].end,t.splice(i+2,r-i-2),r=i+2),i=void 0);return e?e(t,n):t}}function Pt(e,t){let n=0;for(;++n<=e.length;)if((n===e.length||e[n][1].type===`lineEnding`)&&e[n-1][1].type===`data`){let r=e[n-1][1],i=t.sliceStream(r),a=i.length,o=-1,s=0,c;for(;a--;){let e=i[a];if(typeof e==`string`){for(o=e.length;e.charCodeAt(o-1)===32;)s++,o--;if(o)break;o=-1}else if(e===-2)c=!0,s++;else if(e!==-1){a++;break}}if(t._contentTypeTextTrailing&&n===e.length&&(s=0),s){let i={type:n===e.length||c||s<2?`lineSuffix`:`hardBreakTrailing`,start:{_bufferIndex:a?o:r.start._bufferIndex+o,_index:r.start._index+a,line:r.end.line,column:r.end.column-s,offset:r.end.offset-s},end:{...r.end}};r.end={...i.start},r.start.offset===r.end.offset?Object.assign(r,i):(e.splice(n,0,[`enter`,i,t],[`exit`,i,t]),n+=2)}n++}return e}var Ft=n({attentionMarkers:()=>Ut,contentInitial:()=>Lt,disable:()=>Wt,document:()=>It,flow:()=>zt,flowInitial:()=>Rt,insideSpan:()=>Ht,string:()=>Bt,text:()=>Vt});let It={42:J,43:J,45:J,48:J,49:J,50:J,51:J,52:J,53:J,54:J,55:J,56:J,57:J,62:ie},Lt={91:Ne},Rt={[-2]:G,[-1]:G,32:G},zt={35:ze,42:ht,45:[wt,ht],60:We,61:wt,95:ht,96:fe,126:fe},Bt={38:ue,92:ce},Vt={[-5]:pt,[-4]:pt,[-3]:pt,33:lt,38:ue,42:z,60:[te,Ze],91:dt,92:[Le,ce],93:$e,95:z,96:ve},Ht={null:[z,kt]},Ut={null:[42,95]},Wt={null:[]};function Gt(e,t,n){let r={_bufferIndex:-1,_index:0,line:n&&n.line||1,column:n&&n.column||1,offset:n&&n.offset||0},i={},a=[],o=[],s=[],c={attempt:E(C),check:E(w),consume:b,enter:x,exit:S,interrupt:E(w,{interrupt:!0})},l={code:null,containerState:{},defineSkip:_,events:[],now:g,parser:e,previous:null,sliceSerialize:m,sliceStream:h,write:p},f=t.tokenize.call(l,c);return t.resolveAll&&a.push(t),l;function p(e){return o=d(o,e),v(),o[o.length-1]===null?(D(t,0),l.events=R(a,l.events,l),l.events):[]}function m(e,t){return qt(h(e),t)}function h(e){return Kt(o,e)}function g(){let{_bufferIndex:e,_index:t,line:n,column:i,offset:a}=r;return{_bufferIndex:e,_index:t,line:n,column:i,offset:a}}function _(e){i[e.line]=e.column,k()}function v(){let e;for(;r._index<o.length;){let t=o[r._index];if(typeof t==`string`)for(e=r._index,r._bufferIndex<0&&(r._bufferIndex=0);r._index===e&&r._bufferIndex<t.length;)y(t.charCodeAt(r._bufferIndex));else y(t)}}function y(e){f=f(e)}function b(e){T(e)?(r.line++,r.column=1,r.offset+=e===-3?2:1,k()):e!==-1&&(r.column++,r.offset++),r._bufferIndex<0?r._index++:(r._bufferIndex++,r._bufferIndex===o[r._index].length&&(r._bufferIndex=-1,r._index++)),l.previous=e}function x(e,t){let n=t||{};return n.type=e,n.start=g(),l.events.push([`enter`,n,l]),s.push(n),n}function S(e){let t=s.pop();return t.end=g(),l.events.push([`exit`,t,l]),t}function C(e,t){D(e,t.from)}function w(e,t){t.restore()}function E(e,t){return n;function n(n,r,i){let a,o,s,u;return Array.isArray(n)?f(n):`tokenize`in n?f([n]):d(n);function d(e){return t;function t(t){let n=t!==null&&e[t],r=t!==null&&e.null;return f([...Array.isArray(n)?n:n?[n]:[],...Array.isArray(r)?r:r?[r]:[]])(t)}}function f(e){return a=e,o=0,e.length===0?i:p(e[o])}function p(e){return n;function n(n){return u=O(),s=e,e.partial||(l.currentConstruct=e),e.name&&l.parser.constructs.disable.null.includes(e.name)?h(n):e.tokenize.call(t?Object.assign(Object.create(l),t):l,c,m,h)(n)}}function m(t){return e(s,u),r}function h(e){return u.restore(),++o<a.length?p(a[o]):i}}}function D(e,t){e.resolveAll&&!a.includes(e)&&a.push(e),e.resolve&&u(l.events,t,l.events.length-t,e.resolve(l.events.slice(t),l)),e.resolveTo&&(l.events=e.resolveTo(l.events,l))}function O(){let e=g(),t=l.previous,n=l.currentConstruct,i=l.events.length,a=Array.from(s);return{from:i,restore:o};function o(){r=e,l.previous=t,l.currentConstruct=n,l.events.length=i,s=a,k()}}function k(){r.line in i&&r.column<2&&(r.column=i[r.line],r.offset+=i[r.line]-1)}}function Kt(e,t){let n=t.start._index,r=t.start._bufferIndex,i=t.end._index,a=t.end._bufferIndex,o;if(n===i)o=[e[n].slice(r,a)];else{if(o=e.slice(n,i),r>-1){let e=o[0];typeof e==`string`?o[0]=e.slice(r):o.shift()}a>0&&o.push(e[i].slice(0,a))}return o}function qt(e,t){let n=-1,r=[],i;for(;++n<e.length;){let a=e[n],o;if(typeof a==`string`)o=a;else switch(a){case-5:o=`\r`;break;case-4:o=`
`;break;case-3:o=`\r
`;break;case-2:o=t?` `:`	`;break;case-1:if(!t&&i)continue;o=` `;break;default:o=String.fromCharCode(a)}i=a===-2,r.push(o)}return r.join(``)}function Jt(e){let t={constructs:p([Ft,...(e||{}).extensions||[]]),content:n(M),defined:[],document:n(P),flow:n(Dt),lazy:{},string:n(At),text:n(jt)};return t;function n(e){return n;function n(n){return Gt(t,e,n)}}}function Yt(e){for(;!Ce(e););return e}let Xt=/[\0\t\n\r]/g;function Zt(){let e=1,t=``,n=!0,r;return i;function i(i,a,o){let s=[],c,l,u,d,f;for(i=t+(typeof i==`string`?i.toString():new TextDecoder(a||void 0).decode(i)),u=0,t=``,n&&=(i.charCodeAt(0)===65279&&u++,void 0);u<i.length;){if(Xt.lastIndex=u,c=Xt.exec(i),d=c&&c.index!==void 0?c.index:i.length,f=i.charCodeAt(d),!c){t=i.slice(u);break}if(f===10&&u===d&&r)s.push(-3),r=void 0;else switch(r&&=(s.push(-5),void 0),u<d&&(s.push(i.slice(u,d)),e+=d-u),f){case 0:s.push(65533),e++;break;case 9:for(l=Math.ceil(e/4)*4,s.push(-2);e++<l;)s.push(-1);break;case 10:s.push(-4),e=1;break;default:r=!0,e=1}u=d+1}return o&&(r&&s.push(-5),t&&s.push(t),s.push(null)),s}}let Qt=/\\([!-/:-@[-`{-~])|&(#(?:\d{1,7}|x[\da-f]{1,6})|[\da-z]{1,31});/gi;function $t(e){return e.replace(Qt,en)}function en(e,t,n){if(t)return t;if(n.charCodeAt(0)===35){let e=n.charCodeAt(1),t=e===120||e===88;return g(n.slice(t?2:1),t?16:10)}return l(n)||e}function tn(e){return!e||typeof e!=`object`?``:`position`in e||`type`in e?rn(e.position):`start`in e||`end`in e?rn(e):`line`in e||`column`in e?nn(e):``}function nn(e){return an(e&&e.line)+`:`+an(e&&e.column)}function rn(e){return nn(e&&e.start)+`-`+nn(e&&e.end)}function an(e){return e&&typeof e==`number`?e:1}let on={}.hasOwnProperty;function sn(e,t,n){return t&&typeof t==`object`&&(n=t,t=void 0),cn(n)(Yt(Jt(n).document().write(Zt()(e,t,!0))))}function cn(e){let t={transforms:[],canContainEols:[`emphasis`,`fragment`,`heading`,`paragraph`,`strong`],enter:{autolink:o(me),autolinkProtocol:k,autolinkEmail:k,atxHeading:o(de),blockQuote:o(oe),characterEscape:k,characterReference:k,codeFenced:o(se),codeFencedFenceInfo:s,codeFencedFenceMeta:s,codeIndented:o(se,s),codeText:o(ce,s),codeTextData:k,data:k,codeFlowValue:k,definition:o(le),definitionDestinationString:s,definitionLabelString:s,definitionTitleString:s,emphasis:o(ue),hardBreakEscape:o(W),hardBreakTrailing:o(W),htmlFlow:o(fe,s),htmlFlowData:k,htmlText:o(fe,s),htmlTextData:k,image:o(pe),label:s,link:o(me),listItem:o(he),listItemValue:m,listOrdered:o(G,p),listUnordered:o(G),paragraph:o(ge),reference:H,referenceString:s,resourceDestinationString:s,resourceTitleString:s,setextHeading:o(de),strong:o(_e),thematicBreak:o(ye)},exit:{atxHeading:u(),atxHeadingSequence:T,autolink:u(),autolinkEmail:ae,autolinkProtocol:ie,blockQuote:u(),characterEscapeValue:A,characterReferenceMarkerHexadecimal:ne,characterReferenceMarkerNumeric:ne,characterReferenceValue:U,characterReference:re,codeFenced:u(b),codeFencedFence:y,codeFencedFenceInfo:h,codeFencedFenceMeta:v,codeFlowValue:A,codeIndented:u(x),codeText:u(F),codeTextData:A,data:A,definition:u(),definitionDestinationString:w,definitionLabelString:S,definitionTitleString:C,emphasis:u(),hardBreakEscape:u(M),hardBreakTrailing:u(M),htmlFlow:u(N),htmlFlowData:A,htmlText:u(P),htmlTextData:A,image:u(ee),label:R,labelText:L,lineEnding:j,link:u(I),listItem:u(),listOrdered:u(),listUnordered:u(),paragraph:u(),referenceString:te,resourceDestinationString:z,resourceTitleString:B,resource:V,setextHeading:u(O),setextHeadingLineSequence:D,setextHeadingText:E,strong:u(),thematicBreak:u()}};ln(t,(e||{}).mdastExtensions||[]);let n={};return r;function r(e){let r={type:`root`,children:[]},i={stack:[r],tokenStack:[],config:t,enter:c,exit:d,buffer:s,resume:f,data:n},o=[],l=-1;for(;++l<e.length;)(e[l][1].type===`listOrdered`||e[l][1].type===`listUnordered`)&&(e[l][0]===`enter`?o.push(l):l=a(e,o.pop(),l));for(l=-1;++l<e.length;){let n=t[e[l][0]];on.call(n,e[l][1].type)&&n[e[l][1].type].call(Object.assign({sliceSerialize:e[l][2].sliceSerialize},i),e[l][1])}if(i.tokenStack.length>0){let e=i.tokenStack[i.tokenStack.length-1];(e[1]||dn).call(i,void 0,e[0])}for(r.position={start:Y(e.length>0?e[0][1].start:{line:1,column:1,offset:0}),end:Y(e.length>0?e[e.length-2][1].end:{line:1,column:1,offset:0})},l=-1;++l<t.transforms.length;)r=t.transforms[l](r)||r;return r}function a(e,t,n){let r=t-1,i=-1,a=!1,o,s,c,l;for(;++r<=n;){let t=e[r];switch(t[1].type){case`listUnordered`:case`listOrdered`:case`blockQuote`:t[0]===`enter`?i++:i--,l=void 0;break;case`lineEndingBlank`:t[0]===`enter`&&(o&&!l&&!i&&!c&&(c=r),l=void 0);break;case`linePrefix`:case`listItemValue`:case`listItemMarker`:case`listItemPrefix`:case`listItemPrefixWhitespace`:break;default:l=void 0}if(!i&&t[0]===`enter`&&t[1].type===`listItemPrefix`||i===-1&&t[0]===`exit`&&(t[1].type===`listUnordered`||t[1].type===`listOrdered`)){if(o){let i=r;for(s=void 0;i--;){let t=e[i];if(t[1].type===`lineEnding`||t[1].type===`lineEndingBlank`){if(t[0]===`exit`)continue;s&&(e[s][1].type=`lineEndingBlank`,a=!0),t[1].type=`lineEnding`,s=i}else if(t[1].type!==`linePrefix`&&t[1].type!==`blockQuotePrefix`&&t[1].type!==`blockQuotePrefixWhitespace`&&t[1].type!==`blockQuoteMarker`&&t[1].type!==`listItemIndent`)break}c&&(!s||c<s)&&(o._spread=!0),o.end=Object.assign({},s?e[s][1].start:t[1].end),e.splice(s||r,0,[`exit`,o,t[2]]),r++,n++}if(t[1].type===`listItemPrefix`){let i={type:`listItem`,_spread:!1,start:Object.assign({},t[1].start),end:void 0};o=i,e.splice(r,0,[`enter`,i,t[2]]),r++,n++,c=void 0,l=!0}}}return e[t][1]._spread=a,n}function o(e,t){return n;function n(n){c.call(this,e(n),n),t&&t.call(this,n)}}function s(){this.stack.push({type:`fragment`,children:[]})}function c(e,t,n){this.stack[this.stack.length-1].children.push(e),this.stack.push(e),this.tokenStack.push([t,n||void 0]),e.position={start:Y(t.start),end:void 0}}function u(e){return t;function t(t){e&&e.call(this,t),d.call(this,t)}}function d(e,t){let n=this.stack.pop(),r=this.tokenStack.pop();if(r)r[0].type!==e.type&&(t?t.call(this,e,r[0]):(r[1]||dn).call(this,e,r[0]));else throw Error("Cannot close `"+e.type+"` ("+tn({start:e.start,end:e.end})+`): it’s not open`);n.position.end=Y(e.end)}function f(){return i(this.stack.pop())}function p(){this.data.expectingFirstListItemValue=!0}function m(e){if(this.data.expectingFirstListItemValue){let t=this.stack[this.stack.length-2];t.start=Number.parseInt(this.sliceSerialize(e),10),this.data.expectingFirstListItemValue=void 0}}function h(){let e=this.resume(),t=this.stack[this.stack.length-1];t.lang=e}function v(){let e=this.resume(),t=this.stack[this.stack.length-1];t.meta=e}function y(){this.data.flowCodeInside||(this.buffer(),this.data.flowCodeInside=!0)}function b(){let e=this.resume(),t=this.stack[this.stack.length-1];t.value=e.replace(/^(\r?\n|\r)|(\r?\n|\r)$/g,``),this.data.flowCodeInside=void 0}function x(){let e=this.resume(),t=this.stack[this.stack.length-1];t.value=e.replace(/(\r?\n|\r)$/g,``)}function S(e){let t=this.resume(),n=this.stack[this.stack.length-1];n.label=t,n.identifier=_(this.sliceSerialize(e)).toLowerCase()}function C(){let e=this.resume(),t=this.stack[this.stack.length-1];t.title=e}function w(){let e=this.resume(),t=this.stack[this.stack.length-1];t.url=e}function T(e){let t=this.stack[this.stack.length-1];t.depth||=this.sliceSerialize(e).length}function E(){this.data.setextHeadingSlurpLineEnding=!0}function D(e){let t=this.stack[this.stack.length-1];t.depth=this.sliceSerialize(e).codePointAt(0)===61?1:2}function O(){this.data.setextHeadingSlurpLineEnding=void 0}function k(e){let t=this.stack[this.stack.length-1].children,n=t[t.length-1];(!n||n.type!==`text`)&&(n=ve(),n.position={start:Y(e.start),end:void 0},t.push(n)),this.stack.push(n)}function A(e){let t=this.stack.pop();t.value+=this.sliceSerialize(e),t.position.end=Y(e.end)}function j(e){let n=this.stack[this.stack.length-1];if(this.data.atHardBreak){let t=n.children[n.children.length-1];t.position.end=Y(e.end),this.data.atHardBreak=void 0;return}!this.data.setextHeadingSlurpLineEnding&&t.canContainEols.includes(n.type)&&(k.call(this,e),A.call(this,e))}function M(){this.data.atHardBreak=!0}function N(){let e=this.resume(),t=this.stack[this.stack.length-1];t.value=e}function P(){let e=this.resume(),t=this.stack[this.stack.length-1];t.value=e}function F(){let e=this.resume(),t=this.stack[this.stack.length-1];t.value=e}function I(){let e=this.stack[this.stack.length-1];if(this.data.inReference){let t=this.data.referenceType||`shortcut`;e.type+=`Reference`,e.referenceType=t,delete e.url,delete e.title}else delete e.identifier,delete e.label;this.data.referenceType=void 0}function ee(){let e=this.stack[this.stack.length-1];if(this.data.inReference){let t=this.data.referenceType||`shortcut`;e.type+=`Reference`,e.referenceType=t,delete e.url,delete e.title}else delete e.identifier,delete e.label;this.data.referenceType=void 0}function L(e){let t=this.sliceSerialize(e),n=this.stack[this.stack.length-2];n.label=$t(t),n.identifier=_(t).toLowerCase()}function R(){let e=this.stack[this.stack.length-1],t=this.resume(),n=this.stack[this.stack.length-1];this.data.inReference=!0,n.type===`link`?n.children=e.children:n.alt=t}function z(){let e=this.resume(),t=this.stack[this.stack.length-1];t.url=e}function B(){let e=this.resume(),t=this.stack[this.stack.length-1];t.title=e}function V(){this.data.inReference=void 0}function H(){this.data.referenceType=`collapsed`}function te(e){let t=this.resume(),n=this.stack[this.stack.length-1];n.label=t,n.identifier=_(this.sliceSerialize(e)).toLowerCase(),this.data.referenceType=`full`}function ne(e){this.data.characterReferenceType=e.type}function U(e){let t=this.sliceSerialize(e),n=this.data.characterReferenceType,r;n?(r=g(t,n===`characterReferenceMarkerNumeric`?10:16),this.data.characterReferenceType=void 0):r=l(t);let i=this.stack[this.stack.length-1];i.value+=r}function re(e){let t=this.stack.pop();t.position.end=Y(e.end)}function ie(e){A.call(this,e);let t=this.stack[this.stack.length-1];t.url=this.sliceSerialize(e)}function ae(e){A.call(this,e);let t=this.stack[this.stack.length-1];t.url=`mailto:`+this.sliceSerialize(e)}function oe(){return{type:`blockquote`,children:[]}}function se(){return{type:`code`,lang:null,meta:null,value:``}}function ce(){return{type:`inlineCode`,value:``}}function le(){return{type:`definition`,identifier:``,label:null,title:null,url:``}}function ue(){return{type:`emphasis`,children:[]}}function de(){return{type:`heading`,depth:0,children:[]}}function W(){return{type:`break`}}function fe(){return{type:`html`,value:``}}function pe(){return{type:`image`,title:null,url:``,alt:null}}function me(){return{type:`link`,title:null,url:``,children:[]}}function G(e){return{type:`list`,ordered:e.type===`listOrdered`,start:null,spread:e._spread,children:[]}}function he(e){return{type:`listItem`,spread:e._spread,checked:null,children:[]}}function ge(){return{type:`paragraph`,children:[]}}function _e(){return{type:`strong`,children:[]}}function ve(){return{type:`text`,value:``}}function ye(){return{type:`thematicBreak`}}}function Y(e){return{line:e.line,column:e.column,offset:e.offset}}function ln(e,t){let n=-1;for(;++n<t.length;){let r=t[n];Array.isArray(r)?ln(e,r):un(e,r)}}function un(e,t){let n;for(n in t)if(on.call(t,n))switch(n){case`canContainEols`:{let r=t[n];r&&e[n].push(...r);break}case`transforms`:{let r=t[n];r&&e[n].push(...r);break}case`enter`:case`exit`:{let r=t[n];r&&Object.assign(e[n],r);break}}}function dn(e,t){throw Error(e?"Cannot close `"+e.type+"` ("+tn({start:e.start,end:e.end})+"): a different token (`"+t.type+"`, "+tn({start:t.start,end:t.end})+`) is open`:"Cannot close document, a token (`"+t.type+"`, "+tn({start:t.start,end:t.end})+`) is still open`)}let fn={tokenize:Cn,partial:!0},pn={tokenize:wn,partial:!0},mn={tokenize:Tn,partial:!0},hn={tokenize:En,partial:!0},gn={tokenize:Dn,partial:!0},_n={name:`wwwAutolink`,tokenize:xn,previous:On},vn={name:`protocolAutolink`,tokenize:Sn,previous:kn},X={name:`emailAutolink`,tokenize:bn,previous:An},Z={};function yn(){return{text:Z}}let Q=48;for(;Q<123;)Z[Q]=X,Q++,Q===58?Q=65:Q===91&&(Q=97);Z[43]=X,Z[45]=X,Z[46]=X,Z[95]=X,Z[72]=[X,vn],Z[104]=[X,vn],Z[87]=[X,_n],Z[119]=[X,_n];function bn(e,t,n){let r=this,i,a;return o;function o(t){return!jn(t)||!An.call(r,r.previous)||Mn(r.events)?n(t):(e.enter(`literalAutolink`),e.enter(`literalAutolinkEmail`),s(t))}function s(t){return jn(t)?(e.consume(t),s):t===64?(e.consume(t),c):n(t)}function c(t){return t===46?e.check(gn,u,l)(t):t===45||t===95||y(t)?(a=!0,e.consume(t),c):u(t)}function l(t){return e.consume(t),i=!0,c}function u(o){return a&&i&&v(r.previous)?(e.exit(`literalAutolinkEmail`),e.exit(`literalAutolink`),t(o)):n(o)}}function xn(e,t,n){let r=this;return i;function i(t){return t!==87&&t!==119||!On.call(r,r.previous)||Mn(r.events)?n(t):(e.enter(`literalAutolink`),e.enter(`literalAutolinkWww`),e.check(fn,e.attempt(pn,e.attempt(mn,a),n),n)(t))}function a(n){return e.exit(`literalAutolinkWww`),e.exit(`literalAutolink`),t(n)}}function Sn(e,t,n){let r=this,i=``,a=!1;return o;function o(t){return(t===72||t===104)&&kn.call(r,r.previous)&&!Mn(r.events)?(e.enter(`literalAutolink`),e.enter(`literalAutolinkHttp`),i+=String.fromCodePoint(t),e.consume(t),s):n(t)}function s(t){if(v(t)&&i.length<5)return i+=String.fromCodePoint(t),e.consume(t),s;if(t===58){let n=i.toLowerCase();if(n===`http`||n===`https`)return e.consume(t),c}return n(t)}function c(t){return t===47?(e.consume(t),a?l:(a=!0,c)):n(t)}function l(t){return t===null||x(t)||E(t)||k(t)||O(t)?n(t):e.attempt(pn,e.attempt(mn,u),n)(t)}function u(n){return e.exit(`literalAutolinkHttp`),e.exit(`literalAutolink`),t(n)}}function Cn(e,t,n){let r=0;return i;function i(t){return(t===87||t===119)&&r<3?(r++,e.consume(t),i):t===46&&r===3?(e.consume(t),a):n(t)}function a(e){return e===null?n(e):t(e)}}function wn(e,t,n){let r,i,a;return o;function o(t){return t===46||t===95?e.check(hn,c,s)(t):t===null||E(t)||k(t)||t!==45&&O(t)?c(t):(a=!0,e.consume(t),o)}function s(t){return t===95?r=!0:(i=r,r=void 0),e.consume(t),o}function c(e){return i||r||!a?n(e):t(e)}}function Tn(e,t){let n=0,r=0;return i;function i(o){return o===40?(n++,e.consume(o),i):o===41&&r<n?a(o):o===33||o===34||o===38||o===39||o===41||o===42||o===44||o===46||o===58||o===59||o===60||o===63||o===93||o===95||o===126?e.check(hn,t,a)(o):o===null||E(o)||k(o)?t(o):(e.consume(o),i)}function a(t){return t===41&&r++,e.consume(t),i}}function En(e,t,n){return r;function r(o){return o===33||o===34||o===39||o===41||o===42||o===44||o===46||o===58||o===59||o===63||o===95||o===126?(e.consume(o),r):o===38?(e.consume(o),a):o===93?(e.consume(o),i):o===60||o===null||E(o)||k(o)?t(o):n(o)}function i(e){return e===null||e===40||e===91||E(e)||k(e)?t(e):r(e)}function a(e){return v(e)?o(e):n(e)}function o(t){return t===59?(e.consume(t),r):v(t)?(e.consume(t),o):n(t)}}function Dn(e,t,n){return r;function r(t){return e.consume(t),i}function i(e){return y(e)?n(e):t(e)}}function On(e){return e===null||e===40||e===42||e===95||e===91||e===93||e===126||E(e)}function kn(e){return!v(e)}function An(e){return!(e===47||jn(e))}function jn(e){return e===43||e===45||e===46||e===95||y(e)}function Mn(e){let t=e.length,n=!1;for(;t--;){let r=e[t][1];if((r.type===`labelLink`||r.type===`labelImage`)&&!r._balanced){n=!0;break}if(r._gfmAutolinkLiteralWalkedInto){n=!1;break}}return e.length>0&&!n&&(e[e.length-1][1]._gfmAutolinkLiteralWalkedInto=!0),n}let Nn={tokenize:Vn,partial:!0};function Pn(){return{document:{91:{name:`gfmFootnoteDefinition`,tokenize:Rn,continuation:{tokenize:zn},exit:Bn}},text:{91:{name:`gfmFootnoteCall`,tokenize:Ln},93:{name:`gfmPotentialFootnoteCall`,add:`after`,tokenize:Fn,resolveTo:In}}}}function Fn(e,t,n){let r=this,i=r.events.length,a=r.parser.gfmFootnotes||(r.parser.gfmFootnotes=[]),o;for(;i--;){let e=r.events[i][1];if(e.type===`labelImage`){o=e;break}if(e.type===`gfmFootnoteCall`||e.type===`labelLink`||e.type===`label`||e.type===`image`||e.type===`link`)break}return s;function s(i){if(!o||!o._balanced)return n(i);let s=_(r.sliceSerialize({start:o.end,end:r.now()}));return s.codePointAt(0)!==94||!a.includes(s.slice(1))?n(i):(e.enter(`gfmFootnoteCallLabelMarker`),e.consume(i),e.exit(`gfmFootnoteCallLabelMarker`),t(i))}}function In(e,t){let n=e.length;for(;n--;)if(e[n][1].type===`labelImage`&&e[n][0]===`enter`){e[n][1];break}e[n+1][1].type=`data`,e[n+3][1].type=`gfmFootnoteCallLabelMarker`;let r={type:`gfmFootnoteCall`,start:Object.assign({},e[n+3][1].start),end:Object.assign({},e[e.length-1][1].end)},i={type:`gfmFootnoteCallMarker`,start:Object.assign({},e[n+3][1].end),end:Object.assign({},e[n+3][1].end)};i.end.column++,i.end.offset++,i.end._bufferIndex++;let a={type:`gfmFootnoteCallString`,start:Object.assign({},i.end),end:Object.assign({},e[e.length-1][1].start)},o={type:`chunkString`,contentType:`string`,start:Object.assign({},a.start),end:Object.assign({},a.end)},s=[e[n+1],e[n+2],[`enter`,r,t],e[n+3],e[n+4],[`enter`,i,t],[`exit`,i,t],[`enter`,a,t],[`enter`,o,t],[`exit`,o,t],[`exit`,a,t],e[e.length-2],e[e.length-1],[`exit`,r,t]];return e.splice(n,e.length-n+1,...s),e}function Ln(e,t,n){let r=this,i=r.parser.gfmFootnotes||(r.parser.gfmFootnotes=[]),a=0,o;return s;function s(t){return e.enter(`gfmFootnoteCall`),e.enter(`gfmFootnoteCallLabelMarker`),e.consume(t),e.exit(`gfmFootnoteCallLabelMarker`),c}function c(t){return t===94?(e.enter(`gfmFootnoteCallMarker`),e.consume(t),e.exit(`gfmFootnoteCallMarker`),e.enter(`gfmFootnoteCallString`),e.enter(`chunkString`).contentType=`string`,l):n(t)}function l(s){if(a>999||s===93&&!o||s===null||s===91||E(s))return n(s);if(s===93){e.exit(`chunkString`);let a=e.exit(`gfmFootnoteCallString`);return i.includes(_(r.sliceSerialize(a)))?(e.enter(`gfmFootnoteCallLabelMarker`),e.consume(s),e.exit(`gfmFootnoteCallLabelMarker`),e.exit(`gfmFootnoteCall`),t):n(s)}return E(s)||(o=!0),a++,e.consume(s),s===92?u:l}function u(t){return t===91||t===92||t===93?(e.consume(t),a++,l):l(t)}}function Rn(e,t,n){let r=this,i=r.parser.gfmFootnotes||(r.parser.gfmFootnotes=[]),a,o=0,s;return c;function c(t){return e.enter(`gfmFootnoteDefinition`)._container=!0,e.enter(`gfmFootnoteDefinitionLabel`),e.enter(`gfmFootnoteDefinitionLabelMarker`),e.consume(t),e.exit(`gfmFootnoteDefinitionLabelMarker`),l}function l(t){return t===94?(e.enter(`gfmFootnoteDefinitionMarker`),e.consume(t),e.exit(`gfmFootnoteDefinitionMarker`),e.enter(`gfmFootnoteDefinitionLabelString`),e.enter(`chunkString`).contentType=`string`,u):n(t)}function u(t){if(o>999||t===93&&!s||t===null||t===91||E(t))return n(t);if(t===93){e.exit(`chunkString`);let n=e.exit(`gfmFootnoteDefinitionLabelString`);return a=_(r.sliceSerialize(n)),e.enter(`gfmFootnoteDefinitionLabelMarker`),e.consume(t),e.exit(`gfmFootnoteDefinitionLabelMarker`),e.exit(`gfmFootnoteDefinitionLabel`),f}return E(t)||(s=!0),o++,e.consume(t),t===92?d:u}function d(t){return t===91||t===92||t===93?(e.consume(t),o++,u):u(t)}function f(t){return t===58?(e.enter(`definitionMarker`),e.consume(t),e.exit(`definitionMarker`),i.includes(a)||i.push(a),j(e,p,`gfmFootnoteDefinitionWhitespace`)):n(t)}function p(e){return t(e)}}function zn(e,t,n){return e.check(U,t,e.attempt(Nn,t,n))}function Bn(e){e.exit(`gfmFootnoteDefinition`)}function Vn(e,t,n){let r=this;return j(e,i,`gfmFootnoteDefinitionIndent`,5);function i(e){let i=r.events[r.events.length-1];return i&&i[1].type===`gfmFootnoteDefinitionIndent`&&i[2].sliceSerialize(i[1],!0).length===4?t(e):n(e)}}function Hn(e){let t=(e||{}).singleTilde,n={name:`strikethrough`,tokenize:i,resolveAll:r};return t??=!0,{text:{126:n},insideSpan:{null:[n]},attentionMarkers:{null:[126]}};function r(e,t){let n=-1;for(;++n<e.length;)if(e[n][0]===`enter`&&e[n][1].type===`strikethroughSequenceTemporary`&&e[n][1]._close){let r=n;for(;r--;)if(e[r][0]===`exit`&&e[r][1].type===`strikethroughSequenceTemporary`&&e[r][1]._open&&e[n][1].end.offset-e[n][1].start.offset===e[r][1].end.offset-e[r][1].start.offset){e[n][1].type=`strikethroughSequence`,e[r][1].type=`strikethroughSequence`;let i={type:`strikethrough`,start:Object.assign({},e[r][1].start),end:Object.assign({},e[n][1].end)},a={type:`strikethroughText`,start:Object.assign({},e[r][1].end),end:Object.assign({},e[n][1].start)},o=[[`enter`,i,t],[`enter`,e[r][1],t],[`exit`,e[r][1],t],[`enter`,a,t]],s=t.parser.constructs.insideSpan.null;s&&u(o,o.length,0,R(s,e.slice(r+1,n),t)),u(o,o.length,0,[[`exit`,a,t],[`enter`,e[n][1],t],[`exit`,e[n][1],t],[`exit`,i,t]]),u(e,r-1,n-r+3,o),n=r+o.length-2;break}}for(n=-1;++n<e.length;)e[n][1].type===`strikethroughSequenceTemporary`&&(e[n][1].type=`data`);return e}function i(e,n,r){let i=this.previous,a=this.events,o=0;return s;function s(t){return i===126&&a[a.length-1][1].type!==`characterEscape`?r(t):(e.enter(`strikethroughSequenceTemporary`),c(t))}function c(a){let s=L(i);if(a===126)return o>1?r(a):(e.consume(a),o++,c);if(o<2&&!t)return r(a);let l=e.exit(`strikethroughSequenceTemporary`),u=L(a);return l._open=!u||u===2&&!!s,l._close=!s||s===2&&!!u,n(a)}}}var Un=class{constructor(){this.map=[]}add(e,t,n){Wn(this,e,t,n)}consume(e){if(this.map.sort(function(e,t){return e[0]-t[0]}),this.map.length===0)return;let t=this.map.length,n=[];for(;t>0;)--t,n.push(e.slice(this.map[t][0]+this.map[t][1]),this.map[t][2]),e.length=this.map[t][0];n.push(e.slice()),e.length=0;let r=n.pop();for(;r;){for(let t of r)e.push(t);r=n.pop()}this.map.length=0}};function Wn(e,t,n,r){let i=0;if(n!==0||r.length!==0){for(;i<e.map.length;){if(e.map[i][0]===t){e.map[i][1]+=n,e.map[i][2].push(...r);return}i+=1}e.map.push([t,n,r])}}function Gn(e,t){let n=!1,r=[];for(;t<e.length;){let i=e[t];if(n){if(i[0]===`enter`)i[1].type===`tableContent`&&r.push(e[t+1][1].type===`tableDelimiterMarker`?`left`:`none`);else if(i[1].type===`tableContent`){if(e[t-1][1].type===`tableDelimiterMarker`){let e=r.length-1;r[e]=r[e]===`left`?`center`:`right`}}else if(i[1].type===`tableDelimiterRow`)break}else i[0]===`enter`&&i[1].type===`tableDelimiterRow`&&(n=!0);t+=1}return r}function Kn(){return{flow:{null:{name:`table`,tokenize:qn,resolveAll:Jn}}}}function qn(e,t,n){let r=this,i=0,a=0,o;return s;function s(e){let t=r.events.length-1;for(;t>-1;){let e=r.events[t][1].type;if(e===`lineEnding`||e===`linePrefix`)t--;else break}let i=t>-1?r.events[t][1].type:null,a=i===`tableHead`||i===`tableRow`?S:c;return a===S&&r.parser.lazy[r.now().line]?n(e):a(e)}function c(t){return e.enter(`tableHead`),e.enter(`tableRow`),l(t)}function l(e){return e===124?u(e):(o=!0,a+=1,u(e))}function u(t){return t===null?n(t):T(t)?a>1?(a=0,r.interrupt=!0,e.exit(`tableRow`),e.enter(`lineEnding`),e.consume(t),e.exit(`lineEnding`),p):n(t):D(t)?j(e,u,`whitespace`)(t):(a+=1,o&&(o=!1,i+=1),t===124?(e.enter(`tableCellDivider`),e.consume(t),e.exit(`tableCellDivider`),o=!0,u):(e.enter(`data`),d(t)))}function d(t){return t===null||t===124||E(t)?(e.exit(`data`),u(t)):(e.consume(t),t===92?f:d)}function f(t){return t===92||t===124?(e.consume(t),d):d(t)}function p(t){return r.interrupt=!1,r.parser.lazy[r.now().line]?n(t):(e.enter(`tableDelimiterRow`),o=!1,D(t)?j(e,m,`linePrefix`,r.parser.constructs.disable.null.includes(`codeIndented`)?void 0:4)(t):m(t))}function m(t){return t===45||t===58?g(t):t===124?(o=!0,e.enter(`tableCellDivider`),e.consume(t),e.exit(`tableCellDivider`),h):x(t)}function h(t){return D(t)?j(e,g,`whitespace`)(t):g(t)}function g(t){return t===58?(a+=1,o=!0,e.enter(`tableDelimiterMarker`),e.consume(t),e.exit(`tableDelimiterMarker`),_):t===45?(a+=1,_(t)):t===null||T(t)?b(t):x(t)}function _(t){return t===45?(e.enter(`tableDelimiterFiller`),v(t)):x(t)}function v(t){return t===45?(e.consume(t),v):t===58?(o=!0,e.exit(`tableDelimiterFiller`),e.enter(`tableDelimiterMarker`),e.consume(t),e.exit(`tableDelimiterMarker`),y):(e.exit(`tableDelimiterFiller`),y(t))}function y(t){return D(t)?j(e,b,`whitespace`)(t):b(t)}function b(n){return n===124?m(n):n===null||T(n)?!o||i!==a?x(n):(e.exit(`tableDelimiterRow`),e.exit(`tableHead`),t(n)):x(n)}function x(e){return n(e)}function S(t){return e.enter(`tableRow`),C(t)}function C(n){return n===124?(e.enter(`tableCellDivider`),e.consume(n),e.exit(`tableCellDivider`),C):n===null||T(n)?(e.exit(`tableRow`),t(n)):D(n)?j(e,C,`whitespace`)(n):(e.enter(`data`),w(n))}function w(t){return t===null||t===124||E(t)?(e.exit(`data`),C(t)):(e.consume(t),t===92?O:w)}function O(t){return t===92||t===124?(e.consume(t),w):w(t)}}function Jn(e,t){let n=-1,r=!0,i=0,a=[0,0,0,0],o=[0,0,0,0],s=!1,c=0,l,u,d,f=new Un;for(;++n<e.length;){let p=e[n],m=p[1];p[0]===`enter`?m.type===`tableHead`?(s=!1,c!==0&&(Xn(f,t,c,l,u),u=void 0,c=0),l={type:`table`,start:Object.assign({},m.start),end:Object.assign({},m.end)},f.add(n,0,[[`enter`,l,t]])):m.type===`tableRow`||m.type===`tableDelimiterRow`?(r=!0,d=void 0,a=[0,0,0,0],o=[0,n+1,0,0],s&&(s=!1,u={type:`tableBody`,start:Object.assign({},m.start),end:Object.assign({},m.end)},f.add(n,0,[[`enter`,u,t]])),i=m.type===`tableDelimiterRow`?2:u?3:1):i&&(m.type===`data`||m.type===`tableDelimiterMarker`||m.type===`tableDelimiterFiller`)?(r=!1,o[2]===0&&(a[1]!==0&&(o[0]=o[1],d=Yn(f,t,a,i,void 0,d),a=[0,0,0,0]),o[2]=n)):m.type===`tableCellDivider`&&(r?r=!1:(a[1]!==0&&(o[0]=o[1],d=Yn(f,t,a,i,void 0,d)),a=o,o=[a[1],n,0,0])):m.type===`tableHead`?(s=!0,c=n):m.type===`tableRow`||m.type===`tableDelimiterRow`?(c=n,a[1]===0?o[1]!==0&&(d=Yn(f,t,o,i,n,d)):(o[0]=o[1],d=Yn(f,t,a,i,n,d)),i=0):i&&(m.type===`data`||m.type===`tableDelimiterMarker`||m.type===`tableDelimiterFiller`)&&(o[3]=n)}for(c!==0&&Xn(f,t,c,l,u),f.consume(t.events),n=-1;++n<t.events.length;){let e=t.events[n];e[0]===`enter`&&e[1].type===`table`&&(e[1]._align=Gn(t.events,n))}return e}function Yn(e,t,n,r,i,a){let o=r===1?`tableHeader`:r===2?`tableDelimiter`:`tableData`;n[0]!==0&&(a.end=Object.assign({},$(t.events,n[0])),e.add(n[0],0,[[`exit`,a,t]]));let s=$(t.events,n[1]);if(a={type:o,start:Object.assign({},s),end:Object.assign({},s)},e.add(n[1],0,[[`enter`,a,t]]),n[2]!==0){let i=$(t.events,n[2]),a=$(t.events,n[3]),o={type:`tableContent`,start:Object.assign({},i),end:Object.assign({},a)};if(e.add(n[2],0,[[`enter`,o,t]]),r!==2){let r=t.events[n[2]],i=t.events[n[3]];if(r[1].end=Object.assign({},i[1].end),r[1].type=`chunkText`,r[1].contentType=`text`,n[3]>n[2]+1){let t=n[2]+1,r=n[3]-n[2]-1;e.add(t,r,[])}}e.add(n[3]+1,0,[[`exit`,o,t]])}return i!==void 0&&(a.end=Object.assign({},$(t.events,i)),e.add(i,0,[[`exit`,a,t]]),a=void 0),a}function Xn(e,t,n,r,i){let a=[],o=$(t.events,n);i&&(i.end=Object.assign({},o),a.push([`exit`,i,t])),r.end=Object.assign({},o),a.push([`exit`,r,t]),e.add(n+1,0,a)}function $(e,t){let n=e[t],r=n[0]===`enter`?`start`:`end`;return n[1][r]}let Zn={name:`tasklistCheck`,tokenize:$n};function Qn(){return{text:{91:Zn}}}function $n(e,t,n){let r=this;return i;function i(t){return r.previous!==null||!r._gfmTasklistFirstContentOfListItem?n(t):(e.enter(`taskListCheck`),e.enter(`taskListCheckMarker`),e.consume(t),e.exit(`taskListCheckMarker`),a)}function a(t){return E(t)?(e.enter(`taskListCheckValueUnchecked`),e.consume(t),e.exit(`taskListCheckValueUnchecked`),o):t===88||t===120?(e.enter(`taskListCheckValueChecked`),e.consume(t),e.exit(`taskListCheckValueChecked`),o):n(t)}function o(t){return t===93?(e.enter(`taskListCheckMarker`),e.consume(t),e.exit(`taskListCheckMarker`),e.exit(`taskListCheck`),s):n(t)}function s(r){return T(r)?t(r):D(r)?e.check({tokenize:er},t,n)(r):n(r)}}function er(e,t,n){return j(e,r,`whitespace`);function r(e){return e===null?n(e):t(e)}}function tr(e){return p([yn(),Pn(),Hn(e),Kn(),Qn()])}function nr(e,t){let n=String(e);if(typeof t!=`string`)throw TypeError(`Expected character`);let r=0,i=n.indexOf(t);for(;i!==-1;)r++,i=n.indexOf(t,i+t.length);return r}function rr(e){if(typeof e!=`string`)throw TypeError(`Expected a string`);return e.replace(/[|\\{}()[\]^$+*?.]/g,`\\$&`).replace(/-/g,`\\x2d`)}let ir=(function(e){if(e==null)return lr;if(typeof e==`function`)return cr(e);if(typeof e==`object`)return Array.isArray(e)?ar(e):or(e);if(typeof e==`string`)return sr(e);throw Error(`Expected function, string, or object as test`)});function ar(e){let t=[],n=-1;for(;++n<e.length;)t[n]=ir(e[n]);return cr(r);function r(...e){let n=-1;for(;++n<t.length;)if(t[n].apply(this,e))return!0;return!1}}function or(e){let t=e;return cr(n);function n(n){let r=n,i;for(i in e)if(r[i]!==t[i])return!1;return!0}}function sr(e){return cr(t);function t(t){return t&&t.type===e}}function cr(e){return t;function t(t,n,r){return!!(ur(t)&&e.call(this,t,typeof n==`number`?n:void 0,r||void 0))}}function lr(){return!0}function ur(e){return typeof e==`object`&&!!e&&`type`in e}function dr(e){return e}let fr=[];function pr(e,t,n,r){let i;typeof t==`function`&&typeof n!=`function`?(r=n,n=t):i=t;let a=ir(i),o=r?-1:1;s(e,void 0,[])();function s(e,i,c){let l=e&&typeof e==`object`?e:{};if(typeof l.type==`string`){let t=typeof l.tagName==`string`?l.tagName:typeof l.name==`string`?l.name:void 0;Object.defineProperty(u,"name",{value:`node (`+dr(e.type+(t?`<`+t+`>`:``))+`)`})}return u;function u(){let l=fr,u,d,f;if((!t||a(e,i,c[c.length-1]||void 0))&&(l=mr(n(e,c)),l[0]===!1))return l;if(`children`in e&&e.children){let t=e;if(t.children&&l[0]!==`skip`)for(d=(r?t.children.length:-1)+o,f=c.concat(t);d>-1&&d<t.children.length;){let e=t.children[d];if(u=s(e,d,f)(),u[0]===!1)return u;d=typeof u[1]==`number`?u[1]:d+o}}return l}}}function mr(e){return Array.isArray(e)?e:typeof e==`number`?[!0,e]:e==null?fr:[e]}function hr(e,t,n){let r=ir((n||{}).ignore||[]),i=gr(t),a=-1;for(;++a<i.length;)pr(e,`text`,o);function o(e,t){let n=-1,i;for(;++n<t.length;){let e=t[n],a=i?i.children:void 0;if(r(e,a?a.indexOf(e):void 0,i))return;i=e}if(i)return s(e,t)}function s(e,t){let n=t[t.length-1],r=i[a][0],o=i[a][1],s=0,c=n.children.indexOf(e),l=!1,u=[];r.lastIndex=0;let d=r.exec(e.value);for(;d;){let n=d.index,i={index:d.index,input:d.input,stack:[...t,e]},a=o(...d,i);if(typeof a==`string`&&(a=a.length>0?{type:`text`,value:a}:void 0),a===!1?r.lastIndex=n+1:(s!==n&&u.push({type:`text`,value:e.value.slice(s,n)}),Array.isArray(a)?u.push(...a):a&&u.push(a),s=n+d[0].length,l=!0),!r.global)break;d=r.exec(e.value)}return l?(s<e.value.length&&u.push({type:`text`,value:e.value.slice(s)}),n.children.splice(c,1,...u)):u=[e],c+u.length}}function gr(e){let t=[];if(!Array.isArray(e))throw TypeError(`Expected find and replace tuple or list of tuples`);let n=!e[0]||Array.isArray(e[0])?e:[e],r=-1;for(;++r<n.length;){let e=n[r];t.push([_r(e[0]),vr(e[1])])}return t}function _r(e){return typeof e==`string`?new RegExp(rr(e),`g`):e}function vr(e){return typeof e==`function`?e:function(){return e}}function yr(){return{transforms:[Er],enter:{literalAutolink:br,literalAutolinkEmail:xr,literalAutolinkHttp:xr,literalAutolinkWww:xr},exit:{literalAutolink:Tr,literalAutolinkEmail:wr,literalAutolinkHttp:Sr,literalAutolinkWww:Cr}}}function br(e){this.enter({type:`link`,title:null,url:``,children:[]},e)}function xr(e){this.config.enter.autolinkProtocol.call(this,e)}function Sr(e){this.config.exit.autolinkProtocol.call(this,e)}function Cr(e){this.config.exit.data.call(this,e);let t=this.stack[this.stack.length-1];t.type,t.url=`http://`+this.sliceSerialize(e)}function wr(e){this.config.exit.autolinkEmail.call(this,e)}function Tr(e){this.exit(e)}function Er(e){hr(e,[[/(https?:\/\/|www(?=\.))([-.\w]+)([^ \t\r\n]*)/gi,Dr],[/(?<=^|\s|\p{P}|\p{S})([-.\w+]+)@([-\w]+(?:\.[-\w]+)+)/gu,Or]],{ignore:[`link`,`linkReference`]})}function Dr(e,t,n,r,i){let a=``;if(!jr(i)||(/^w/i.test(t)&&(n=t+n,t=``,a=`http://`),!kr(n)))return!1;let o=Ar(n+r);if(!o[0])return!1;let s={type:`link`,title:null,url:a+t+o[0],children:[{type:`text`,value:t+o[0]}]};return o[1]?[s,{type:`text`,value:o[1]}]:s}function Or(e,t,n,r){return!jr(r,!0)||/[-\d_]$/.test(n)?!1:{type:`link`,title:null,url:`mailto:`+t+`@`+n,children:[{type:`text`,value:t+`@`+n}]}}function kr(e){let t=e.split(`.`);return!(t.length<2||t[t.length-1]&&(/_/.test(t[t.length-1])||!/[a-zA-Z\d]/.test(t[t.length-1]))||t[t.length-2]&&(/_/.test(t[t.length-2])||!/[a-zA-Z\d]/.test(t[t.length-2])))}function Ar(e){let t=/[!"&'),.:;<>?\]}]+$/.exec(e);if(!t)return[e,void 0];e=e.slice(0,t.index);let n=t[0],r=n.indexOf(`)`),i=nr(e,`(`),a=nr(e,`)`);for(;r!==-1&&i>a;)e+=n.slice(0,r+1),n=n.slice(r+1),r=n.indexOf(`)`),a++;return[e,n]}function jr(e,t){let n=e.input.charCodeAt(e.index-1);return(e.index===0||k(n)||O(n))&&(!t||n!==47)}Vr.peek=Br;function Mr(){this.buffer()}function Nr(e){this.enter({type:`footnoteReference`,identifier:``,label:``},e)}function Pr(){this.buffer()}function Fr(e){this.enter({type:`footnoteDefinition`,identifier:``,label:``,children:[]},e)}function Ir(e){let t=this.resume(),n=this.stack[this.stack.length-1];n.type,n.identifier=_(this.sliceSerialize(e)).toLowerCase(),n.label=t}function Lr(e){this.exit(e)}function Rr(e){let t=this.resume(),n=this.stack[this.stack.length-1];n.type,n.identifier=_(this.sliceSerialize(e)).toLowerCase(),n.label=t}function zr(e){this.exit(e)}function Br(){return`[`}function Vr(e,t,n,r){let i=n.createTracker(r),a=i.move(`[^`),o=n.enter(`footnoteReference`),s=n.enter(`reference`);return a+=i.move(n.safe(n.associationId(e),{after:`]`,before:a})),s(),o(),a+=i.move(`]`),a}function Hr(){return{enter:{gfmFootnoteCallString:Mr,gfmFootnoteCall:Nr,gfmFootnoteDefinitionLabelString:Pr,gfmFootnoteDefinition:Fr},exit:{gfmFootnoteCallString:Ir,gfmFootnoteCall:Lr,gfmFootnoteDefinitionLabelString:Rr,gfmFootnoteDefinition:zr}}}Kr.peek=qr;function Ur(){return{canContainEols:[`delete`],enter:{strikethrough:Wr},exit:{strikethrough:Gr}}}function Wr(e){this.enter({type:`delete`,children:[]},e)}function Gr(e){this.exit(e)}function Kr(e,t,n,r){let i=n.createTracker(r),a=n.enter(`strikethrough`),o=i.move(`~~`);return o+=n.containerPhrasing(e,{...i.current(),before:o,after:`~`}),o+=i.move(`~~`),a(),o}function qr(){return`~`}function Jr(){return{enter:{table:Yr,tableData:$r,tableHeader:$r,tableRow:Zr},exit:{codeText:ei,table:Xr,tableData:Qr,tableHeader:Qr,tableRow:Qr}}}function Yr(e){let t=e._align;this.enter({type:`table`,align:t.map(function(e){return e===`none`?null:e}),children:[]},e),this.data.inTable=!0}function Xr(e){this.exit(e),this.data.inTable=void 0}function Zr(e){this.enter({type:`tableRow`,children:[]},e)}function Qr(e){this.exit(e)}function $r(e){this.enter({type:`tableCell`,children:[]},e)}function ei(e){let t=this.resume();this.data.inTable&&(t=t.replace(/\\([\\|])/g,ti));let n=this.stack[this.stack.length-1];n.type,n.value=t,this.exit(e)}function ti(e,t){return t===`|`?t:e}function ni(){return{exit:{taskListCheckValueChecked:ri,taskListCheckValueUnchecked:ri,paragraph:ii}}}function ri(e){let t=this.stack[this.stack.length-2];t.type,t.checked=e.type===`taskListCheckValueChecked`}function ii(e){let t=this.stack[this.stack.length-2];if(t&&t.type===`listItem`&&typeof t.checked==`boolean`){let e=this.stack[this.stack.length-1];e.type;let n=e.children[0];if(n&&n.type===`text`){let r=t.children,i=-1,a;for(;++i<r.length;){let e=r[i];if(e.type===`paragraph`){a=e;break}}a===e&&(n.value=n.value.slice(1),n.value.length===0?e.children.shift():e.position&&n.position&&typeof n.position.start.offset==`number`&&(n.position.start.column++,n.position.start.offset++,e.position.start=Object.assign({},n.position.start)))}}this.exit(e)}function ai(){return[yr(),Hr(),Ur(),Jr(),ni()]}return e.fromMarkdown=sn,e.gfm=tr,e.gfmFromMarkdown=ai,e})({});
  })());
}
// ---------- end GENERATED ----------

// ---------- GENERATED by plugin/build-novnc.mjs. Do not edit; rerun it. ----------
// noVNC 1.7.0 RFB client (MPL-2.0, https://github.com/novnc/noVNC; source: /home/yt/Work/novnc).
function novncClient() {
  return (novncClient.loaded ??= (() => {
return (function(e){Object.defineProperty(e,Symbol.toStringTag,{value:`Module`});function t(e){return e>>>0}function n(e){return e|0}let r=`warn`,i=()=>{},a=()=>{},o=()=>{},s=()=>{};function c(e){if(e===void 0?e=r:r=e,i=a=o=s=()=>{},window.console!==void 0)switch(e){case`debug`:i=console.debug.bind(window.console);case`info`:a=console.info.bind(window.console);case`warn`:o=console.warn.bind(window.console);case`error`:s=console.error.bind(window.console);case`none`:break;default:throw new window.Error(`invalid logging type '`+e+`'`)}}c();function l(e,t=!1){try{return decodeURIComponent(escape(e))}catch(n){if(n instanceof URIError&&t)return e;throw n}}function u(e){return unescape(encodeURIComponent(e))}var d={toBase64Table:`ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=`.split(``),base64Pad:`=`,encode(e){"use strict";let t=``,n=e.length,r=n%3;for(let r=0;r<n-2;r+=3)t+=this.toBase64Table[e[r]>>2],t+=this.toBase64Table[((e[r]&3)<<4)+(e[r+1]>>4)],t+=this.toBase64Table[((e[r+1]&15)<<2)+(e[r+2]>>6)],t+=this.toBase64Table[e[r+2]&63];let i=n-r;return r===2?(t+=this.toBase64Table[e[i]>>2],t+=this.toBase64Table[((e[i]&3)<<4)+(e[i+1]>>4)],t+=this.toBase64Table[(e[i+1]&15)<<2],t+=this.toBase64Table[64]):r===1&&(t+=this.toBase64Table[e[i]>>2],t+=this.toBase64Table[(e[i]&3)<<4],t+=this.toBase64Table[64],t+=this.toBase64Table[64]),t},toBinaryTable:[-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,62,-1,-1,-1,63,52,53,54,55,56,57,58,59,60,61,-1,-1,-1,0,-1,-1,-1,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,-1,-1,-1,-1,-1,-1,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,-1,-1,-1,-1,-1],decode(e,t=0){let n=e.indexOf(`=`)-t;n<0&&(n=e.length-t);let r=(n>>2)*3+Math.floor(n%4/1.5),i=Array(r),a=0,o=0;for(let n=0,r=t;r<e.length;r++){let t=this.toBinaryTable[e.charCodeAt(r)&127],c=e.charAt(r)===this.base64Pad;if(t===-1){s(`Illegal character code `+e.charCodeAt(r)+` at position `+r);continue}o=o<<6|t,a+=6,a>=8&&(a-=8,c||(i[n++]=o>>a&255),o&=(1<<a)-1)}if(a){let e=Error(`Corrupted base64 string`);throw e.name=`Base64-Error`,e}return i}};let f=`ontouchstart`in document.documentElement||document.ontouchstart!==void 0||navigator.maxTouchPoints>0||navigator.msMaxTouchPoints>0;window.addEventListener(`touchstart`,function e(){f=!0,window.removeEventListener(`touchstart`,e,!1)},!1);let p=10*(window.devicePixelRatio||1),m=!1;try{let e=document.createElement(`canvas`);e.style.cursor=`url("data:image/x-icon;base64,AAACAAEACAgAAAIAAgA4AQAAFgAAACgAAAAIAAAAEAAAAAEAIAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAD/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////AAAAAAAAAAAAAAAAAAAAAA==") 2 2, default`,e.style.cursor.indexOf(`url`)===0?(a(`Data URI scheme cursor supported`),m=!0):o(`Data URI scheme cursor not supported`)}catch(e){s(`Data URI scheme cursor test exception: `+e)}let h=m;try{let e=document.createElement(`div`);e.style.visibility=`hidden`,e.style.overflow=`scroll`,document.body.appendChild(e);let t=document.createElement(`div`);e.appendChild(t),e.offsetWidth-t.offsetWidth,e.parentNode.removeChild(e)}catch(e){s(`Scrollbar test exception: `+e)}let g=!1;g=!1;function _(){return!!/mac/i.exec(navigator.platform)}function v(){return!!/win/i.exec(navigator.platform)}function y(){return!!/ipad/i.exec(navigator.platform)||!!/iphone/i.exec(navigator.platform)||!!/ipod/i.exec(navigator.platform)}function b(e,t,n){let r=n.getBoundingClientRect(),i={x:0,y:0};return i.x=e<r.left?0:e>=r.right?r.width-1:e-r.left,i.y=t<r.top?0:t>=r.bottom?r.height-1:t-r.top,i}function x(e){e.stopPropagation(),e.preventDefault()}let S=!1,C=null;document.captureElement=null;function w(e){if(S)return;let t=new e.constructor(e.type,e);S=!0,document.captureElement?document.captureElement.dispatchEvent(t):C.dispatchEvent(t),S=!1,e.stopPropagation(),t.defaultPrevented&&e.preventDefault(),e.type===`mouseup`&&O()}function T(){let e=document.getElementById(`noVNC_mouse_capture_elem`);e.style.cursor=window.getComputedStyle(document.captureElement).cursor}let E=new MutationObserver(T);function D(e){if(e.setCapture)e.setCapture(),document.captureElement=e;else{O();let t=document.getElementById(`noVNC_mouse_capture_elem`);t===null&&(t=document.createElement(`div`),t.id=`noVNC_mouse_capture_elem`,t.style.position=`fixed`,t.style.top=`0px`,t.style.left=`0px`,t.style.width=`100%`,t.style.height=`100%`,t.style.zIndex=1e4,t.style.display=`none`,document.body.appendChild(t),t.addEventListener(`contextmenu`,w),t.addEventListener(`mousemove`,w),t.addEventListener(`mouseup`,w)),document.captureElement=e,E.observe(e,{attributes:!0}),T(),t.style.display=``,window.addEventListener(`mousemove`,w),window.addEventListener(`mouseup`,w)}}function O(){if(document.releaseCapture)document.releaseCapture(),document.captureElement=null;else{if(!document.captureElement)return;C=document.captureElement,document.captureElement=null,E.disconnect();let e=document.getElementById(`noVNC_mouse_capture_elem`);e.style.display=`none`,window.removeEventListener(`mousemove`,w),window.removeEventListener(`mouseup`,w)}}var ee=class{constructor(){this._listeners=new Map}addEventListener(e,t){this._listeners.has(e)||this._listeners.set(e,new Set),this._listeners.get(e).add(t)}removeEventListener(e,t){this._listeners.has(e)&&this._listeners.get(e).delete(t)}dispatchEvent(e){return!this._listeners.has(e.type)||(this._listeners.get(e.type).forEach(t=>t.call(this,e)),!e.defaultPrevented)}},te=class{constructor(e){if(this._drawCtx=null,this._renderQ=[],this._flushPromise=null,this._fbWidth=0,this._fbHeight=0,this._prevDrawStyle=``,i(`>> Display.constructor`),this._target=e,!this._target)throw Error(`Target must be set`);if(typeof this._target==`string`)throw Error(`target must be a DOM element`);if(!this._target.getContext)throw Error(`no getContext method`);this._targetCtx=this._target.getContext(`2d`),this._viewportLoc={x:0,y:0,w:this._target.width,h:this._target.height},this._backbuffer=document.createElement(`canvas`),this._drawCtx=this._backbuffer.getContext(`2d`),this._damageBounds={left:0,top:0,right:this._backbuffer.width,bottom:this._backbuffer.height},i(`User Agent: `+navigator.userAgent),i(`<< Display.constructor`),this._scale=1,this._clipViewport=!1}get scale(){return this._scale}set scale(e){this._rescale(e)}get clipViewport(){return this._clipViewport}set clipViewport(e){this._clipViewport=e;let t=this._viewportLoc;this.viewportChangeSize(t.w,t.h),this.viewportChangePos(0,0)}get width(){return this._fbWidth}get height(){return this._fbHeight}viewportChangePos(e,t){let n=this._viewportLoc;e=Math.floor(e),t=Math.floor(t),this._clipViewport||(e=-n.w,t=-n.h);let r=n.x+n.w-1,a=n.y+n.h-1;e<0&&n.x+e<0&&(e=-n.x),r+e>=this._fbWidth&&(e-=r+e-this._fbWidth+1),n.y+t<0&&(t=-n.y),a+t>=this._fbHeight&&(t-=a+t-this._fbHeight+1),(e!==0||t!==0)&&(i(`viewportChange deltaX: `+e+`, deltaY: `+t),n.x+=e,n.y+=t,this._damage(n.x,n.y,n.w,n.h),this.flip())}viewportChangeSize(e,t){(!this._clipViewport||e===void 0||t===void 0)&&(i(`Setting viewport to full display region`),e=this._fbWidth,t=this._fbHeight),e=Math.floor(e),t=Math.floor(t),e>this._fbWidth&&(e=this._fbWidth),t>this._fbHeight&&(t=this._fbHeight);let n=this._viewportLoc;if(n.w!==e||n.h!==t){n.w=e,n.h=t;let r=this._target;r.width=e,r.height=t,this.viewportChangePos(0,0),this._damage(n.x,n.y,n.w,n.h),this.flip(),this._rescale(this._scale)}}absX(e){return this._scale===0?0:n(e/this._scale+this._viewportLoc.x)}absY(e){return this._scale===0?0:n(e/this._scale+this._viewportLoc.y)}resize(e,t){this._prevDrawStyle=``,this._fbWidth=e,this._fbHeight=t;let n=this._backbuffer;if(n.width!==e||n.height!==t){let r=null;n.width>0&&n.height>0&&(r=this._drawCtx.getImageData(0,0,n.width,n.height)),n.width!==e&&(n.width=e),n.height!==t&&(n.height=t),r&&this._drawCtx.putImageData(r,0,0)}let r=this._viewportLoc;this.viewportChangeSize(r.w,r.h),this.viewportChangePos(0,0)}getImageData(){return this._drawCtx.getImageData(0,0,this.width,this.height)}toDataURL(e,t){return this._backbuffer.toDataURL(e,t)}toBlob(e,t,n){return this._backbuffer.toBlob(e,t,n)}_damage(e,t,n,r){e<this._damageBounds.left&&(this._damageBounds.left=e),t<this._damageBounds.top&&(this._damageBounds.top=t),e+n>this._damageBounds.right&&(this._damageBounds.right=e+n),t+r>this._damageBounds.bottom&&(this._damageBounds.bottom=t+r)}flip(e){if(this._renderQ.length!==0&&!e)this._renderQPush({type:`flip`});else{let e=this._damageBounds.left,t=this._damageBounds.top,n=this._damageBounds.right-e,r=this._damageBounds.bottom-t,i=e-this._viewportLoc.x,a=t-this._viewportLoc.y;i<0&&(n+=i,e-=i,i=0),a<0&&(r+=a,t-=a,a=0),i+n>this._viewportLoc.w&&(n=this._viewportLoc.w-i),a+r>this._viewportLoc.h&&(r=this._viewportLoc.h-a),n>0&&r>0&&this._targetCtx.drawImage(this._backbuffer,e,t,n,r,i,a,n,r),this._damageBounds.left=this._damageBounds.top=65535,this._damageBounds.right=this._damageBounds.bottom=0}}pending(){return this._renderQ.length>0}flush(){return this._renderQ.length===0?Promise.resolve():(this._flushPromise===null&&(this._flushPromise=new Promise(e=>{this._flushResolve=e})),this._flushPromise)}fillRect(e,t,n,r,i,a){this._renderQ.length!==0&&!a?this._renderQPush({type:`fill`,x:e,y:t,width:n,height:r,color:i}):(this._setFillColor(i),this._drawCtx.fillRect(e,t,n,r),this._damage(e,t,n,r))}copyImage(e,t,n,r,i,a,o){this._renderQ.length!==0&&!o?this._renderQPush({type:`copy`,oldX:e,oldY:t,x:n,y:r,width:i,height:a}):(this._drawCtx.mozImageSmoothingEnabled=!1,this._drawCtx.webkitImageSmoothingEnabled=!1,this._drawCtx.msImageSmoothingEnabled=!1,this._drawCtx.imageSmoothingEnabled=!1,this._drawCtx.drawImage(this._backbuffer,e,t,i,a,n,r,i,a),this._damage(n,r,i,a))}imageRect(e,t,n,r,i,a){if(n===0||r===0)return;let o=new Image;o.src=`data: `+i+`;base64,`+d.encode(a),this._renderQPush({type:`img`,img:o,x:e,y:t,width:n,height:r})}videoFrame(e,t,n,r,i){this._renderQPush({type:`frame`,frame:i,x:e,y:t,width:n,height:r})}blitImage(e,t,n,r,i,a,o){if(this._renderQ.length!==0&&!o){let a=new Uint8Array(n*r*4);a.set(new Uint8Array(i.buffer,0,a.length)),this._renderQPush({type:`blit`,data:a,x:e,y:t,width:n,height:r})}else{let o=new Uint8ClampedArray(i.buffer,i.byteOffset+a,n*r*4),s=new ImageData(o,n,r);this._drawCtx.putImageData(s,e,t),this._damage(e,t,n,r)}}drawImage(e,...t){if(this._drawCtx.drawImage(e,...t),t.length<=4){let[n,r]=t;this._damage(n,r,e.width,e.height)}else{let[,,e,n,r,i]=t;this._damage(r,i,e,n)}}autoscale(e,t){let n;if(e===0||t===0)n=0;else{let r=this._viewportLoc,i=e/t;n=r.w/r.h>=i?e/r.w:t/r.h}this._rescale(n)}_rescale(e){this._scale=e;let t=this._viewportLoc,n=e*t.w+`px`,r=e*t.h+`px`;(this._target.style.width!==n||this._target.style.height!==r)&&(this._target.style.width=n,this._target.style.height=r)}_setFillColor(e){let t=`rgb(`+e[0]+`,`+e[1]+`,`+e[2]+`)`;t!==this._prevDrawStyle&&(this._drawCtx.fillStyle=t,this._prevDrawStyle=t)}_renderQPush(e){this._renderQ.push(e),this._renderQ.length===1&&this._scanRenderQ()}_resumeRenderQ(){this.removeEventListener(`load`,this._noVNCDisplay._resumeRenderQ),this._noVNCDisplay._scanRenderQ()}_scanRenderQ(){let e=!0;for(;e&&this._renderQ.length>0;){let t=this._renderQ[0];switch(t.type){case`flip`:this.flip(!0);break;case`copy`:this.copyImage(t.oldX,t.oldY,t.x,t.y,t.width,t.height,!0);break;case`fill`:this.fillRect(t.x,t.y,t.width,t.height,t.color,!0);break;case`blit`:this.blitImage(t.x,t.y,t.width,t.height,t.data,0,!0);break;case`img`:if(t.img.complete){if(t.img.width!==t.width||t.img.height!==t.height){s(`Decoded image has incorrect dimensions. Got `+t.img.width+`x`+t.img.height+`. Expected `+t.width+`x`+t.height+`.`);return}this.drawImage(t.img,t.x,t.y),t.img.src=``}else t.img._noVNCDisplay=this,t.img.addEventListener(`load`,this._resumeRenderQ),e=!1;break;case`frame`:if(t.frame.ready){let e=t.frame.frame;(e.codedWidth<t.width||e.codedHeight<t.height)&&o(`Decoded video frame does not cover its full rectangle area. Expecting at least `+t.width+`x`+t.height+` but got `+e.codedWidth+`x`+e.codedHeight);let n=t.width,r=t.height,i=t.x,a=t.y,s=n,c=r;this.drawImage(e,0,0,n,r,i,a,s,c),e.close()}else{let n=this;t.frame.promise.then(()=>{n._scanRenderQ()}),e=!1}}e&&this._renderQ.shift()}this._renderQ.length===0&&this._flushPromise!==null&&(this._flushResolve(),this._flushPromise=null,this._flushResolve=null)}};function ne(e,t,n,r,i){if(t.subarray&&e.subarray){e.set(t.subarray(n,n+r),i);return}for(var a=0;a<r;a++)e[i+a]=t[n+a]}var re=Uint8Array,k=Uint16Array,ie=Int32Array;function ae(e,t,n,r){for(var i=e&65535|0,a=e>>>16&65535|0,o=0;n!==0;){o=n>2e3?2e3:n,n-=o;do i=i+t[r++]|0,a=a+i|0;while(--o);i%=65521,a%=65521}return i|a<<16|0}function A(){for(var e,t=[],n=0;n<256;n++){e=n;for(var r=0;r<8;r++)e=e&1?3988292384^e>>>1:e>>>1;t[n]=e}return t}A();var oe=30,se=12;function ce(e,t){var n=e.state,r=e.next_in,i,a,o,s,c,l,u,d,f,p,m,h,g,_,v,y,b,x,S,C,w,T=e.input,E;i=r+(e.avail_in-5),a=e.next_out,E=e.output,o=a-(t-e.avail_out),s=a+(e.avail_out-257),c=n.dmax,l=n.wsize,u=n.whave,d=n.wnext,f=n.window,p=n.hold,m=n.bits,h=n.lencode,g=n.distcode,_=(1<<n.lenbits)-1,v=(1<<n.distbits)-1;top:do{m<15&&(p+=T[r++]<<m,m+=8,p+=T[r++]<<m,m+=8),y=h[p&_];dolen:for(;;){if(b=y>>>24,p>>>=b,m-=b,b=y>>>16&255,b===0)E[a++]=y&65535;else if(b&16){x=y&65535,b&=15,b&&(m<b&&(p+=T[r++]<<m,m+=8),x+=p&(1<<b)-1,p>>>=b,m-=b),m<15&&(p+=T[r++]<<m,m+=8,p+=T[r++]<<m,m+=8),y=g[p&v];dodist:for(;;){if(b=y>>>24,p>>>=b,m-=b,b=y>>>16&255,b&16){if(S=y&65535,b&=15,m<b&&(p+=T[r++]<<m,m+=8,m<b&&(p+=T[r++]<<m,m+=8)),S+=p&(1<<b)-1,S>c){e.msg=`invalid distance too far back`,n.mode=oe;break top}if(p>>>=b,m-=b,b=a-o,S>b){if(b=S-b,b>u&&n.sane){e.msg=`invalid distance too far back`,n.mode=oe;break top}if(C=0,w=f,d===0){if(C+=l-b,b<x){x-=b;do E[a++]=f[C++];while(--b);C=a-S,w=E}}else if(d<b){if(C+=l+d-b,b-=d,b<x){x-=b;do E[a++]=f[C++];while(--b);if(C=0,d<x){b=d,x-=b;do E[a++]=f[C++];while(--b);C=a-S,w=E}}}else if(C+=d-b,b<x){x-=b;do E[a++]=f[C++];while(--b);C=a-S,w=E}for(;x>2;)E[a++]=w[C++],E[a++]=w[C++],E[a++]=w[C++],x-=3;x&&(E[a++]=w[C++],x>1&&(E[a++]=w[C++]))}else{C=a-S;do E[a++]=E[C++],E[a++]=E[C++],E[a++]=E[C++],x-=3;while(x>2);x&&(E[a++]=E[C++],x>1&&(E[a++]=E[C++]))}}else if(b&64){e.msg=`invalid distance code`,n.mode=oe;break top}else{y=g[(y&65535)+(p&(1<<b)-1)];continue dodist}break}}else if(!(b&64)){y=h[(y&65535)+(p&(1<<b)-1)];continue dolen}else if(b&32){n.mode=se;break top}else{e.msg=`invalid literal/length code`,n.mode=oe;break top}break}}while(r<i&&a<s);x=m>>3,r-=x,m-=x<<3,p&=(1<<m)-1,e.next_in=r,e.next_out=a,e.avail_in=r<i?5+(i-r):5-(r-i),e.avail_out=a<s?257+(s-a):257-(a-s),n.hold=p,n.bits=m}var le=15,ue=852,de=592,fe=0,pe=1,me=2,he=[3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258,0,0],ge=[16,16,16,16,16,16,16,16,17,17,17,17,18,18,18,18,19,19,19,19,20,20,20,20,21,21,21,21,16,72,78],_e=[1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577,0,0],ve=[16,16,16,16,17,17,18,18,19,19,20,20,21,21,22,22,23,23,24,24,25,25,26,26,27,27,28,28,29,29,64,64];function ye(e,t,n,r,i,a,o,s){var c=s.bits,l=0,u=0,d=0,f=0,p=0,m=0,h=0,g=0,_=0,v=0,y,b,x,S,C,w=null,T=0,E,D=new k(le+1),O=new k(le+1),ee=null,te=0,ne,re,ie;for(l=0;l<=le;l++)D[l]=0;for(u=0;u<r;u++)D[t[n+u]]++;for(p=c,f=le;f>=1&&D[f]===0;f--);if(p>f&&(p=f),f===0)return i[a++]=20971520,i[a++]=20971520,s.bits=1,0;for(d=1;d<f&&D[d]===0;d++);for(p<d&&(p=d),g=1,l=1;l<=le;l++)if(g<<=1,g-=D[l],g<0)return-1;if(g>0&&(e===fe||f!==1))return-1;for(O[1]=0,l=1;l<le;l++)O[l+1]=O[l]+D[l];for(u=0;u<r;u++)t[n+u]!==0&&(o[O[t[n+u]]++]=u);if(e===fe?(w=ee=o,E=19):e===pe?(w=he,T-=257,ee=ge,te-=257,E=256):(w=_e,ee=ve,E=-1),v=0,u=0,l=d,C=a,m=p,h=0,x=-1,_=1<<p,S=_-1,e===pe&&_>ue||e===me&&_>de)return 1;for(;;){ne=l-h,o[u]<E?(re=0,ie=o[u]):o[u]>E?(re=ee[te+o[u]],ie=w[T+o[u]]):(re=96,ie=0),y=1<<l-h,b=1<<m,d=b;do b-=y,i[C+(v>>h)+b]=ne<<24|re<<16|ie|0;while(b!==0);for(y=1<<l-1;v&y;)y>>=1;if(y===0?v=0:(v&=y-1,v+=y),u++,--D[l]===0){if(l===f)break;l=t[n+o[u]]}if(l>p&&(v&S)!==x){for(h===0&&(h=p),C+=d,m=l-h,g=1<<m;m+h<f&&(g-=D[m+h],!(g<=0));)m++,g<<=1;if(_+=1<<m,e===pe&&_>ue||e===me&&_>de)return 1;x=v&S,i[x]=p<<24|m<<16|C-a|0}}return v!==0&&(i[C+v]=l-h<<24|4194304),s.bits=p,0}var be=0,xe=1,Se=2,Ce=1,we=2,Te=3,Ee=4,De=5,Oe=6,ke=7,Ae=8,je=9,Me=10,Ne=11,Pe=12,Fe=13,Ie=14,Le=15,Re=16,ze=17,Be=18,Ve=19,He=20,Ue=21,We=22,Ge=23,Ke=24,qe=25,Je=26,Ye=27,Xe=28,Ze=29,j=30,Qe=31,$e=32,et=852,tt=592,nt=15;function rt(e){return(e>>>24&255)+(e>>>8&65280)+((e&65280)<<8)+((e&255)<<24)}function it(){this.mode=0,this.last=!1,this.wrap=0,this.havedict=!1,this.flags=0,this.dmax=0,this.check=0,this.total=0,this.head=null,this.wbits=0,this.wsize=0,this.whave=0,this.wnext=0,this.window=null,this.hold=0,this.bits=0,this.length=0,this.offset=0,this.extra=0,this.lencode=null,this.distcode=null,this.lenbits=0,this.distbits=0,this.ncode=0,this.nlen=0,this.ndist=0,this.have=0,this.next=null,this.lens=new k(320),this.work=new k(288),this.lendyn=null,this.distdyn=null,this.sane=0,this.back=0,this.was=0}function at(e){var t;return!e||!e.state?-2:(t=e.state,e.total_in=e.total_out=t.total=0,e.msg=``,t.wrap&&(e.adler=t.wrap&1),t.mode=Ce,t.last=0,t.havedict=0,t.dmax=32768,t.head=null,t.hold=0,t.bits=0,t.lencode=t.lendyn=new ie(et),t.distcode=t.distdyn=new ie(tt),t.sane=1,t.back=-1,0)}function ot(e){var t;return!e||!e.state?-2:(t=e.state,t.wsize=0,t.whave=0,t.wnext=0,at(e))}function st(e,t){var n,r;return!e||!e.state||(r=e.state,t<0?(n=0,t=-t):(n=(t>>4)+1,t<48&&(t&=15)),t&&(t<8||t>15))?-2:(r.window!==null&&r.wbits!==t&&(r.window=null),r.wrap=n,r.wbits=t,ot(e))}function ct(e,t){var n,r;return e?(r=new it,e.state=r,r.window=null,n=st(e,t),n!==0&&(e.state=null),n):-2}function lt(e){return ct(e,nt)}var ut=!0,dt,ft;function pt(e){if(ut){var t;for(dt=new ie(512),ft=new ie(32),t=0;t<144;)e.lens[t++]=8;for(;t<256;)e.lens[t++]=9;for(;t<280;)e.lens[t++]=7;for(;t<288;)e.lens[t++]=8;for(ye(xe,e.lens,0,288,dt,0,e.work,{bits:9}),t=0;t<32;)e.lens[t++]=5;ye(Se,e.lens,0,32,ft,0,e.work,{bits:5}),ut=!1}e.lencode=dt,e.lenbits=9,e.distcode=ft,e.distbits=5}function mt(e,t,n,r){var i,a=e.state;return a.window===null&&(a.wsize=1<<a.wbits,a.wnext=0,a.whave=0,a.window=new re(a.wsize)),r>=a.wsize?(ne(a.window,t,n-a.wsize,a.wsize,0),a.wnext=0,a.whave=a.wsize):(i=a.wsize-a.wnext,i>r&&(i=r),ne(a.window,t,n-r,i,a.wnext),r-=i,r?(ne(a.window,t,n-r,r,0),a.wnext=r,a.whave=a.wsize):(a.wnext+=i,a.wnext===a.wsize&&(a.wnext=0),a.whave<a.wsize&&(a.whave+=i))),0}function ht(e,t){var n,r,i,a,o,s,c,l,u,d,f,p,m,h,g=0,_,v,y,b,x,S,C,w,T=new re(4),E,D,O=[16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15];if(!e||!e.state||!e.output||!e.input&&e.avail_in!==0)return-2;n=e.state,n.mode===Pe&&(n.mode=Fe),o=e.next_out,i=e.output,c=e.avail_out,a=e.next_in,r=e.input,s=e.avail_in,l=n.hold,u=n.bits,d=s,f=c,w=0;inf_leave:for(;;)switch(n.mode){case Ce:if(n.wrap===0){n.mode=Fe;break}for(;u<16;){if(s===0)break inf_leave;s--,l+=r[a++]<<u,u+=8}if(n.wrap&2&&l===35615){n.check=0,T[0]=l&255,T[1]=l>>>8&255,n.check=A(n.check,T,2,0),l=0,u=0,n.mode=we;break}if(n.flags=0,n.head&&(n.head.done=!1),!(n.wrap&1)||(((l&255)<<8)+(l>>8))%31){e.msg=`incorrect header check`,n.mode=j;break}if((l&15)!=8){e.msg=`unknown compression method`,n.mode=j;break}if(l>>>=4,u-=4,C=(l&15)+8,n.wbits===0)n.wbits=C;else if(C>n.wbits){e.msg=`invalid window size`,n.mode=j;break}n.dmax=1<<C,e.adler=n.check=1,n.mode=l&512?Me:Pe,l=0,u=0;break;case we:for(;u<16;){if(s===0)break inf_leave;s--,l+=r[a++]<<u,u+=8}if(n.flags=l,(n.flags&255)!=8){e.msg=`unknown compression method`,n.mode=j;break}if(n.flags&57344){e.msg=`unknown header flags set`,n.mode=j;break}n.head&&(n.head.text=l>>8&1),n.flags&512&&(T[0]=l&255,T[1]=l>>>8&255,n.check=A(n.check,T,2,0)),l=0,u=0,n.mode=Te;case Te:for(;u<32;){if(s===0)break inf_leave;s--,l+=r[a++]<<u,u+=8}n.head&&(n.head.time=l),n.flags&512&&(T[0]=l&255,T[1]=l>>>8&255,T[2]=l>>>16&255,T[3]=l>>>24&255,n.check=A(n.check,T,4,0)),l=0,u=0,n.mode=Ee;case Ee:for(;u<16;){if(s===0)break inf_leave;s--,l+=r[a++]<<u,u+=8}n.head&&(n.head.xflags=l&255,n.head.os=l>>8),n.flags&512&&(T[0]=l&255,T[1]=l>>>8&255,n.check=A(n.check,T,2,0)),l=0,u=0,n.mode=De;case De:if(n.flags&1024){for(;u<16;){if(s===0)break inf_leave;s--,l+=r[a++]<<u,u+=8}n.length=l,n.head&&(n.head.extra_len=l),n.flags&512&&(T[0]=l&255,T[1]=l>>>8&255,n.check=A(n.check,T,2,0)),l=0,u=0}else n.head&&(n.head.extra=null);n.mode=Oe;case Oe:if(n.flags&1024&&(p=n.length,p>s&&(p=s),p&&(n.head&&(C=n.head.extra_len-n.length,n.head.extra||(n.head.extra=Array(n.head.extra_len)),ne(n.head.extra,r,a,p,C)),n.flags&512&&(n.check=A(n.check,r,p,a)),s-=p,a+=p,n.length-=p),n.length))break inf_leave;n.length=0,n.mode=ke;case ke:if(n.flags&2048){if(s===0)break inf_leave;p=0;do C=r[a+p++],n.head&&C&&n.length<65536&&(n.head.name+=String.fromCharCode(C));while(C&&p<s);if(n.flags&512&&(n.check=A(n.check,r,p,a)),s-=p,a+=p,C)break inf_leave}else n.head&&(n.head.name=null);n.length=0,n.mode=Ae;case Ae:if(n.flags&4096){if(s===0)break inf_leave;p=0;do C=r[a+p++],n.head&&C&&n.length<65536&&(n.head.comment+=String.fromCharCode(C));while(C&&p<s);if(n.flags&512&&(n.check=A(n.check,r,p,a)),s-=p,a+=p,C)break inf_leave}else n.head&&(n.head.comment=null);n.mode=je;case je:if(n.flags&512){for(;u<16;){if(s===0)break inf_leave;s--,l+=r[a++]<<u,u+=8}if(l!==(n.check&65535)){e.msg=`header crc mismatch`,n.mode=j;break}l=0,u=0}n.head&&(n.head.hcrc=n.flags>>9&1,n.head.done=!0),e.adler=n.check=0,n.mode=Pe;break;case Me:for(;u<32;){if(s===0)break inf_leave;s--,l+=r[a++]<<u,u+=8}e.adler=n.check=rt(l),l=0,u=0,n.mode=Ne;case Ne:if(n.havedict===0)return e.next_out=o,e.avail_out=c,e.next_in=a,e.avail_in=s,n.hold=l,n.bits=u,2;e.adler=n.check=1,n.mode=Pe;case Pe:if(t===5||t===6)break inf_leave;case Fe:if(n.last){l>>>=u&7,u-=u&7,n.mode=Ye;break}for(;u<3;){if(s===0)break inf_leave;s--,l+=r[a++]<<u,u+=8}switch(n.last=l&1,l>>>=1,--u,l&3){case 0:n.mode=Ie;break;case 1:if(pt(n),n.mode=He,t===6){l>>>=2,u-=2;break inf_leave}break;case 2:n.mode=ze;break;case 3:e.msg=`invalid block type`,n.mode=j}l>>>=2,u-=2;break;case Ie:for(l>>>=u&7,u-=u&7;u<32;){if(s===0)break inf_leave;s--,l+=r[a++]<<u,u+=8}if((l&65535)!=(l>>>16^65535)){e.msg=`invalid stored block lengths`,n.mode=j;break}if(n.length=l&65535,l=0,u=0,n.mode=Le,t===6)break inf_leave;case Le:n.mode=Re;case Re:if(p=n.length,p){if(p>s&&(p=s),p>c&&(p=c),p===0)break inf_leave;ne(i,r,a,p,o),s-=p,a+=p,c-=p,o+=p,n.length-=p;break}n.mode=Pe;break;case ze:for(;u<14;){if(s===0)break inf_leave;s--,l+=r[a++]<<u,u+=8}if(n.nlen=(l&31)+257,l>>>=5,u-=5,n.ndist=(l&31)+1,l>>>=5,u-=5,n.ncode=(l&15)+4,l>>>=4,u-=4,n.nlen>286||n.ndist>30){e.msg=`too many length or distance symbols`,n.mode=j;break}n.have=0,n.mode=Be;case Be:for(;n.have<n.ncode;){for(;u<3;){if(s===0)break inf_leave;s--,l+=r[a++]<<u,u+=8}n.lens[O[n.have++]]=l&7,l>>>=3,u-=3}for(;n.have<19;)n.lens[O[n.have++]]=0;if(n.lencode=n.lendyn,n.lenbits=7,E={bits:n.lenbits},w=ye(be,n.lens,0,19,n.lencode,0,n.work,E),n.lenbits=E.bits,w){e.msg=`invalid code lengths set`,n.mode=j;break}n.have=0,n.mode=Ve;case Ve:for(;n.have<n.nlen+n.ndist;){for(;g=n.lencode[l&(1<<n.lenbits)-1],_=g>>>24,v=g>>>16&255,y=g&65535,!(_<=u);){if(s===0)break inf_leave;s--,l+=r[a++]<<u,u+=8}if(y<16)l>>>=_,u-=_,n.lens[n.have++]=y;else{if(y===16){for(D=_+2;u<D;){if(s===0)break inf_leave;s--,l+=r[a++]<<u,u+=8}if(l>>>=_,u-=_,n.have===0){e.msg=`invalid bit length repeat`,n.mode=j;break}C=n.lens[n.have-1],p=3+(l&3),l>>>=2,u-=2}else if(y===17){for(D=_+3;u<D;){if(s===0)break inf_leave;s--,l+=r[a++]<<u,u+=8}l>>>=_,u-=_,C=0,p=3+(l&7),l>>>=3,u-=3}else{for(D=_+7;u<D;){if(s===0)break inf_leave;s--,l+=r[a++]<<u,u+=8}l>>>=_,u-=_,C=0,p=11+(l&127),l>>>=7,u-=7}if(n.have+p>n.nlen+n.ndist){e.msg=`invalid bit length repeat`,n.mode=j;break}for(;p--;)n.lens[n.have++]=C}}if(n.mode===j)break;if(n.lens[256]===0){e.msg=`invalid code -- missing end-of-block`,n.mode=j;break}if(n.lenbits=9,E={bits:n.lenbits},w=ye(xe,n.lens,0,n.nlen,n.lencode,0,n.work,E),n.lenbits=E.bits,w){e.msg=`invalid literal/lengths set`,n.mode=j;break}if(n.distbits=6,n.distcode=n.distdyn,E={bits:n.distbits},w=ye(Se,n.lens,n.nlen,n.ndist,n.distcode,0,n.work,E),n.distbits=E.bits,w){e.msg=`invalid distances set`,n.mode=j;break}if(n.mode=He,t===6)break inf_leave;case He:n.mode=Ue;case Ue:if(s>=6&&c>=258){e.next_out=o,e.avail_out=c,e.next_in=a,e.avail_in=s,n.hold=l,n.bits=u,ce(e,f),o=e.next_out,i=e.output,c=e.avail_out,a=e.next_in,r=e.input,s=e.avail_in,l=n.hold,u=n.bits,n.mode===Pe&&(n.back=-1);break}for(n.back=0;g=n.lencode[l&(1<<n.lenbits)-1],_=g>>>24,v=g>>>16&255,y=g&65535,!(_<=u);){if(s===0)break inf_leave;s--,l+=r[a++]<<u,u+=8}if(v&&!(v&240)){for(b=_,x=v,S=y;g=n.lencode[S+((l&(1<<b+x)-1)>>b)],_=g>>>24,v=g>>>16&255,y=g&65535,!(b+_<=u);){if(s===0)break inf_leave;s--,l+=r[a++]<<u,u+=8}l>>>=b,u-=b,n.back+=b}if(l>>>=_,u-=_,n.back+=_,n.length=y,v===0){n.mode=Je;break}if(v&32){n.back=-1,n.mode=Pe;break}if(v&64){e.msg=`invalid literal/length code`,n.mode=j;break}n.extra=v&15,n.mode=We;case We:if(n.extra){for(D=n.extra;u<D;){if(s===0)break inf_leave;s--,l+=r[a++]<<u,u+=8}n.length+=l&(1<<n.extra)-1,l>>>=n.extra,u-=n.extra,n.back+=n.extra}n.was=n.length,n.mode=Ge;case Ge:for(;g=n.distcode[l&(1<<n.distbits)-1],_=g>>>24,v=g>>>16&255,y=g&65535,!(_<=u);){if(s===0)break inf_leave;s--,l+=r[a++]<<u,u+=8}if(!(v&240)){for(b=_,x=v,S=y;g=n.distcode[S+((l&(1<<b+x)-1)>>b)],_=g>>>24,v=g>>>16&255,y=g&65535,!(b+_<=u);){if(s===0)break inf_leave;s--,l+=r[a++]<<u,u+=8}l>>>=b,u-=b,n.back+=b}if(l>>>=_,u-=_,n.back+=_,v&64){e.msg=`invalid distance code`,n.mode=j;break}n.offset=y,n.extra=v&15,n.mode=Ke;case Ke:if(n.extra){for(D=n.extra;u<D;){if(s===0)break inf_leave;s--,l+=r[a++]<<u,u+=8}n.offset+=l&(1<<n.extra)-1,l>>>=n.extra,u-=n.extra,n.back+=n.extra}if(n.offset>n.dmax){e.msg=`invalid distance too far back`,n.mode=j;break}n.mode=qe;case qe:if(c===0)break inf_leave;if(p=f-c,n.offset>p){if(p=n.offset-p,p>n.whave&&n.sane){e.msg=`invalid distance too far back`,n.mode=j;break}p>n.wnext?(p-=n.wnext,m=n.wsize-p):m=n.wnext-p,p>n.length&&(p=n.length),h=n.window}else h=i,m=o-n.offset,p=n.length;p>c&&(p=c),c-=p,n.length-=p;do i[o++]=h[m++];while(--p);n.length===0&&(n.mode=Ue);break;case Je:if(c===0)break inf_leave;i[o++]=n.length,c--,n.mode=Ue;break;case Ye:if(n.wrap){for(;u<32;){if(s===0)break inf_leave;s--,l|=r[a++]<<u,u+=8}if(f-=c,e.total_out+=f,n.total+=f,f&&(e.adler=n.check=n.flags?A(n.check,i,f,o-f):ae(n.check,i,f,o-f)),f=c,(n.flags?l:rt(l))!==n.check){e.msg=`incorrect data check`,n.mode=j;break}l=0,u=0}n.mode=Xe;case Xe:if(n.wrap&&n.flags){for(;u<32;){if(s===0)break inf_leave;s--,l+=r[a++]<<u,u+=8}if(l!==(n.total&4294967295)){e.msg=`incorrect length check`,n.mode=j;break}l=0,u=0}n.mode=Ze;case Ze:w=1;break inf_leave;case j:w=-3;break inf_leave;case Qe:return-4;case $e:default:return-2}return e.next_out=o,e.avail_out=c,e.next_in=a,e.avail_in=s,n.hold=l,n.bits=u,(n.wsize||f!==e.avail_out&&n.mode<j&&(n.mode<Ye||t!==4))&&mt(e,e.output,e.next_out,f-e.avail_out)?(n.mode=Qe,-4):(d-=e.avail_in,f-=e.avail_out,e.total_in+=d,e.total_out+=f,n.total+=f,n.wrap&&f&&(e.adler=n.check=n.flags?A(n.check,i,f,e.next_out-f):ae(n.check,i,f,e.next_out-f)),e.data_type=n.bits+(n.last?64:0)+(n.mode===Pe?128:0)+(n.mode===He||n.mode===Le?256:0),(d===0&&f===0||t===4)&&w===0&&(w=-5),w)}function gt(){this.input=null,this.next_in=0,this.avail_in=0,this.total_in=0,this.output=null,this.next_out=0,this.avail_out=0,this.total_out=0,this.msg=``,this.state=null,this.data_type=2,this.adler=0}var _t=class{constructor(){this.strm=new gt,this.chunkSize=102400,this.strm.output=new Uint8Array(this.chunkSize),lt(this.strm)}setInput(e){e?(this.strm.input=e,this.strm.avail_in=this.strm.input.length,this.strm.next_in=0):(this.strm.input=null,this.strm.avail_in=0,this.strm.next_in=0)}inflate(e){if(e>this.chunkSize&&(this.chunkSize=e,this.strm.output=new Uint8Array(this.chunkSize)),this.strm.next_out=0,this.strm.avail_out=e,ht(this.strm,0)<0)throw Error(`zlib inflate failed`);if(this.strm.next_out!=e)throw Error(`Incomplete zlib block`);return new Uint8Array(this.strm.output.buffer,0,this.strm.next_out)}reset(){ot(this.strm)}},vt=4,yt=0,bt=1,xt=2;function St(e){for(var t=e.length;--t>=0;)e[t]=0}var Ct=0,wt=1,Tt=2,Et=3,Dt=258,Ot=29,kt=256,At=kt+1+Ot,jt=30,Mt=19,Nt=2*At+1,Pt=15,Ft=16,It=7,Lt=256,Rt=16,zt=17,Bt=18,Vt=[0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0],Ht=[0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13],Ut=[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,3,7],Wt=[16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15],Gt=512,Kt=Array((At+2)*2);St(Kt);var qt=Array(jt*2);St(qt);var Jt=Array(Gt);St(Jt);var Yt=Array(Dt-Et+1);St(Yt);var Xt=Array(Ot);St(Xt);var Zt=Array(jt);St(Zt);function Qt(e,t,n,r,i){this.static_tree=e,this.extra_bits=t,this.extra_base=n,this.elems=r,this.max_length=i,this.has_stree=e&&e.length}var $t,en,tn;function nn(e,t){this.dyn_tree=e,this.max_code=0,this.stat_desc=t}function rn(e){return e<256?Jt[e]:Jt[256+(e>>>7)]}function an(e,t){e.pending_buf[e.pending++]=t&255,e.pending_buf[e.pending++]=t>>>8&255}function M(e,t,n){e.bi_valid>Ft-n?(e.bi_buf|=t<<e.bi_valid&65535,an(e,e.bi_buf),e.bi_buf=t>>Ft-e.bi_valid,e.bi_valid+=n-Ft):(e.bi_buf|=t<<e.bi_valid&65535,e.bi_valid+=n)}function on(e,t,n){M(e,n[t*2],n[t*2+1])}function sn(e,t){var n=0;do n|=e&1,e>>>=1,n<<=1;while(--t>0);return n>>>1}function cn(e){e.bi_valid===16?(an(e,e.bi_buf),e.bi_buf=0,e.bi_valid=0):e.bi_valid>=8&&(e.pending_buf[e.pending++]=e.bi_buf&255,e.bi_buf>>=8,e.bi_valid-=8)}function ln(e,t){var n=t.dyn_tree,r=t.max_code,i=t.stat_desc.static_tree,a=t.stat_desc.has_stree,o=t.stat_desc.extra_bits,s=t.stat_desc.extra_base,c=t.stat_desc.max_length,l,u,d,f,p,m,h=0;for(f=0;f<=Pt;f++)e.bl_count[f]=0;for(n[e.heap[e.heap_max]*2+1]=0,l=e.heap_max+1;l<Nt;l++)u=e.heap[l],f=n[n[u*2+1]*2+1]+1,f>c&&(f=c,h++),n[u*2+1]=f,!(u>r)&&(e.bl_count[f]++,p=0,u>=s&&(p=o[u-s]),m=n[u*2],e.opt_len+=m*(f+p),a&&(e.static_len+=m*(i[u*2+1]+p)));if(h!==0){do{for(f=c-1;e.bl_count[f]===0;)f--;e.bl_count[f]--,e.bl_count[f+1]+=2,e.bl_count[c]--,h-=2}while(h>0);for(f=c;f!==0;f--)for(u=e.bl_count[f];u!==0;)d=e.heap[--l],!(d>r)&&(n[d*2+1]!==f&&(e.opt_len+=(f-n[d*2+1])*n[d*2],n[d*2+1]=f),u--)}}function un(e,t,n){for(var r=Array(Pt+1),i=0,a=1,o;a<=Pt;a++)r[a]=i=i+n[a-1]<<1;for(o=0;o<=t;o++){var s=e[o*2+1];s!==0&&(e[o*2]=sn(r[s]++,s))}}function dn(){var e,t,n,r,i,a=Array(Pt+1);for(n=0,r=0;r<Ot-1;r++)for(Xt[r]=n,e=0;e<1<<Vt[r];e++)Yt[n++]=r;for(Yt[n-1]=r,i=0,r=0;r<16;r++)for(Zt[r]=i,e=0;e<1<<Ht[r];e++)Jt[i++]=r;for(i>>=7;r<jt;r++)for(Zt[r]=i<<7,e=0;e<1<<Ht[r]-7;e++)Jt[256+i++]=r;for(t=0;t<=Pt;t++)a[t]=0;for(e=0;e<=143;)Kt[e*2+1]=8,e++,a[8]++;for(;e<=255;)Kt[e*2+1]=9,e++,a[9]++;for(;e<=279;)Kt[e*2+1]=7,e++,a[7]++;for(;e<=287;)Kt[e*2+1]=8,e++,a[8]++;for(un(Kt,At+1,a),e=0;e<jt;e++)qt[e*2+1]=5,qt[e*2]=sn(e,5);$t=new Qt(Kt,Vt,kt+1,At,Pt),en=new Qt(qt,Ht,0,jt,Pt),tn=new Qt([],Ut,0,Mt,It)}function fn(e){for(var t=0;t<At;t++)e.dyn_ltree[t*2]=0;for(t=0;t<jt;t++)e.dyn_dtree[t*2]=0;for(t=0;t<Mt;t++)e.bl_tree[t*2]=0;e.dyn_ltree[Lt*2]=1,e.opt_len=e.static_len=0,e.last_lit=e.matches=0}function pn(e){e.bi_valid>8?an(e,e.bi_buf):e.bi_valid>0&&(e.pending_buf[e.pending++]=e.bi_buf),e.bi_buf=0,e.bi_valid=0}function mn(e,t,n,r){pn(e),r&&(an(e,n),an(e,~n)),ne(e.pending_buf,e.window,t,n,e.pending),e.pending+=n}function hn(e,t,n,r){var i=t*2,a=n*2;return e[i]<e[a]||e[i]===e[a]&&r[t]<=r[n]}function gn(e,t,n){for(var r=e.heap[n],i=n<<1;i<=e.heap_len&&(i<e.heap_len&&hn(t,e.heap[i+1],e.heap[i],e.depth)&&i++,!hn(t,r,e.heap[i],e.depth));)e.heap[n]=e.heap[i],n=i,i<<=1;e.heap[n]=r}function _n(e,t,n){var r,i,a=0,o,s;if(e.last_lit!==0)do r=e.pending_buf[e.d_buf+a*2]<<8|e.pending_buf[e.d_buf+a*2+1],i=e.pending_buf[e.l_buf+a],a++,r===0?on(e,i,t):(o=Yt[i],on(e,o+kt+1,t),s=Vt[o],s!==0&&(i-=Xt[o],M(e,i,s)),r--,o=rn(r),on(e,o,n),s=Ht[o],s!==0&&(r-=Zt[o],M(e,r,s)));while(a<e.last_lit);on(e,Lt,t)}function vn(e,t){var n=t.dyn_tree,r=t.stat_desc.static_tree,i=t.stat_desc.has_stree,a=t.stat_desc.elems,o,s,c=-1,l;for(e.heap_len=0,e.heap_max=Nt,o=0;o<a;o++)n[o*2]===0?n[o*2+1]=0:(e.heap[++e.heap_len]=c=o,e.depth[o]=0);for(;e.heap_len<2;)l=e.heap[++e.heap_len]=c<2?++c:0,n[l*2]=1,e.depth[l]=0,e.opt_len--,i&&(e.static_len-=r[l*2+1]);for(t.max_code=c,o=e.heap_len>>1;o>=1;o--)gn(e,n,o);l=a;do o=e.heap[1],e.heap[1]=e.heap[e.heap_len--],gn(e,n,1),s=e.heap[1],e.heap[--e.heap_max]=o,e.heap[--e.heap_max]=s,n[l*2]=n[o*2]+n[s*2],e.depth[l]=(e.depth[o]>=e.depth[s]?e.depth[o]:e.depth[s])+1,n[o*2+1]=n[s*2+1]=l,e.heap[1]=l++,gn(e,n,1);while(e.heap_len>=2);e.heap[--e.heap_max]=e.heap[1],ln(e,t),un(n,c,e.bl_count)}function yn(e,t,n){var r,i=-1,a,o=t[1],s=0,c=7,l=4;for(o===0&&(c=138,l=3),t[(n+1)*2+1]=65535,r=0;r<=n;r++)a=o,o=t[(r+1)*2+1],!(++s<c&&a===o)&&(s<l?e.bl_tree[a*2]+=s:a===0?s<=10?e.bl_tree[zt*2]++:e.bl_tree[Bt*2]++:(a!==i&&e.bl_tree[a*2]++,e.bl_tree[Rt*2]++),s=0,i=a,o===0?(c=138,l=3):a===o?(c=6,l=3):(c=7,l=4))}function bn(e,t,n){var r,i=-1,a,o=t[1],s=0,c=7,l=4;for(o===0&&(c=138,l=3),r=0;r<=n;r++)if(a=o,o=t[(r+1)*2+1],!(++s<c&&a===o)){if(s<l)do on(e,a,e.bl_tree);while(--s!==0);else a===0?s<=10?(on(e,zt,e.bl_tree),M(e,s-3,3)):(on(e,Bt,e.bl_tree),M(e,s-11,7)):(a!==i&&(on(e,a,e.bl_tree),s--),on(e,Rt,e.bl_tree),M(e,s-3,2));s=0,i=a,o===0?(c=138,l=3):a===o?(c=6,l=3):(c=7,l=4)}}function xn(e){var t;for(yn(e,e.dyn_ltree,e.l_desc.max_code),yn(e,e.dyn_dtree,e.d_desc.max_code),vn(e,e.bl_desc),t=Mt-1;t>=3&&e.bl_tree[Wt[t]*2+1]===0;t--);return e.opt_len+=3*(t+1)+5+5+4,t}function Sn(e,t,n,r){var i;for(M(e,t-257,5),M(e,n-1,5),M(e,r-4,4),i=0;i<r;i++)M(e,e.bl_tree[Wt[i]*2+1],3);bn(e,e.dyn_ltree,t-1),bn(e,e.dyn_dtree,n-1)}function Cn(e){for(var t=4093624447,n=0;n<=31;n++,t>>>=1)if(t&1&&e.dyn_ltree[n*2]!==0)return yt;if(e.dyn_ltree[18]!==0||e.dyn_ltree[20]!==0||e.dyn_ltree[26]!==0)return bt;for(n=32;n<kt;n++)if(e.dyn_ltree[n*2]!==0)return bt;return yt}var wn=!1;function Tn(e){wn||=(dn(),!0),e.l_desc=new nn(e.dyn_ltree,$t),e.d_desc=new nn(e.dyn_dtree,en),e.bl_desc=new nn(e.bl_tree,tn),e.bi_buf=0,e.bi_valid=0,fn(e)}function En(e,t,n,r){M(e,(Ct<<1)+ +!!r,3),mn(e,t,n,!0)}function Dn(e){M(e,wt<<1,3),on(e,Lt,Kt),cn(e)}function On(e,t,n,r){var i,a,o=0;e.level>0?(e.strm.data_type===xt&&(e.strm.data_type=Cn(e)),vn(e,e.l_desc),vn(e,e.d_desc),o=xn(e),i=e.opt_len+3+7>>>3,a=e.static_len+3+7>>>3,a<=i&&(i=a)):i=a=n+5,n+4<=i&&t!==-1?En(e,t,n,r):e.strategy===vt||a===i?(M(e,(wt<<1)+ +!!r,3),_n(e,Kt,qt)):(M(e,(Tt<<1)+ +!!r,3),Sn(e,e.l_desc.max_code+1,e.d_desc.max_code+1,o+1),_n(e,e.dyn_ltree,e.dyn_dtree)),fn(e),r&&pn(e)}function kn(e,t,n){return e.pending_buf[e.d_buf+e.last_lit*2]=t>>>8&255,e.pending_buf[e.d_buf+e.last_lit*2+1]=t&255,e.pending_buf[e.l_buf+e.last_lit]=n&255,e.last_lit++,t===0?e.dyn_ltree[n*2]++:(e.matches++,t--,e.dyn_ltree[(Yt[n]+kt+1)*2]++,e.dyn_dtree[rn(t)*2]++),e.last_lit===e.lit_bufsize-1}var An={2:`need dictionary`,1:`stream end`,0:``,"-1":`file error`,"-2":`stream error`,"-3":`data error`,"-4":`insufficient memory`,"-5":`buffer error`,"-6":`incompatible version`},jn=9,Mn=15,Nn=8,Pn=286,Fn=30,In=19,Ln=2*Pn+1,Rn=15,N=3,zn=258,P=zn+N+1,Bn=32,Vn=42,Hn=69,Un=73,Wn=91,Gn=103,Kn=113,qn=666,F=1,Jn=2,Yn=3,Xn=4,Zn=3;function Qn(e,t){return e.msg=An[t],t}function $n(e){return(e<<1)-(e>4?9:0)}function er(e){for(var t=e.length;--t>=0;)e[t]=0}function tr(e){var t=e.state,n=t.pending;n>e.avail_out&&(n=e.avail_out),n!==0&&(ne(e.output,t.pending_buf,t.pending_out,n,e.next_out),e.next_out+=n,t.pending_out+=n,e.total_out+=n,e.avail_out-=n,t.pending-=n,t.pending===0&&(t.pending_out=0))}function I(e,t){On(e,e.block_start>=0?e.block_start:-1,e.strstart-e.block_start,t),e.block_start=e.strstart,tr(e.strm)}function L(e,t){e.pending_buf[e.pending++]=t}function nr(e,t){e.pending_buf[e.pending++]=t>>>8&255,e.pending_buf[e.pending++]=t&255}function rr(e,t,n,r){var i=e.avail_in;return i>r&&(i=r),i===0?0:(e.avail_in-=i,ne(t,e.input,e.next_in,i,n),e.state.wrap===1?e.adler=ae(e.adler,t,i,n):e.state.wrap===2&&(e.adler=A(e.adler,t,i,n)),e.next_in+=i,e.total_in+=i,i)}function ir(e,t){var n=e.max_chain_length,r=e.strstart,i,a,o=e.prev_length,s=e.nice_match,c=e.strstart>e.w_size-P?e.strstart-(e.w_size-P):0,l=e.window,u=e.w_mask,d=e.prev,f=e.strstart+zn,p=l[r+o-1],m=l[r+o];e.prev_length>=e.good_match&&(n>>=2),s>e.lookahead&&(s=e.lookahead);do if(i=t,l[i+o]===m&&l[i+o-1]===p&&l[i]===l[r]&&l[++i]===l[r+1]){r+=2,i++;do;while(l[++r]===l[++i]&&l[++r]===l[++i]&&l[++r]===l[++i]&&l[++r]===l[++i]&&l[++r]===l[++i]&&l[++r]===l[++i]&&l[++r]===l[++i]&&l[++r]===l[++i]&&r<f);if(a=zn-(f-r),r=f-zn,a>o){if(e.match_start=t,o=a,a>=s)break;p=l[r+o-1],m=l[r+o]}}while((t=d[t&u])>c&&--n!==0);return o<=e.lookahead?o:e.lookahead}function ar(e){var t=e.w_size,n,r,i,a,o;do{if(a=e.window_size-e.lookahead-e.strstart,e.strstart>=t+(t-P)){ne(e.window,e.window,t,t,0),e.match_start-=t,e.strstart-=t,e.block_start-=t,r=e.hash_size,n=r;do i=e.head[--n],e.head[n]=i>=t?i-t:0;while(--r);r=t,n=r;do i=e.prev[--n],e.prev[n]=i>=t?i-t:0;while(--r);a+=t}if(e.strm.avail_in===0)break;if(r=rr(e.strm,e.window,e.strstart+e.lookahead,a),e.lookahead+=r,e.lookahead+e.insert>=N)for(o=e.strstart-e.insert,e.ins_h=e.window[o],e.ins_h=(e.ins_h<<e.hash_shift^e.window[o+1])&e.hash_mask;e.insert&&(e.ins_h=(e.ins_h<<e.hash_shift^e.window[o+N-1])&e.hash_mask,e.prev[o&e.w_mask]=e.head[e.ins_h],e.head[e.ins_h]=o,o++,e.insert--,!(e.lookahead+e.insert<N)););}while(e.lookahead<P&&e.strm.avail_in!==0)}function or(e,t){var n=65535;for(n>e.pending_buf_size-5&&(n=e.pending_buf_size-5);;){if(e.lookahead<=1){if(ar(e),e.lookahead===0&&t===0)return F;if(e.lookahead===0)break}e.strstart+=e.lookahead,e.lookahead=0;var r=e.block_start+n;if((e.strstart===0||e.strstart>=r)&&(e.lookahead=e.strstart-r,e.strstart=r,I(e,!1),e.strm.avail_out===0)||e.strstart-e.block_start>=e.w_size-P&&(I(e,!1),e.strm.avail_out===0))return F}return e.insert=0,t===4?(I(e,!0),e.strm.avail_out===0?Yn:Xn):(e.strstart>e.block_start&&(I(e,!1),e.strm.avail_out),F)}function sr(e,t){for(var n,r;;){if(e.lookahead<P){if(ar(e),e.lookahead<P&&t===0)return F;if(e.lookahead===0)break}if(n=0,e.lookahead>=N&&(e.ins_h=(e.ins_h<<e.hash_shift^e.window[e.strstart+N-1])&e.hash_mask,n=e.prev[e.strstart&e.w_mask]=e.head[e.ins_h],e.head[e.ins_h]=e.strstart),n!==0&&e.strstart-n<=e.w_size-P&&(e.match_length=ir(e,n)),e.match_length>=N){if(r=kn(e,e.strstart-e.match_start,e.match_length-N),e.lookahead-=e.match_length,e.match_length<=e.max_lazy_match&&e.lookahead>=N){e.match_length--;do e.strstart++,e.ins_h=(e.ins_h<<e.hash_shift^e.window[e.strstart+N-1])&e.hash_mask,n=e.prev[e.strstart&e.w_mask]=e.head[e.ins_h],e.head[e.ins_h]=e.strstart;while(--e.match_length!==0);e.strstart++}else e.strstart+=e.match_length,e.match_length=0,e.ins_h=e.window[e.strstart],e.ins_h=(e.ins_h<<e.hash_shift^e.window[e.strstart+1])&e.hash_mask}else r=kn(e,0,e.window[e.strstart]),e.lookahead--,e.strstart++;if(r&&(I(e,!1),e.strm.avail_out===0))return F}return e.insert=e.strstart<N-1?e.strstart:N-1,t===4?(I(e,!0),e.strm.avail_out===0?Yn:Xn):e.last_lit&&(I(e,!1),e.strm.avail_out===0)?F:Jn}function cr(e,t){for(var n,r,i;;){if(e.lookahead<P){if(ar(e),e.lookahead<P&&t===0)return F;if(e.lookahead===0)break}if(n=0,e.lookahead>=N&&(e.ins_h=(e.ins_h<<e.hash_shift^e.window[e.strstart+N-1])&e.hash_mask,n=e.prev[e.strstart&e.w_mask]=e.head[e.ins_h],e.head[e.ins_h]=e.strstart),e.prev_length=e.match_length,e.prev_match=e.match_start,e.match_length=N-1,n!==0&&e.prev_length<e.max_lazy_match&&e.strstart-n<=e.w_size-P&&(e.match_length=ir(e,n),e.match_length<=5&&(e.strategy===1||e.match_length===N&&e.strstart-e.match_start>4096)&&(e.match_length=N-1)),e.prev_length>=N&&e.match_length<=e.prev_length){i=e.strstart+e.lookahead-N,r=kn(e,e.strstart-1-e.prev_match,e.prev_length-N),e.lookahead-=e.prev_length-1,e.prev_length-=2;do++e.strstart<=i&&(e.ins_h=(e.ins_h<<e.hash_shift^e.window[e.strstart+N-1])&e.hash_mask,n=e.prev[e.strstart&e.w_mask]=e.head[e.ins_h],e.head[e.ins_h]=e.strstart);while(--e.prev_length!==0);if(e.match_available=0,e.match_length=N-1,e.strstart++,r&&(I(e,!1),e.strm.avail_out===0))return F}else if(e.match_available){if(r=kn(e,0,e.window[e.strstart-1]),r&&I(e,!1),e.strstart++,e.lookahead--,e.strm.avail_out===0)return F}else e.match_available=1,e.strstart++,e.lookahead--}return e.match_available&&=(r=kn(e,0,e.window[e.strstart-1]),0),e.insert=e.strstart<N-1?e.strstart:N-1,t===4?(I(e,!0),e.strm.avail_out===0?Yn:Xn):e.last_lit&&(I(e,!1),e.strm.avail_out===0)?F:Jn}function lr(e,t){for(var n,r,i,a,o=e.window;;){if(e.lookahead<=zn){if(ar(e),e.lookahead<=zn&&t===0)return F;if(e.lookahead===0)break}if(e.match_length=0,e.lookahead>=N&&e.strstart>0&&(i=e.strstart-1,r=o[i],r===o[++i]&&r===o[++i]&&r===o[++i])){a=e.strstart+zn;do;while(r===o[++i]&&r===o[++i]&&r===o[++i]&&r===o[++i]&&r===o[++i]&&r===o[++i]&&r===o[++i]&&r===o[++i]&&i<a);e.match_length=zn-(a-i),e.match_length>e.lookahead&&(e.match_length=e.lookahead)}if(e.match_length>=N?(n=kn(e,1,e.match_length-N),e.lookahead-=e.match_length,e.strstart+=e.match_length,e.match_length=0):(n=kn(e,0,e.window[e.strstart]),e.lookahead--,e.strstart++),n&&(I(e,!1),e.strm.avail_out===0))return F}return e.insert=0,t===4?(I(e,!0),e.strm.avail_out===0?Yn:Xn):e.last_lit&&(I(e,!1),e.strm.avail_out===0)?F:Jn}function ur(e,t){for(var n;;){if(e.lookahead===0&&(ar(e),e.lookahead===0)){if(t===0)return F;break}if(e.match_length=0,n=kn(e,0,e.window[e.strstart]),e.lookahead--,e.strstart++,n&&(I(e,!1),e.strm.avail_out===0))return F}return e.insert=0,t===4?(I(e,!0),e.strm.avail_out===0?Yn:Xn):e.last_lit&&(I(e,!1),e.strm.avail_out===0)?F:Jn}function dr(e,t,n,r,i){this.good_length=e,this.max_lazy=t,this.nice_length=n,this.max_chain=r,this.func=i}var fr=[new dr(0,0,0,0,or),new dr(4,4,8,4,sr),new dr(4,5,16,8,sr),new dr(4,6,32,32,sr),new dr(4,4,16,16,cr),new dr(8,16,32,32,cr),new dr(8,16,128,128,cr),new dr(8,32,128,256,cr),new dr(32,128,258,1024,cr),new dr(32,258,258,4096,cr)];function pr(e){e.window_size=2*e.w_size,er(e.head),e.max_lazy_match=fr[e.level].max_lazy,e.good_match=fr[e.level].good_length,e.nice_match=fr[e.level].nice_length,e.max_chain_length=fr[e.level].max_chain,e.strstart=0,e.block_start=0,e.lookahead=0,e.insert=0,e.match_length=e.prev_length=N-1,e.match_available=0,e.ins_h=0}function mr(){this.strm=null,this.status=0,this.pending_buf=null,this.pending_buf_size=0,this.pending_out=0,this.pending=0,this.wrap=0,this.gzhead=null,this.gzindex=0,this.method=8,this.last_flush=-1,this.w_size=0,this.w_bits=0,this.w_mask=0,this.window=null,this.window_size=0,this.prev=null,this.head=null,this.ins_h=0,this.hash_size=0,this.hash_bits=0,this.hash_mask=0,this.hash_shift=0,this.block_start=0,this.match_length=0,this.prev_match=0,this.match_available=0,this.strstart=0,this.match_start=0,this.lookahead=0,this.prev_length=0,this.max_chain_length=0,this.max_lazy_match=0,this.level=0,this.strategy=0,this.good_match=0,this.nice_match=0,this.dyn_ltree=new k(Ln*2),this.dyn_dtree=new k((2*Fn+1)*2),this.bl_tree=new k((2*In+1)*2),er(this.dyn_ltree),er(this.dyn_dtree),er(this.bl_tree),this.l_desc=null,this.d_desc=null,this.bl_desc=null,this.bl_count=new k(Rn+1),this.heap=new k(2*Pn+1),er(this.heap),this.heap_len=0,this.heap_max=0,this.depth=new k(2*Pn+1),er(this.depth),this.l_buf=0,this.lit_bufsize=0,this.last_lit=0,this.d_buf=0,this.opt_len=0,this.static_len=0,this.matches=0,this.insert=0,this.bi_buf=0,this.bi_valid=0}function hr(e){var t;return!e||!e.state?Qn(e,-2):(e.total_in=e.total_out=0,e.data_type=2,t=e.state,t.pending=0,t.pending_out=0,t.wrap<0&&(t.wrap=-t.wrap),t.status=t.wrap?Vn:Kn,e.adler=t.wrap===2?0:1,t.last_flush=0,Tn(t),0)}function gr(e){var t=hr(e);return t===0&&pr(e.state),t}function _r(e,t,n,r,i,a){if(!e)return-2;var o=1;if(t===-1&&(t=6),r<0?(o=0,r=-r):r>15&&(o=2,r-=16),i<1||i>jn||n!==8||r<8||r>15||t<0||t>9||a<0||a>4)return Qn(e,-2);r===8&&(r=9);var s=new mr;return e.state=s,s.strm=e,s.wrap=o,s.gzhead=null,s.w_bits=r,s.w_size=1<<s.w_bits,s.w_mask=s.w_size-1,s.hash_bits=i+7,s.hash_size=1<<s.hash_bits,s.hash_mask=s.hash_size-1,s.hash_shift=~~((s.hash_bits+N-1)/N),s.window=new re(s.w_size*2),s.head=new k(s.hash_size),s.prev=new k(s.w_size),s.lit_bufsize=1<<i+6,s.pending_buf_size=s.lit_bufsize*4,s.pending_buf=new re(s.pending_buf_size),s.d_buf=1*s.lit_bufsize,s.l_buf=3*s.lit_bufsize,s.level=t,s.strategy=a,s.method=n,gr(e)}function vr(e,t){return _r(e,t,8,Mn,Nn,0)}function yr(e,t){var n,r,i,a;if(!e||!e.state||t>5||t<0)return e?Qn(e,-2):-2;if(r=e.state,!e.output||!e.input&&e.avail_in!==0||r.status===qn&&t!==4)return Qn(e,e.avail_out===0?-5:-2);if(r.strm=e,n=r.last_flush,r.last_flush=t,r.status===Vn){if(r.wrap===2)e.adler=0,L(r,31),L(r,139),L(r,8),r.gzhead?(L(r,+!!r.gzhead.text+(r.gzhead.hcrc?2:0)+(r.gzhead.extra?4:0)+(r.gzhead.name?8:0)+(r.gzhead.comment?16:0)),L(r,r.gzhead.time&255),L(r,r.gzhead.time>>8&255),L(r,r.gzhead.time>>16&255),L(r,r.gzhead.time>>24&255),L(r,r.level===9?2:r.strategy>=2||r.level<2?4:0),L(r,r.gzhead.os&255),r.gzhead.extra&&r.gzhead.extra.length&&(L(r,r.gzhead.extra.length&255),L(r,r.gzhead.extra.length>>8&255)),r.gzhead.hcrc&&(e.adler=A(e.adler,r.pending_buf,r.pending,0)),r.gzindex=0,r.status=Hn):(L(r,0),L(r,0),L(r,0),L(r,0),L(r,0),L(r,r.level===9?2:r.strategy>=2||r.level<2?4:0),L(r,Zn),r.status=Kn);else{var o=8+(r.w_bits-8<<4)<<8,s=-1;s=r.strategy>=2||r.level<2?0:r.level<6?1:r.level===6?2:3,o|=s<<6,r.strstart!==0&&(o|=Bn),o+=31-o%31,r.status=Kn,nr(r,o),r.strstart!==0&&(nr(r,e.adler>>>16),nr(r,e.adler&65535)),e.adler=1}}if(r.status===Hn){if(r.gzhead.extra){for(i=r.pending;r.gzindex<(r.gzhead.extra.length&65535)&&!(r.pending===r.pending_buf_size&&(r.gzhead.hcrc&&r.pending>i&&(e.adler=A(e.adler,r.pending_buf,r.pending-i,i)),tr(e),i=r.pending,r.pending===r.pending_buf_size));)L(r,r.gzhead.extra[r.gzindex]&255),r.gzindex++;r.gzhead.hcrc&&r.pending>i&&(e.adler=A(e.adler,r.pending_buf,r.pending-i,i)),r.gzindex===r.gzhead.extra.length&&(r.gzindex=0,r.status=Un)}else r.status=Un}if(r.status===Un){if(r.gzhead.name){i=r.pending;do{if(r.pending===r.pending_buf_size&&(r.gzhead.hcrc&&r.pending>i&&(e.adler=A(e.adler,r.pending_buf,r.pending-i,i)),tr(e),i=r.pending,r.pending===r.pending_buf_size)){a=1;break}a=r.gzindex<r.gzhead.name.length?r.gzhead.name.charCodeAt(r.gzindex++)&255:0,L(r,a)}while(a!==0);r.gzhead.hcrc&&r.pending>i&&(e.adler=A(e.adler,r.pending_buf,r.pending-i,i)),a===0&&(r.gzindex=0,r.status=Wn)}else r.status=Wn}if(r.status===Wn){if(r.gzhead.comment){i=r.pending;do{if(r.pending===r.pending_buf_size&&(r.gzhead.hcrc&&r.pending>i&&(e.adler=A(e.adler,r.pending_buf,r.pending-i,i)),tr(e),i=r.pending,r.pending===r.pending_buf_size)){a=1;break}a=r.gzindex<r.gzhead.comment.length?r.gzhead.comment.charCodeAt(r.gzindex++)&255:0,L(r,a)}while(a!==0);r.gzhead.hcrc&&r.pending>i&&(e.adler=A(e.adler,r.pending_buf,r.pending-i,i)),a===0&&(r.status=Gn)}else r.status=Gn}if(r.status===Gn&&(r.gzhead.hcrc?(r.pending+2>r.pending_buf_size&&tr(e),r.pending+2<=r.pending_buf_size&&(L(r,e.adler&255),L(r,e.adler>>8&255),e.adler=0,r.status=Kn)):r.status=Kn),r.pending!==0){if(tr(e),e.avail_out===0)return r.last_flush=-1,0}else if(e.avail_in===0&&$n(t)<=$n(n)&&t!==4)return Qn(e,-5);if(r.status===qn&&e.avail_in!==0)return Qn(e,-5);if(e.avail_in!==0||r.lookahead!==0||t!==0&&r.status!==qn){var c=r.strategy===2?ur(r,t):r.strategy===3?lr(r,t):fr[r.level].func(r,t);if((c===Yn||c===Xn)&&(r.status=qn),c===F||c===Yn)return e.avail_out===0&&(r.last_flush=-1),0;if(c===Jn&&(t===1?Dn(r):t!==5&&(En(r,0,0,!1),t===3&&(er(r.head),r.lookahead===0&&(r.strstart=0,r.block_start=0,r.insert=0))),tr(e),e.avail_out===0))return r.last_flush=-1,0}return t===4?r.wrap<=0?1:(r.wrap===2?(L(r,e.adler&255),L(r,e.adler>>8&255),L(r,e.adler>>16&255),L(r,e.adler>>24&255),L(r,e.total_in&255),L(r,e.total_in>>8&255),L(r,e.total_in>>16&255),L(r,e.total_in>>24&255)):(nr(r,e.adler>>>16),nr(r,e.adler&65535)),tr(e),r.wrap>0&&(r.wrap=-r.wrap),+(r.pending===0)):0}var br=class{constructor(){this.strm=new gt,this.chunkSize=102400,this.outputBuffer=new Uint8Array(this.chunkSize),vr(this.strm,-1)}deflate(e){this.strm.input=e,this.strm.avail_in=this.strm.input.length,this.strm.next_in=0,this.strm.output=this.outputBuffer,this.strm.avail_out=this.chunkSize,this.strm.next_out=0;let t=yr(this.strm,3),n=new Uint8Array(this.strm.output.buffer,0,this.strm.next_out);if(t<0)throw Error(`zlib deflate failed`);if(this.strm.avail_in>0){let e=[n],r=n.length;do{if(this.strm.output=new Uint8Array(this.chunkSize),this.strm.next_out=0,this.strm.avail_out=this.chunkSize,t=yr(this.strm,3),t<0)throw Error(`zlib deflate failed`);let n=new Uint8Array(this.strm.output.buffer,0,this.strm.next_out);r+=n.length,e.push(n)}while(this.strm.avail_in>0);let i=new Uint8Array(r),a=0;for(let t=0;t<e.length;t++)i.set(e[t],a),a+=e[t].length;n=i}return this.strm.input=null,this.strm.avail_in=0,this.strm.next_in=0,n}},R={XK_VoidSymbol:16777215,XK_BackSpace:65288,XK_Tab:65289,XK_Linefeed:65290,XK_Clear:65291,XK_Return:65293,XK_Pause:65299,XK_Scroll_Lock:65300,XK_Sys_Req:65301,XK_Escape:65307,XK_Delete:65535,XK_Multi_key:65312,XK_Codeinput:65335,XK_SingleCandidate:65340,XK_MultipleCandidate:65341,XK_PreviousCandidate:65342,XK_Kanji:65313,XK_Muhenkan:65314,XK_Henkan_Mode:65315,XK_Henkan:65315,XK_Romaji:65316,XK_Hiragana:65317,XK_Katakana:65318,XK_Hiragana_Katakana:65319,XK_Zenkaku:65320,XK_Hankaku:65321,XK_Zenkaku_Hankaku:65322,XK_Touroku:65323,XK_Massyo:65324,XK_Kana_Lock:65325,XK_Kana_Shift:65326,XK_Eisu_Shift:65327,XK_Eisu_toggle:65328,XK_Kanji_Bangou:65335,XK_Zen_Koho:65341,XK_Mae_Koho:65342,XK_Home:65360,XK_Left:65361,XK_Up:65362,XK_Right:65363,XK_Down:65364,XK_Prior:65365,XK_Page_Up:65365,XK_Next:65366,XK_Page_Down:65366,XK_End:65367,XK_Begin:65368,XK_Select:65376,XK_Print:65377,XK_Execute:65378,XK_Insert:65379,XK_Undo:65381,XK_Redo:65382,XK_Menu:65383,XK_Find:65384,XK_Cancel:65385,XK_Help:65386,XK_Break:65387,XK_Mode_switch:65406,XK_script_switch:65406,XK_Num_Lock:65407,XK_KP_Space:65408,XK_KP_Tab:65417,XK_KP_Enter:65421,XK_KP_F1:65425,XK_KP_F2:65426,XK_KP_F3:65427,XK_KP_F4:65428,XK_KP_Home:65429,XK_KP_Left:65430,XK_KP_Up:65431,XK_KP_Right:65432,XK_KP_Down:65433,XK_KP_Prior:65434,XK_KP_Page_Up:65434,XK_KP_Next:65435,XK_KP_Page_Down:65435,XK_KP_End:65436,XK_KP_Begin:65437,XK_KP_Insert:65438,XK_KP_Delete:65439,XK_KP_Equal:65469,XK_KP_Multiply:65450,XK_KP_Add:65451,XK_KP_Separator:65452,XK_KP_Subtract:65453,XK_KP_Decimal:65454,XK_KP_Divide:65455,XK_KP_0:65456,XK_KP_1:65457,XK_KP_2:65458,XK_KP_3:65459,XK_KP_4:65460,XK_KP_5:65461,XK_KP_6:65462,XK_KP_7:65463,XK_KP_8:65464,XK_KP_9:65465,XK_F1:65470,XK_F2:65471,XK_F3:65472,XK_F4:65473,XK_F5:65474,XK_F6:65475,XK_F7:65476,XK_F8:65477,XK_F9:65478,XK_F10:65479,XK_F11:65480,XK_L1:65480,XK_F12:65481,XK_L2:65481,XK_F13:65482,XK_L3:65482,XK_F14:65483,XK_L4:65483,XK_F15:65484,XK_L5:65484,XK_F16:65485,XK_L6:65485,XK_F17:65486,XK_L7:65486,XK_F18:65487,XK_L8:65487,XK_F19:65488,XK_L9:65488,XK_F20:65489,XK_L10:65489,XK_F21:65490,XK_R1:65490,XK_F22:65491,XK_R2:65491,XK_F23:65492,XK_R3:65492,XK_F24:65493,XK_R4:65493,XK_F25:65494,XK_R5:65494,XK_F26:65495,XK_R6:65495,XK_F27:65496,XK_R7:65496,XK_F28:65497,XK_R8:65497,XK_F29:65498,XK_R9:65498,XK_F30:65499,XK_R10:65499,XK_F31:65500,XK_R11:65500,XK_F32:65501,XK_R12:65501,XK_F33:65502,XK_R13:65502,XK_F34:65503,XK_R14:65503,XK_F35:65504,XK_R15:65504,XK_Shift_L:65505,XK_Shift_R:65506,XK_Control_L:65507,XK_Control_R:65508,XK_Caps_Lock:65509,XK_Shift_Lock:65510,XK_Meta_L:65511,XK_Meta_R:65512,XK_Alt_L:65513,XK_Alt_R:65514,XK_Super_L:65515,XK_Super_R:65516,XK_Hyper_L:65517,XK_Hyper_R:65518,XK_ISO_Level3_Shift:65027,XK_ISO_Next_Group:65032,XK_ISO_Prev_Group:65034,XK_ISO_First_Group:65036,XK_ISO_Last_Group:65038,XK_space:32,XK_exclam:33,XK_quotedbl:34,XK_numbersign:35,XK_dollar:36,XK_percent:37,XK_ampersand:38,XK_apostrophe:39,XK_quoteright:39,XK_parenleft:40,XK_parenright:41,XK_asterisk:42,XK_plus:43,XK_comma:44,XK_minus:45,XK_period:46,XK_slash:47,XK_0:48,XK_1:49,XK_2:50,XK_3:51,XK_4:52,XK_5:53,XK_6:54,XK_7:55,XK_8:56,XK_9:57,XK_colon:58,XK_semicolon:59,XK_less:60,XK_equal:61,XK_greater:62,XK_question:63,XK_at:64,XK_A:65,XK_B:66,XK_C:67,XK_D:68,XK_E:69,XK_F:70,XK_G:71,XK_H:72,XK_I:73,XK_J:74,XK_K:75,XK_L:76,XK_M:77,XK_N:78,XK_O:79,XK_P:80,XK_Q:81,XK_R:82,XK_S:83,XK_T:84,XK_U:85,XK_V:86,XK_W:87,XK_X:88,XK_Y:89,XK_Z:90,XK_bracketleft:91,XK_backslash:92,XK_bracketright:93,XK_asciicircum:94,XK_underscore:95,XK_grave:96,XK_quoteleft:96,XK_a:97,XK_b:98,XK_c:99,XK_d:100,XK_e:101,XK_f:102,XK_g:103,XK_h:104,XK_i:105,XK_j:106,XK_k:107,XK_l:108,XK_m:109,XK_n:110,XK_o:111,XK_p:112,XK_q:113,XK_r:114,XK_s:115,XK_t:116,XK_u:117,XK_v:118,XK_w:119,XK_x:120,XK_y:121,XK_z:122,XK_braceleft:123,XK_bar:124,XK_braceright:125,XK_asciitilde:126,XK_nobreakspace:160,XK_exclamdown:161,XK_cent:162,XK_sterling:163,XK_currency:164,XK_yen:165,XK_brokenbar:166,XK_section:167,XK_diaeresis:168,XK_copyright:169,XK_ordfeminine:170,XK_guillemotleft:171,XK_notsign:172,XK_hyphen:173,XK_registered:174,XK_macron:175,XK_degree:176,XK_plusminus:177,XK_twosuperior:178,XK_threesuperior:179,XK_acute:180,XK_mu:181,XK_paragraph:182,XK_periodcentered:183,XK_cedilla:184,XK_onesuperior:185,XK_masculine:186,XK_guillemotright:187,XK_onequarter:188,XK_onehalf:189,XK_threequarters:190,XK_questiondown:191,XK_Agrave:192,XK_Aacute:193,XK_Acircumflex:194,XK_Atilde:195,XK_Adiaeresis:196,XK_Aring:197,XK_AE:198,XK_Ccedilla:199,XK_Egrave:200,XK_Eacute:201,XK_Ecircumflex:202,XK_Ediaeresis:203,XK_Igrave:204,XK_Iacute:205,XK_Icircumflex:206,XK_Idiaeresis:207,XK_ETH:208,XK_Eth:208,XK_Ntilde:209,XK_Ograve:210,XK_Oacute:211,XK_Ocircumflex:212,XK_Otilde:213,XK_Odiaeresis:214,XK_multiply:215,XK_Oslash:216,XK_Ooblique:216,XK_Ugrave:217,XK_Uacute:218,XK_Ucircumflex:219,XK_Udiaeresis:220,XK_Yacute:221,XK_THORN:222,XK_Thorn:222,XK_ssharp:223,XK_agrave:224,XK_aacute:225,XK_acircumflex:226,XK_atilde:227,XK_adiaeresis:228,XK_aring:229,XK_ae:230,XK_ccedilla:231,XK_egrave:232,XK_eacute:233,XK_ecircumflex:234,XK_ediaeresis:235,XK_igrave:236,XK_iacute:237,XK_icircumflex:238,XK_idiaeresis:239,XK_eth:240,XK_ntilde:241,XK_ograve:242,XK_oacute:243,XK_ocircumflex:244,XK_otilde:245,XK_odiaeresis:246,XK_division:247,XK_oslash:248,XK_ooblique:248,XK_ugrave:249,XK_uacute:250,XK_ucircumflex:251,XK_udiaeresis:252,XK_yacute:253,XK_thorn:254,XK_ydiaeresis:255,XK_Hangul:65329,XK_Hangul_Hanja:65332,XK_Hangul_Jeonja:65336,XF86XK_ModeLock:269025025,XF86XK_MonBrightnessUp:269025026,XF86XK_MonBrightnessDown:269025027,XF86XK_KbdLightOnOff:269025028,XF86XK_KbdBrightnessUp:269025029,XF86XK_KbdBrightnessDown:269025030,XF86XK_Standby:269025040,XF86XK_AudioLowerVolume:269025041,XF86XK_AudioMute:269025042,XF86XK_AudioRaiseVolume:269025043,XF86XK_AudioPlay:269025044,XF86XK_AudioStop:269025045,XF86XK_AudioPrev:269025046,XF86XK_AudioNext:269025047,XF86XK_HomePage:269025048,XF86XK_Mail:269025049,XF86XK_Start:269025050,XF86XK_Search:269025051,XF86XK_AudioRecord:269025052,XF86XK_Calculator:269025053,XF86XK_Memo:269025054,XF86XK_ToDoList:269025055,XF86XK_Calendar:269025056,XF86XK_PowerDown:269025057,XF86XK_ContrastAdjust:269025058,XF86XK_RockerUp:269025059,XF86XK_RockerDown:269025060,XF86XK_RockerEnter:269025061,XF86XK_Back:269025062,XF86XK_Forward:269025063,XF86XK_Stop:269025064,XF86XK_Refresh:269025065,XF86XK_PowerOff:269025066,XF86XK_WakeUp:269025067,XF86XK_Eject:269025068,XF86XK_ScreenSaver:269025069,XF86XK_WWW:269025070,XF86XK_Sleep:269025071,XF86XK_Favorites:269025072,XF86XK_AudioPause:269025073,XF86XK_AudioMedia:269025074,XF86XK_MyComputer:269025075,XF86XK_VendorHome:269025076,XF86XK_LightBulb:269025077,XF86XK_Shop:269025078,XF86XK_History:269025079,XF86XK_OpenURL:269025080,XF86XK_AddFavorite:269025081,XF86XK_HotLinks:269025082,XF86XK_BrightnessAdjust:269025083,XF86XK_Finance:269025084,XF86XK_Community:269025085,XF86XK_AudioRewind:269025086,XF86XK_BackForward:269025087,XF86XK_Launch0:269025088,XF86XK_Launch1:269025089,XF86XK_Launch2:269025090,XF86XK_Launch3:269025091,XF86XK_Launch4:269025092,XF86XK_Launch5:269025093,XF86XK_Launch6:269025094,XF86XK_Launch7:269025095,XF86XK_Launch8:269025096,XF86XK_Launch9:269025097,XF86XK_LaunchA:269025098,XF86XK_LaunchB:269025099,XF86XK_LaunchC:269025100,XF86XK_LaunchD:269025101,XF86XK_LaunchE:269025102,XF86XK_LaunchF:269025103,XF86XK_ApplicationLeft:269025104,XF86XK_ApplicationRight:269025105,XF86XK_Book:269025106,XF86XK_CD:269025107,XF86XK_Calculater:269025108,XF86XK_Clear:269025109,XF86XK_Close:269025110,XF86XK_Copy:269025111,XF86XK_Cut:269025112,XF86XK_Display:269025113,XF86XK_DOS:269025114,XF86XK_Documents:269025115,XF86XK_Excel:269025116,XF86XK_Explorer:269025117,XF86XK_Game:269025118,XF86XK_Go:269025119,XF86XK_iTouch:269025120,XF86XK_LogOff:269025121,XF86XK_Market:269025122,XF86XK_Meeting:269025123,XF86XK_MenuKB:269025125,XF86XK_MenuPB:269025126,XF86XK_MySites:269025127,XF86XK_New:269025128,XF86XK_News:269025129,XF86XK_OfficeHome:269025130,XF86XK_Open:269025131,XF86XK_Option:269025132,XF86XK_Paste:269025133,XF86XK_Phone:269025134,XF86XK_Q:269025136,XF86XK_Reply:269025138,XF86XK_Reload:269025139,XF86XK_RotateWindows:269025140,XF86XK_RotationPB:269025141,XF86XK_RotationKB:269025142,XF86XK_Save:269025143,XF86XK_ScrollUp:269025144,XF86XK_ScrollDown:269025145,XF86XK_ScrollClick:269025146,XF86XK_Send:269025147,XF86XK_Spell:269025148,XF86XK_SplitScreen:269025149,XF86XK_Support:269025150,XF86XK_TaskPane:269025151,XF86XK_Terminal:269025152,XF86XK_Tools:269025153,XF86XK_Travel:269025154,XF86XK_UserPB:269025156,XF86XK_User1KB:269025157,XF86XK_User2KB:269025158,XF86XK_Video:269025159,XF86XK_WheelButton:269025160,XF86XK_Word:269025161,XF86XK_Xfer:269025162,XF86XK_ZoomIn:269025163,XF86XK_ZoomOut:269025164,XF86XK_Away:269025165,XF86XK_Messenger:269025166,XF86XK_WebCam:269025167,XF86XK_MailForward:269025168,XF86XK_Pictures:269025169,XF86XK_Music:269025170,XF86XK_Battery:269025171,XF86XK_Bluetooth:269025172,XF86XK_WLAN:269025173,XF86XK_UWB:269025174,XF86XK_AudioForward:269025175,XF86XK_AudioRepeat:269025176,XF86XK_AudioRandomPlay:269025177,XF86XK_Subtitle:269025178,XF86XK_AudioCycleTrack:269025179,XF86XK_CycleAngle:269025180,XF86XK_FrameBack:269025181,XF86XK_FrameForward:269025182,XF86XK_Time:269025183,XF86XK_Select:269025184,XF86XK_View:269025185,XF86XK_TopMenu:269025186,XF86XK_Red:269025187,XF86XK_Green:269025188,XF86XK_Yellow:269025189,XF86XK_Blue:269025190,XF86XK_Suspend:269025191,XF86XK_Hibernate:269025192,XF86XK_TouchpadToggle:269025193,XF86XK_TouchpadOn:269025200,XF86XK_TouchpadOff:269025201,XF86XK_AudioMicMute:269025202,XF86XK_Switch_VT_1:269024769,XF86XK_Switch_VT_2:269024770,XF86XK_Switch_VT_3:269024771,XF86XK_Switch_VT_4:269024772,XF86XK_Switch_VT_5:269024773,XF86XK_Switch_VT_6:269024774,XF86XK_Switch_VT_7:269024775,XF86XK_Switch_VT_8:269024776,XF86XK_Switch_VT_9:269024777,XF86XK_Switch_VT_10:269024778,XF86XK_Switch_VT_11:269024779,XF86XK_Switch_VT_12:269024780,XF86XK_Ungrab:269024800,XF86XK_ClearGrab:269024801,XF86XK_Next_VMode:269024802,XF86XK_Prev_VMode:269024803,XF86XK_LogWindowTree:269024804,XF86XK_LogGrabInfo:269024805};let xr={256:960,257:992,258:451,259:483,260:417,261:433,262:454,263:486,264:710,265:742,266:709,267:741,268:456,269:488,270:463,271:495,272:464,273:496,274:938,275:954,278:972,279:1004,280:458,281:490,282:460,283:492,284:728,285:760,286:683,287:699,288:725,289:757,290:939,291:955,292:678,293:694,294:673,295:689,296:933,297:949,298:975,299:1007,302:967,303:999,304:681,305:697,308:684,309:700,310:979,311:1011,312:930,313:453,314:485,315:934,316:950,317:421,318:437,321:419,322:435,323:465,324:497,325:977,326:1009,327:466,328:498,330:957,331:959,332:978,333:1010,336:469,337:501,338:5052,339:5053,340:448,341:480,342:931,343:947,344:472,345:504,346:422,347:438,348:734,349:766,350:426,351:442,352:425,353:441,354:478,355:510,356:427,357:443,358:940,359:956,360:989,361:1021,362:990,363:1022,364:733,365:765,366:473,367:505,368:475,369:507,370:985,371:1017,376:5054,377:428,378:444,379:431,380:447,381:430,382:446,402:2294,466:16777681,711:439,728:418,729:511,731:434,733:445,901:1966,902:1953,904:1954,905:1955,906:1956,908:1959,910:1960,911:1963,912:1974,913:1985,914:1986,915:1987,916:1988,917:1989,918:1990,919:1991,920:1992,921:1993,922:1994,923:1995,924:1996,925:1997,926:1998,927:1999,928:2e3,929:2001,931:2002,932:2004,933:2005,934:2006,935:2007,936:2008,937:2009,938:1957,939:1961,940:1969,941:1970,942:1971,943:1972,944:1978,945:2017,946:2018,947:2019,948:2020,949:2021,950:2022,951:2023,952:2024,953:2025,954:2026,955:2027,956:2028,957:2029,958:2030,959:2031,960:2032,961:2033,962:2035,963:2034,964:2036,965:2037,966:2038,967:2039,968:2040,969:2041,970:1973,971:1977,972:1975,973:1976,974:1979,1025:1715,1026:1713,1027:1714,1028:1716,1029:1717,1030:1718,1031:1719,1032:1720,1033:1721,1034:1722,1035:1723,1036:1724,1038:1726,1039:1727,1040:1761,1041:1762,1042:1783,1043:1767,1044:1764,1045:1765,1046:1782,1047:1786,1048:1769,1049:1770,1050:1771,1051:1772,1052:1773,1053:1774,1054:1775,1055:1776,1056:1778,1057:1779,1058:1780,1059:1781,1060:1766,1061:1768,1062:1763,1063:1790,1064:1787,1065:1789,1066:1791,1067:1785,1068:1784,1069:1788,1070:1760,1071:1777,1072:1729,1073:1730,1074:1751,1075:1735,1076:1732,1077:1733,1078:1750,1079:1754,1080:1737,1081:1738,1082:1739,1083:1740,1084:1741,1085:1742,1086:1743,1087:1744,1088:1746,1089:1747,1090:1748,1091:1749,1092:1734,1093:1736,1094:1731,1095:1758,1096:1755,1097:1757,1098:1759,1099:1753,1100:1752,1101:1756,1102:1728,1103:1745,1105:1699,1106:1697,1107:1698,1108:1700,1109:1701,1110:1702,1111:1703,1112:1704,1113:1705,1114:1706,1115:1707,1116:1708,1118:1710,1119:1711,1168:1725,1169:1709,1488:3296,1489:3297,1490:3298,1491:3299,1492:3300,1493:3301,1494:3302,1495:3303,1496:3304,1497:3305,1498:3306,1499:3307,1500:3308,1501:3309,1502:3310,1503:3311,1504:3312,1505:3313,1506:3314,1507:3315,1508:3316,1509:3317,1510:3318,1511:3319,1512:3320,1513:3321,1514:3322,1548:1452,1563:1467,1567:1471,1569:1473,1570:1474,1571:1475,1572:1476,1573:1477,1574:1478,1575:1479,1576:1480,1577:1481,1578:1482,1579:1483,1580:1484,1581:1485,1582:1486,1583:1487,1584:1488,1585:1489,1586:1490,1587:1491,1588:1492,1589:1493,1590:1494,1591:1495,1592:1496,1593:1497,1594:1498,1600:1504,1601:1505,1602:1506,1603:1507,1604:1508,1605:1509,1606:1510,1607:1511,1608:1512,1609:1513,1610:1514,1611:1515,1612:1516,1613:1517,1614:1518,1615:1519,1616:1520,1617:1521,1618:1522,3585:3489,3586:3490,3587:3491,3588:3492,3589:3493,3590:3494,3591:3495,3592:3496,3593:3497,3594:3498,3595:3499,3596:3500,3597:3501,3598:3502,3599:3503,3600:3504,3601:3505,3602:3506,3603:3507,3604:3508,3605:3509,3606:3510,3607:3511,3608:3512,3609:3513,3610:3514,3611:3515,3612:3516,3613:3517,3614:3518,3615:3519,3616:3520,3617:3521,3618:3522,3619:3523,3620:3524,3621:3525,3622:3526,3623:3527,3624:3528,3625:3529,3626:3530,3627:3531,3628:3532,3629:3533,3630:3534,3631:3535,3632:3536,3633:3537,3634:3538,3635:3539,3636:3540,3637:3541,3638:3542,3639:3543,3640:3544,3641:3545,3642:3546,3647:3551,3648:3552,3649:3553,3650:3554,3651:3555,3652:3556,3653:3557,3654:3558,3655:3559,3656:3560,3657:3561,3658:3562,3659:3563,3660:3564,3661:3565,3664:3568,3665:3569,3666:3570,3667:3571,3668:3572,3669:3573,3670:3574,3671:3575,3672:3576,3673:3577,8194:2722,8195:2721,8196:2723,8197:2724,8199:2725,8200:2726,8201:2727,8202:2728,8210:2747,8211:2730,8212:2729,8213:1967,8215:3295,8216:2768,8217:2769,8218:2813,8220:2770,8221:2771,8222:2814,8224:2801,8225:2802,8226:2790,8229:2735,8230:2734,8240:2773,8242:2774,8243:2775,8248:2812,8254:1150,8361:3839,8364:8364,8453:2744,8470:1712,8471:2811,8478:2772,8482:2761,8531:2736,8532:2737,8533:2738,8534:2739,8535:2740,8536:2741,8537:2742,8538:2743,8539:2755,8540:2756,8541:2757,8542:2758,8592:2299,8593:2300,8594:2301,8595:2302,8658:2254,8660:2253,8706:2287,8711:2245,8728:3018,8730:2262,8733:2241,8734:2242,8743:2270,8744:2271,8745:2268,8746:2269,8747:2239,8756:2240,8764:2248,8771:2249,8773:16785992,8800:2237,8801:2255,8804:2236,8805:2238,8834:2266,8835:2267,8866:3068,8867:3036,8868:3010,8869:3022,8968:3027,8970:3012,8981:2810,8992:2212,8993:2213,9109:3020,9115:2219,9117:2220,9118:2221,9120:2222,9121:2215,9123:2216,9124:2217,9126:2218,9128:2223,9132:2224,9143:2209,9146:2543,9147:2544,9148:2546,9149:2547,9225:2530,9226:2533,9227:2537,9228:2531,9229:2532,9251:2732,9252:2536,9472:2211,9474:2214,9484:2210,9488:2539,9492:2541,9496:2538,9500:2548,9508:2549,9516:2551,9524:2550,9532:2542,9618:2529,9642:2791,9643:2785,9644:2779,9645:2786,9646:2783,9647:2767,9650:2792,9651:2787,9654:2781,9655:2765,9660:2793,9661:2788,9664:2780,9665:2764,9670:2528,9675:2766,9679:2782,9702:2784,9734:2789,9742:2809,9747:2762,9756:2794,9758:2795,9792:2808,9794:2807,9827:2796,9829:2798,9830:2797,9837:2806,9839:2805,10003:2803,10007:2804,10013:2777,10016:2800,10216:2748,10217:2750,12289:1188,12290:1185,12300:1186,12301:1187,12443:1246,12444:1247,12449:1191,12450:1201,12451:1192,12452:1202,12453:1193,12454:1203,12455:1194,12456:1204,12457:1195,12458:1205,12459:1206,12461:1207,12463:1208,12465:1209,12467:1210,12469:1211,12471:1212,12473:1213,12475:1214,12477:1215,12479:1216,12481:1217,12483:1199,12484:1218,12486:1219,12488:1220,12490:1221,12491:1222,12492:1223,12493:1224,12494:1225,12495:1226,12498:1227,12501:1228,12504:1229,12507:1230,12510:1231,12511:1232,12512:1233,12513:1234,12514:1235,12515:1196,12516:1236,12517:1197,12518:1237,12519:1198,12520:1238,12521:1239,12522:1240,12523:1241,12524:1242,12525:1243,12527:1244,12530:1190,12531:1245,12539:1189,12540:1200};var Sr={lookup(e){if(e>=32&&e<=255)return e;let t=xr[e];return t===void 0?16777216|e:t}},Cr={8:`Backspace`,9:`Tab`,10:`NumpadClear`,13:`Enter`,16:`ShiftLeft`,17:`ControlLeft`,18:`AltLeft`,19:`Pause`,20:`CapsLock`,21:`Lang1`,25:`Lang2`,27:`Escape`,28:`Convert`,29:`NonConvert`,32:`Space`,33:`PageUp`,34:`PageDown`,35:`End`,36:`Home`,37:`ArrowLeft`,38:`ArrowUp`,39:`ArrowRight`,40:`ArrowDown`,41:`Select`,44:`PrintScreen`,45:`Insert`,46:`Delete`,47:`Help`,48:`Digit0`,49:`Digit1`,50:`Digit2`,51:`Digit3`,52:`Digit4`,53:`Digit5`,54:`Digit6`,55:`Digit7`,56:`Digit8`,57:`Digit9`,91:`MetaLeft`,92:`MetaRight`,93:`ContextMenu`,95:`Sleep`,96:`Numpad0`,97:`Numpad1`,98:`Numpad2`,99:`Numpad3`,100:`Numpad4`,101:`Numpad5`,102:`Numpad6`,103:`Numpad7`,104:`Numpad8`,105:`Numpad9`,106:`NumpadMultiply`,107:`NumpadAdd`,108:`NumpadDecimal`,109:`NumpadSubtract`,110:`NumpadDecimal`,111:`NumpadDivide`,112:`F1`,113:`F2`,114:`F3`,115:`F4`,116:`F5`,117:`F6`,118:`F7`,119:`F8`,120:`F9`,121:`F10`,122:`F11`,123:`F12`,124:`F13`,125:`F14`,126:`F15`,127:`F16`,128:`F17`,129:`F18`,130:`F19`,131:`F20`,132:`F21`,133:`F22`,134:`F23`,135:`F24`,144:`NumLock`,145:`ScrollLock`,166:`BrowserBack`,167:`BrowserForward`,168:`BrowserRefresh`,169:`BrowserStop`,170:`BrowserSearch`,171:`BrowserFavorites`,172:`BrowserHome`,173:`AudioVolumeMute`,174:`AudioVolumeDown`,175:`AudioVolumeUp`,176:`MediaTrackNext`,177:`MediaTrackPrevious`,178:`MediaStop`,179:`MediaPlayPause`,180:`LaunchMail`,181:`MediaSelect`,182:`LaunchApp1`,183:`LaunchApp2`,225:`AltRight`},wr={Backspace:`Backspace`,AltLeft:`Alt`,AltRight:`Alt`,CapsLock:`CapsLock`,ContextMenu:`ContextMenu`,ControlLeft:`Control`,ControlRight:`Control`,Enter:`Enter`,MetaLeft:`Meta`,MetaRight:`Meta`,ShiftLeft:`Shift`,ShiftRight:`Shift`,Tab:`Tab`,Delete:`Delete`,End:`End`,Help:`Help`,Home:`Home`,Insert:`Insert`,PageDown:`PageDown`,PageUp:`PageUp`,ArrowDown:`ArrowDown`,ArrowLeft:`ArrowLeft`,ArrowRight:`ArrowRight`,ArrowUp:`ArrowUp`,NumLock:`NumLock`,NumpadBackspace:`Backspace`,NumpadClear:`Clear`,Escape:`Escape`,F1:`F1`,F2:`F2`,F3:`F3`,F4:`F4`,F5:`F5`,F6:`F6`,F7:`F7`,F8:`F8`,F9:`F9`,F10:`F10`,F11:`F11`,F12:`F12`,F13:`F13`,F14:`F14`,F15:`F15`,F16:`F16`,F17:`F17`,F18:`F18`,F19:`F19`,F20:`F20`,F21:`F21`,F22:`F22`,F23:`F23`,F24:`F24`,F25:`F25`,F26:`F26`,F27:`F27`,F28:`F28`,F29:`F29`,F30:`F30`,F31:`F31`,F32:`F32`,F33:`F33`,F34:`F34`,F35:`F35`,PrintScreen:`PrintScreen`,ScrollLock:`ScrollLock`,Pause:`Pause`,BrowserBack:`BrowserBack`,BrowserFavorites:`BrowserFavorites`,BrowserForward:`BrowserForward`,BrowserHome:`BrowserHome`,BrowserRefresh:`BrowserRefresh`,BrowserSearch:`BrowserSearch`,BrowserStop:`BrowserStop`,Eject:`Eject`,LaunchApp1:`LaunchMyComputer`,LaunchApp2:`LaunchCalendar`,LaunchMail:`LaunchMail`,MediaPlayPause:`MediaPlay`,MediaStop:`MediaStop`,MediaTrackNext:`MediaTrackNext`,MediaTrackPrevious:`MediaTrackPrevious`,Power:`Power`,Sleep:`Sleep`,AudioVolumeDown:`AudioVolumeDown`,AudioVolumeMute:`AudioVolumeMute`,AudioVolumeUp:`AudioVolumeUp`,WakeUp:`WakeUp`};let Tr={};function z(e,t){if(t===void 0)throw Error(`Undefined keysym for key "`+e+`"`);if(e in Tr)throw Error(`Duplicate entry for key "`+e+`"`);Tr[e]=[t,t,t,t]}function Er(e,t,n){if(t===void 0||n===void 0)throw Error(`Undefined keysym for key "`+e+`"`);if(e in Tr)throw Error(`Duplicate entry for key "`+e+`"`);Tr[e]=[t,t,n,t]}function B(e,t,n){if(t===void 0||n===void 0)throw Error(`Undefined keysym for key "`+e+`"`);if(e in Tr)throw Error(`Duplicate entry for key "`+e+`"`);Tr[e]=[t,t,t,n]}Er(`Alt`,R.XK_Alt_L,R.XK_Alt_R),z(`AltGraph`,R.XK_ISO_Level3_Shift),z(`CapsLock`,R.XK_Caps_Lock),Er(`Control`,R.XK_Control_L,R.XK_Control_R),Er(`Meta`,R.XK_Super_L,R.XK_Super_R),z(`NumLock`,R.XK_Num_Lock),z(`ScrollLock`,R.XK_Scroll_Lock),Er(`Shift`,R.XK_Shift_L,R.XK_Shift_R),B(`Enter`,R.XK_Return,R.XK_KP_Enter),z(`Tab`,R.XK_Tab),B(` `,R.XK_space,R.XK_KP_Space),B(`ArrowDown`,R.XK_Down,R.XK_KP_Down),B(`ArrowLeft`,R.XK_Left,R.XK_KP_Left),B(`ArrowRight`,R.XK_Right,R.XK_KP_Right),B(`ArrowUp`,R.XK_Up,R.XK_KP_Up),B(`End`,R.XK_End,R.XK_KP_End),B(`Home`,R.XK_Home,R.XK_KP_Home),B(`PageDown`,R.XK_Next,R.XK_KP_Next),B(`PageUp`,R.XK_Prior,R.XK_KP_Prior),z(`Backspace`,R.XK_BackSpace),B(`Clear`,R.XK_Clear,R.XK_KP_Begin),z(`Copy`,R.XF86XK_Copy),z(`Cut`,R.XF86XK_Cut),B(`Delete`,R.XK_Delete,R.XK_KP_Delete),B(`Insert`,R.XK_Insert,R.XK_KP_Insert),z(`Paste`,R.XF86XK_Paste),z(`Redo`,R.XK_Redo),z(`Undo`,R.XK_Undo),z(`Cancel`,R.XK_Cancel),z(`ContextMenu`,R.XK_Menu),z(`Escape`,R.XK_Escape),z(`Execute`,R.XK_Execute),z(`Find`,R.XK_Find),z(`Help`,R.XK_Help),z(`Pause`,R.XK_Pause),z(`Select`,R.XK_Select),z(`ZoomIn`,R.XF86XK_ZoomIn),z(`ZoomOut`,R.XF86XK_ZoomOut),z(`BrightnessDown`,R.XF86XK_MonBrightnessDown),z(`BrightnessUp`,R.XF86XK_MonBrightnessUp),z(`Eject`,R.XF86XK_Eject),z(`LogOff`,R.XF86XK_LogOff),z(`Power`,R.XF86XK_PowerOff),z(`PowerOff`,R.XF86XK_PowerDown),z(`PrintScreen`,R.XK_Print),z(`Hibernate`,R.XF86XK_Hibernate),z(`Standby`,R.XF86XK_Standby),z(`WakeUp`,R.XF86XK_WakeUp),z(`AllCandidates`,R.XK_MultipleCandidate),z(`Alphanumeric`,R.XK_Eisu_toggle),z(`CodeInput`,R.XK_Codeinput),z(`Compose`,R.XK_Multi_key),z(`Convert`,R.XK_Henkan),z(`GroupFirst`,R.XK_ISO_First_Group),z(`GroupLast`,R.XK_ISO_Last_Group),z(`GroupNext`,R.XK_ISO_Next_Group),z(`GroupPrevious`,R.XK_ISO_Prev_Group),z(`NonConvert`,R.XK_Muhenkan),z(`PreviousCandidate`,R.XK_PreviousCandidate),z(`SingleCandidate`,R.XK_SingleCandidate),z(`HangulMode`,R.XK_Hangul),z(`HanjaMode`,R.XK_Hangul_Hanja),z(`JunjaMode`,R.XK_Hangul_Jeonja),z(`Eisu`,R.XK_Eisu_toggle),z(`Hankaku`,R.XK_Hankaku),z(`Hiragana`,R.XK_Hiragana),z(`HiraganaKatakana`,R.XK_Hiragana_Katakana),z(`KanaMode`,R.XK_Kana_Shift),z(`KanjiMode`,R.XK_Kanji),z(`Katakana`,R.XK_Katakana),z(`Romaji`,R.XK_Romaji),z(`Zenkaku`,R.XK_Zenkaku),z(`ZenkakuHankaku`,R.XK_Zenkaku_Hankaku),z(`F1`,R.XK_F1),z(`F2`,R.XK_F2),z(`F3`,R.XK_F3),z(`F4`,R.XK_F4),z(`F5`,R.XK_F5),z(`F6`,R.XK_F6),z(`F7`,R.XK_F7),z(`F8`,R.XK_F8),z(`F9`,R.XK_F9),z(`F10`,R.XK_F10),z(`F11`,R.XK_F11),z(`F12`,R.XK_F12),z(`F13`,R.XK_F13),z(`F14`,R.XK_F14),z(`F15`,R.XK_F15),z(`F16`,R.XK_F16),z(`F17`,R.XK_F17),z(`F18`,R.XK_F18),z(`F19`,R.XK_F19),z(`F20`,R.XK_F20),z(`F21`,R.XK_F21),z(`F22`,R.XK_F22),z(`F23`,R.XK_F23),z(`F24`,R.XK_F24),z(`F25`,R.XK_F25),z(`F26`,R.XK_F26),z(`F27`,R.XK_F27),z(`F28`,R.XK_F28),z(`F29`,R.XK_F29),z(`F30`,R.XK_F30),z(`F31`,R.XK_F31),z(`F32`,R.XK_F32),z(`F33`,R.XK_F33),z(`F34`,R.XK_F34),z(`F35`,R.XK_F35),z(`Close`,R.XF86XK_Close),z(`MailForward`,R.XF86XK_MailForward),z(`MailReply`,R.XF86XK_Reply),z(`MailSend`,R.XF86XK_Send),z(`MediaFastForward`,R.XF86XK_AudioForward),z(`MediaPause`,R.XF86XK_AudioPause),z(`MediaPlay`,R.XF86XK_AudioPlay),z(`MediaRecord`,R.XF86XK_AudioRecord),z(`MediaRewind`,R.XF86XK_AudioRewind),z(`MediaStop`,R.XF86XK_AudioStop),z(`MediaTrackNext`,R.XF86XK_AudioNext),z(`MediaTrackPrevious`,R.XF86XK_AudioPrev),z(`New`,R.XF86XK_New),z(`Open`,R.XF86XK_Open),z(`Print`,R.XK_Print),z(`Save`,R.XF86XK_Save),z(`SpellCheck`,R.XF86XK_Spell),z(`AudioVolumeDown`,R.XF86XK_AudioLowerVolume),z(`AudioVolumeUp`,R.XF86XK_AudioRaiseVolume),z(`AudioVolumeMute`,R.XF86XK_AudioMute),z(`MicrophoneVolumeMute`,R.XF86XK_AudioMicMute),z(`LaunchApplication1`,R.XF86XK_MyComputer),z(`LaunchApplication2`,R.XF86XK_Calculator),z(`LaunchCalendar`,R.XF86XK_Calendar),z(`LaunchMail`,R.XF86XK_Mail),z(`LaunchMediaPlayer`,R.XF86XK_AudioMedia),z(`LaunchMusicPlayer`,R.XF86XK_Music),z(`LaunchPhone`,R.XF86XK_Phone),z(`LaunchScreenSaver`,R.XF86XK_ScreenSaver),z(`LaunchSpreadsheet`,R.XF86XK_Excel),z(`LaunchWebBrowser`,R.XF86XK_WWW),z(`LaunchWebCam`,R.XF86XK_WebCam),z(`LaunchWordProcessor`,R.XF86XK_Word),z(`BrowserBack`,R.XF86XK_Back),z(`BrowserFavorites`,R.XF86XK_Favorites),z(`BrowserForward`,R.XF86XK_Forward),z(`BrowserHome`,R.XF86XK_HomePage),z(`BrowserRefresh`,R.XF86XK_Refresh),z(`BrowserSearch`,R.XF86XK_Search),z(`BrowserStop`,R.XF86XK_Stop),z(`Dimmer`,R.XF86XK_BrightnessAdjust),z(`MediaAudioTrack`,R.XF86XK_AudioCycleTrack),z(`RandomToggle`,R.XF86XK_AudioRandomPlay),z(`SplitScreenToggle`,R.XF86XK_SplitScreen),z(`Subtitle`,R.XF86XK_Subtitle),z(`VideoModeNext`,R.XF86XK_Next_VMode),B(`=`,R.XK_equal,R.XK_KP_Equal),B(`+`,R.XK_plus,R.XK_KP_Add),B(`-`,R.XK_minus,R.XK_KP_Subtract),B(`*`,R.XK_asterisk,R.XK_KP_Multiply),B(`/`,R.XK_slash,R.XK_KP_Divide),B(`.`,R.XK_period,R.XK_KP_Decimal),B(`,`,R.XK_comma,R.XK_KP_Separator),B(`0`,R.XK_0,R.XK_KP_0),B(`1`,R.XK_1,R.XK_KP_1),B(`2`,R.XK_2,R.XK_KP_2),B(`3`,R.XK_3,R.XK_KP_3),B(`4`,R.XK_4,R.XK_KP_4),B(`5`,R.XK_5,R.XK_KP_5),B(`6`,R.XK_6,R.XK_KP_6),B(`7`,R.XK_7,R.XK_KP_7),B(`8`,R.XK_8,R.XK_KP_8),B(`9`,R.XK_9,R.XK_KP_9);function Dr(e){if(e.code){switch(e.code){case`OSLeft`:return`MetaLeft`;case`OSRight`:return`MetaRight`}return e.code}if(e.keyCode in Cr){let t=Cr[e.keyCode];if(_()&&t===`ContextMenu`&&(t=`MetaRight`),e.location===2)switch(t){case`ShiftLeft`:return`ShiftRight`;case`ControlLeft`:return`ControlRight`;case`AltLeft`:return`AltRight`}if(e.location===3)switch(t){case`Delete`:return`NumpadDecimal`;case`Insert`:return`Numpad0`;case`End`:return`Numpad1`;case`ArrowDown`:return`Numpad2`;case`PageDown`:return`Numpad3`;case`ArrowLeft`:return`Numpad4`;case`ArrowRight`:return`Numpad6`;case`Home`:return`Numpad7`;case`ArrowUp`:return`Numpad8`;case`PageUp`:return`Numpad9`;case`Enter`:return`NumpadEnter`}return t}return`Unidentified`}function Or(e){if(e.key!==void 0&&e.key!==`Unidentified`){switch(e.key){case`OS`:return`Meta`;case`LaunchMyComputer`:return`LaunchApplication1`;case`LaunchCalculator`:return`LaunchApplication2`}switch(e.key){case`UIKeyInputUpArrow`:return`ArrowUp`;case`UIKeyInputDownArrow`:return`ArrowDown`;case`UIKeyInputLeftArrow`:return`ArrowLeft`;case`UIKeyInputRightArrow`:return`ArrowRight`;case`UIKeyInputEscape`:return`Escape`}return e.key===`\0`&&e.code===`NumpadDecimal`?`Delete`:e.key}let t=Dr(e);return t in wr?wr[t]:e.charCode?String.fromCharCode(e.charCode):`Unidentified`}function kr(e){let t=Or(e);if(t===`Unidentified`)return null;if(t in Tr){let n=e.location;if(t===`Meta`&&n===0&&(n=2),t===`Clear`&&n===3&&Dr(e)===`NumLock`&&(n=0),(n===void 0||n>3)&&(n=0),t===`Meta`){let t=Dr(e);if(t===`AltLeft`)return R.XK_Meta_L;if(t===`AltRight`)return R.XK_Meta_R}if(t===`Clear`&&Dr(e)===`NumLock`)return R.XK_Num_Lock;if(v())switch(t){case`Zenkaku`:case`Hankaku`:return R.XK_Zenkaku_Hankaku;case`Romaji`:case`KanaMode`:return R.XK_Romaji}return Tr[t][n]}if(t.length!==1)return null;let n=t.charCodeAt();return n?Sr.lookup(n):null}var Ar=class{constructor(e){this._target=e||null,this._keyDownList={},this._altGrArmed=!1,this._eventHandlers={keyup:this._handleKeyUp.bind(this),keydown:this._handleKeyDown.bind(this),blur:this._allKeysUp.bind(this)},this.onkeyevent=()=>{}}_sendKeyEvent(e,t,n,r=null,a=null){if(n)this._keyDownList[t]=e;else{if(!(t in this._keyDownList))return;delete this._keyDownList[t]}i(`onkeyevent `+(n?`down`:`up`)+`, keysym: `+e,`, code: `+t+`, numlock: `+r+`, capslock: `+a),this.onkeyevent(e,t,n,r,a)}_getKeyCode(e){let t=Dr(e);if(t!==`Unidentified`)return t;if(e.keyCode&&e.keyCode!==229)return`Platform`+e.keyCode;if(e.keyIdentifier){if(e.keyIdentifier.substr(0,2)!==`U+`)return e.keyIdentifier;let t=parseInt(e.keyIdentifier.substr(2),16);return`Platform`+String.fromCharCode(t).toUpperCase().charCodeAt()}return`Unidentified`}_handleKeyDown(e){let t=this._getKeyCode(e),n=kr(e),r=e.getModifierState(`NumLock`),i=e.getModifierState(`CapsLock`);if((_()||y())&&(r=null),this._altGrArmed&&(this._altGrArmed=!1,clearTimeout(this._altGrTimeout),t===`AltRight`&&e.timeStamp-this._altGrCtrlTime<50?n=R.XK_ISO_Level3_Shift:this._sendKeyEvent(R.XK_Control_L,`ControlLeft`,!0,r,i)),t===`Unidentified`){n&&(this._sendKeyEvent(n,t,!0,r,i),this._sendKeyEvent(n,t,!1,r,i)),x(e);return}if(_()||y())switch(n){case R.XK_Super_L:n=R.XK_Alt_L;break;case R.XK_Super_R:n=R.XK_Super_L;break;case R.XK_Alt_L:n=R.XK_Mode_switch;break;case R.XK_Alt_R:n=R.XK_ISO_Level3_Shift}if(t in this._keyDownList&&(n=this._keyDownList[t]),(_()||y())&&e.metaKey&&t!==`MetaLeft`&&t!==`MetaRight`){this._sendKeyEvent(n,t,!0,r,i),this._sendKeyEvent(n,t,!1,r,i),x(e);return}if((_()||y())&&t===`CapsLock`){this._sendKeyEvent(R.XK_Caps_Lock,`CapsLock`,!0,r,i),this._sendKeyEvent(R.XK_Caps_Lock,`CapsLock`,!1,r,i),x(e);return}let a=[R.XK_Zenkaku_Hankaku,R.XK_Eisu_toggle,R.XK_Katakana,R.XK_Hiragana,R.XK_Romaji];if(v()&&a.includes(n)){this._sendKeyEvent(n,t,!0,r,i),this._sendKeyEvent(n,t,!1,r,i),x(e);return}if(x(e),t===`ControlLeft`&&v()&&!(`ControlLeft`in this._keyDownList)){this._altGrArmed=!0,this._altGrTimeout=setTimeout(this._interruptAltGrSequence.bind(this),100),this._altGrCtrlTime=e.timeStamp;return}this._sendKeyEvent(n,t,!0,r,i)}_handleKeyUp(e){x(e);let t=this._getKeyCode(e);if(this._interruptAltGrSequence(),(_()||y())&&t===`CapsLock`){this._sendKeyEvent(R.XK_Caps_Lock,`CapsLock`,!0),this._sendKeyEvent(R.XK_Caps_Lock,`CapsLock`,!1);return}this._sendKeyEvent(this._keyDownList[t],t,!1),v()&&(t===`ShiftLeft`||t===`ShiftRight`)&&(`ShiftRight`in this._keyDownList&&this._sendKeyEvent(this._keyDownList.ShiftRight,`ShiftRight`,!1),`ShiftLeft`in this._keyDownList&&this._sendKeyEvent(this._keyDownList.ShiftLeft,`ShiftLeft`,!1))}_interruptAltGrSequence(){this._altGrArmed&&(this._altGrArmed=!1,clearTimeout(this._altGrTimeout),this._sendKeyEvent(R.XK_Control_L,`ControlLeft`,!0))}_allKeysUp(){i(`>> Keyboard.allKeysUp`),this._interruptAltGrSequence();for(let e in this._keyDownList)this._sendKeyEvent(this._keyDownList[e],e,!1);i(`<< Keyboard.allKeysUp`)}grab(){this._target.addEventListener(`keydown`,this._eventHandlers.keydown),this._target.addEventListener(`keyup`,this._eventHandlers.keyup),window.addEventListener(`blur`,this._eventHandlers.blur)}ungrab(){this._target.removeEventListener(`keydown`,this._eventHandlers.keydown),this._target.removeEventListener(`keyup`,this._eventHandlers.keyup),window.removeEventListener(`blur`,this._eventHandlers.blur),this._allKeysUp()}},jr=class{constructor(){this._target=null,this._state=127,this._tracked=[],this._ignored=[],this._waitingRelease=!1,this._releaseStart=0,this._longpressTimeoutId=null,this._twoTouchTimeoutId=null,this._boundEventHandler=this._eventHandler.bind(this)}attach(e){this.detach(),this._target=e,this._target.addEventListener(`touchstart`,this._boundEventHandler),this._target.addEventListener(`touchmove`,this._boundEventHandler),this._target.addEventListener(`touchend`,this._boundEventHandler),this._target.addEventListener(`touchcancel`,this._boundEventHandler)}detach(){this._target&&=(this._stopLongpressTimeout(),this._stopTwoTouchTimeout(),this._target.removeEventListener(`touchstart`,this._boundEventHandler),this._target.removeEventListener(`touchmove`,this._boundEventHandler),this._target.removeEventListener(`touchend`,this._boundEventHandler),this._target.removeEventListener(`touchcancel`,this._boundEventHandler),null)}_eventHandler(e){let t;switch(e.stopPropagation(),e.preventDefault(),e.type){case`touchstart`:t=this._touchStart;break;case`touchmove`:t=this._touchMove;break;case`touchend`:case`touchcancel`:t=this._touchEnd}for(let n=0;n<e.changedTouches.length;n++){let r=e.changedTouches[n];t.call(this,r.identifier,r.clientX,r.clientY)}}_touchStart(e,t,n){if(this._hasDetectedGesture()||this._state===0){this._ignored.push(e);return}if(this._tracked.length>0&&Date.now()-this._tracked[0].started>250){this._state=0,this._ignored.push(e);return}if(this._waitingRelease){this._state=0,this._ignored.push(e);return}switch(this._tracked.push({id:e,started:Date.now(),active:!0,firstX:t,firstY:n,lastX:t,lastY:n,angle:0}),this._tracked.length){case 1:this._startLongpressTimeout();break;case 2:this._state&=-26,this._stopLongpressTimeout();break;case 3:this._state&=-99;break;default:this._state=0}}_touchMove(e,t,n){let r=this._tracked.find(t=>t.id===e);if(r===void 0)return;r.lastX=t,r.lastY=n;let i=t-r.firstX,a=n-r.firstY;if((r.firstX!==r.lastX||r.firstY!==r.lastY)&&(r.angle=Math.atan2(a,i)*180/Math.PI),!this._hasDetectedGesture()){if(Math.hypot(i,a)<50)return;if(this._state&=-24,this._stopLongpressTimeout(),this._tracked.length!==1&&(this._state&=-9),this._tracked.length!==2&&(this._state&=-97),this._tracked.length===2){let t=this._tracked.find(t=>t.id!==e);if(Math.hypot(t.firstX-t.lastX,t.firstY-t.lastY)>50){let e=Math.abs(r.angle-t.angle);e=Math.abs((e+180)%360-180),e>90?this._state&=-33:this._state&=-65,this._isTwoTouchTimeoutRunning()&&this._stopTwoTouchTimeout()}else this._isTwoTouchTimeoutRunning()||this._startTwoTouchTimeout()}if(!this._hasDetectedGesture())return;this._pushEvent(`gesturestart`)}this._pushEvent(`gesturemove`)}_touchEnd(e,t,n){if(this._ignored.indexOf(e)!==-1){this._ignored.splice(this._ignored.indexOf(e),1),this._ignored.length===0&&this._tracked.length===0&&(this._state=127,this._waitingRelease=!1);return}if(!this._hasDetectedGesture()&&this._isTwoTouchTimeoutRunning()&&(this._stopTwoTouchTimeout(),this._state=0),!this._hasDetectedGesture()&&(this._state&=-105,this._state&=-17,this._stopLongpressTimeout(),!this._waitingRelease))switch(this._releaseStart=Date.now(),this._waitingRelease=!0,this._tracked.length){case 1:this._state&=-7;break;case 2:this._state&=-6}if(this._waitingRelease){Date.now()-this._releaseStart>250&&(this._state=0),this._tracked.some(e=>Date.now()-e.started>1e3)&&(this._state=0);let t=this._tracked.find(t=>t.id===e);if(t.active=!1,this._hasDetectedGesture())this._pushEvent(`gesturestart`);else if(this._state!==0)return}this._hasDetectedGesture()&&this._pushEvent(`gestureend`);for(let e=0;e<this._tracked.length;e++)this._tracked[e].active&&this._ignored.push(this._tracked[e].id);this._tracked=[],this._state=0,this._ignored.indexOf(e)!==-1&&this._ignored.splice(this._ignored.indexOf(e),1),this._ignored.length===0&&(this._state=127,this._waitingRelease=!1)}_hasDetectedGesture(){return!(this._state===0||this._state&this._state-1||this._state&7&&this._tracked.some(e=>e.active))}_startLongpressTimeout(){this._stopLongpressTimeout(),this._longpressTimeoutId=setTimeout(()=>this._longpressTimeout(),1e3)}_stopLongpressTimeout(){clearTimeout(this._longpressTimeoutId),this._longpressTimeoutId=null}_longpressTimeout(){if(this._hasDetectedGesture())throw Error(`A longpress gesture failed, conflict with a different gesture`);this._state=16,this._pushEvent(`gesturestart`)}_startTwoTouchTimeout(){this._stopTwoTouchTimeout(),this._twoTouchTimeoutId=setTimeout(()=>this._twoTouchTimeout(),50)}_stopTwoTouchTimeout(){clearTimeout(this._twoTouchTimeoutId),this._twoTouchTimeoutId=null}_isTwoTouchTimeoutRunning(){return this._twoTouchTimeoutId!==null}_twoTouchTimeout(){if(this._tracked.length===0)throw Error(`A pinch or two drag gesture failed, no tracked touches`);let e=this._getAverageMovement(),t=Math.abs(e.x),n=Math.abs(e.y),r=this._getAverageDistance(),i=Math.abs(Math.hypot(r.first.x,r.first.y)-Math.hypot(r.last.x,r.last.y));this._state=n<i&&t<i?64:32,this._pushEvent(`gesturestart`),this._pushEvent(`gesturemove`)}_pushEvent(e){let t={type:this._stateToGesture(this._state)},n=this._getPosition(),r=n.last;switch(e===`gesturestart`&&(r=n.first),this._state){case 32:case 64:r=n.first}if(t.clientX=r.x,t.clientY=r.y,this._state===64){let n=this._getAverageDistance();e===`gesturestart`?(t.magnitudeX=n.first.x,t.magnitudeY=n.first.y):(t.magnitudeX=n.last.x,t.magnitudeY=n.last.y)}else if(this._state===32){if(e===`gesturestart`)t.magnitudeX=0,t.magnitudeY=0;else{let e=this._getAverageMovement();t.magnitudeX=e.x,t.magnitudeY=e.y}}let i=new CustomEvent(e,{detail:t});this._target.dispatchEvent(i)}_stateToGesture(e){switch(e){case 1:return`onetap`;case 2:return`twotap`;case 4:return`threetap`;case 8:return`drag`;case 16:return`longpress`;case 32:return`twodrag`;case 64:return`pinch`}throw Error(`Unknown gesture state: `+e)}_getPosition(){if(this._tracked.length===0)throw Error(`Failed to get gesture position, no tracked touches`);let e=this._tracked.length,t=0,n=0,r=0,i=0;for(let e=0;e<this._tracked.length;e++)t+=this._tracked[e].firstX,n+=this._tracked[e].firstY,r+=this._tracked[e].lastX,i+=this._tracked[e].lastY;return{first:{x:t/e,y:n/e},last:{x:r/e,y:i/e}}}_getAverageMovement(){if(this._tracked.length===0)throw Error(`Failed to get gesture movement, no tracked touches`);let e,t;e=t=0;let n=this._tracked.length;for(let n=0;n<this._tracked.length;n++)e+=this._tracked[n].lastX-this._tracked[n].firstX,t+=this._tracked[n].lastY-this._tracked[n].firstY;return{x:e/n,y:t/n}}_getAverageDistance(){if(this._tracked.length===0)throw Error(`Failed to get gesture distance, no tracked touches`);let e=this._tracked[0],t=this._tracked[this._tracked.length-1],n=Math.abs(t.firstX-e.firstX),r=Math.abs(t.firstY-e.firstY),i=Math.abs(t.lastX-e.lastX),a=Math.abs(t.lastY-e.lastY);return{first:{x:n,y:r},last:{x:i,y:a}}}};let Mr=!h||f;var Nr=class{constructor(){this._target=null,this._canvas=document.createElement(`canvas`),Mr&&(this._canvas.style.position=`fixed`,this._canvas.style.zIndex=`65535`,this._canvas.style.pointerEvents=`none`,this._canvas.style.userSelect=`none`,this._canvas.style.WebkitUserSelect=`none`,this._canvas.style.visibility=`hidden`),this._position={x:0,y:0},this._hotSpot={x:0,y:0},this._eventHandlers={mouseover:this._handleMouseOver.bind(this),mouseleave:this._handleMouseLeave.bind(this),mousemove:this._handleMouseMove.bind(this),mouseup:this._handleMouseUp.bind(this)}}attach(e){if(this._target&&this.detach(),this._target=e,Mr){document.body.appendChild(this._canvas);let e={capture:!0,passive:!0};this._target.addEventListener(`mouseover`,this._eventHandlers.mouseover,e),this._target.addEventListener(`mouseleave`,this._eventHandlers.mouseleave,e),this._target.addEventListener(`mousemove`,this._eventHandlers.mousemove,e),this._target.addEventListener(`mouseup`,this._eventHandlers.mouseup,e)}this.clear()}detach(){if(this._target){if(Mr){let e={capture:!0,passive:!0};this._target.removeEventListener(`mouseover`,this._eventHandlers.mouseover,e),this._target.removeEventListener(`mouseleave`,this._eventHandlers.mouseleave,e),this._target.removeEventListener(`mousemove`,this._eventHandlers.mousemove,e),this._target.removeEventListener(`mouseup`,this._eventHandlers.mouseup,e),document.contains(this._canvas)&&document.body.removeChild(this._canvas)}this._target=null}}change(e,t,n,r,i){if(r===0||i===0){this.clear();return}this._position.x=this._position.x+this._hotSpot.x-t,this._position.y=this._position.y+this._hotSpot.y-n,this._hotSpot.x=t,this._hotSpot.y=n;let a=this._canvas.getContext(`2d`);this._canvas.width=r,this._canvas.height=i;let o=new ImageData(new Uint8ClampedArray(e),r,i);if(a.clearRect(0,0,r,i),a.putImageData(o,0,0),Mr)this._updatePosition();else{let e=this._canvas.toDataURL();this._target.style.cursor=`url(`+e+`)`+t+` `+n+`, default`}}clear(){this._target.style.cursor=`none`,this._canvas.width=0,this._canvas.height=0,this._position.x=this._position.x+this._hotSpot.x,this._position.y=this._position.y+this._hotSpot.y,this._hotSpot.x=0,this._hotSpot.y=0}move(e,t){if(!Mr)return;window.visualViewport?(this._position.x=e+window.visualViewport.offsetLeft,this._position.y=t+window.visualViewport.offsetTop):(this._position.x=e,this._position.y=t),this._updatePosition();let n=document.elementFromPoint(e,t);this._updateVisibility(n)}_handleMouseOver(e){this._handleMouseMove(e)}_handleMouseLeave(e){this._updateVisibility(e.relatedTarget)}_handleMouseMove(e){this._updateVisibility(e.target),this._position.x=e.clientX-this._hotSpot.x,this._position.y=e.clientY-this._hotSpot.y,this._updatePosition()}_handleMouseUp(e){let t=document.elementFromPoint(e.clientX,e.clientY);this._updateVisibility(t),this._captureIsActive()&&window.setTimeout(()=>{this._target&&(t=document.elementFromPoint(e.clientX,e.clientY),this._updateVisibility(t))},0)}_showCursor(){this._canvas.style.visibility===`hidden`&&(this._canvas.style.visibility=``)}_hideCursor(){this._canvas.style.visibility!==`hidden`&&(this._canvas.style.visibility=`hidden`)}_shouldShowCursor(e){return e?e===this._target||!(!this._target.contains(e)||window.getComputedStyle(e).cursor!==`none`):!1}_updateVisibility(e){this._captureIsActive()&&(e=document.captureElement),this._shouldShowCursor(e)?this._showCursor():this._hideCursor()}_updatePosition(){this._canvas.style.left=this._position.x+`px`,this._canvas.style.top=this._position.y+`px`}_captureIsActive(){return document.captureElement&&document.documentElement.contains(document.captureElement)}};let Pr=41943040,Fr={CONNECTING:`connecting`,OPEN:`open`,CLOSING:`closing`,CLOSED:`closed`},Ir={CONNECTING:[WebSocket.CONNECTING,Fr.CONNECTING],OPEN:[WebSocket.OPEN,Fr.OPEN],CLOSING:[WebSocket.CLOSING,Fr.CLOSING],CLOSED:[WebSocket.CLOSED,Fr.CLOSED]},Lr=[`send`,`close`,`binaryType`,`onerror`,`onmessage`,`onopen`,`protocol`,`readyState`];var Rr=class{constructor(){this._websocket=null,this._rQi=0,this._rQlen=0,this._rQbufferSize=4194304,this._rQ=null,this._sQbufferSize=10240,this._sQlen=0,this._sQ=null,this._eventHandlers={message:()=>{},open:()=>{},close:()=>{},error:()=>{}}}get readyState(){let e;return this._websocket===null?`unused`:(e=this._websocket.readyState,Ir.CONNECTING.includes(e)?`connecting`:Ir.OPEN.includes(e)?`open`:Ir.CLOSING.includes(e)?`closing`:Ir.CLOSED.includes(e)?`closed`:`unknown`)}rQpeek8(){return this._rQ[this._rQi]}rQskipBytes(e){this._rQi+=e}rQshift8(){return this._rQshift(1)}rQshift16(){return this._rQshift(2)}rQshift32(){return this._rQshift(4)}_rQshift(e){let t=0;for(let n=e-1;n>=0;n--)t+=this._rQ[this._rQi++]<<n*8;return t>>>0}rQlen(){return this._rQlen-this._rQi}rQshiftStr(e){let t=``;for(let n=0;n<e;n+=4096){let r=this.rQshiftBytes(Math.min(4096,e-n),!1);t+=String.fromCharCode.apply(null,r)}return t}rQshiftBytes(e,t=!0){return this._rQi+=e,t?this._rQ.slice(this._rQi-e,this._rQi):this._rQ.subarray(this._rQi-e,this._rQi)}rQshiftTo(e,t){e.set(new Uint8Array(this._rQ.buffer,this._rQi,t)),this._rQi+=t}rQpeekBytes(e,t=!0){return t?this._rQ.slice(this._rQi,this._rQi+e):this._rQ.subarray(this._rQi,this._rQi+e)}rQwait(e,t,n){if(this._rQlen-this._rQi<t){if(n){if(this._rQi<n)throw Error(`rQwait cannot backup `+n+` bytes`);this._rQi-=n}return!0}return!1}sQpush8(e){this._sQensureSpace(1),this._sQ[this._sQlen++]=e}sQpush16(e){this._sQensureSpace(2),this._sQ[this._sQlen++]=e>>8&255,this._sQ[this._sQlen++]=e>>0&255}sQpush32(e){this._sQensureSpace(4),this._sQ[this._sQlen++]=e>>24&255,this._sQ[this._sQlen++]=e>>16&255,this._sQ[this._sQlen++]=e>>8&255,this._sQ[this._sQlen++]=e>>0&255}sQpushString(e){let t=e.split(``).map(e=>e.charCodeAt(0));this.sQpushBytes(new Uint8Array(t))}sQpushBytes(e){for(let t=0;t<e.length;){this._sQensureSpace(1);let n=this._sQbufferSize-this._sQlen;n>e.length-t&&(n=e.length-t),this._sQ.set(e.subarray(t,t+n),this._sQlen),this._sQlen+=n,t+=n}}flush(){this._sQlen>0&&this.readyState===`open`&&(this._websocket.send(new Uint8Array(this._sQ.buffer,0,this._sQlen)),this._sQlen=0)}_sQensureSpace(e){this._sQbufferSize-this._sQlen<e&&this.flush()}off(e){this._eventHandlers[e]=()=>{}}on(e,t){this._eventHandlers[e]=t}_allocateBuffers(){this._rQ=new Uint8Array(this._rQbufferSize),this._sQ=new Uint8Array(this._sQbufferSize)}init(){this._allocateBuffers(),this._rQi=0,this._websocket=null}open(e,t){this.attach(new WebSocket(e,t))}attach(e){this.init();let t=[...Object.keys(e),...Object.getOwnPropertyNames(Object.getPrototypeOf(e))];for(let e=0;e<Lr.length;e++){let n=Lr[e];if(t.indexOf(n)<0)throw Error(`Raw channel missing property: `+n)}this._websocket=e,this._websocket.binaryType=`arraybuffer`,this._websocket.onmessage=this._recvMessage.bind(this),this._websocket.onopen=()=>{i(`>> WebSock.onopen`),this._websocket.protocol&&a(`Server choose sub-protocol: `+this._websocket.protocol),this._eventHandlers.open(),i(`<< WebSock.onopen`)},this._websocket.onclose=e=>{i(`>> WebSock.onclose`),this._eventHandlers.close(e),i(`<< WebSock.onclose`)},this._websocket.onerror=e=>{i(`>> WebSock.onerror: `+e),this._eventHandlers.error(e),i(`<< WebSock.onerror: `+e)}}close(){this._websocket&&((this.readyState===`connecting`||this.readyState===`open`)&&(a(`Closing WebSocket connection`),this._websocket.close()),this._websocket.onmessage=()=>{})}_expandCompactRQ(e){let t=(this._rQlen-this._rQi+e)*8,n=this._rQbufferSize<t;if(n&&(this._rQbufferSize=Math.max(this._rQbufferSize*2,t)),this._rQbufferSize>Pr&&(this._rQbufferSize=Pr,this._rQbufferSize-(this._rQlen-this._rQi)<e))throw Error(`Receive queue buffer exceeded 41943040 bytes, and the new message could not fit`);if(n){let e=this._rQ.buffer;this._rQ=new Uint8Array(this._rQbufferSize),this._rQ.set(new Uint8Array(e,this._rQi,this._rQlen-this._rQi))}else this._rQ.copyWithin(0,this._rQi,this._rQlen);this._rQlen-=this._rQi,this._rQi=0}_recvMessage(e){this._rQlen==this._rQi&&(this._rQlen=0,this._rQi=0);let t=new Uint8Array(e.data);t.length>this._rQbufferSize-this._rQlen&&this._expandCompactRQ(t.length),this._rQ.set(t,this._rQlen),this._rQlen+=t.length,this._rQlen-this._rQi>0?this._eventHandlers.message():i(`Ignoring empty message`)}},zr={Again:57349,AltLeft:56,AltRight:57400,ArrowDown:57424,ArrowLeft:57419,ArrowRight:57421,ArrowUp:57416,AudioVolumeDown:57390,AudioVolumeMute:57376,AudioVolumeUp:57392,Backquote:41,Backslash:43,Backspace:14,BracketLeft:26,BracketRight:27,BrowserBack:57450,BrowserFavorites:57446,BrowserForward:57449,BrowserHome:57394,BrowserRefresh:57447,BrowserSearch:57445,BrowserStop:57448,CapsLock:58,Comma:51,ContextMenu:57437,ControlLeft:29,ControlRight:57373,Convert:121,Copy:57464,Cut:57404,Delete:57427,Digit0:11,Digit1:2,Digit2:3,Digit3:4,Digit4:5,Digit5:6,Digit6:7,Digit7:8,Digit8:9,Digit9:10,Eject:57469,End:57423,Enter:28,Equal:13,Escape:1,F1:59,F10:68,F11:87,F12:88,F13:93,F14:94,F15:95,F16:85,F17:57347,F18:57463,F19:57348,F2:60,F20:90,F21:116,F22:57465,F23:109,F24:111,F3:61,F4:62,F5:63,F6:64,F7:65,F8:66,F9:67,Find:57409,Help:57461,Hiragana:119,Home:57415,Insert:57426,IntlBackslash:86,IntlRo:115,IntlYen:125,KanaMode:112,Katakana:120,KeyA:30,KeyB:48,KeyC:46,KeyD:32,KeyE:18,KeyF:33,KeyG:34,KeyH:35,KeyI:23,KeyJ:36,KeyK:37,KeyL:38,KeyM:50,KeyN:49,KeyO:24,KeyP:25,KeyQ:16,KeyR:19,KeyS:31,KeyT:20,KeyU:22,KeyV:47,KeyW:17,KeyX:45,KeyY:21,KeyZ:44,Lang1:114,Lang2:113,Lang3:120,Lang4:119,Lang5:118,LaunchApp1:57451,LaunchApp2:57377,LaunchMail:57452,MediaPlayPause:57378,MediaSelect:57453,MediaStop:57380,MediaTrackNext:57369,MediaTrackPrevious:57360,MetaLeft:57435,MetaRight:57436,Minus:12,NonConvert:123,NumLock:69,Numpad0:82,Numpad1:79,Numpad2:80,Numpad3:81,Numpad4:75,Numpad5:76,Numpad6:77,Numpad7:71,Numpad8:72,Numpad9:73,NumpadAdd:78,NumpadComma:126,NumpadDecimal:83,NumpadDivide:57397,NumpadEnter:57372,NumpadEqual:89,NumpadMultiply:55,NumpadParenLeft:57462,NumpadParenRight:57467,NumpadSubtract:74,Open:100,PageDown:57425,PageUp:57417,Paste:101,Pause:57414,Period:52,Power:57438,PrintScreen:84,Props:57350,Quote:40,ScrollLock:70,Semicolon:39,ShiftLeft:42,ShiftRight:54,Slash:53,Sleep:57439,Space:57,Suspend:57381,Tab:15,Undo:57351,WakeUp:57443};let V={encodingRaw:0,encodingCopyRect:1,encodingRRE:2,encodingHextile:5,encodingZlib:6,encodingTight:7,encodingZRLE:16,encodingTightPNG:-260,encodingJPEG:21,encodingH264:50,pseudoEncodingQualityLevel9:-23,pseudoEncodingQualityLevel0:-32,pseudoEncodingDesktopSize:-223,pseudoEncodingLastRect:-224,pseudoEncodingCursor:-239,pseudoEncodingQEMUExtendedKeyEvent:-258,pseudoEncodingQEMULedEvent:-261,pseudoEncodingDesktopName:-307,pseudoEncodingExtendedDesktopSize:-308,pseudoEncodingXvp:-309,pseudoEncodingFence:-312,pseudoEncodingContinuousUpdates:-313,pseudoEncodingExtendedMouseButtons:-316,pseudoEncodingCompressLevel9:-247,pseudoEncodingCompressLevel0:-256,pseudoEncodingVMwareCursor:1464686180,pseudoEncodingExtendedClipboard:3231835598};var Br=class e{constructor(){this._key=null}get algorithm(){return{name:`AES-ECB`}}static async importKey(t,n,r,i){let a=new e;return await a._importKey(t,r,i),a}async _importKey(e,t,n){this._key=await window.crypto.subtle.importKey(`raw`,e,{name:`AES-CBC`},t,n)}async encrypt(e,t){let n=new Uint8Array(t);if(n.length%16!=0||this._key===null)return null;let r=n.length/16;for(let e=0;e<r;e++){let t=new Uint8Array(await window.crypto.subtle.encrypt({name:`AES-CBC`,iv:new Uint8Array(16)},this._key,n.slice(e*16,e*16+16))).slice(0,16);n.set(t,e*16)}return n}},Vr=class e{constructor(){this._rawKey=null,this._ctrKey=null,this._cbcKey=null,this._zeroBlock=new Uint8Array(16),this._prefixBlock0=this._zeroBlock,this._prefixBlock1=new Uint8Array([0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1]),this._prefixBlock2=new Uint8Array([0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2])}get algorithm(){return{name:`AES-EAX`}}async _encryptBlock(e){let t=await window.crypto.subtle.encrypt({name:`AES-CBC`,iv:this._zeroBlock},this._cbcKey,e);return new Uint8Array(t).slice(0,16)}async _initCMAC(){let e=await this._encryptBlock(this._zeroBlock),t=new Uint8Array(16),n=e[0]>>>6;for(let n=0;n<15;n++)t[n]=e[n+1]>>6|e[n]<<2,e[n]=e[n+1]>>7|e[n]<<1;let r=[0,135,14,137];t[14]^=n>>>1,t[15]=e[15]<<2^r[n],e[15]=e[15]<<1^r[n>>1],this._k1=e,this._k2=t}async _encryptCTR(e,t){let n=await window.crypto.subtle.encrypt({name:`AES-CTR`,counter:t,length:128},this._ctrKey,e);return new Uint8Array(n)}async _decryptCTR(e,t){let n=await window.crypto.subtle.decrypt({name:`AES-CTR`,counter:t,length:128},this._ctrKey,e);return new Uint8Array(n)}async _computeCMAC(e,t){if(t.length!==16)return null;let n=Math.floor(e.length/16),r=Math.ceil(e.length/16),i=e.length-n*16,a=new Uint8Array((r+1)*16);if(a.set(t),a.set(e,16),i===0)for(let e=0;e<16;e++)a[n*16+e]^=this._k1[e];else{a[(n+1)*16+i]=128;for(let e=0;e<16;e++)a[(n+1)*16+e]^=this._k2[e]}let o=await window.crypto.subtle.encrypt({name:`AES-CBC`,iv:this._zeroBlock},this._cbcKey,a);return o=new Uint8Array(o),o.slice(o.length-32,o.length-16)}static async importKey(t,n,r,i){let a=new e;return await a._importKey(t),a}async _importKey(e){this._rawKey=e,this._ctrKey=await window.crypto.subtle.importKey(`raw`,e,{name:`AES-CTR`},!1,[`encrypt`,`decrypt`]),this._cbcKey=await window.crypto.subtle.importKey(`raw`,e,{name:`AES-CBC`},!1,[`encrypt`]),await this._initCMAC()}async encrypt(e,t){let n=e.additionalData,r=e.iv,i=await this._computeCMAC(r,this._prefixBlock0),a=await this._encryptCTR(t,i),o=await this._computeCMAC(n,this._prefixBlock1),s=await this._computeCMAC(a,this._prefixBlock2);for(let e=0;e<16;e++)s[e]^=i[e]^o[e];let c=new Uint8Array(16+a.length);return c.set(a),c.set(s,a.length),c}async decrypt(e,t){let n=t.slice(0,t.length-16),r=e.additionalData,i=e.iv,a=t.slice(t.length-16),o=await this._computeCMAC(i,this._prefixBlock0),s=await this._computeCMAC(r,this._prefixBlock1),c=await this._computeCMAC(n,this._prefixBlock2);for(let e=0;e<16;e++)c[e]^=o[e]^s[e];if(c.length!==a.length)return null;for(let e=0;e<a.length;e++)if(c[e]!==a[e])return null;return await this._decryptCTR(n,o)}};let Hr=[13,16,10,23,0,4,2,27,14,5,20,9,22,18,11,3,25,7,15,6,26,19,12,1,40,51,30,36,46,54,29,39,50,44,32,47,43,48,38,55,33,52,45,41,49,35,28,31],Ur=[1,2,4,6,8,10,12,14,15,17,19,21,23,25,27,28],H,U,W,G,K,q;H=65536,U=1<<24,W=H|U,G=4,K=1024,q=G|K;let Wr=[W|K,0,H|0,W|q,W|G,H|q,0|G,H|0,0|K,W|K,W|q,0|K,U|q,W|G,U|0,0|G,0|q,U|K,U|K,H|K,H|K,W|0,W|0,U|q,H|G,U|G,U|G,H|G,0,0|q,H|q,U|0,H|0,W|q,0|G,W|0,W|K,U|0,U|0,0|K,W|G,H|0,H|K,U|G,0|K,0|G,U|q,H|q,W|q,H|G,W|0,U|q,U|G,0|q,H|q,W|K,0|q,U|K,U|K,0,H|G,H|K,0,W|G];H=1<<20,U=1<<31,W=H|U,G=32,K=32768,q=G|K;let Gr=[W|q,U|K,0|K,H|q,H|0,0|G,W|G,U|q,U|G,W|q,W|K,U|0,U|K,H|0,0|G,W|G,H|K,H|G,U|q,0,U|0,0|K,H|q,W|0,H|G,U|G,0,H|K,0|q,W|K,W|0,0|q,0,H|q,W|G,H|0,U|q,W|0,W|K,0|K,W|0,U|K,0|G,W|q,H|q,0|G,0|K,U|0,0|q,W|K,H|0,U|G,H|G,U|q,U|G,H|G,H|K,0,U|K,0|q,U|0,W|G,W|q,H|K];H=1<<17,U=1<<27,W=H|U,G=8,K=512,q=G|K;let Kr=[0|q,W|K,0,W|G,U|K,0,H|q,U|K,H|G,U|G,U|G,H|0,W|q,H|G,W|0,0|q,U|0,0|G,W|K,0|K,H|K,W|0,W|G,H|q,U|q,H|K,H|0,U|q,0|G,W|q,0|K,U|0,W|K,U|0,H|G,0|q,H|0,W|K,U|K,0,0|K,H|G,W|q,U|K,U|G,0|K,0,W|G,U|q,H|0,U|0,W|q,0|G,H|q,H|K,U|G,W|0,U|q,0|q,W|0,H|q,0|G,W|G,H|K];H=8192,U=1<<23,W=H|U,G=1,K=128,q=G|K;let qr=[W|G,H|q,H|q,0|K,W|K,U|q,U|G,H|G,0,W|0,W|0,W|q,0|q,0,U|K,U|G,0|G,H|0,U|0,W|G,0|K,U|0,H|G,H|K,U|q,0|G,H|K,U|K,H|0,W|K,W|q,0|q,U|K,U|G,W|0,W|q,0|q,0,0,W|0,H|K,U|K,U|q,0|G,W|G,H|q,H|q,0|K,W|q,0|q,0|G,H|0,U|G,H|G,W|K,U|q,H|G,H|K,U|0,W|G,0|K,U|0,H|0,W|K];H=1<<25,U=1<<30,W=H|U,G=256,K=1<<19,q=G|K;let Jr=[0|G,H|q,H|K,W|G,0|K,0|G,U|0,H|K,U|q,0|K,H|G,U|q,W|G,W|K,0|q,U|0,H|0,U|K,U|K,0,U|G,W|q,W|q,H|G,W|K,U|G,0,W|0,H|q,H|0,W|0,0|q,0|K,W|G,0|G,H|0,U|0,H|K,W|G,U|q,H|G,U|0,W|K,H|q,U|q,0|G,H|0,W|K,W|q,0|q,W|0,W|q,H|K,0,U|K,W|0,0|q,H|G,U|G,0|K,0,U|K,H|q,U|G];H=1<<22,U=1<<29,W=H|U,G=16,K=16384,q=G|K;let Yr=[U|G,W|0,0|K,W|q,W|0,0|G,W|q,H|0,U|K,H|q,H|0,U|G,H|G,U|K,U|0,0|q,0,H|G,U|q,0|K,H|K,U|q,0|G,W|G,W|G,0,H|q,W|K,0|q,H|K,W|K,U|0,U|K,0|G,W|G,H|K,W|q,H|0,0|q,U|G,H|0,U|K,U|0,0|q,U|G,W|q,H|K,W|0,H|q,W|K,0,W|G,0|G,0|K,W|0,H|q,0|K,H|G,U|q,0,W|K,U|0,H|G,U|q];H=1<<21,U=1<<26,W=H|U,G=2,K=2048,q=G|K;let Xr=[H|0,W|G,U|q,0,0|K,U|q,H|q,W|K,W|q,H|0,0,U|G,0|G,U|0,W|G,0|q,U|K,H|q,H|G,U|K,U|G,W|0,W|K,H|G,W|0,0|K,0|q,W|q,H|K,0|G,U|0,H|K,U|0,H|K,H|0,U|q,U|q,W|G,W|G,0|G,H|G,U|0,U|K,H|0,W|K,0|q,H|q,W|K,0|q,U|G,W|q,W|0,H|K,0,0|G,W|q,0,H|q,W|0,0|K,U|G,U|K,0|K,H|G];H=1<<18,U=1<<28,W=H|U,G=64,K=4096,q=G|K;let Zr=[U|q,0|K,H|0,W|q,U|0,U|q,0|G,U|0,H|G,W|0,W|q,H|K,W|K,H|q,0|K,0|G,W|0,U|G,U|K,0|q,H|K,H|G,W|G,W|K,0|q,0,0,W|G,U|G,U|K,H|q,H|0,H|q,H|0,W|K,0|K,0|G,W|G,0|K,H|q,U|K,0|G,U|G,W|0,W|G,U|0,H|0,U|q,0,W|q,H|G,U|G,W|0,U|K,U|q,0,W|q,H|K,H|K,0|q,0|q,H|G,U|0,W|K];var Qr=class{constructor(e){this.keys=[];let t=[],n=[],r=[];for(let n=0,r=56;n<56;++n,r-=8){r+=r<-5?65:r<-3?31:r<-1?63:r===27?35:0;let i=r&7;t[n]=e[r>>>3]&1<<i?1:0}for(let e=0;e<16;++e){let i=e<<1,a=i+1;r[i]=r[a]=0;for(let r=28;r<59;r+=28)for(let i=r-28;i<r;++i){let a=i+Ur[e];n[i]=a<r?t[a]:t[a-28]}for(let e=0;e<24;++e)n[Hr[e]]!==0&&(r[i]|=1<<23-e),n[Hr[e+24]]!==0&&(r[a]|=1<<23-e)}for(let e=0,t=0,n=0;e<16;++e){let e=r[t++],i=r[t++];this.keys[n]=(e&16515072)<<6,this.keys[n]|=(e&4032)<<10,this.keys[n]|=(i&16515072)>>>10,this.keys[n]|=(i&4032)>>>6,++n,this.keys[n]=(e&258048)<<12,this.keys[n]|=(e&63)<<16,this.keys[n]|=(i&258048)>>>4,this.keys[n]|=i&63,++n}}enc8(e){let t=e.slice(),n=0,r,i,a;r=t[n++]<<24|t[n++]<<16|t[n++]<<8|t[n++],i=t[n++]<<24|t[n++]<<16|t[n++]<<8|t[n++],a=(r>>>4^i)&252645135,i^=a,r^=a<<4,a=(r>>>16^i)&65535,i^=a,r^=a<<16,a=(i>>>2^r)&858993459,r^=a,i^=a<<2,a=(i>>>8^r)&16711935,r^=a,i^=a<<8,i=i<<1|i>>>31&1,a=(r^i)&2863311530,r^=a,i^=a,r=r<<1|r>>>31&1;for(let e=0,t=0;e<8;++e){a=i<<28|i>>>4,a^=this.keys[t++];let e=Xr[a&63];e|=Jr[a>>>8&63],e|=Kr[a>>>16&63],e|=Wr[a>>>24&63],a=i^this.keys[t++],e|=Zr[a&63],e|=Yr[a>>>8&63],e|=qr[a>>>16&63],e|=Gr[a>>>24&63],r^=e,a=r<<28|r>>>4,a^=this.keys[t++],e=Xr[a&63],e|=Jr[a>>>8&63],e|=Kr[a>>>16&63],e|=Wr[a>>>24&63],a=r^this.keys[t++],e|=Zr[a&63],e|=Yr[a>>>8&63],e|=qr[a>>>16&63],e|=Gr[a>>>24&63],i^=e}for(i=i<<31|i>>>1,a=(r^i)&2863311530,r^=a,i^=a,r=r<<31|r>>>1,a=(r>>>8^i)&16711935,i^=a,r^=a<<8,a=(r>>>2^i)&858993459,i^=a,r^=a<<2,a=(i>>>16^r)&65535,r^=a,i^=a<<16,a=(i>>>4^r)&252645135,r^=a,i^=a<<4,a=[i,r],n=0;n<8;n++)t[n]=(a[n>>>2]>>>8*(3-n%4))%256,t[n]<0&&(t[n]+=256);return t}},$r=class e{constructor(){this._cipher=null}get algorithm(){return{name:`DES-ECB`}}static importKey(t,n,r,i){let a=new e;return a._importKey(t),a}_importKey(e,t,n){this._cipher=new Qr(e)}encrypt(e,t){let n=new Uint8Array(t);if(n.length%8!=0||this._cipher===null)return null;let r=n.length/8;for(let e=0;e<r;e++)n.set(this._cipher.enc8(n.slice(e*8,e*8+8)),e*8);return n}},ei=class e{constructor(){this._cipher=null}get algorithm(){return{name:`DES-CBC`}}static importKey(t,n,r,i){let a=new e;return a._importKey(t),a}_importKey(e){this._cipher=new Qr(e)}encrypt(e,t){let n=new Uint8Array(t),r=new Uint8Array(e.iv);if(n.length%8!=0||this._cipher===null)return null;let i=n.length/8;for(let e=0;e<i;e++){for(let n=0;n<8;n++)r[n]^=t[e*8+n];r=this._cipher.enc8(r),n.set(r,e*8)}return n}};function ti(e,t,n){let r=1n;for(e%=n;t>0n;)(t&1n)==1n&&(r=r*e%n),t>>=1n,e=e*e%n;return r}function ni(e,t=0){let n=e.toString(16);t===0&&(t=Math.ceil(n.length/2)),n=n.padStart(t*2,`0`);let r=n.length/2,i=new Uint8Array(r);for(let e=0;e<r;e++)i[e]=parseInt(n.slice(e*2,e*2+2),16);return i}function ri(e){let t=`0x`;for(let n=0;n<e.length;n++)t+=e[n].toString(16).padStart(2,`0`);return BigInt(t)}var ii=class e{constructor(){this._keyLength=0,this._keyBytes=0,this._n=null,this._e=null,this._d=null,this._nBigInt=null,this._eBigInt=null,this._dBigInt=null,this._extractable=!1}get algorithm(){return{name:`RSA-PKCS1-v1_5`}}_base64urlDecode(e){return e=e.replace(/-/g,`+`).replace(/_/g,`/`),e=e.padEnd(Math.ceil(e.length/4)*4,`=`),d.decode(e)}_padArray(e,t){let n=new Uint8Array(t);return n.set(e,t-e.length),n}static async generateKey(t,n,r){let i=new e;return await i._generateKey(t,n),{privateKey:i}}async _generateKey(e,t){this._keyLength=e.modulusLength,this._keyBytes=Math.ceil(this._keyLength/8);let n=await window.crypto.subtle.generateKey({name:`RSA-OAEP`,modulusLength:e.modulusLength,publicExponent:e.publicExponent,hash:{name:`SHA-256`}},!0,[`encrypt`,`decrypt`]),r=await window.crypto.subtle.exportKey(`jwk`,n.privateKey);this._n=this._padArray(this._base64urlDecode(r.n),this._keyBytes),this._nBigInt=ri(this._n),this._e=this._padArray(this._base64urlDecode(r.e),this._keyBytes),this._eBigInt=ri(this._e),this._d=this._padArray(this._base64urlDecode(r.d),this._keyBytes),this._dBigInt=ri(this._d),this._extractable=t}static async importKey(t,n,r,i){if(i.length!==1||i[0]!==`encrypt`)throw Error(`only support importing RSA public key`);let a=new e;return await a._importKey(t,r),a}async _importKey(e,t){let n=e.n,r=e.e;if(n.length!==r.length)throw Error(`the sizes of modulus and public exponent do not match`);this._keyBytes=n.length,this._keyLength=this._keyBytes*8,this._n=new Uint8Array(this._keyBytes),this._e=new Uint8Array(this._keyBytes),this._n.set(n),this._e.set(r),this._nBigInt=ri(this._n),this._eBigInt=ri(this._e),this._extractable=t}async encrypt(e,t){if(t.length>this._keyBytes-11)return null;let n=new Uint8Array(this._keyBytes-t.length-3);window.crypto.getRandomValues(n);for(let e=0;e<n.length;e++)n[e]=Math.floor(n[e]*254/255+1);let r=new Uint8Array(this._keyBytes);return r[1]=2,r.set(n,2),r.set(t,n.length+3),ni(ti(ri(r),this._eBigInt,this._nBigInt),this._keyBytes)}async decrypt(e,t){if(t.length!==this._keyBytes)return null;let n=ni(ti(ri(t),this._dBigInt,this._nBigInt),this._keyBytes);if(n[0]!==0||n[1]!==2)return null;let r=2;for(;r<n.length&&n[r]!==0;r++);return r===n.length?null:n.slice(r+1,n.length)}async exportKey(){if(!this._extractable)throw Error(`key is not extractable`);return{n:this._n,e:this._e,d:this._d}}},ai=class{constructor(e){this._key=e}get algorithm(){return{name:`DH`}}exportKey(){return this._key}},oi=class e{constructor(){this._g=null,this._p=null,this._gBigInt=null,this._pBigInt=null,this._privateKey=null}get algorithm(){return{name:`DH`}}static generateKey(t,n){let r=new e;return r._generateKey(t),{privateKey:r,publicKey:new ai(r._publicKey)}}_generateKey(e){let t=e.g,n=e.p;this._keyBytes=n.length,this._gBigInt=ri(t),this._pBigInt=ri(n),this._privateKey=window.crypto.getRandomValues(new Uint8Array(this._keyBytes)),this._privateKeyBigInt=ri(this._privateKey),this._publicKey=ni(ti(this._gBigInt,this._privateKeyBigInt,this._pBigInt),this._keyBytes)}deriveBits(e,t){let n=Math.ceil(t/8),r=new Uint8Array(e.public),i=n>this._keyBytes?n:this._keyBytes;return ni(ti(ri(r),this._privateKeyBigInt,this._pBigInt),i).slice(0,i)}};async function si(e){let t=``;for(let n=0;n<e.length;n++)t+=String.fromCharCode(e[n]);return ci(ui(di(li(t),8*t.length)))}function ci(e){let t=new Uint8Array(e.length);for(let n=0;n<e.length;n++)t[n]=e.charCodeAt(n);return t}function li(e){let t=Array(e.length>>2);for(let e=0;e<t.length;e++)t[e]=0;for(let n=0;n<8*e.length;n+=8)t[n>>5]|=(255&e.charCodeAt(n/8))<<n%32;return t}function ui(e){let t=``;for(let n=0;n<32*e.length;n+=8)t+=String.fromCharCode(e[n>>5]>>>n%32&255);return t}function di(e,t){e[t>>5]|=128<<t%32,e[14+(t+64>>>9<<4)]=t;let n=1732584193,r=-271733879,i=-1732584194,a=271733878;for(let t=0;t<e.length;t+=16){let o=n,s=r,c=i,l=a;r=Z(r=Z(r=Z(r=Z(r=X(r=X(r=X(r=X(r=Y(r=Y(r=Y(r=Y(r=J(r=J(r=J(r=J(r,i=J(i,a=J(a,n=J(n,r,i,a,e[t+0],7,-680876936),r,i,e[t+1],12,-389564586),n,r,e[t+2],17,606105819),a,n,e[t+3],22,-1044525330),i=J(i,a=J(a,n=J(n,r,i,a,e[t+4],7,-176418897),r,i,e[t+5],12,1200080426),n,r,e[t+6],17,-1473231341),a,n,e[t+7],22,-45705983),i=J(i,a=J(a,n=J(n,r,i,a,e[t+8],7,1770035416),r,i,e[t+9],12,-1958414417),n,r,e[t+10],17,-42063),a,n,e[t+11],22,-1990404162),i=J(i,a=J(a,n=J(n,r,i,a,e[t+12],7,1804603682),r,i,e[t+13],12,-40341101),n,r,e[t+14],17,-1502002290),a,n,e[t+15],22,1236535329),i=Y(i,a=Y(a,n=Y(n,r,i,a,e[t+1],5,-165796510),r,i,e[t+6],9,-1069501632),n,r,e[t+11],14,643717713),a,n,e[t+0],20,-373897302),i=Y(i,a=Y(a,n=Y(n,r,i,a,e[t+5],5,-701558691),r,i,e[t+10],9,38016083),n,r,e[t+15],14,-660478335),a,n,e[t+4],20,-405537848),i=Y(i,a=Y(a,n=Y(n,r,i,a,e[t+9],5,568446438),r,i,e[t+14],9,-1019803690),n,r,e[t+3],14,-187363961),a,n,e[t+8],20,1163531501),i=Y(i,a=Y(a,n=Y(n,r,i,a,e[t+13],5,-1444681467),r,i,e[t+2],9,-51403784),n,r,e[t+7],14,1735328473),a,n,e[t+12],20,-1926607734),i=X(i,a=X(a,n=X(n,r,i,a,e[t+5],4,-378558),r,i,e[t+8],11,-2022574463),n,r,e[t+11],16,1839030562),a,n,e[t+14],23,-35309556),i=X(i,a=X(a,n=X(n,r,i,a,e[t+1],4,-1530992060),r,i,e[t+4],11,1272893353),n,r,e[t+7],16,-155497632),a,n,e[t+10],23,-1094730640),i=X(i,a=X(a,n=X(n,r,i,a,e[t+13],4,681279174),r,i,e[t+0],11,-358537222),n,r,e[t+3],16,-722521979),a,n,e[t+6],23,76029189),i=X(i,a=X(a,n=X(n,r,i,a,e[t+9],4,-640364487),r,i,e[t+12],11,-421815835),n,r,e[t+15],16,530742520),a,n,e[t+2],23,-995338651),i=Z(i,a=Z(a,n=Z(n,r,i,a,e[t+0],6,-198630844),r,i,e[t+7],10,1126891415),n,r,e[t+14],15,-1416354905),a,n,e[t+5],21,-57434055),i=Z(i,a=Z(a,n=Z(n,r,i,a,e[t+12],6,1700485571),r,i,e[t+3],10,-1894986606),n,r,e[t+10],15,-1051523),a,n,e[t+1],21,-2054922799),i=Z(i,a=Z(a,n=Z(n,r,i,a,e[t+8],6,1873313359),r,i,e[t+15],10,-30611744),n,r,e[t+6],15,-1560198380),a,n,e[t+13],21,1309151649),i=Z(i,a=Z(a,n=Z(n,r,i,a,e[t+4],6,-145523070),r,i,e[t+11],10,-1120210379),n,r,e[t+2],15,718787259),a,n,e[t+9],21,-343485551),n=pi(n,o),r=pi(r,s),i=pi(i,c),a=pi(a,l)}return[n,r,i,a]}function fi(e,t,n,r,i,a){return pi(mi(pi(pi(t,e),pi(r,a)),i),n)}function J(e,t,n,r,i,a,o){return fi(t&n|~t&r,e,t,i,a,o)}function Y(e,t,n,r,i,a,o){return fi(t&r|n&~r,e,t,i,a,o)}function X(e,t,n,r,i,a,o){return fi(t^n^r,e,t,i,a,o)}function Z(e,t,n,r,i,a,o){return fi(n^(t|~r),e,t,i,a,o)}function pi(e,t){let n=(65535&e)+(65535&t);return(e>>16)+(t>>16)+(n>>16)<<16|65535&n}function mi(e,t){return e<<t|e>>>32-t}var Q=new class{constructor(){this._algorithms={"AES-ECB":Br,"AES-EAX":Vr,"DES-ECB":$r,"DES-CBC":ei,"RSA-PKCS1-v1_5":ii,DH:oi,MD5:si}}encrypt(e,t,n){if(t.algorithm.name!==e.name)throw Error(`algorithm does not match`);if(typeof t.encrypt!=`function`)throw Error(`key does not support encryption`);return t.encrypt(e,n)}decrypt(e,t,n){if(t.algorithm.name!==e.name)throw Error(`algorithm does not match`);if(typeof t.decrypt!=`function`)throw Error(`key does not support encryption`);return t.decrypt(e,n)}importKey(e,t,n,r,i){if(e!==`raw`)throw Error(`key format is not supported`);let a=this._algorithms[n.name];if(a===void 0||typeof a.importKey!=`function`)throw Error(`algorithm is not supported`);return a.importKey(t,n,r,i)}generateKey(e,t,n){let r=this._algorithms[e.name];if(r===void 0||typeof r.generateKey!=`function`)throw Error(`algorithm is not supported`);return r.generateKey(e,t,n)}exportKey(e,t){if(e!==`raw`)throw Error(`key format is not supported`);if(typeof t.exportKey!=`function`)throw Error(`key does not support exportKey`);return t.exportKey()}digest(e,t){let n=this._algorithms[e];if(typeof n!=`function`)throw Error(`algorithm is not supported`);return n(t)}deriveBits(e,t,n){if(t.algorithm.name!==e.name)throw Error(`algorithm does not match`);if(typeof t.deriveBits!=`function`)throw Error(`key does not support deriveBits`);return t.deriveBits(e,n)}},hi=class{constructor(){this._cipher=null,this._counter=new Uint8Array(16)}async setKey(e){this._cipher=await Q.importKey(`raw`,e,{name:`AES-EAX`},!1,[`encrypt, decrypt`])}async makeMessage(e){let t=new Uint8Array([(e.length&65280)>>>8,e.length&255]),n=await Q.encrypt({name:`AES-EAX`,iv:this._counter,additionalData:t},this._cipher,e);for(let e=0;e<16&&this._counter[e]++===255;e++);let r=new Uint8Array(e.length+2+16);return r.set(t),r.set(n,2),r}async receiveMessage(e,t){let n=new Uint8Array([(e&65280)>>>8,e&255]),r=await Q.decrypt({name:`AES-EAX`,iv:this._counter,additionalData:n},this._cipher,t);for(let e=0;e<16&&this._counter[e]++===255;e++);return r}},gi=class extends ee{constructor(e,t){super(),this._hasStarted=!1,this._checkSock=null,this._checkCredentials=null,this._approveServerResolve=null,this._sockReject=null,this._credentialsReject=null,this._approveServerReject=null,this._sock=e,this._getCredentials=t}_waitSockAsync(e){return new Promise((t,n)=>{let r=()=>!this._sock.rQwait(`RA2`,e);r()?t():(this._checkSock=()=>{r()&&(t(),this._checkSock=null,this._sockReject=null)},this._sockReject=n)})}_waitApproveKeyAsync(){return new Promise((e,t)=>{this._approveServerResolve=e,this._approveServerReject=t})}_waitCredentialsAsync(e){let t=()=>e===1&&this._getCredentials().username!==void 0&&this._getCredentials().password!==void 0||e===2&&this._getCredentials().password!==void 0;return new Promise((e,n)=>{t()?e():(this._checkCredentials=()=>{t()&&(e(),this._checkCredentials=null,this._credentialsReject=null)},this._credentialsReject=n)})}checkInternalEvents(){this._checkSock!==null&&this._checkSock(),this._checkCredentials!==null&&this._checkCredentials()}approveServer(){this._approveServerResolve!==null&&(this._approveServerResolve(),this._approveServerResolve=null)}disconnect(){this._sockReject!==null&&(this._sockReject(Error(`disconnect normally`)),this._sockReject=null),this._credentialsReject!==null&&(this._credentialsReject(Error(`disconnect normally`)),this._credentialsReject=null),this._approveServerReject!==null&&(this._approveServerReject(Error(`disconnect normally`)),this._approveServerReject=null)}async negotiateRA2neAuthAsync(){this._hasStarted=!0,await this._waitSockAsync(4);let e=this._sock.rQpeekBytes(4),t=this._sock.rQshift32();if(t<1024)throw Error(`RA2: server public key is too short: `+t);if(t>8192)throw Error(`RA2: server public key is too long: `+t);let n=Math.ceil(t/8);await this._waitSockAsync(n*2);let r=this._sock.rQshiftBytes(n),i=this._sock.rQshiftBytes(n),a=await Q.importKey(`raw`,{n:r,e:i},{name:`RSA-PKCS1-v1_5`},!1,[`encrypt`]),o=new Uint8Array(4+n*2);o.set(e),o.set(r,4),o.set(i,4+n);let s=this._waitApproveKeyAsync();this.dispatchEvent(new CustomEvent(`serververification`,{detail:{type:`RSA`,publickey:o}})),await s;let c=(await Q.generateKey({name:`RSA-PKCS1-v1_5`,modulusLength:2048,publicExponent:new Uint8Array([1,0,1])},!0,[`encrypt`])).privateKey,l=await Q.exportKey(`raw`,c),d=l.n,f=l.e,p=new Uint8Array(516);p[0]=0,p[1]=0,p[2]=8,p[3]=0,p.set(d,4),p.set(f,260),this._sock.sQpushBytes(p),this._sock.flush();let m=new Uint8Array(16);window.crypto.getRandomValues(m);let h=await Q.encrypt({name:`RSA-PKCS1-v1_5`},a,m),g=new Uint8Array(2+n);if(g[0]=(n&65280)>>>8,g[1]=n&255,g.set(h,2),this._sock.sQpushBytes(g),this._sock.flush(),await this._waitSockAsync(2),this._sock.rQshift16()!==256)throw Error(`RA2: wrong encrypted message length`);let _=this._sock.rQshiftBytes(256),v=await Q.decrypt({name:`RSA-PKCS1-v1_5`},c,_);if(v===null||v.length!==16)throw Error(`RA2: corrupted server encrypted random`);let y=new Uint8Array(32),b=new Uint8Array(32);y.set(v),y.set(m,16),b.set(m),b.set(v,16),y=await window.crypto.subtle.digest(`SHA-1`,y),y=new Uint8Array(y).slice(0,16),b=await window.crypto.subtle.digest(`SHA-1`,b),b=new Uint8Array(b).slice(0,16);let x=new hi;await x.setKey(y);let S=new hi;await S.setKey(b);let C=new Uint8Array(8+n*2+512),w=new Uint8Array(8+n*2+512);if(C.set(o),C.set(p,4+n*2),w.set(p),w.set(o,516),C=await window.crypto.subtle.digest(`SHA-1`,C),w=await window.crypto.subtle.digest(`SHA-1`,w),C=new Uint8Array(C),w=new Uint8Array(w),this._sock.sQpushBytes(await x.makeMessage(w)),this._sock.flush(),await this._waitSockAsync(38),this._sock.rQshift16()!==20)throw Error(`RA2: wrong server hash`);let T=await S.receiveMessage(20,this._sock.rQshiftBytes(36));if(T===null)throw Error(`RA2: failed to authenticate the message`);for(let e=0;e<20;e++)if(T[e]!==C[e])throw Error(`RA2: wrong server hash`);if(await this._waitSockAsync(19),this._sock.rQshift16()!==1)throw Error(`RA2: wrong subtype`);let E=await S.receiveMessage(1,this._sock.rQshiftBytes(17));if(E===null)throw Error(`RA2: failed to authenticate the message`);E=E[0];let D=this._waitCredentialsAsync(E);if(E===1)(this._getCredentials().username===void 0||this._getCredentials().password===void 0)&&this.dispatchEvent(new CustomEvent(`credentialsrequired`,{detail:{types:[`username`,`password`]}}));else if(E===2)this._getCredentials().password===void 0&&this.dispatchEvent(new CustomEvent(`credentialsrequired`,{detail:{types:[`password`]}}));else throw Error(`RA2: wrong subtype`);await D;let O;O=E===1?u(this._getCredentials().username).slice(0,255):``;let ee=u(this._getCredentials().password).slice(0,255),te=new Uint8Array(O.length+ee.length+2);te[0]=O.length,te[O.length+1]=ee.length;for(let e=0;e<O.length;e++)te[e+1]=O.charCodeAt(e);for(let e=0;e<ee.length;e++)te[O.length+2+e]=ee.charCodeAt(e);this._sock.sQpushBytes(await x.makeMessage(te)),this._sock.flush()}get hasStarted(){return this._hasStarted}set hasStarted(e){this._hasStarted=e}},_i=class{constructor(){this._lines=0}decodeRect(e,t,n,r,i,a,o){if(n===0||r===0)return!0;this._lines===0&&(this._lines=r);let s=n*(o==8?1:4);for(;this._lines>0;){if(i.rQwait(`RAW`,s))return!1;let c=t+(r-this._lines),l=i.rQshiftBytes(s,!1);if(o==8){let e=new Uint8Array(n*4);for(let t=0;t<n;t++)e[t*4+0]=(l[t]>>0&3)*255/3,e[t*4+1]=(l[t]>>2&3)*255/3,e[t*4+2]=(l[t]>>4&3)*255/3,e[t*4+3]=255;l=e}for(let e=0;e<n;e++)l[e*4+3]=255;a.blitImage(e,c,n,1,l,0),this._lines--}return!0}},vi=class{decodeRect(e,t,n,r,i,a,o){if(i.rQwait(`COPYRECT`,4))return!1;let s=i.rQshift16(),c=i.rQshift16();return n===0||r===0||a.copyImage(s,c,e,t,n,r),!0}},yi=class{constructor(){this._subrects=0}decodeRect(e,t,n,r,i,a,o){if(this._subrects===0){if(i.rQwait(`RRE`,8))return!1;this._subrects=i.rQshift32();let o=i.rQshiftBytes(4);a.fillRect(e,t,n,r,o)}for(;this._subrects>0;){if(i.rQwait(`RRE`,12))return!1;let n=i.rQshiftBytes(4),r=i.rQshift16(),o=i.rQshift16(),s=i.rQshift16(),c=i.rQshift16();a.fillRect(e+r,t+o,s,c,n),this._subrects--}return!0}},bi=class{constructor(){this._tiles=0,this._lastsubencoding=0,this._tileBuffer=new Uint8Array(1024)}decodeRect(e,t,n,r,a,o,s){for(this._tiles===0&&(this._tilesX=Math.ceil(n/16),this._tilesY=Math.ceil(r/16),this._totalTiles=this._tilesX*this._tilesY,this._tiles=this._totalTiles);this._tiles>0;){let s=1;if(a.rQwait(`HEXTILE`,s))return!1;let c=a.rQpeek8();if(c>30)throw Error(`Illegal hextile subencoding (subencoding: `+c+`)`);let l=this._totalTiles-this._tiles,u=l%this._tilesX,d=Math.floor(l/this._tilesX),f=e+u*16,p=t+d*16,m=Math.min(16,e+n-f),h=Math.min(16,t+r-p);if(c&1)s+=m*h*4;else if(c&2&&(s+=4),c&4&&(s+=4),c&8){if(s++,a.rQwait(`HEXTILE`,s))return!1;let e=a.rQpeekBytes(s).at(-1);c&16?s+=e*6:s+=e*2}if(a.rQwait(`HEXTILE`,s))return!1;if(a.rQshift8(),c===0)this._lastsubencoding&1?i(`     Ignoring blank after RAW`):o.fillRect(f,p,m,h,this._background);else if(c&1){let e=m*h,t=a.rQshiftBytes(e*4,!1);for(let n=0;n<e;n++)t[n*4+3]=255;o.blitImage(f,p,m,h,t,0)}else{if(c&2&&(this._background=new Uint8Array(a.rQshiftBytes(4))),c&4&&(this._foreground=new Uint8Array(a.rQshiftBytes(4))),this._startTile(f,p,m,h,this._background),c&8){let e=a.rQshift8();for(let t=0;t<e;t++){let e;e=c&16?a.rQshiftBytes(4):this._foreground;let t=a.rQshift8(),n=t>>4,r=t&15,i=a.rQshift8(),o=(i>>4)+1,s=(i&15)+1;this._subTile(n,r,o,s,e)}}this._finishTile(o)}this._lastsubencoding=c,this._tiles--}return!0}_startTile(e,t,n,r,i){this._tileX=e,this._tileY=t,this._tileW=n,this._tileH=r;let a=i[0],o=i[1],s=i[2],c=this._tileBuffer;for(let e=0;e<n*r*4;e+=4)c[e]=a,c[e+1]=o,c[e+2]=s,c[e+3]=255}_subTile(e,t,n,r,i){let a=i[0],o=i[1],s=i[2],c=e+n,l=t+r,u=this._tileBuffer,d=this._tileW;for(let n=t;n<l;n++)for(let t=e;t<c;t++){let e=(t+n*d)*4;u[e]=a,u[e+1]=o,u[e+2]=s,u[e+3]=255}}_finishTile(e){e.blitImage(this._tileX,this._tileY,this._tileW,this._tileH,this._tileBuffer,0)}},xi=class{constructor(){this._zlib=new _t,this._length=0}decodeRect(e,t,n,r,i,a,o){if(n===0||r===0)return!0;if(this._length===0){if(i.rQwait(`ZLIB`,4))return!1;this._length=i.rQshift32()}if(i.rQwait(`ZLIB`,this._length))return!1;let s=new Uint8Array(i.rQshiftBytes(this._length,!1));this._length=0,this._zlib.setInput(s),s=this._zlib.inflate(n*r*4),this._zlib.setInput(null);for(let e=0;e<n*r;e++)s[e*4+3]=255;return a.blitImage(e,t,n,r,s,0),!0}},Si=class{constructor(){this._ctl=null,this._filter=null,this._numColors=0,this._palette=new Uint8Array(1024),this._len=0,this._zlibs=[];for(let e=0;e<4;e++)this._zlibs[e]=new _t}decodeRect(e,t,n,r,i,o,s){if(this._ctl===null){if(i.rQwait(`TIGHT compression-control`,1))return!1;this._ctl=i.rQshift8();for(let e=0;e<4;e++)this._ctl>>e&1&&(this._zlibs[e].reset(),a(`Reset zlib stream `+e));this._ctl>>=4}let c;if(this._ctl===8)c=this._fillRect(e,t,n,r,i,o,s);else if(this._ctl===9)c=this._jpegRect(e,t,n,r,i,o,s);else if(this._ctl===10)c=this._pngRect(e,t,n,r,i,o,s);else if(!(this._ctl&8))c=this._basicRect(this._ctl,e,t,n,r,i,o,s);else throw Error(`Illegal tight compression received (ctl: `+this._ctl+`)`);return c&&(this._ctl=null),c}_fillRect(e,t,n,r,i,a,o){if(i.rQwait(`TIGHT`,3))return!1;let s=i.rQshiftBytes(3);return a.fillRect(e,t,n,r,s,!1),!0}_jpegRect(e,t,n,r,i,a,o){let s=this._readData(i);return s!==null&&(a.imageRect(e,t,n,r,`image/jpeg`,s),!0)}_pngRect(e,t,n,r,i,a,o){throw Error(`PNG received in standard Tight rect`)}_basicRect(e,t,n,r,i,a,o,s){if(this._filter===null){if(e&4){if(a.rQwait(`TIGHT`,1))return!1;this._filter=a.rQshift8()}else this._filter=0}let c=e&3,l;switch(this._filter){case 0:l=this._copyFilter(c,t,n,r,i,a,o,s);break;case 1:l=this._paletteFilter(c,t,n,r,i,a,o,s);break;case 2:l=this._gradientFilter(c,t,n,r,i,a,o,s);break;default:throw Error(`Illegal tight filter received (ctl: `+this._filter+`)`)}return l&&(this._filter=null),l}_copyFilter(e,t,n,r,i,a,o,s){let c=r*i*3,l;if(c===0)return!0;if(c<12){if(a.rQwait(`TIGHT`,c))return!1;l=a.rQshiftBytes(c)}else{if(l=this._readData(a),l===null)return!1;this._zlibs[e].setInput(l),l=this._zlibs[e].inflate(c),this._zlibs[e].setInput(null)}let u=new Uint8Array(r*i*4);for(let e=0,t=0;e<r*i*4;e+=4,t+=3)u[e]=l[t],u[e+1]=l[t+1],u[e+2]=l[t+2],u[e+3]=255;return o.blitImage(t,n,r,i,u,0,!1),!0}_paletteFilter(e,t,n,r,i,a,o,s){if(this._numColors===0){if(a.rQwait(`TIGHT palette`,1))return!1;let e=a.rQpeek8()+1,t=e*3;if(a.rQwait(`TIGHT palette`,1+t))return!1;this._numColors=e,a.rQskipBytes(1),a.rQshiftTo(this._palette,t)}let c=this._numColors<=2?1:8,l=Math.floor((r*c+7)/8)*i,u;if(l===0)return!0;if(l<12){if(a.rQwait(`TIGHT`,l))return!1;u=a.rQshiftBytes(l)}else{if(u=this._readData(a),u===null)return!1;this._zlibs[e].setInput(u),u=this._zlibs[e].inflate(l),this._zlibs[e].setInput(null)}return this._numColors==2?this._monoRect(t,n,r,i,u,this._palette,o):this._paletteRect(t,n,r,i,u,this._palette,o),this._numColors=0,!0}_monoRect(e,t,n,r,i,a,o){let s=this._getScratchBuffer(n*r*4),c=Math.floor((n+7)/8),l=Math.floor(n/8);for(let e=0;e<r;e++){let t,r,o=0;for(;o<l;o++)for(let l=7;l>=0;l--)t=(e*n+o*8+7-l)*4,r=(i[e*c+o]>>l&1)*3,s[t]=a[r],s[t+1]=a[r+1],s[t+2]=a[r+2],s[t+3]=255;for(let l=7;l>=8-n%8;l--)t=(e*n+o*8+7-l)*4,r=(i[e*c+o]>>l&1)*3,s[t]=a[r],s[t+1]=a[r+1],s[t+2]=a[r+2],s[t+3]=255}o.blitImage(e,t,n,r,s,0,!1)}_paletteRect(e,t,n,r,i,a,o){let s=this._getScratchBuffer(n*r*4),c=n*r*4;for(let e=0,t=0;e<c;e+=4,t++){let n=i[t]*3;s[e]=a[n],s[e+1]=a[n+1],s[e+2]=a[n+2],s[e+3]=255}o.blitImage(e,t,n,r,s,0,!1)}_gradientFilter(e,t,n,r,i,a,o,s){let c=r*i*3,l;if(c===0)return!0;if(c<12){if(a.rQwait(`TIGHT`,c))return!1;l=a.rQshiftBytes(c)}else{if(l=this._readData(a),l===null)return!1;this._zlibs[e].setInput(l),l=this._zlibs[e].inflate(c),this._zlibs[e].setInput(null)}let u=new Uint8Array(4*r*i),d=0,f=0,p=new Uint8Array(3);for(let e=0;e<r;e++){for(let e=0;e<3;e++){let t=p[e],n=l[f++]+t;u[d++]=n,p[e]=n}u[d++]=255}let m=0,h=new Uint8Array(3),g=new Uint8Array(3);for(let e=1;e<i;e++){p.fill(0),g.fill(0);for(let e=0;e<r;e++){for(let e=0;e<3;e++){h[e]=u[m++];let t=p[e]+h[e]-g[e];t<0?t=0:t>255&&(t=255);let n=l[f++]+t;u[d++]=n,g[e]=h[e],p[e]=n}u[d++]=255,m++}}return o.blitImage(t,n,r,i,u,0,!1),!0}_readData(e){if(this._len===0){if(e.rQwait(`TIGHT`,3))return null;let t;t=e.rQshift8(),this._len=t&127,t&128&&(t=e.rQshift8(),this._len|=(t&127)<<7,t&128&&(t=e.rQshift8(),this._len|=t<<14))}if(e.rQwait(`TIGHT`,this._len))return null;let t=e.rQshiftBytes(this._len,!1);return this._len=0,t}_getScratchBuffer(e){return(!this._scratchBuffer||this._scratchBuffer.length<e)&&(this._scratchBuffer=new Uint8Array(e)),this._scratchBuffer}},Ci=class extends Si{_pngRect(e,t,n,r,i,a,o){let s=this._readData(i);return s!==null&&(a.imageRect(e,t,n,r,`image/png`,s),!0)}_basicRect(e,t,n,r,i,a,o,s){throw Error(`BasicCompression received in TightPNG rect`)}},wi=class{constructor(){this._length=0,this._inflator=new _t,this._pixelBuffer=new Uint8Array(16384),this._tileBuffer=new Uint8Array(16384)}decodeRect(e,t,n,r,i,a,o){if(this._length===0){if(i.rQwait(`ZLib data length`,4))return!1;this._length=i.rQshift32()}if(i.rQwait(`Zlib data`,this._length))return!1;let s=i.rQshiftBytes(this._length,!1);this._inflator.setInput(s);for(let i=t;i<t+r;i+=64){let o=Math.min(64,t+r-i);for(let t=e;t<e+n;t+=64){let r=Math.min(64,e+n-t),s=r*o,c=this._inflator.inflate(1)[0];if(c===0){let e=this._readPixels(s);a.blitImage(t,i,r,o,e,0,!1)}else if(c===1){let e=this._readPixels(1);a.fillRect(t,i,r,o,[e[0],e[1],e[2]])}else if(c>=2&&c<=16){let e=this._decodePaletteTile(c,s,r,o);a.blitImage(t,i,r,o,e,0,!1)}else if(c===128){let e=this._decodeRLETile(s);a.blitImage(t,i,r,o,e,0,!1)}else if(c>=130&&c<=255){let e=this._decodeRLEPaletteTile(c-128,s);a.blitImage(t,i,r,o,e,0,!1)}else throw Error(`Unknown subencoding: `+c)}}return this._length=0,!0}_getBitsPerPixelInPalette(e){if(e<=2)return 1;if(e<=4)return 2;if(e<=16)return 4}_readPixels(e){let t=this._pixelBuffer,n=this._inflator.inflate(3*e);for(let r=0,i=0;r<e*4;r+=4,i+=3)t[r]=n[i],t[r+1]=n[i+1],t[r+2]=n[i+2],t[r+3]=255;return t}_decodePaletteTile(e,t,n,r){let i=this._tileBuffer,a=this._readPixels(e),o=this._getBitsPerPixelInPalette(e),s=(1<<o)-1,c=0,l=this._inflator.inflate(1)[0];for(let e=0;e<r;e++){let t=8-o;for(let e=0;e<n;e++){t<0&&(t=8-o,l=this._inflator.inflate(1)[0]);let e=l>>t&s;i[c]=a[e*4],i[c+1]=a[e*4+1],i[c+2]=a[e*4+2],i[c+3]=a[e*4+3],c+=4,t-=o}t<8-o&&e<r-1&&(l=this._inflator.inflate(1)[0])}return i}_decodeRLETile(e){let t=this._tileBuffer,n=0;for(;n<e;){let e=this._readPixels(1),r=this._readRLELength();for(let i=0;i<r;i++)t[n*4]=e[0],t[n*4+1]=e[1],t[n*4+2]=e[2],t[n*4+3]=e[3],n++}return t}_decodeRLEPaletteTile(e,t){let n=this._tileBuffer,r=this._readPixels(e),i=0;for(;i<t;){let a=this._inflator.inflate(1)[0],o=1;if(a>=128&&(a-=128,o=this._readRLELength()),a>e)throw Error(`Too big index in palette: `+a+`, palette size: `+e);if(i+o>t)throw Error(`Too big rle length in palette mode: `+o+`, allowed length is: `+(t-i));for(let e=0;e<o;e++)n[i*4]=r[a*4],n[i*4+1]=r[a*4+1],n[i*4+2]=r[a*4+2],n[i*4+3]=r[a*4+3],i++}return n}_readRLELength(){let e=0,t=0;do t=this._inflator.inflate(1)[0],e+=t;while(t===255);return e+1}},Ti=class{constructor(){this._cachedQuantTables=[],this._cachedHuffmanTables=[],this._segments=[]}decodeRect(e,t,n,r,i,a,o){for(;;){let e=this._readSegment(i);if(e===null)return!1;if(this._segments.push(e),e[1]===217)break}let s=[],c=[];for(let e of this._segments){let t=e[1];t===196?s.push(e):t===219&&c.push(e)}let l=this._segments.findIndex(e=>e[1]==192||e[1]==194);if(l==-1)throw Error(`Illegal JPEG image without SOF`);c.length===0&&this._segments.splice(l+1,0,...this._cachedQuantTables),s.length===0&&this._segments.splice(l+1,0,...this._cachedHuffmanTables);let u=0;for(let e of this._segments)u+=e.length;let d=new Uint8Array(u);u=0;for(let e of this._segments)d.set(e,u),u+=e.length;return a.imageRect(e,t,n,r,`image/jpeg`,d),s.length!==0&&(this._cachedHuffmanTables=s),c.length!==0&&(this._cachedQuantTables=c),this._segments=[],!0}_readSegment(e){if(e.rQwait(`JPEG`,2))return null;let t=e.rQshift8();if(t!=255)throw Error(`Illegal JPEG marker received (byte: `+t+`)`);let n=e.rQshift8();if(n>=208&&n<=217||n==1)return new Uint8Array([t,n]);if(e.rQwait(`JPEG`,2,2))return null;let r=e.rQshift16();if(r<2)throw Error(`Illegal JPEG length received (length: `+r+`)`);if(e.rQwait(`JPEG`,r-2,4))return null;let i=0;if(n===218){if(e.rQwait(`JPEG`,r-2+2,4))return null;let t=e.rQlen(),n=e.rQpeekBytes(t,!1);for(;;){let a=n.indexOf(255,r-2+i);if(a===-1||a===t-1)return e.rQwait(`JPEG`,1/0,4),null;if(n.at(a+1)===0||n.at(a+1)>=208&&n.at(a+1)<=215){i=a+2-(r-2);continue}i=a-(r-2);break}}let a=new Uint8Array(2+r+i);return a[0]=t,a[1]=n,a[2]=r>>8,a[3]=r,a.set(e.rQshiftBytes(r-2+i,!1),4),a}},Ei=class{constructor(e){this._data=e,this._index=0,this.profileIdc=null,this.constraintSet=null,this.levelIdc=null}_getStartSequenceLen(e){let t=this._data;return t[e+0]==0&&t[e+1]==0&&t[e+2]==0&&t[e+3]==1?4:t[e+0]==0&&t[e+1]==0&&t[e+2]==1?3:0}_indexOfNextNalUnit(e){let t=this._data;for(let n=e;n<t.length;++n)if(this._getStartSequenceLen(n)!=0)return n;return-1}_parseSps(e){this.profileIdc=this._data[e],this.constraintSet=this._data[e+1],this.levelIdc=this._data[e+2]}_parseNalUnit(e){let t=this._data[e];if(t&128)throw Error(`H264 parsing sanity check failed, forbidden zero bit is set`);let n=t&31;switch(n){case 1:return{slice:!0};case 5:return{slice:!0,key:!0};case 6:return{};case 7:return this._parseSps(e+1),{};case 8:return{};default:o(`Unhandled unit type: `,n)}return{}}parse(){let e=this._index,t=!1;for(;this._index<this._data.length;){let e=this._getStartSequenceLen(this._index);if(e==0)throw Error(`Invalid start sequence in bit stream`);let{slice:n,key:r}=this._parseNalUnit(this._index+e),i=this._indexOfNextNalUnit(this._index+e);if(this._index=i==-1?this._data.length:i,r&&(t=!0),n)break}return e===this._index?null:{frame:this._data.subarray(e,this._index),key:t}}},Di=class{constructor(e,t){this.lastUsed=0,this._width=e,this._height=t,this._profileIdc=null,this._constraintSet=null,this._levelIdc=null,this._decoder=null,this._pendingFrames=[]}_handleFrame(e){let t=this._pendingFrames.shift();if(t===void 0)throw Error(`Pending frame queue empty when receiving frame from decoder`);if(t.timestamp!=e.timestamp)throw Error(`Video frame timestamp mismatch. Expected `+e.timestamp+` but but got `+t.timestamp);t.frame=e,t.ready=!0,t.resolve(),t.keep||e.close()}_handleError(e){throw Error(`Failed to decode frame: `+e.message)}_configureDecoder(e,t,n){(this._decoder===null||this._decoder.state===`closed`)&&(this._decoder=new VideoDecoder({output:e=>this._handleFrame(e),error:e=>this._handleError(e)}));let r=`avc1.`+e.toString(16).padStart(2,`0`)+t.toString(16).padStart(2,`0`)+n.toString(16).padStart(2,`0`);this._decoder.configure({codec:r,codedWidth:this._width,codedHeight:this._height,optimizeForLatency:!0})}_preparePendingFrame(e){let t={timestamp:e,promise:null,resolve:null,frame:null,ready:!1,keep:!1};return t.promise=new Promise(e=>{t.resolve=e}),this._pendingFrames.push(t),t}decode(e){let t=new Ei(e),n=null,r=Math.round(window.performance.now()*1e3);for(;;){let e=t.parse();if(e===null)break;if(t.profileIdc!==null&&(self._profileIdc=t.profileIdc,self._constraintSet=t.constraintSet,self._levelIdc=t.levelIdc),this._decoder===null||this._decoder.state!==`configured`){if(!e.key){o(`Missing key frame. Can't decode until one arrives`);continue}if(self._profileIdc===null){o(`Cannot config decoder. Have not received SPS and PPS yet.`);continue}this._configureDecoder(self._profileIdc,self._constraintSet,self._levelIdc)}n=this._preparePendingFrame(r);let i=new EncodedVideoChunk({timestamp:r,type:e.key?`key`:`delta`,data:e.frame});try{this._decoder.decode(i)}catch(e){o(`Failed to decode:`,e)}}return n!==null&&(n.keep=!0),n}},Oi=class{constructor(){this._tick=0,this._contexts={}}_contextId(e,t,n,r){return[e,t,n,r].join(`,`)}_findOldestContextId(){let e=Number.MAX_VALUE,t;for(let[n,r]of Object.entries(this._contexts))r.lastUsed<e&&(e=r.lastUsed,t=n);return t}_createContext(e,t,n,r){if(Object.keys(this._contexts).length>=64){let e=this._findOldestContextId();delete this._contexts[e]}let i=new Di(n,r);return this._contexts[this._contextId(e,t,n,r)]=i,i}_getContext(e,t,n,r){let i=this._contexts[this._contextId(e,t,n,r)];return i===void 0?this._createContext(e,t,n,r):i}_resetContext(e,t,n,r){delete this._contexts[this._contextId(e,t,n,r)]}_resetAllContexts(){this._contexts={}}decodeRect(e,t,n,r,i,a,o){if(i.rQwait(`h264 header`,8))return!1;let s=i.rQshift32(),c=i.rQshift32();if(i.rQwait(`h264 payload`,s,8))return!1;c&2?this._resetAllContexts():c&1&&this._resetContext(e,t,n,r);let l=this._getContext(e,t,n,r);if(l.lastUsed=this._tick++,s!==0){let o=i.rQshiftBytes(s,!1),c=l.decode(o);c!==null&&a.videoFrame(e,t,n,r,c)}return!0}};let ki=1<<24,Ai=1<<25,ji=1<<26,Mi=1<<27,Ni=1<<28;var $=class e extends ee{constructor(t,n,r){if(!t)throw Error(`Must specify target`);if(!n)throw Error(`Must specify URL, WebSocket or RTCDataChannel`);window.isSecureContext||s(`noVNC requires a secure context (TLS). Expect crashes!`),super(),this._target=t,typeof n==`string`?this._url=n:(this._url=null,this._rawChannel=n),r||={},this._rfbCredentials=r.credentials||{},this._shared=`shared`in r?!!r.shared:!0,this._repeaterID=r.repeaterID||``,this._wsProtocols=r.wsProtocols||[],this._rfbConnectionState=``,this._rfbInitState=``,this._rfbAuthScheme=-1,this._rfbCleanDisconnect=!0,this._rfbRSAAESAuthenticationState=null,this._rfbVersion=0,this._rfbMaxVersion=3.8,this._rfbTightVNC=!1,this._rfbVeNCryptState=0,this._rfbXvpVer=0,this._fbWidth=0,this._fbHeight=0,this._fbName=``,this._capabilities={power:!1},this._supportsFence=!1,this._supportsContinuousUpdates=!1,this._enabledContinuousUpdates=!1,this._supportsSetDesktopSize=!1,this._screenID=0,this._screenFlags=0,this._pendingRemoteResize=!1,this._lastResize=0,this._qemuExtKeyEventSupported=!1,this._extendedPointerEventSupported=!1,this._clipboardText=null,this._clipboardServerCapabilitiesActions={},this._clipboardServerCapabilitiesFormats={},this._sock=null,this._display=null,this._flushing=!1,this._keyboard=null,this._gestures=null,this._resizeObserver=null,this._disconnTimer=null,this._resizeTimeout=null,this._mouseMoveTimer=null,this._decoders={},this._FBU={rects:0,x:0,y:0,width:0,height:0,encoding:null},this._mousePos={},this._mouseButtonMask=0,this._mouseLastMoveTime=0,this._viewportDragging=!1,this._viewportDragPos={},this._viewportHasMoved=!1,this._accumulatedWheelDeltaX=0,this._accumulatedWheelDeltaY=0,this._gestureLastTapTime=null,this._gestureFirstDoubleTapEv=null,this._gestureLastMagnitudeX=0,this._gestureLastMagnitudeY=0,this._eventHandlers={focusCanvas:this._focusCanvas.bind(this),handleResize:this._handleResize.bind(this),handleMouse:this._handleMouse.bind(this),handleWheel:this._handleWheel.bind(this),handleGesture:this._handleGesture.bind(this),handleRSAAESCredentialsRequired:this._handleRSAAESCredentialsRequired.bind(this),handleRSAAESServerVerification:this._handleRSAAESServerVerification.bind(this)},i(`>> RFB.constructor`),this._screen=document.createElement(`div`),this._screen.style.display=`flex`,this._screen.style.width=`100%`,this._screen.style.height=`100%`,this._screen.style.overflow=`auto`,this._screen.style.background=`rgb(40, 40, 40)`,this._canvas=document.createElement(`canvas`),this._canvas.style.margin=`auto`,this._canvas.style.outline=`none`,this._canvas.width=0,this._canvas.height=0,this._canvas.tabIndex=-1,this._screen.appendChild(this._canvas),this._cursor=new Nr,this._cursorImage=e.cursors.none,this._decoders[V.encodingRaw]=new _i,this._decoders[V.encodingCopyRect]=new vi,this._decoders[V.encodingRRE]=new yi,this._decoders[V.encodingHextile]=new bi,this._decoders[V.encodingZlib]=new xi,this._decoders[V.encodingTight]=new Si,this._decoders[V.encodingTightPNG]=new Ci,this._decoders[V.encodingZRLE]=new wi,this._decoders[V.encodingJPEG]=new Ti,this._decoders[V.encodingH264]=new Oi;try{this._display=new te(this._canvas)}catch(e){throw s(`Display exception: `+e),e}this._keyboard=new Ar(this._canvas),this._keyboard.onkeyevent=this._handleKeyEvent.bind(this),this._remoteCapsLock=null,this._remoteNumLock=null,this._gestures=new jr,this._sock=new Rr,this._sock.on(`open`,this._socketOpen.bind(this)),this._sock.on(`close`,this._socketClose.bind(this)),this._sock.on(`message`,this._handleMessage.bind(this)),this._sock.on(`error`,this._socketError.bind(this)),this._expectedClientWidth=null,this._expectedClientHeight=null,this._resizeObserver=new ResizeObserver(this._eventHandlers.handleResize),this._updateConnectionState(`connecting`),i(`<< RFB.constructor`),this.dragViewport=!1,this.focusOnClick=!0,this._viewOnly=!1,this._clipViewport=!1,this._clippingViewport=!1,this._scaleViewport=!1,this._resizeSession=!1,this._showDotCursor=!1,this._qualityLevel=6,this._compressionLevel=2}get viewOnly(){return this._viewOnly}set viewOnly(e){this._viewOnly=e,(this._rfbConnectionState===`connecting`||this._rfbConnectionState===`connected`)&&(e?this._keyboard.ungrab():this._keyboard.grab())}get capabilities(){return this._capabilities}get clippingViewport(){return this._clippingViewport}_setClippingViewport(e){e!==this._clippingViewport&&(this._clippingViewport=e,this.dispatchEvent(new CustomEvent(`clippingviewport`,{detail:this._clippingViewport})))}get touchButton(){return 0}set touchButton(e){o(`Using old API!`)}get clipViewport(){return this._clipViewport}set clipViewport(e){this._clipViewport=e,this._updateClip()}get scaleViewport(){return this._scaleViewport}set scaleViewport(e){this._scaleViewport=e,e&&this._clipViewport&&this._updateClip(),this._updateScale(),!e&&this._clipViewport&&this._updateClip()}get resizeSession(){return this._resizeSession}set resizeSession(e){this._resizeSession=e,e&&this._requestRemoteResize()}get showDotCursor(){return this._showDotCursor}set showDotCursor(e){this._showDotCursor=e,this._refreshCursor()}get background(){return this._screen.style.background}set background(e){this._screen.style.background=e}get qualityLevel(){return this._qualityLevel}set qualityLevel(e){if(!Number.isInteger(e)||e<0||e>9){s(`qualityLevel must be an integer between 0 and 9`);return}this._qualityLevel!==e&&(this._qualityLevel=e,this._rfbConnectionState===`connected`&&this._sendEncodings())}get compressionLevel(){return this._compressionLevel}set compressionLevel(e){if(!Number.isInteger(e)||e<0||e>9){s(`compressionLevel must be an integer between 0 and 9`);return}this._compressionLevel!==e&&(this._compressionLevel=e,this._rfbConnectionState===`connected`&&this._sendEncodings())}disconnect(){this._updateConnectionState(`disconnecting`),this._sock.off(`error`),this._sock.off(`message`),this._sock.off(`open`),this._rfbRSAAESAuthenticationState!==null&&this._rfbRSAAESAuthenticationState.disconnect()}approveServer(){this._rfbRSAAESAuthenticationState!==null&&this._rfbRSAAESAuthenticationState.approveServer()}sendCredentials(e){this._rfbCredentials=e,this._resumeAuthentication()}sendCtrlAltDel(){this._rfbConnectionState!==`connected`||this._viewOnly||(a(`Sending Ctrl-Alt-Del`),this.sendKey(R.XK_Control_L,`ControlLeft`,!0),this.sendKey(R.XK_Alt_L,`AltLeft`,!0),this.sendKey(R.XK_Delete,`Delete`,!0),this.sendKey(R.XK_Delete,`Delete`,!1),this.sendKey(R.XK_Alt_L,`AltLeft`,!1),this.sendKey(R.XK_Control_L,`ControlLeft`,!1))}machineShutdown(){this._xvpOp(1,2)}machineReboot(){this._xvpOp(1,3)}machineReset(){this._xvpOp(1,4)}sendKey(t,n,r){if(this._rfbConnectionState!==`connected`||this._viewOnly)return;if(r===void 0){this.sendKey(t,n,!0),this.sendKey(t,n,!1);return}let i=zr[n];if(this._qemuExtKeyEventSupported&&i)t||=0,a(`Sending key (`+(r?`down`:`up`)+`): keysym `+t+`, scancode `+i),e.messages.QEMUExtendedKeyEvent(this._sock,t,r,i);else{if(!t)return;a(`Sending keysym (`+(r?`down`:`up`)+`): `+t),e.messages.keyEvent(this._sock,t,+!!r)}}focus(e){this._canvas.focus(e)}blur(){this._canvas.blur()}clipboardPasteFrom(t){if(!(this._rfbConnectionState!==`connected`||this._viewOnly)){if(this._clipboardServerCapabilitiesFormats[1]&&this._clipboardServerCapabilitiesActions[Mi])this._clipboardText=t,e.messages.extendedClipboardNotify(this._sock,[1]);else{let n,r,i;n=0;for(let e of t)n++;i=new Uint8Array(n),r=0;for(let e of t){let t=e.codePointAt(0);t>255&&(t=63),i[r++]=t}e.messages.clientCutText(this._sock,i)}}}getImageData(){return this._display.getImageData()}toDataURL(e,t){return this._display.toDataURL(e,t)}toBlob(e,t,n){return this._display.toBlob(e,t,n)}_connect(){if(i(`>> RFB.connect`),this._url)a(`connecting to ${this._url}`),this._sock.open(this._url,this._wsProtocols);else{if(a(`attaching ${this._rawChannel} to Websock`),this._sock.attach(this._rawChannel),this._sock.readyState===`closed`)throw Error(`Cannot use already closed WebSocket/RTCDataChannel`);this._sock.readyState===`open`&&this._socketOpen()}this._target.appendChild(this._screen),this._gestures.attach(this._canvas),this._cursor.attach(this._canvas),this._refreshCursor(),this._resizeObserver.observe(this._screen),this._canvas.addEventListener(`mousedown`,this._eventHandlers.focusCanvas),this._canvas.addEventListener(`touchstart`,this._eventHandlers.focusCanvas),this._canvas.addEventListener(`mousedown`,this._eventHandlers.handleMouse),this._canvas.addEventListener(`mouseup`,this._eventHandlers.handleMouse),this._canvas.addEventListener(`mousemove`,this._eventHandlers.handleMouse),this._canvas.addEventListener(`click`,this._eventHandlers.handleMouse),this._canvas.addEventListener(`contextmenu`,this._eventHandlers.handleMouse),this._canvas.addEventListener(`wheel`,this._eventHandlers.handleWheel),this._canvas.addEventListener(`gesturestart`,this._eventHandlers.handleGesture),this._canvas.addEventListener(`gesturemove`,this._eventHandlers.handleGesture),this._canvas.addEventListener(`gestureend`,this._eventHandlers.handleGesture),i(`<< RFB.connect`)}_disconnect(){i(`>> RFB.disconnect`),this._cursor.detach(),this._canvas.removeEventListener(`gesturestart`,this._eventHandlers.handleGesture),this._canvas.removeEventListener(`gesturemove`,this._eventHandlers.handleGesture),this._canvas.removeEventListener(`gestureend`,this._eventHandlers.handleGesture),this._canvas.removeEventListener(`wheel`,this._eventHandlers.handleWheel),this._canvas.removeEventListener(`mousedown`,this._eventHandlers.handleMouse),this._canvas.removeEventListener(`mouseup`,this._eventHandlers.handleMouse),this._canvas.removeEventListener(`mousemove`,this._eventHandlers.handleMouse),this._canvas.removeEventListener(`click`,this._eventHandlers.handleMouse),this._canvas.removeEventListener(`contextmenu`,this._eventHandlers.handleMouse),this._canvas.removeEventListener(`mousedown`,this._eventHandlers.focusCanvas),this._canvas.removeEventListener(`touchstart`,this._eventHandlers.focusCanvas),this._resizeObserver.disconnect(),this._keyboard.ungrab(),this._gestures.detach(),this._sock.close();try{this._target.removeChild(this._screen)}catch(e){if(e.name!==`NotFoundError`)throw e}clearTimeout(this._resizeTimeout),clearTimeout(this._mouseMoveTimer),i(`<< RFB.disconnect`)}_socketOpen(){this._rfbConnectionState===`connecting`&&this._rfbInitState===``?(this._rfbInitState=`ProtocolVersion`,i(`Starting VNC handshake`)):this._fail(`Unexpected server connection while `+this._rfbConnectionState)}_socketClose(e){i(`WebSocket on-close event`);let t=``;switch(e.code&&(t=`(code: `+e.code,e.reason&&(t+=`, reason: `+e.reason),t+=`)`),this._rfbConnectionState){case`connecting`:this._fail(`Connection closed `+t);break;case`connected`:this._updateConnectionState(`disconnecting`),this._updateConnectionState(`disconnected`);break;case`disconnecting`:this._updateConnectionState(`disconnected`);break;case`disconnected`:this._fail(`Unexpected server disconnect when already disconnected `+t);break;default:this._fail(`Unexpected server disconnect before connecting `+t)}this._sock.off(`close`),this._rawChannel=null}_socketError(e){o(`WebSocket on-error event`)}_focusCanvas(e){this.focusOnClick&&this.focus({preventScroll:!0})}_setDesktopName(e){this._fbName=e,this.dispatchEvent(new CustomEvent(`desktopname`,{detail:{name:this._fbName}}))}_saveExpectedClientSize(){this._expectedClientWidth=this._screen.clientWidth,this._expectedClientHeight=this._screen.clientHeight}_currentClientSize(){return[this._screen.clientWidth,this._screen.clientHeight]}_clientHasExpectedSize(){let[e,t]=this._currentClientSize();return e==this._expectedClientWidth&&t==this._expectedClientHeight}_handleResize(){this._clientHasExpectedSize()||(window.requestAnimationFrame(()=>{this._updateClip(),this._updateScale(),this._saveExpectedClientSize()}),this._requestRemoteResize())}_updateClip(){let e=this._display.clipViewport,t=this._clipViewport;if(this._scaleViewport&&(t=!1),e!==t&&(this._display.clipViewport=t),t){let e=this._screenSize();this._display.viewportChangeSize(e.w,e.h),this._fixScrollbars(),this._setClippingViewport(e.w<this._display.width||e.h<this._display.height)}else this._setClippingViewport(!1);e!==t&&this._saveExpectedClientSize()}_updateScale(){if(!this._scaleViewport)this._display.scale=1;else{let e=this._screenSize();this._display.autoscale(e.w,e.h)}this._fixScrollbars()}_requestRemoteResize(){if(!this._resizeSession||this._viewOnly||!this._supportsSetDesktopSize||this._pendingRemoteResize)return;if(Date.now()-this._lastResize<100){clearTimeout(this._resizeTimeout),this._resizeTimeout=setTimeout(this._requestRemoteResize.bind(this),100-(Date.now()-this._lastResize));return}this._resizeTimeout=null;let t=this._screenSize();(t.w!==this._fbWidth||t.h!==this._fbHeight)&&(this._pendingRemoteResize=!0,this._lastResize=Date.now(),e.messages.setDesktopSize(this._sock,Math.floor(t.w),Math.floor(t.h),this._screenID,this._screenFlags),i(`Requested new desktop size: `+t.w+`x`+t.h))}_screenSize(){let e=this._screen.getBoundingClientRect();return{w:e.width,h:e.height}}_fixScrollbars(){let e=this._screen.style.overflow;this._screen.style.overflow=`hidden`,this._screen.getBoundingClientRect(),this._screen.style.overflow=e}_updateConnectionState(e){let t=this._rfbConnectionState;if(e===t){i(`Already in state '`+e+`', ignoring`);return}if(t===`disconnected`){s(`Tried changing state of a disconnected RFB object`);return}switch(e){case`connected`:if(t!==`connecting`){s(`Bad transition to connected state, previous connection state: `+t);return}break;case`disconnected`:if(t!==`disconnecting`){s(`Bad transition to disconnected state, previous connection state: `+t);return}break;case`connecting`:if(t!==``){s(`Bad transition to connecting state, previous connection state: `+t);return}break;case`disconnecting`:if(t!==`connected`&&t!==`connecting`){s(`Bad transition to disconnecting state, previous connection state: `+t);return}break;default:s(`Unknown connection state: `+e);return}switch(this._rfbConnectionState=e,i(`New state '`+e+`', was '`+t+`'.`),this._disconnTimer&&e!==`disconnecting`&&(i(`Clearing disconnect timer`),clearTimeout(this._disconnTimer),this._disconnTimer=null,this._sock.off(`close`)),e){case`connecting`:this._connect();break;case`connected`:this.dispatchEvent(new CustomEvent(`connect`,{detail:{}}));break;case`disconnecting`:this._disconnect(),this._disconnTimer=setTimeout(()=>{s(`Disconnection timed out.`),this._updateConnectionState(`disconnected`)},3e3);break;case`disconnected`:this.dispatchEvent(new CustomEvent(`disconnect`,{detail:{clean:this._rfbCleanDisconnect}}))}}_fail(e){switch(this._rfbConnectionState){case`disconnecting`:s(`Failed when disconnecting: `+e);break;case`connected`:s(`Failed while connected: `+e);break;case`connecting`:s(`Failed when connecting: `+e);break;default:s(`RFB failure: `+e)}return this._rfbCleanDisconnect=!1,this._updateConnectionState(`disconnecting`),this._updateConnectionState(`disconnected`),!1}_setCapability(e,t){this._capabilities[e]=t,this.dispatchEvent(new CustomEvent(`capabilities`,{detail:{capabilities:this._capabilities}}))}_handleMessage(){if(this._sock.rQwait(`message`,1)){o(`handleMessage called on an empty receive queue`);return}switch(this._rfbConnectionState){case`disconnected`:s(`Got data while disconnected`);break;case`connected`:for(;!(this._flushing||!this._normalMsg()||this._sock.rQwait(`message`,1)););break;case`connecting`:for(;this._rfbConnectionState===`connecting`&&this._initMsg(););break;default:s(`Got data while in an invalid state`)}}_handleKeyEvent(e,t,n,r,a){t==`CapsLock`&&n&&(this._remoteCapsLock=null),this._remoteCapsLock!==null&&a!==null&&this._remoteCapsLock!==a&&n&&(i(`Fixing remote caps lock`),this.sendKey(R.XK_Caps_Lock,`CapsLock`,!0),this.sendKey(R.XK_Caps_Lock,`CapsLock`,!1),this._remoteCapsLock=null),t==`NumLock`&&n&&(this._remoteNumLock=null),this._remoteNumLock!==null&&r!==null&&this._remoteNumLock!==r&&n&&(i(`Fixing remote num lock`),this.sendKey(R.XK_Num_Lock,`NumLock`,!0),this.sendKey(R.XK_Num_Lock,`NumLock`,!1),this._remoteNumLock=null),this.sendKey(e,t,n)}static _convertButtonMask(e){let t={0:1,1:4,2:2,3:128,4:256},n=0;for(let r=0;r<5;r++)e&1<<r&&(n|=t[r]);return n}_handleMouse(t){if(t.type===`click`&&t.target!==this._canvas||(t.stopPropagation(),t.preventDefault(),t.type===`click`||t.type===`contextmenu`))return;let n=b(t.clientX,t.clientY,this._canvas),r=e._convertButtonMask(t.buttons),i=t.type==`mousedown`;switch(t.type){case`mousedown`:case`mouseup`:if(this.dragViewport){if(i&&!this._viewportDragging){this._viewportDragging=!0,this._viewportDragPos={x:n.x,y:n.y},this._viewportHasMoved=!1,this._flushMouseMoveTimer(n.x,n.y),this._mouseButtonMask=r;break}if(this._viewportDragging=!1,this._viewportHasMoved){this._mouseButtonMask=r;break}this._sendMouse(n.x,n.y,this._mouseButtonMask)}i&&D(this._canvas),this._handleMouseButton(n.x,n.y,r);break;case`mousemove`:if(this._viewportDragging){let e=this._viewportDragPos.x-n.x,t=this._viewportDragPos.y-n.y;(this._viewportHasMoved||Math.abs(e)>p||Math.abs(t)>p)&&(this._viewportHasMoved=!0,this._viewportDragPos={x:n.x,y:n.y},this._display.viewportChangePos(e,t));break}this._handleMouseMove(n.x,n.y)}}_handleMouseButton(e,t,n){this._flushMouseMoveTimer(e,t),this._mouseButtonMask=n,this._sendMouse(e,t,this._mouseButtonMask)}_handleMouseMove(e,t){if(this._mousePos={x:e,y:t},this._mouseMoveTimer==null){let n=Date.now()-this._mouseLastMoveTime;n>17?(this._sendMouse(e,t,this._mouseButtonMask),this._mouseLastMoveTime=Date.now()):this._mouseMoveTimer=setTimeout(()=>{this._handleDelayedMouseMove()},17-n)}}_handleDelayedMouseMove(){this._mouseMoveTimer=null,this._sendMouse(this._mousePos.x,this._mousePos.y,this._mouseButtonMask),this._mouseLastMoveTime=Date.now()}_sendMouse(t,n,r){if(this._rfbConnectionState!==`connected`||this._viewOnly)return;if(r&32768)throw Error(`Illegal mouse button mask (mask: `+r+`)`);let i=r&32640;this._extendedPointerEventSupported&&i?e.messages.extendedPointerEvent(this._sock,this._display.absX(t),this._display.absY(n),r):e.messages.pointerEvent(this._sock,this._display.absX(t),this._display.absY(n),r)}_handleWheel(t){if(this._rfbConnectionState!==`connected`||this._viewOnly)return;t.stopPropagation(),t.preventDefault();let n=b(t.clientX,t.clientY,this._canvas),r=e._convertButtonMask(t.buttons),i=t.deltaX,a=t.deltaY;t.deltaMode!==0&&(i*=19,a*=19),this._accumulatedWheelDeltaX+=i,this._accumulatedWheelDeltaY+=a,Math.abs(this._accumulatedWheelDeltaX)>=50&&(this._accumulatedWheelDeltaX<0?(this._handleMouseButton(n.x,n.y,r|32),this._handleMouseButton(n.x,n.y,r)):this._accumulatedWheelDeltaX>0&&(this._handleMouseButton(n.x,n.y,r|64),this._handleMouseButton(n.x,n.y,r)),this._accumulatedWheelDeltaX=0),Math.abs(this._accumulatedWheelDeltaY)>=50&&(this._accumulatedWheelDeltaY<0?(this._handleMouseButton(n.x,n.y,r|8),this._handleMouseButton(n.x,n.y,r)):this._accumulatedWheelDeltaY>0&&(this._handleMouseButton(n.x,n.y,r|16),this._handleMouseButton(n.x,n.y,r)),this._accumulatedWheelDeltaY=0)}_fakeMouseMove(e,t,n){this._handleMouseMove(t,n),this._cursor.move(e.detail.clientX,e.detail.clientY)}_handleTapEvent(e,t){let n=b(e.detail.clientX,e.detail.clientY,this._canvas);if(this._gestureLastTapTime!==null&&Date.now()-this._gestureLastTapTime<1e3&&this._gestureFirstDoubleTapEv.detail.type===e.detail.type){let t=this._gestureFirstDoubleTapEv.detail.clientX-e.detail.clientX,r=this._gestureFirstDoubleTapEv.detail.clientY-e.detail.clientY;Math.hypot(t,r)<50?n=b(this._gestureFirstDoubleTapEv.detail.clientX,this._gestureFirstDoubleTapEv.detail.clientY,this._canvas):this._gestureFirstDoubleTapEv=e}else this._gestureFirstDoubleTapEv=e;this._gestureLastTapTime=Date.now(),this._fakeMouseMove(this._gestureFirstDoubleTapEv,n.x,n.y),this._handleMouseButton(n.x,n.y,t),this._handleMouseButton(n.x,n.y,0)}_handleGesture(e){let t,n=b(e.detail.clientX,e.detail.clientY,this._canvas);switch(e.type){case`gesturestart`:switch(e.detail.type){case`onetap`:this._handleTapEvent(e,1);break;case`twotap`:this._handleTapEvent(e,4);break;case`threetap`:this._handleTapEvent(e,2);break;case`drag`:this.dragViewport?(this._viewportHasMoved=!1,this._viewportDragging=!0,this._viewportDragPos={x:n.x,y:n.y}):(this._fakeMouseMove(e,n.x,n.y),this._handleMouseButton(n.x,n.y,1));break;case`longpress`:this.dragViewport?(this._viewportHasMoved=!1,this._viewportDragPos={x:n.x,y:n.y}):(this._fakeMouseMove(e,n.x,n.y),this._handleMouseButton(n.x,n.y,4));break;case`twodrag`:this._gestureLastMagnitudeX=e.detail.magnitudeX,this._gestureLastMagnitudeY=e.detail.magnitudeY,this._fakeMouseMove(e,n.x,n.y);break;case`pinch`:this._gestureLastMagnitudeX=Math.hypot(e.detail.magnitudeX,e.detail.magnitudeY),this._fakeMouseMove(e,n.x,n.y)}break;case`gesturemove`:switch(e.detail.type){case`onetap`:case`twotap`:case`threetap`:break;case`drag`:case`longpress`:if(this.dragViewport){this._viewportDragging=!0;let e=this._viewportDragPos.x-n.x,t=this._viewportDragPos.y-n.y;(this._viewportHasMoved||Math.abs(e)>p||Math.abs(t)>p)&&(this._viewportHasMoved=!0,this._viewportDragPos={x:n.x,y:n.y},this._display.viewportChangePos(e,t))}else this._fakeMouseMove(e,n.x,n.y);break;case`twodrag`:for(this._fakeMouseMove(e,n.x,n.y);e.detail.magnitudeY-this._gestureLastMagnitudeY>50;)this._handleMouseButton(n.x,n.y,8),this._handleMouseButton(n.x,n.y,0),this._gestureLastMagnitudeY+=50;for(;e.detail.magnitudeY-this._gestureLastMagnitudeY<-50;)this._handleMouseButton(n.x,n.y,16),this._handleMouseButton(n.x,n.y,0),this._gestureLastMagnitudeY-=50;for(;e.detail.magnitudeX-this._gestureLastMagnitudeX>50;)this._handleMouseButton(n.x,n.y,32),this._handleMouseButton(n.x,n.y,0),this._gestureLastMagnitudeX+=50;for(;e.detail.magnitudeX-this._gestureLastMagnitudeX<-50;)this._handleMouseButton(n.x,n.y,64),this._handleMouseButton(n.x,n.y,0),this._gestureLastMagnitudeX-=50;break;case`pinch`:if(this._fakeMouseMove(e,n.x,n.y),t=Math.hypot(e.detail.magnitudeX,e.detail.magnitudeY),Math.abs(t-this._gestureLastMagnitudeX)>75){for(this._handleKeyEvent(R.XK_Control_L,`ControlLeft`,!0);t-this._gestureLastMagnitudeX>75;)this._handleMouseButton(n.x,n.y,8),this._handleMouseButton(n.x,n.y,0),this._gestureLastMagnitudeX+=75;for(;t-this._gestureLastMagnitudeX<-75;)this._handleMouseButton(n.x,n.y,16),this._handleMouseButton(n.x,n.y,0),this._gestureLastMagnitudeX-=75}this._handleKeyEvent(R.XK_Control_L,`ControlLeft`,!1)}break;case`gestureend`:switch(e.detail.type){case`onetap`:case`twotap`:case`threetap`:case`pinch`:case`twodrag`:break;case`drag`:this.dragViewport?this._viewportDragging=!1:(this._fakeMouseMove(e,n.x,n.y),this._handleMouseButton(n.x,n.y,0));break;case`longpress`:if(this._viewportHasMoved)break;this.dragViewport&&!this._viewportHasMoved?(this._fakeMouseMove(e,n.x,n.y),this._handleMouseButton(n.x,n.y,4),this._handleMouseButton(n.x,n.y,0),this._viewportDragging=!1):(this._fakeMouseMove(e,n.x,n.y),this._handleMouseButton(n.x,n.y,0))}}}_flushMouseMoveTimer(e,t){this._mouseMoveTimer!==null&&(clearTimeout(this._mouseMoveTimer),this._mouseMoveTimer=null,this._sendMouse(e,t,this._mouseButtonMask))}_negotiateProtocolVersion(){if(this._sock.rQwait(`version`,12))return!1;let e=this._sock.rQshiftStr(12).substr(4,7);a(`Server ProtocolVersion: `+e);let t=0;switch(e){case`000.000`:t=1;break;case`003.003`:case`003.006`:this._rfbVersion=3.3;break;case`003.007`:this._rfbVersion=3.7;break;case`003.008`:case`003.889`:case`004.000`:case`004.001`:case`005.000`:this._rfbVersion=3.8;break;default:return this._fail(`Invalid server version `+e)}if(t){let e=`ID:`+this._repeaterID;for(;e.length<250;)e+=`\0`;return this._sock.sQpushString(e),this._sock.flush(),!0}this._rfbVersion>this._rfbMaxVersion&&(this._rfbVersion=this._rfbMaxVersion);let n=`00`+parseInt(this._rfbVersion,10)+`.00`+this._rfbVersion*10%10;this._sock.sQpushString(`RFB `+n+`
`),this._sock.flush(),i(`Sent ProtocolVersion: `+n),this._rfbInitState=`Security`}_isSupportedSecurityType(e){return[1,2,6,16,19,22,30,113,256].includes(e)}_negotiateSecurity(){if(this._rfbVersion>=3.7){let e=this._sock.rQshift8();if(this._sock.rQwait(`security type`,e,1))return!1;if(e===0)return this._rfbInitState=`SecurityReason`,this._securityContext=`no security types`,this._securityStatus=1,!0;let t=this._sock.rQshiftBytes(e);i(`Server security types: `+t),this._rfbAuthScheme=-1;for(let e of t)if(this._isSupportedSecurityType(e)){this._rfbAuthScheme=e;break}if(this._rfbAuthScheme===-1)return this._fail(`Unsupported security types (types: `+t+`)`);this._sock.sQpush8(this._rfbAuthScheme),this._sock.flush()}else{if(this._sock.rQwait(`security scheme`,4))return!1;if(this._rfbAuthScheme=this._sock.rQshift32(),this._rfbAuthScheme==0)return this._rfbInitState=`SecurityReason`,this._securityContext=`authentication scheme`,this._securityStatus=1,!0}return this._rfbInitState=`Authentication`,i(`Authenticating using scheme: `+this._rfbAuthScheme),!0}_handleSecurityReason(){if(this._sock.rQwait(`reason length`,4))return!1;let e=this._sock.rQshift32(),t=``;if(e>0){if(this._sock.rQwait(`reason`,e,4))return!1;t=this._sock.rQshiftStr(e)}return t===``?(this.dispatchEvent(new CustomEvent(`securityfailure`,{detail:{status:this._securityStatus}})),this._fail(`Security negotiation failed on `+this._securityContext)):(this.dispatchEvent(new CustomEvent(`securityfailure`,{detail:{status:this._securityStatus,reason:t}})),this._fail(`Security negotiation failed on `+this._securityContext+` (reason: `+t+`)`))}_negotiateXvpAuth(){return this._rfbCredentials.username===void 0||this._rfbCredentials.password===void 0||this._rfbCredentials.target===void 0?(this.dispatchEvent(new CustomEvent(`credentialsrequired`,{detail:{types:[`username`,`password`,`target`]}})),!1):(this._sock.sQpush8(this._rfbCredentials.username.length),this._sock.sQpush8(this._rfbCredentials.target.length),this._sock.sQpushString(this._rfbCredentials.username),this._sock.sQpushString(this._rfbCredentials.target),this._sock.flush(),this._rfbAuthScheme=2,this._negotiateAuthentication())}_negotiateVeNCryptAuth(){if(this._rfbVeNCryptState==0){if(this._sock.rQwait(`vencrypt version`,2))return!1;let e=this._sock.rQshift8(),t=this._sock.rQshift8();if(e!=0||t!=2)return this._fail(`Unsupported VeNCrypt version `+e+`.`+t);this._sock.sQpush8(0),this._sock.sQpush8(2),this._sock.flush(),this._rfbVeNCryptState=1}if(this._rfbVeNCryptState==1){if(this._sock.rQwait(`vencrypt ack`,1))return!1;let e=this._sock.rQshift8();if(e!=0)return this._fail(`VeNCrypt failure `+e);this._rfbVeNCryptState=2}if(this._rfbVeNCryptState==2){if(this._sock.rQwait(`vencrypt subtypes length`,1))return!1;let e=this._sock.rQshift8();if(e<1)return this._fail(`VeNCrypt subtypes empty`);this._rfbVeNCryptSubtypesLength=e,this._rfbVeNCryptState=3}if(this._rfbVeNCryptState==3){if(this._sock.rQwait(`vencrypt subtypes`,4*this._rfbVeNCryptSubtypesLength))return!1;let e=[];for(let t=0;t<this._rfbVeNCryptSubtypesLength;t++)e.push(this._sock.rQshift32());this._rfbAuthScheme=-1;for(let t of e)if(t!==19&&this._isSupportedSecurityType(t)){this._rfbAuthScheme=t;break}return this._rfbAuthScheme===-1?this._fail(`Unsupported security types (types: `+e+`)`):(this._sock.sQpush32(this._rfbAuthScheme),this._sock.flush(),this._rfbVeNCryptState=4,!0)}}_negotiatePlainAuth(){if(this._rfbCredentials.username===void 0||this._rfbCredentials.password===void 0)return this.dispatchEvent(new CustomEvent(`credentialsrequired`,{detail:{types:[`username`,`password`]}})),!1;let e=u(this._rfbCredentials.username),t=u(this._rfbCredentials.password);return this._sock.sQpush32(e.length),this._sock.sQpush32(t.length),this._sock.sQpushString(e),this._sock.sQpushString(t),this._sock.flush(),this._rfbInitState=`SecurityResult`,!0}_negotiateStdVNCAuth(){if(this._sock.rQwait(`auth challenge`,16))return!1;if(this._rfbCredentials.password===void 0)return this.dispatchEvent(new CustomEvent(`credentialsrequired`,{detail:{types:[`password`]}})),!1;let t=Array.prototype.slice.call(this._sock.rQshiftBytes(16)),n=e.genDES(this._rfbCredentials.password,t);return this._sock.sQpushBytes(n),this._sock.flush(),this._rfbInitState=`SecurityResult`,!0}_negotiateARDAuth(){if(this._rfbCredentials.username===void 0||this._rfbCredentials.password===void 0)return this.dispatchEvent(new CustomEvent(`credentialsrequired`,{detail:{types:[`username`,`password`]}})),!1;if(this._rfbCredentials.ardPublicKey!=null&&this._rfbCredentials.ardCredentials!=null)return this._sock.sQpushBytes(this._rfbCredentials.ardCredentials),this._sock.sQpushBytes(this._rfbCredentials.ardPublicKey),this._sock.flush(),this._rfbCredentials.ardCredentials=null,this._rfbCredentials.ardPublicKey=null,this._rfbInitState=`SecurityResult`,!0;if(this._sock.rQwait(`read ard`,4))return!1;let e=this._sock.rQshiftBytes(2),t=this._sock.rQshift16();if(this._sock.rQwait(`read ard keylength`,t*2,4))return!1;let n=this._sock.rQshiftBytes(t),r=this._sock.rQshiftBytes(t),i=Q.generateKey({name:`DH`,g:e,p:n},!1,[`deriveBits`]);return this._negotiateARDAuthAsync(t,r,i),!1}async _negotiateARDAuthAsync(e,t,n){let r=Q.exportKey(`raw`,n.publicKey),i=Q.deriveBits({name:`DH`,public:t},n.privateKey,e*8),a=u(this._rfbCredentials.username).substring(0,63),o=u(this._rfbCredentials.password).substring(0,63),s=window.crypto.getRandomValues(new Uint8Array(128));for(let e=0;e<a.length;e++)s[e]=a.charCodeAt(e);s[a.length]=0;for(let e=0;e<o.length;e++)s[64+e]=o.charCodeAt(e);s[64+o.length]=0;let c=await Q.digest(`MD5`,i),l=await Q.importKey(`raw`,c,{name:`AES-ECB`},!1,[`encrypt`]),d=await Q.encrypt({name:`AES-ECB`},l,s);this._rfbCredentials.ardCredentials=d,this._rfbCredentials.ardPublicKey=r,this._resumeAuthentication()}_negotiateTightUnixAuth(){return this._rfbCredentials.username===void 0||this._rfbCredentials.password===void 0?(this.dispatchEvent(new CustomEvent(`credentialsrequired`,{detail:{types:[`username`,`password`]}})),!1):(this._sock.sQpush32(this._rfbCredentials.username.length),this._sock.sQpush32(this._rfbCredentials.password.length),this._sock.sQpushString(this._rfbCredentials.username),this._sock.sQpushString(this._rfbCredentials.password),this._sock.flush(),this._rfbInitState=`SecurityResult`,!0)}_negotiateTightTunnels(e){let t={0:{vendor:`TGHT`,signature:`NOTUNNEL`}},n={};for(let t=0;t<e;t++){let e=this._sock.rQshift32();n[e]={vendor:this._sock.rQshiftStr(4),signature:this._sock.rQshiftStr(8)}}return i(`Server Tight tunnel types: `+n),n[1]&&n[1].vendor===`SICR`&&n[1].signature===`SCHANNEL`&&(i(`Detected Siemens server. Assuming NOTUNNEL support.`),n[0]={vendor:`TGHT`,signature:`NOTUNNEL`}),n[0]?n[0].vendor!=t[0].vendor||n[0].signature!=t[0].signature?this._fail(`Client's tunnel type had the incorrect vendor or signature`):(i(`Selected tunnel type: `+t[0]),this._sock.sQpush32(0),this._sock.flush(),!1):this._fail(`Server wanted tunnels, but doesn't support the notunnel type`)}_negotiateTightAuth(){if(!this._rfbTightVNC){if(this._sock.rQwait(`num tunnels`,4))return!1;let e=this._sock.rQshift32();if(e>0&&this._sock.rQwait(`tunnel capabilities`,16*e,4))return!1;if(this._rfbTightVNC=!0,e>0)return this._negotiateTightTunnels(e),!1}if(this._sock.rQwait(`sub auth count`,4))return!1;let e=this._sock.rQshift32();if(e===0)return this._rfbInitState=`SecurityResult`,!0;if(this._sock.rQwait(`sub auth capabilities`,16*e,4))return!1;let t={STDVNOAUTH__:1,STDVVNCAUTH_:2,TGHTULGNAUTH:129},n=[];for(let t=0;t<e;t++){this._sock.rQshift32();let e=this._sock.rQshiftStr(12);n.push(e)}i(`Server Tight authentication types: `+n);for(let e in t)if(n.indexOf(e)!=-1)switch(this._sock.sQpush32(t[e]),this._sock.flush(),i(`Selected authentication type: `+e),e){case`STDVNOAUTH__`:return this._rfbInitState=`SecurityResult`,!0;case`STDVVNCAUTH_`:return this._rfbAuthScheme=2,!0;case`TGHTULGNAUTH`:return this._rfbAuthScheme=129,!0;default:return this._fail(`Unsupported tiny auth scheme (scheme: `+e+`)`)}return this._fail(`No supported sub-auth types!`)}_handleRSAAESCredentialsRequired(e){this.dispatchEvent(e)}_handleRSAAESServerVerification(e){this.dispatchEvent(e)}_negotiateRA2neAuth(){return this._rfbRSAAESAuthenticationState===null&&(this._rfbRSAAESAuthenticationState=new gi(this._sock,()=>this._rfbCredentials),this._rfbRSAAESAuthenticationState.addEventListener(`serververification`,this._eventHandlers.handleRSAAESServerVerification),this._rfbRSAAESAuthenticationState.addEventListener(`credentialsrequired`,this._eventHandlers.handleRSAAESCredentialsRequired)),this._rfbRSAAESAuthenticationState.checkInternalEvents(),this._rfbRSAAESAuthenticationState.hasStarted||this._rfbRSAAESAuthenticationState.negotiateRA2neAuthAsync().catch(e=>{e.message!==`disconnect normally`&&this._fail(e.message)}).then(()=>(this._rfbInitState=`SecurityResult`,!0)).finally(()=>{this._rfbRSAAESAuthenticationState.removeEventListener(`serververification`,this._eventHandlers.handleRSAAESServerVerification),this._rfbRSAAESAuthenticationState.removeEventListener(`credentialsrequired`,this._eventHandlers.handleRSAAESCredentialsRequired),this._rfbRSAAESAuthenticationState=null}),!1}_negotiateMSLogonIIAuth(){if(this._sock.rQwait(`mslogonii dh param`,24))return!1;if(this._rfbCredentials.username===void 0||this._rfbCredentials.password===void 0)return this.dispatchEvent(new CustomEvent(`credentialsrequired`,{detail:{types:[`username`,`password`]}})),!1;let e=this._sock.rQshiftBytes(8),t=this._sock.rQshiftBytes(8),n=this._sock.rQshiftBytes(8),r=Q.generateKey({name:`DH`,g:e,p:t},!0,[`deriveBits`]),i=Q.exportKey(`raw`,r.publicKey),a=Q.deriveBits({name:`DH`,public:n},r.privateKey,64),o=Q.importKey(`raw`,a,{name:`DES-CBC`},!1,[`encrypt`]),s=u(this._rfbCredentials.username).substring(0,255),c=u(this._rfbCredentials.password).substring(0,63),l=new Uint8Array(256),d=new Uint8Array(64);window.crypto.getRandomValues(l),window.crypto.getRandomValues(d);for(let e=0;e<s.length;e++)l[e]=s.charCodeAt(e);l[s.length]=0;for(let e=0;e<c.length;e++)d[e]=c.charCodeAt(e);return d[c.length]=0,l=Q.encrypt({name:`DES-CBC`,iv:a},o,l),d=Q.encrypt({name:`DES-CBC`,iv:a},o,d),this._sock.sQpushBytes(i),this._sock.sQpushBytes(l),this._sock.sQpushBytes(d),this._sock.flush(),this._rfbInitState=`SecurityResult`,!0}_negotiateAuthentication(){switch(this._rfbAuthScheme){case 1:return this._rfbInitState=this._rfbVersion>=3.8?`SecurityResult`:`ClientInitialisation`,!0;case 22:return this._negotiateXvpAuth();case 30:return this._negotiateARDAuth();case 2:return this._negotiateStdVNCAuth();case 16:return this._negotiateTightAuth();case 19:return this._negotiateVeNCryptAuth();case 256:return this._negotiatePlainAuth();case 129:return this._negotiateTightUnixAuth();case 6:return this._negotiateRA2neAuth();case 113:return this._negotiateMSLogonIIAuth();default:return this._fail(`Unsupported auth scheme (scheme: `+this._rfbAuthScheme+`)`)}}_handleSecurityResult(){if(this._sock.rQwait(`VNC auth response `,4))return!1;let e=this._sock.rQshift32();return e===0?(this._rfbInitState=`ClientInitialisation`,i(`Authentication OK`),!0):this._rfbVersion>=3.8?(this._rfbInitState=`SecurityReason`,this._securityContext=`security result`,this._securityStatus=e,!0):(this.dispatchEvent(new CustomEvent(`securityfailure`,{detail:{status:e}})),this._fail(`Security handshake failed`))}_negotiateServerInit(){if(this._sock.rQwait(`server initialization`,24))return!1;let t=this._sock.rQshift16(),n=this._sock.rQshift16(),r=this._sock.rQshift8(),i=this._sock.rQshift8(),s=this._sock.rQshift8(),c=this._sock.rQshift8(),u=this._sock.rQshift16(),d=this._sock.rQshift16(),f=this._sock.rQshift16(),p=this._sock.rQshift8(),m=this._sock.rQshift8(),h=this._sock.rQshift8();this._sock.rQskipBytes(3);let g=this._sock.rQshift32();if(this._sock.rQwait(`server init name`,g,24))return!1;let _=this._sock.rQshiftStr(g);if(_=l(_,!0),this._rfbTightVNC){if(this._sock.rQwait(`TightVNC extended server init header`,8,24+g))return!1;let e=this._sock.rQshift16(),t=this._sock.rQshift16(),n=this._sock.rQshift16();this._sock.rQskipBytes(2);let r=(e+t+n)*16;if(this._sock.rQwait(`TightVNC extended server init header`,r,32+g))return!1;this._sock.rQskipBytes(16*e),this._sock.rQskipBytes(16*t),this._sock.rQskipBytes(16*n)}return a(`Screen: `+t+`x`+n+`, bpp: `+r+`, depth: `+i+`, bigEndian: `+s+`, trueColor: `+c+`, redMax: `+u+`, greenMax: `+d+`, blueMax: `+f+`, redShift: `+p+`, greenShift: `+m+`, blueShift: `+h),this._setDesktopName(_),this._resize(t,n),this._viewOnly||this._keyboard.grab(),this._fbDepth=24,this._fbName===`Intel(r) AMT KVM`&&(o(`Intel AMT KVM only supports 8/16 bit depths. Using low color mode.`),this._fbDepth=8),e.messages.pixelFormat(this._sock,this._fbDepth,!0),this._sendEncodings(),e.messages.fbUpdateRequest(this._sock,!1,0,0,this._fbWidth,this._fbHeight),this._updateConnectionState(`connected`),!0}_sendEncodings(){let t=[];t.push(V.encodingCopyRect),this._fbDepth==24&&(g&&t.push(V.encodingH264),t.push(V.encodingTight),t.push(V.encodingTightPNG),t.push(V.encodingZRLE),t.push(V.encodingJPEG),t.push(V.encodingHextile),t.push(V.encodingRRE),t.push(V.encodingZlib)),t.push(V.encodingRaw),t.push(V.pseudoEncodingQualityLevel0+this._qualityLevel),t.push(V.pseudoEncodingCompressLevel0+this._compressionLevel),t.push(V.pseudoEncodingDesktopSize),t.push(V.pseudoEncodingLastRect),t.push(V.pseudoEncodingQEMUExtendedKeyEvent),t.push(V.pseudoEncodingQEMULedEvent),t.push(V.pseudoEncodingExtendedDesktopSize),t.push(V.pseudoEncodingXvp),t.push(V.pseudoEncodingFence),t.push(V.pseudoEncodingContinuousUpdates),t.push(V.pseudoEncodingDesktopName),t.push(V.pseudoEncodingExtendedClipboard),t.push(V.pseudoEncodingExtendedMouseButtons),this._fbDepth==24&&(t.push(V.pseudoEncodingVMwareCursor),t.push(V.pseudoEncodingCursor)),e.messages.clientEncodings(this._sock,t)}_initMsg(){switch(this._rfbInitState){case`ProtocolVersion`:return this._negotiateProtocolVersion();case`Security`:return this._negotiateSecurity();case`Authentication`:return this._negotiateAuthentication();case`SecurityResult`:return this._handleSecurityResult();case`SecurityReason`:return this._handleSecurityReason();case`ClientInitialisation`:return this._sock.sQpush8(+!!this._shared),this._sock.flush(),this._rfbInitState=`ServerInitialisation`,!0;case`ServerInitialisation`:return this._negotiateServerInit();default:return this._fail(`Unknown init state (state: `+this._rfbInitState+`)`)}}_resumeAuthentication(){setTimeout(this._initMsg.bind(this),0)}_handleSetColourMapMsg(){return i(`SetColorMapEntries`),this._fail(`Unexpected SetColorMapEntries message`)}_handleServerCutText(){if(i(`ServerCutText`),this._sock.rQwait(`ServerCutText header`,7,1))return!1;this._sock.rQskipBytes(3);let t=this._sock.rQshift32();if(t=n(t),this._sock.rQwait(`ServerCutText content`,Math.abs(t),8))return!1;if(t>=0){let e=this._sock.rQshiftStr(t);if(this._viewOnly)return!0;this.dispatchEvent(new CustomEvent(`clipboard`,{detail:{text:e}}))}else{t=Math.abs(t);let n=this._sock.rQshift32(),r=n&65535,i=n&4278190080;if(i&ki){this._clipboardServerCapabilitiesFormats={},this._clipboardServerCapabilitiesActions={};for(let e=0;e<=15;e++){let t=1<<e;r&t&&(this._clipboardServerCapabilitiesFormats[t]=!0,this._sock.rQshift32())}for(let e=24;e<=31;e++){let t=1<<e;this._clipboardServerCapabilitiesActions[t]=!!(i&t)}let t=[ki,Ai,ji,Mi,Ni];e.messages.extendedClipboardCaps(this._sock,t,{extendedClipboardFormatText:0})}else if(i===Ai){if(this._viewOnly)return!0;this._clipboardText!=null&&this._clipboardServerCapabilitiesActions[Ni]&&r&1&&e.messages.extendedClipboardProvide(this._sock,[1],[this._clipboardText])}else if(i===ji){if(this._viewOnly)return!0;this._clipboardServerCapabilitiesActions[Mi]&&(this._clipboardText==null?e.messages.extendedClipboardNotify(this._sock,[]):e.messages.extendedClipboardNotify(this._sock,[1]))}else if(i===Mi){if(this._viewOnly)return!0;this._clipboardServerCapabilitiesActions[Ai]&&r&1&&e.messages.extendedClipboardRequest(this._sock,[1])}else if(i===Ni){if(this._viewOnly||!(r&1))return!0;this._clipboardText=null;let e=this._sock.rQshiftBytes(t-4),n=new _t,i=null;n.setInput(e);for(let e=0;e<=15;e++){let t=1<<e;if(r&t){let e=0,r=n.inflate(4);e|=r[0]<<24,e|=r[1]<<16,e|=r[2]<<8,e|=r[3];let a=n.inflate(e);t===1&&(i=a)}}if(n.setInput(null),i!==null){let e=``;for(let t=0;t<i.length;t++)e+=String.fromCharCode(i[t]);i=e,i=l(i),i.length>0&&i.charAt(i.length-1)===`\0`&&(i=i.slice(0,-1)),i=i.replaceAll(`\r
`,`
`),this.dispatchEvent(new CustomEvent(`clipboard`,{detail:{text:i}}))}}else return this._fail(`Unexpected action in extended clipboard message: `+i)}return!0}_handleServerFenceMsg(){if(this._sock.rQwait(`ServerFence header`,8,1))return!1;this._sock.rQskipBytes(3);let t=this._sock.rQshift32(),n=this._sock.rQshift8();if(this._sock.rQwait(`ServerFence payload`,n,9))return!1;n>64&&(o(`Bad payload length (`+n+`) in fence response`),n=64);let r=this._sock.rQshiftStr(n);return this._supportsFence=!0,t&1<<31?(t&=3,e.messages.clientFence(this._sock,t,r),!0):this._fail(`Unexpected fence response`)}_handleXvpMsg(){if(this._sock.rQwait(`XVP version and message`,3,1))return!1;this._sock.rQskipBytes(1);let e=this._sock.rQshift8(),t=this._sock.rQshift8();switch(t){case 0:s(`XVP operation failed`);break;case 1:this._rfbXvpVer=e,a(`XVP extensions enabled (version `+this._rfbXvpVer+`)`),this._setCapability(`power`,!0);break;default:this._fail(`Illegal server XVP message (msg: `+t+`)`)}return!0}_normalMsg(){let t;t=this._FBU.rects>0?0:this._sock.rQshift8();let n,r;switch(t){case 0:return r=this._framebufferUpdate(),r&&!this._enabledContinuousUpdates&&e.messages.fbUpdateRequest(this._sock,!0,0,0,this._fbWidth,this._fbHeight),r;case 1:return this._handleSetColourMapMsg();case 2:return i(`Bell`),this.dispatchEvent(new CustomEvent(`bell`,{detail:{}})),!0;case 3:return this._handleServerCutText();case 150:return n=!this._supportsContinuousUpdates,this._supportsContinuousUpdates=!0,this._enabledContinuousUpdates=!1,n&&(this._enabledContinuousUpdates=!0,this._updateContinuousUpdates(),a(`Enabling continuous updates.`)),!0;case 248:return this._handleServerFenceMsg();case 250:return this._handleXvpMsg();default:return this._fail(`Unexpected server message (type `+t+`)`),i(`sock.rQpeekBytes(30): `+this._sock.rQpeekBytes(30)),!0}}_framebufferUpdate(){if(this._FBU.rects===0){if(this._sock.rQwait(`FBU header`,3,1))return!1;if(this._sock.rQskipBytes(1),this._FBU.rects=this._sock.rQshift16(),this._display.pending())return this._flushing=!0,this._display.flush().then(()=>{this._flushing=!1,this._sock.rQwait(`message`,1)||this._handleMessage()}),!1}for(;this._FBU.rects>0;){if(this._FBU.encoding===null){if(this._sock.rQwait(`rect header`,12))return!1;this._FBU.x=this._sock.rQshift16(),this._FBU.y=this._sock.rQshift16(),this._FBU.width=this._sock.rQshift16(),this._FBU.height=this._sock.rQshift16(),this._FBU.encoding=this._sock.rQshift32(),this._FBU.encoding>>=0}if(!this._handleRect())return!1;this._FBU.rects--,this._FBU.encoding=null}return this._display.flip(),!0}_handleRect(){switch(this._FBU.encoding){case V.pseudoEncodingLastRect:return this._FBU.rects=1,!0;case V.pseudoEncodingVMwareCursor:return this._handleVMwareCursor();case V.pseudoEncodingCursor:return this._handleCursor();case V.pseudoEncodingQEMUExtendedKeyEvent:return this._qemuExtKeyEventSupported=!0,!0;case V.pseudoEncodingDesktopName:return this._handleDesktopName();case V.pseudoEncodingDesktopSize:return this._resize(this._FBU.width,this._FBU.height),!0;case V.pseudoEncodingExtendedDesktopSize:return this._handleExtendedDesktopSize();case V.pseudoEncodingExtendedMouseButtons:return this._extendedPointerEventSupported=!0,!0;case V.pseudoEncodingQEMULedEvent:return this._handleLedEvent();default:return this._handleDataRect()}}_handleVMwareCursor(){let e=this._FBU.x,t=this._FBU.y,n=this._FBU.width,r=this._FBU.height;if(this._sock.rQwait(`VMware cursor encoding`,1))return!1;let i=this._sock.rQshift8();this._sock.rQshift8();let a;if(i==0){let e=-256;if(a=Array(n*r*4),this._sock.rQwait(`VMware cursor classic encoding`,n*r*4*2,2))return!1;let t=Array(n*r);for(let e=0;e<n*r;e++)t[e]=this._sock.rQshift32();let i=Array(n*r);for(let e=0;e<n*r;e++)i[e]=this._sock.rQshift32();for(let o=0;o<n*r;o++)if(t[o]==0){let e=i[o],t=e>>8&255,n=e>>16&255,r=e>>24&255;a[o*4]=t,a[o*4+1]=n,a[o*4+2]=r,a[o*4+3]=255}else(t[o]&e)==e?i[o]==0?(a[o*4]=0,a[o*4+1]=0,a[o*4+2]=0,a[o*4+3]=0):(i[o]&e,a[o*4]=0,a[o*4+1]=0,a[o*4+2]=0,a[o*4+3]=255):(a[o*4]=0,a[o*4+1]=0,a[o*4+2]=0,a[o*4+3]=255)}else if(i==1){if(this._sock.rQwait(`VMware cursor alpha encoding`,n*r*4,2))return!1;a=Array(n*r*4);for(let e=0;e<n*r;e++){let t=this._sock.rQshift32();a[e*4]=t>>24&255,a[e*4+1]=t>>16&255,a[e*4+2]=t>>8&255,a[e*4+3]=t&255}}else return o(`The given cursor type is not supported: `+i+` given.`),!1;return this._updateCursor(a,e,t,n,r),!0}_handleCursor(){let e=this._FBU.x,t=this._FBU.y,n=this._FBU.width,r=this._FBU.height,i=n*r*4,a=Math.ceil(n/8)*r,o=i+a;if(this._sock.rQwait(`cursor encoding`,o))return!1;let s=this._sock.rQshiftBytes(i),c=this._sock.rQshiftBytes(a),l=new Uint8Array(n*r*4),u=0;for(let e=0;e<r;e++)for(let t=0;t<n;t++){let r=c[e*Math.ceil(n/8)+Math.floor(t/8)]<<t%8&128?255:0;l[u]=s[u+2],l[u+1]=s[u+1],l[u+2]=s[u],l[u+3]=r,u+=4}return this._updateCursor(l,e,t,n,r),!0}_handleDesktopName(){if(this._sock.rQwait(`DesktopName`,4))return!1;let e=this._sock.rQshift32();if(this._sock.rQwait(`DesktopName`,e,4))return!1;let t=this._sock.rQshiftStr(e);return t=l(t,!0),this._setDesktopName(t),!0}_handleLedEvent(){if(this._sock.rQwait(`LED status`,1))return!1;let e=this._sock.rQshift8(),t=!!(e&2),n=!!(e&4);return this._remoteCapsLock=n,this._remoteNumLock=t,!0}_handleExtendedDesktopSize(){if(this._sock.rQwait(`ExtendedDesktopSize`,4))return!1;let e=this._sock.rQpeek8(),t=4+e*16;if(this._sock.rQwait(`ExtendedDesktopSize`,t))return!1;let n=!this._supportsSetDesktopSize;this._supportsSetDesktopSize=!0,this._sock.rQskipBytes(1),this._sock.rQskipBytes(3);for(let t=0;t<e;t+=1)t===0?(this._screenID=this._sock.rQshift32(),this._sock.rQskipBytes(2),this._sock.rQskipBytes(2),this._sock.rQskipBytes(2),this._sock.rQskipBytes(2),this._screenFlags=this._sock.rQshift32()):this._sock.rQskipBytes(16);if(this._FBU.x===1&&(this._pendingRemoteResize=!1),this._FBU.x===1&&this._FBU.y!==0){let e=``;switch(this._FBU.y){case 1:e=`Resize is administratively prohibited`;break;case 2:e=`Out of resources`;break;case 3:e=`Invalid screen layout`;break;default:e=`Unknown reason`}o(`Server did not accept the resize request: `+e)}else this._resize(this._FBU.width,this._FBU.height);return n&&this._requestRemoteResize(),this._FBU.x===1&&this._FBU.y===0&&this._requestRemoteResize(),!0}_handleDataRect(){let e=this._decoders[this._FBU.encoding];if(!e)return this._fail(`Unsupported encoding (encoding: `+this._FBU.encoding+`)`),!1;try{return e.decodeRect(this._FBU.x,this._FBU.y,this._FBU.width,this._FBU.height,this._sock,this._display,this._fbDepth)}catch(e){return this._fail(`Error decoding rect: `+e),!1}}_updateContinuousUpdates(){this._enabledContinuousUpdates&&e.messages.enableContinuousUpdates(this._sock,!0,0,0,this._fbWidth,this._fbHeight)}_resize(e,t){this._fbWidth=e,this._fbHeight=t,this._display.resize(this._fbWidth,this._fbHeight),this._updateClip(),this._updateScale(),this._updateContinuousUpdates(),this._saveExpectedClientSize()}_xvpOp(t,n){this._rfbXvpVer<t||(a(`Sending XVP operation `+n+` (version `+t+`)`),e.messages.xvpOp(this._sock,t,n))}_updateCursor(e,t,n,r,i){this._cursorImage={rgbaPixels:e,hotx:t,hoty:n,w:r,h:i},this._refreshCursor()}_shouldShowDotCursor(){if(!this._showDotCursor)return!1;for(let e=3;e<this._cursorImage.rgbaPixels.length;e+=4)if(this._cursorImage.rgbaPixels[e])return!1;return!0}_refreshCursor(){if(this._rfbConnectionState!==`connecting`&&this._rfbConnectionState!==`connected`)return;let t=this._shouldShowDotCursor()?e.cursors.dot:this._cursorImage;this._cursor.change(t.rgbaPixels,t.hotx,t.hoty,t.w,t.h)}static genDES(e,t){let n=e.split(``).map(e=>e.charCodeAt(0)),r=Q.importKey(`raw`,n,{name:`DES-ECB`},!1,[`encrypt`]);return Q.encrypt({name:`DES-ECB`},r,t)}};return $.messages={keyEvent(e,t,n){e.sQpush8(4),e.sQpush8(n),e.sQpush16(0),e.sQpush32(t),e.flush()},QEMUExtendedKeyEvent(e,t,n,r){function i(e){let t=r>>8,n=r&255;return t===224&&n<127?n|128:e}e.sQpush8(255),e.sQpush8(0),e.sQpush16(n),e.sQpush32(t);let a=i(r);e.sQpush32(a),e.flush()},pointerEvent(e,t,n,r){e.sQpush8(5),r&=127,e.sQpush8(r),e.sQpush16(t),e.sQpush16(n),e.flush()},extendedPointerEvent(e,t,n,r){e.sQpush8(5);let i=r>>7&255;if(i&252)throw Error(`Invalid mouse button mask: `+r);let a=r&127;a|=128,e.sQpush8(a),e.sQpush16(t),e.sQpush16(n),e.sQpush8(i),e.flush()},_buildExtendedClipboardFlags(e,t){let n=new Uint8Array(4),r=0,i=0;for(let t=0;t<e.length;t++)i|=e[t];for(let e=0;e<t.length;e++)r|=t[e];return n[0]=i>>24,n[1]=0,n[2]=0,n[3]=r,n},extendedClipboardProvide(e,t,n){let r=new br,i=[];for(let e=0;e<t.length;e++){if(t[e]!=1)throw Error(`Unsupported extended clipboard format for Provide message.`);n[e]=n[e].replace(/\r\n|\r|\n/gm,`\r
`);let r=u(n[e]+`\0`);i.push(r.length>>24&255,r.length>>16&255,r.length>>8&255,r.length&255);for(let e=0;e<r.length;e++)i.push(r.charCodeAt(e))}let a=r.deflate(new Uint8Array(i)),o=new Uint8Array(4+a.length);o.set($.messages._buildExtendedClipboardFlags([Ni],t)),o.set(a,4),$.messages.clientCutText(e,o,!0)},extendedClipboardNotify(e,t){let n=$.messages._buildExtendedClipboardFlags([Mi],t);$.messages.clientCutText(e,n,!0)},extendedClipboardRequest(e,t){let n=$.messages._buildExtendedClipboardFlags([Ai],t);$.messages.clientCutText(e,n,!0)},extendedClipboardCaps(e,t,n){let r=Object.keys(n),i=new Uint8Array(4+4*r.length);r.map(e=>parseInt(e)),r.sort((e,t)=>e-t),i.set($.messages._buildExtendedClipboardFlags(t,[]));let a=4;for(let e=0;e<r.length;e++)i[a]=n[r[e]]>>24,i[a+1]=n[r[e]]>>16,i[a+2]=n[r[e]]>>8,i[a+3]=n[r[e]]>>0,a+=4,i[3]|=1<<r[e];$.messages.clientCutText(e,i,!0)},clientCutText(e,n,r=!1){e.sQpush8(6),e.sQpush8(0),e.sQpush8(0),e.sQpush8(0);let i;i=r?t(-n.length):n.length,e.sQpush32(i),e.sQpushBytes(n),e.flush()},setDesktopSize(e,t,n,r,i){e.sQpush8(251),e.sQpush8(0),e.sQpush16(t),e.sQpush16(n),e.sQpush8(1),e.sQpush8(0),e.sQpush32(r),e.sQpush16(0),e.sQpush16(0),e.sQpush16(t),e.sQpush16(n),e.sQpush32(i),e.flush()},clientFence(e,t,n){e.sQpush8(248),e.sQpush8(0),e.sQpush8(0),e.sQpush8(0),e.sQpush32(t),e.sQpush8(n.length),e.sQpushString(n),e.flush()},enableContinuousUpdates(e,t,n,r,i,a){e.sQpush8(150),e.sQpush8(t),e.sQpush16(n),e.sQpush16(r),e.sQpush16(i),e.sQpush16(a),e.flush()},pixelFormat(e,t,n){let r;r=t>16?32:t>8?16:8;let i=Math.floor(t/3);e.sQpush8(0),e.sQpush8(0),e.sQpush8(0),e.sQpush8(0),e.sQpush8(r),e.sQpush8(t),e.sQpush8(0),e.sQpush8(+!!n),e.sQpush16((1<<i)-1),e.sQpush16((1<<i)-1),e.sQpush16((1<<i)-1),e.sQpush8(i*0),e.sQpush8(i*1),e.sQpush8(i*2),e.sQpush8(0),e.sQpush8(0),e.sQpush8(0),e.flush()},clientEncodings(e,t){e.sQpush8(2),e.sQpush8(0),e.sQpush16(t.length);for(let n=0;n<t.length;n++)e.sQpush32(t[n]);e.flush()},fbUpdateRequest(e,t,n,r,i,a){n===void 0&&(n=0),r===void 0&&(r=0),e.sQpush8(3),e.sQpush8(+!!t),e.sQpush16(n),e.sQpush16(r),e.sQpush16(i),e.sQpush16(a),e.flush()},xvpOp(e,t,n){e.sQpush8(250),e.sQpush8(0),e.sQpush8(t),e.sQpush8(n),e.flush()}},$.cursors={none:{rgbaPixels:new Uint8Array,w:0,h:0,hotx:0,hoty:0},dot:{rgbaPixels:new Uint8Array([255,255,255,255,0,0,0,255,255,255,255,255,0,0,0,255,0,0,0,0,0,0,0,255,255,255,255,255,0,0,0,255,255,255,255,255]),w:3,h:3,hotx:1,hoty:1}},e.RFB=$,e})({});
  })());
}
// ---------- end GENERATED novnc ----------
