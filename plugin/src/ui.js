// Small UI kit on host tokens, Buzz button/icon primitives, and shared model/profile fields.

export function ui(React) {
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

export const ICONS = {
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

export function createBuzzPrimitives(React) {
  const h = React.createElement;
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
  return { Icon, Btn };
}

// Model choices for a runtime (for Hermes, its profile's): loaded from
// buzz-host, free text as fallback.
export function useModels(React, client, runtime, profile = "") {
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
export function useProfiles(React, client, enabled) {
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
export function ProfileField({ React, client, value, onChange, disabled }) {
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

// Hermes ids name their provider: "nous:anthropic/claude-opus-5.5",
// "opencode-go:deepseek-v4.1-flash", "custom:<name>:<model>".
export function providerOf(id) {
  const parts = id.split(":");
  if (parts.length < 2) return undefined;
  return parts[0] === "custom" && parts.length > 2 ? `${parts[0]}:${parts[1]}` : parts[0];
}

export function groupByProvider(models) {
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

/** buzz-host's models as ModelPicker choices: Hermes ids grouped by provider. */
export function modelChoices(models) {
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

export function profileOptions(profiles, value) {
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

export function ModelField({ React, client, runtime, profile, value, onChange, disabled }) {
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
