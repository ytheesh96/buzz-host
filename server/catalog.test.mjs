// node --test server/
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  probe,
  toModels,
  toModelList,
  catalogs,
  effortLabel,
  withRuntimes,
  resolveChatSettings,
  forComposer,
  formatTarget,
  parseTarget,
} from "./catalog.mjs";

// Temp dirs made by this file, removed when it finishes.
const tmpDirs = [];
after(() => Promise.all(tmpDirs.map((d) => fs.rm(d, { recursive: true, force: true }))));

// A stand-in ACP adapter: Claude-like options, where `old` lacks xhigh and
// `fixed` has no effort option at all. It fails the test if prompted.
const ADAPTER = `
const opts = (model) => {
  const levels = model === "old" ? ["default", "low", "high"] : ["default", "low", "high", "xhigh"];
  return [
    { id: "model", category: "model", currentValue: model, options: [
      { value: "default", name: "Default (recommended)", description: "Opus 5.5" },
      { value: "opus", name: "Opus 5.5" }, { value: "old", name: "Opus 4.6" }, { value: "fixed", name: "Fixed" },
      { value: "bad id!", name: "Unpickable" }, { value: "paid", name: "Needs credits" } ] },
    ...(model === "fixed" ? [] : [{ id: "effort", category: "thought_level", currentValue: "default",
      options: levels.map((value) => ({ value, name: value })) }]),
  ];
};
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    const answer = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
    if (m.method === "initialize") answer({ protocolVersion: 1 });
    else if (m.method === "session/new") {
      // A request to the client first, which the probe must refuse.
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: "ask", method: "session/request_permission", params: {} }) + "\\n");
      answer({ sessionId: "s", configOptions: opts("default") });
    } else if (m.method === "session/set_config_option" && m.params.value === "paid")
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32603, message: "Internal error",
        data: { details: "API error: 429 Usage credits are required for this model · model not changed" } } }) + "\\n");
    else if (m.method === "session/set_config_option") answer({ configOptions: opts(m.params.value) });
    else if (m.method === "session/prompt") process.exit(3);
  }
});
`;

async function adapter() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "catalog-"));
  tmpDirs.push(dir);
  const file = path.join(dir, "adapter.mjs");
  await fs.writeFile(file, ADAPTER);
  return { dir, command: process.execPath, args: [file], cwd: dir };
}

test("probes each model's effort levels without prompting", async () => {
  const a = await adapter();
  const probed = await probe({ command: a.command, args: a.args, cwd: a.cwd, env: process.env });
  assert.equal(probed.model.current, "default");
  assert.deepEqual(Object.keys(probed.efforts), ["default", "opus", "old", "fixed", "bad id!"]);
  assert.equal(probed.efforts.fixed, null);
  assert.deepEqual(probed.unavailable, ["paid"]);
  assert.equal(probed.partial, false);

  const own = toModels(probed);
  assert.equal(own.current, "default");
  assert.deepEqual(own.models.map((m) => [m.id, m.label]), [
    ["default", "Default (Opus 5.5)"],
    ["opus", "Opus 5.5"],
    ["old", "Opus 4.6"],
    ["fixed", "Fixed"],
  ]);
  assert.deepEqual(own.models[1].efforts.map((e) => e.id), ["low", "high", "xhigh"]);
  assert.deepEqual(own.models[2].efforts.map((e) => e.id), ["low", "high"]);
  assert.deepEqual(own.models[3].efforts, []);
  assert.equal(own.models[1].effort, undefined, "Claude's `default` level is no level");

  const once = await probe({ command: a.command, args: a.args, cwd: a.cwd, env: process.env, perModel: false });
  assert.deepEqual(once.efforts, {}, "one set of levels for every model");
  assert.deepEqual(toModels(once).models[2].efforts.map((e) => e.id), ["low", "high", "xhigh"]);

  const configured = toModels(probed, "opus");
  assert.equal(configured.current, "opus");
  assert.ok(!configured.models.some((m) => m.id === "default"), "the alias only as the agent's own");
  const unlisted = toModels(probed, "claude-opus-4-1");
  assert.equal(unlisted.models[0].id, "claude-opus-4-1");
  assert.deepEqual(unlisted.models[0].efforts.map((e) => e.id), ["low", "high", "xhigh"]);
});

test("Hermes: providers become groups, and its resting level shows", () => {
  const effort = { current: "max", options: ["none", "low", "max"].map((value) => ({ value })) };
  const probed = {
    model: { current: "go:flash", options: [
      { value: "nous:anthropic/claude-opus-5.5", name: "Nous Portal · anthropic/claude-opus-5.5" },
      { value: "go:flash", name: "OpenCode Go · flash" },
    ] },
    effort,
    efforts: { "nous:anthropic/claude-opus-5.5": effort },
  };
  const { current, models } = toModels(probed);
  assert.equal(current, "go:flash");
  assert.deepEqual(models.map((m) => m.group), ["Nous Portal", "OpenCode Go"]);
  assert.equal(models[0].effort, "max");
  assert.deepEqual(models[1].efforts.map((e) => e.id), ["none", "low", "max"], "unprobed: the starting levels");
  assert.equal(effortLabel("xhigh"), "Extra high");
});

test("catalogs: cached on disk, refreshed in the background when old", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "catalogs-"));
  tmpDirs.push(dir);
  let n = 0;
  const probeWith = async () => ({ n: ++n });
  const get = catalogs({ dir, probeWith, maxAgeMs: 50 });
  assert.deepEqual(await get("claude:", {}), { n: 1 });
  assert.deepEqual(await get("claude:", {}), { n: 1 }, "fresh: from memory");
  const again = catalogs({ dir, probeWith, maxAgeMs: 60_000 });
  assert.deepEqual(await again("claude:", {}), { n: 1 }, "a restarted buzz-host reads the file");
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(await get("claude:", {}), { n: 1 }, "stale: answered at once");
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(await get("claude:", {}), { n: 2 }, "then refreshed");
  const failing = catalogs({ dir: path.join(dir, "x"), probeWith: async () => { throw new Error("login"); } });
  await assert.rejects(failing("codex:", {}), /login/);
});

test("withRuntimes: one submenu per runtime, other runtimes' ids prefixed", () => {
  const own = { runtime: "claude", title: "Claude Code", current: "opus", models: [
    { id: "opus", label: "Opus 5.5", efforts: [{ id: "high", label: "High" }] },
  ] };
  assert.deepEqual(withRuntimes(own, []), { current: "opus", models: own.models }, "alone: as it was");
  const codex = { runtime: "codex", title: "Codex", current: "gpt-5", models: [
    { id: "gpt-5", label: "GPT-5", efforts: [{ id: "low", label: "Low" }, { id: "xhigh", label: "Extra high" }] },
    { id: "x".repeat(125), label: "too long once prefixed", efforts: [] },
  ] };
  const hermes = { runtime: "hermes", title: "Hermes", current: "go:flash", models: [
    { id: "go:flash", label: "OpenCode Go · flash", group: "OpenCode Go", efforts: [] },
  ] };
  const { current, models } = withRuntimes(own, [codex, hermes]);
  assert.equal(current, "opus", "the agent's own model, unprefixed");
  assert.deepEqual(models.map((m) => [m.id, m.group, m.label]), [
    ["opus", "Claude Code", "Claude Code · Opus 5.5"],
    ["codex::gpt-5", "Codex", "Codex · GPT-5"],
    ["hermes::go:flash", "Hermes · OpenCode Go", "Hermes · OpenCode Go · flash"],
  ]);
  assert.deepEqual(models[1].efforts.map((e) => e.id), ["low", "xhigh"], "efforts follow each model");
});

test("catalogs without waiting: nothing until a background probe answers; a failure backs off", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "catalogs-"));
  tmpDirs.push(dir);
  let release;
  let calls = 0;
  const get = catalogs({
    dir,
    retryMs: 40,
    probeWith: (options) => {
      calls++;
      if (options.fail) return Promise.reject(new Error("not signed in"));
      return new Promise((r) => (release = () => r({ ok: true })));
    },
  });
  assert.equal(await get("codex:", {}, { wait: false }), undefined, "probing in the background");
  assert.equal(await get("codex:", {}, { wait: false }), undefined);
  assert.equal(calls, 1, "one probe at a time");
  release();
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(await get("codex:", {}, { wait: false }), { ok: true });

  assert.equal(await get("antigravity:", { fail: true }, { wait: false }), undefined);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(await get("antigravity:", { fail: true }, { wait: false }), null, "failed: left out");
  assert.equal(calls, 2, "not asked again yet");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(await get("antigravity:", { fail: true }, { wait: false }), undefined, "asked again later");
  assert.equal(calls, 3);
});

test("resolveChatSettings: thread inherits channel unless it switches runtime or Hermes profile", () => {
  const known = new Set(["claude", "codex", "hermes", "antigravity"]);
  const ch = "61ace2b8-1160-44c8-ad2b-6efd96b816af";
  const th = "a".repeat(64);
  const key = `${ch}_${th}`;

  assert.deepEqual(resolveChatSettings({}, ch, th, "claude", known), {
    runtime: "claude",
    profile: "",
    target: "claude",
    model: "",
    effort: "",
  });

  // Channel switched to antigravity; thread inherits runtime, model, effort.
  const chSettings = { [ch]: { runtime: "antigravity", model: "gemini-4-neon", effort: "high" } };
  assert.deepEqual(resolveChatSettings(chSettings, ch, th, "claude", known), {
    runtime: "antigravity",
    profile: "",
    target: "antigravity",
    model: "gemini-4-neon",
    effort: "high",
  });

  // Thread overrides effort on same runtime: keeps channel's runtime and model.
  assert.deepEqual(
    resolveChatSettings({ ...chSettings, [key]: { effort: "low" } }, ch, th, "claude", known),
    { runtime: "antigravity", profile: "", target: "antigravity", model: "gemini-4-neon", effort: "low" },
  );

  // Thread switches back to claude: must NOT inherit channel's antigravity model/effort.
  assert.deepEqual(
    resolveChatSettings({ ...chSettings, [key]: { runtime: "claude" } }, ch, th, "claude", known),
    { runtime: "claude", profile: "", target: "claude", model: "", effort: "" },
  );

  // Channel uses agent default runtime with a model/effort; thread switches to codex.
  assert.deepEqual(
    resolveChatSettings(
      { [ch]: { model: "opus", effort: "high" }, [key]: { runtime: "codex" } },
      ch,
      th,
      "claude",
      known,
    ),
    { runtime: "codex", profile: "", target: "codex", model: "", effort: "" },
  );

  // Unknown runtime falls back to default.
  assert.deepEqual(
    resolveChatSettings({ [ch]: { runtime: "unknown-rt" } }, ch, null, "claude", known),
    { runtime: "claude", profile: "", target: "claude", model: "", effort: "" },
  );

  // Hermes profiles: defaultProfile propagates, thread switching profile drops model/effort,
  // and explicit profile: "" overrides channel's named profile back to default.
  assert.deepEqual(resolveChatSettings({}, ch, th, "hermes", known, "career-lead"), {
    runtime: "hermes",
    profile: "career-lead",
    target: "hermes:career-lead",
    model: "",
    effort: "",
  });
  const hermesCh = { [ch]: { runtime: "hermes", profile: "career-lead", model: "go:flash", effort: "high" } };
  assert.deepEqual(
    resolveChatSettings({ ...hermesCh, [key]: { runtime: "hermes", profile: "selfhost" } }, ch, th, "claude", known),
    { runtime: "hermes", profile: "selfhost", target: "hermes:selfhost", model: "", effort: "" },
  );
  assert.deepEqual(
    resolveChatSettings({ ...hermesCh, [key]: { runtime: "hermes", profile: "" } }, ch, th, "claude", known),
    { runtime: "hermes", profile: "", target: "hermes", model: "", effort: "" },
  );
});

test("parseTarget / formatTarget and forComposer (Option A)", () => {
  const known = new Set(["claude", "codex", "hermes", "antigravity"]);
  assert.equal(formatTarget("hermes", "career-lead"), "hermes:career-lead");
  assert.equal(formatTarget("hermes", "default"), "hermes");
  assert.equal(formatTarget("claude", "ignored"), "claude");
  assert.deepEqual(parseTarget("hermes:career-lead", known), {
    runtime: "hermes",
    profile: "career-lead",
    target: "hermes:career-lead",
  });
  assert.deepEqual(parseTarget("hermes:default", known), {
    runtime: "hermes",
    profile: "",
    target: "hermes",
  });
  assert.equal(parseTarget("claude:foo", known), null);
  assert.equal(parseTarget("hermes:bad space", known), null);

  // Long Hermes model IDs (68 chars) stay pickable.
  const longId = "claude-subscription-directsdk-experimental:claude-haiku-4-5-20251001";
  const hermesModels = toModels({
    model: {
      current: "go:flash",
      options: [
        { value: "go:flash", name: "OpenCode Go · flash" },
        { value: longId, name: "Claude · haiku" },
      ],
    },
    effort: { current: "medium", options: [{ value: "low" }, { value: "medium" }, { value: "high" }] },
  });
  assert.ok(hermesModels.models.some((m) => m.id === longId));

  const runtimes = [
    { id: "claude", label: "Claude Code" },
    { id: "hermes", label: "Hermes · default", group: "Hermes" },
    { id: "hermes:career-lead", label: "Hermes · career-lead", group: "Hermes" },
  ];
  // Active runtime matches chat: applies chat model & effort without mutating input.
  const matched = forComposer({
    active: { target: "hermes:career-lead", ...hermesModels },
    runtimes,
    currentRuntime: "hermes:career-lead",
    chat: { target: "hermes:career-lead", model: longId, effort: "high" },
  });
  assert.equal(matched.currentRuntime, "hermes:career-lead");
  assert.equal(matched.modelsRuntime, "hermes:career-lead");
  assert.equal(matched.current, longId);
  assert.equal(matched.models.find((m) => m.id === longId).effort, "high");
  assert.equal(matched.models[0].group, "OpenCode Go", "provider group only, no Hermes prefix");
  assert.equal(hermesModels.models[1].effort, "medium", "does not mutate cached catalog");

  // Previewing another runtime: keeps chat's currentRuntime, does NOT apply old chat model/effort.
  const preview = forComposer({
    active: { target: "hermes:career-lead", ...hermesModels },
    runtimes,
    currentRuntime: "claude",
    chat: { target: "claude", model: "opus", effort: "high" },
  });
  assert.equal(preview.currentRuntime, "claude");
  assert.equal(preview.modelsRuntime, "hermes:career-lead");
  assert.equal(preview.current, "go:flash");
  assert.equal(preview.models.find((m) => m.id === "go:flash").effort, "medium");
});

test("withRuntimes with per-chat settings selects active runtime, model and effort", () => {
  const own = {
    runtime: "claude",
    title: "Claude Code",
    current: "default",
    models: [
      { id: "default", label: "Default (Opus 5.5)", efforts: [{ id: "low", label: "Low" }, { id: "high", label: "High" }] },
      { id: "sonnet", label: "Sonnet", efforts: [{ id: "low", label: "Low" }, { id: "high", label: "High" }] },
    ],
  };
  const codex = {
    runtime: "codex",
    title: "Codex",
    current: "gpt-5",
    models: [
      { id: "gpt-5", label: "GPT-5", efforts: [{ id: "low", label: "Low" }, { id: "xhigh", label: "Extra high" }] },
      { id: "gpt-5-mini", label: "GPT-5 mini", efforts: [{ id: "low", label: "Low" }] },
    ],
  };
  const antigravity = {
    runtime: "antigravity",
    title: "Antigravity",
    current: "gemini-4-neon",
    models: [
      { id: "gemini-4-neon", label: "Gemini 4 Neon", efforts: [{ id: "low", label: "Low" }, { id: "high", label: "High" }] },
    ],
  };

  // Cross-runtime with explicit model and effort.
  const ag = withRuntimes(own, [codex, antigravity], {
    runtime: "antigravity",
    model: "gemini-4-neon",
    effort: "low",
  });
  assert.equal(ag.current, "antigravity::gemini-4-neon");
  assert.equal(ag.models.find((m) => m.id === "antigravity::gemini-4-neon").effort, "low");
  assert.equal(antigravity.models[0].effort, undefined, "does not mutate cached runtime catalog");

  // Cross-runtime without explicit model uses that runtime's default.
  const cx = withRuntimes(own, [codex, antigravity], { runtime: "codex", model: "", effort: "" });
  assert.equal(cx.current, "codex::gpt-5");

  // Cross-runtime with unlisted custom model adds an entry and selects it.
  const custom = withRuntimes(own, [codex], { runtime: "codex", model: "gpt-5-custom", effort: "xhigh" });
  assert.equal(custom.current, "codex::gpt-5-custom");
  const customEntry = custom.models.find((m) => m.id === "codex::gpt-5-custom");
  assert.equal(customEntry.group, "Codex");
  assert.equal(customEntry.effort, "xhigh");

  // Own runtime with model + unsupported effort: selects model, ignores unsupported effort.
  const ownOverride = withRuntimes(own, [codex], { runtime: "claude", model: "sonnet", effort: "bogus" });
  assert.equal(ownOverride.current, "sonnet");
  assert.equal(ownOverride.models.find((m) => m.id === "sonnet").effort, undefined);

  // Single runtime (no others) still applies per-chat model and effort.
  const solo = withRuntimes(own, [], { runtime: "claude", model: "sonnet", effort: "high" });
  assert.equal(solo.current, "sonnet");
  assert.equal(solo.models.find((m) => m.id === "sonnet").effort, "high");
  assert.equal(own.models[1].effort, undefined, "does not mutate own catalog");

  // Unavailable target runtime falls back to agent default.
  const missing = withRuntimes(own, [codex], { runtime: "hermes", model: "go:flash", effort: "" });
  assert.equal(missing.current, "default");
});

test("toModelList formats cached probe results for the models RPC", () => {
  // Prefers clean model configOptions over flattened legacy available list, filters refused models, and dedupes efforts.
  const list = toModelList({
    model: {
      id: "model",
      current: "default",
      options: [
        { value: "default", name: "Default" },
        { value: "opus", name: "Opus 5.5" },
        { value: "opus", name: "Opus duplicate" },
        { value: "paid", name: "Needs credits" },
        { value: "plain" },
      ],
    },
    available: [
      { value: "opus-high", name: "Opus (High)" },
      { value: "opus-low", name: "Opus (Low)" },
    ],
    effort: {
      current: "medium",
      options: [
        { value: "low", name: "Low" },
        { value: "low", name: "Low dup" },
        { value: "high" },
      ],
    },
    unavailable: ["paid"],
  });
  assert.deepEqual(list, {
    models: [
      { id: "default", name: "Default" },
      { id: "opus", name: "Opus 5.5" },
      { id: "plain", name: "plain" },
    ],
    efforts: [
      { value: "low", name: "Low" },
      { value: "high", name: "high" },
    ],
  });

  // Falls back to legacy available list when model configOption is absent.
  const legacy = toModelList({
    model: null,
    available: [
      { value: "nous:anthropic/claude-opus-5.5", name: "Nous Portal · anthropic/claude-opus-5.5" },
      { value: "opencode-go:deepseek-v4.1-flash", name: "OpenCode Go · deepseek-v4.1-flash" },
    ],
    effort: null,
    unavailable: [],
  });
  assert.deepEqual(legacy, {
    models: [
      { id: "nous:anthropic/claude-opus-5.5", name: "Nous Portal · anthropic/claude-opus-5.5" },
      { id: "opencode-go:deepseek-v4.1-flash", name: "OpenCode Go · deepseek-v4.1-flash" },
    ],
    efforts: [],
  });
});

test("probe closes child stdin cleanly on completion and handles early exit without EPIPE", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "catalog-eof-"));
  tmpDirs.push(dir);
  const eofMarker = path.join(dir, "saw-eof");
  const script = path.join(dir, "adapter-eof.mjs");
  await fs.writeFile(
    script,
    `
import fs from "node:fs";
let buf = "";
process.on("SIGTERM", () => {});
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(eofMarker)}, "eof");
  process.exit(0);
});
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (m.method === "initialize") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1 } }) + "\\n");
    else if (m.method === "session/new") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { sessionId: "s", configOptions: [] } }) + "\\n");
  }
});
`,
  );
  const res = await probe({ command: process.execPath, args: [script], cwd: dir, env: process.env, perModel: false });
  assert.equal(res.model, null);
  let saw = "";
  for (let i = 0; i < 40 && !saw; i++) {
    saw = await fs.readFile(eofMarker, "utf8").catch(() => "");
    if (!saw) await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(saw, "eof");

  // Early-exit adapter must reject cleanly without an unhandled EPIPE on child.stdin.
  const crashScript = path.join(dir, "adapter-crash.mjs");
  await fs.writeFile(crashScript, "process.exit(1);\n");
  await assert.rejects(probe({ command: process.execPath, args: [crashScript], cwd: dir, env: process.env }), /exited/);
});
