// node --test server/
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { probe, toModels, catalogs, effortLabel } from "./catalog.mjs";

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
