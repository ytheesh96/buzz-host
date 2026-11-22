// Self-hosted remote agent type: creation forms, Settings tab, and agent type registration.
import {
  CONCURRENCY_OPTIONS,
  DEFAULT_CONCURRENCY,
  EMPTY,
  PROFILE_HINT,
  RUNTIMES,
  asConfig,
} from "./config.js";
import {
  ModelField,
  ProfileField,
  modelChoices,
  profileOptions,
  useModels,
  useProfiles,
} from "./ui.js";

export function createType({
  React,
  client,
  ctx,
  uiKit,
  invalidateCatalog,
  ActivityTab,
  OrchestratorSettings,
  hostedModels,
  hostedSessions,
}) {
  const { h, Row, Select, Area, Note, control } = uiKit;
  const runtimeOptions = RUNTIMES.map((r) => ({ value: r.id, label: r.title }));

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
      h(ui.Select, {
        label: "Parallel conversations",
        variant: "preference",
        value: String(draft.concurrency ?? DEFAULT_CONCURRENCY),
        disabled,
        groups: one(CONCURRENCY_OPTIONS),
        onValueChange: (v) => onChange({ ...draft, concurrency: Number(v) || DEFAULT_CONCURRENCY }),
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
      h(
        Row,
        { label: "Parallel conversations", hint: "How many chats or threads this agent can answer at once." },
        h(Select, {
          value: String(draft.concurrency ?? DEFAULT_CONCURRENCY),
          disabled,
          options: CONCURRENCY_OPTIONS,
          onChange: (v) => change({ concurrency: Number(v) || DEFAULT_CONCURRENCY }),
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
          setLoaded({
            runtime: s.runtime,
            model: s.model ?? "",
            profile: s.profile ?? "",
            concurrency: Number(s.concurrency) || DEFAULT_CONCURRENCY,
            instructions: i.instructions,
            status: s.status,
          }),
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
          h(ui.PreferenceRow, {
            title: "Sessions",
            subtitle: `One session per thread; Solo chats and DMs keep one. Runs up to ${loaded.concurrency} conversation${loaded.concurrency === 1 ? "" : "s"} in parallel.`,
          }),
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
        h(OrchestratorSettings, { ui, agent }),
        settingsContent,
      );
    }
    const runtimeChanged =
      draft.runtime !== loaded.runtime ||
      draft.model.trim() !== loaded.model ||
      draft.profile !== loaded.profile ||
      (draft.concurrency ?? DEFAULT_CONCURRENCY) !== loaded.concurrency;
    const instructionsChanged = draft.instructions !== loaded.instructions;
    const dirty = runtimeChanged || instructionsChanged;
    const save = () =>
      act("save", async () => {
        if (instructionsChanged)
          await client.call("instructions.set", { pubkey, instructions: draft.instructions, base: loaded.instructions });
        let status = loaded.status;
        if (runtimeChanged) {
          status = (
            await client.call("settings.set", {
              pubkey,
              runtime: draft.runtime,
              model: draft.model.trim(),
              profile: draft.profile,
              concurrency: draft.concurrency ?? DEFAULT_CONCURRENCY,
            })
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
          const value = {
            runtime: s.runtime,
            model: s.model ?? "",
            profile: s.profile ?? "",
            concurrency: Number(s.concurrency) || DEFAULT_CONCURRENCY,
            instructions: i.instructions,
            status: s.status,
          };
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
      draft.runtime !== loaded.runtime ||
      draft.model.trim() !== loaded.model ||
      draft.profile !== loaded.profile ||
      (draft.concurrency ?? DEFAULT_CONCURRENCY) !== loaded.concurrency;
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
            await client.call("settings.set", {
              pubkey,
              runtime: draft.runtime,
              model: draft.model.trim(),
              profile: draft.profile,
              concurrency: draft.concurrency ?? DEFAULT_CONCURRENCY,
            })
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
        `Runs on buzz-host (${client.snapshot().url.replace(/^wss:\/\//, "")})${loaded.runtime === "hermes" ? ` · Hermes profile ${loaded.profile || "default"}` : ""} · service ${loaded.status}. Up to ${loaded.concurrency} parallel conversations.`,
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
        { label: "Parallel conversations", hint: "How many chats or threads this agent can answer at once." },
        h(Select, {
          value: String(draft.concurrency ?? DEFAULT_CONCURRENCY),
          disabled: !!busy,
          options: CONCURRENCY_OPTIONS,
          onChange: (v) => setDraft({ ...draft, concurrency: Number(v) || DEFAULT_CONCURRENCY }),
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
      h(OrchestratorSettings, { agent }),
      !settingsSection && settingsContent,
    );
  }

  const omarchyType = {
    id: "omarchy",
    title: "Self-hosted",
    description: "Hosted on your own server with buzz-host; keeps answering while this computer is off.",
    defaults: () => ({ config: { ...EMPTY } }),
    adopt: (carry, saved) => ({ ...asConfig(saved), instructions: carry.instructions ?? asConfig(saved).instructions }),
    carry: (config) => ({ instructions: asConfig(config).instructions }),
    summary: () => "Runs on your server",
    Create,
    CreateConfiguration,
    tabs: [
      { id: "activity", title: "Activity", role: "activity", component: ActivityTab },
      { id: "settings", title: "Settings", role: "settings", splitSettings: true, component: SettingsTab },
    ],
    remote: {
      async provision({ name, picture, community, config, signal }) {
        const c = asConfig(config);
        return client.call(
          "provision",
          {
            name,
            picture,
            community,
            config: {
              runtime: c.runtime,
              model: c.model.trim(),
              profile: c.runtime === "hermes" ? c.profile : "",
              concurrency: Number(c.concurrency) || DEFAULT_CONCURRENCY,
              instructions: c.instructions,
            },
          },
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
            ...(c
              ? {
                  config: {
                    runtime: c.runtime,
                    model: c.model.trim(),
                    profile: c.runtime === "hermes" ? c.profile : "",
                    concurrency: Number(c.concurrency) || DEFAULT_CONCURRENCY,
                    instructions: c.instructions,
                  },
                }
              : {}),
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

  // Local Buzz patch 0006-models-for-hosted lets a hosted type offer `models`
  // and `sessionControls`; stock Buzz refuses `models` on a hosted type, so
  // the type registers again without them there.
  try {
    ctx.agents.register({ ...omarchyType, models: hostedModels, sessionControls: hostedSessions });
  } catch (error) {
    // Stock Buzz: "A hosted agent type has … no run, models or timeoutMs".
    if (!/models/.test(String(error?.message ?? error))) throw error;
    ctx.agents.register(omarchyType);
  }

  return { omarchyType, SettingsTab, Create, CreateConfiguration };
}
