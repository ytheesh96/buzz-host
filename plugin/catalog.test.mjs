// node --test plugin/
// The composer's model list from buzz-host's catalog answer.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { composerModels } from "./plugin.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, "plugin.js"), "utf8");

test("other runtimes' models pass through grouped; a pending answer is kept briefly", () => {
  const answer = {
    current: "opus",
    models: [
      { id: "opus", label: "Claude Code · Opus 5.5", group: "Claude Code", efforts: [] },
      { id: "codex::gpt-5", label: "Codex · GPT-5", group: "Codex", efforts: [{ id: "low", label: "Low" }] },
    ],
  };
  const done = composerModels(answer);
  assert.deepEqual(done.models, answer, "Buzz's Models, untouched");
  assert.equal(done.ttlMs, 5 * 60_000);
  const pending = composerModels({ ...answer, runtimesPending: true });
  assert.deepEqual(pending.models, answer, "the flag isn't Buzz's");
  assert.equal(pending.ttlMs, 15_000);
});

test("an older buzz-host's single-runtime answer is used as it is", () => {
  const old = { current: "go:flash", models: [{ id: "go:flash", label: "OpenCode Go · flash", group: "OpenCode Go", efforts: [] }] };
  assert.deepEqual(composerModels(old), { models: old, ttlMs: 5 * 60_000 });
});

test("stock Buzz: the type registers again without models", () => {
  // Stock Buzz refuses `models` on a hosted type; the fallback register stays.
  assert.match(source, /stock Buzz refuses `models` on a hosted type/);
  assert.match(source, /register\(\{ \.\.\.omarchyType, models: hostedModels/);
  assert.match(source, /ctx\.agents\.register\(omarchyType\)/);
});
