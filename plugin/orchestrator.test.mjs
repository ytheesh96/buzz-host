// node --test plugin/orchestrator.test.mjs
// Verifies plugin/plugin.js syntax, removal of the in-chat worker card,
// Orchestrator Settings + worker agent selection, and parallel conversations UI.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, "plugin.js"), "utf8");

function loadWorkerFilterHelper() {
  const start = source.indexOf("  function eligibleWorkerAgents(");
  const end = source.indexOf("  function OrchestratorSettings(", start);
  assert.ok(start >= 0 && end > start, "eligibleWorkerAgents helper present");
  return new Function(`${source.slice(start, end)}\nreturn { eligibleWorkerAgents };`)();
}

test("plugin.js removes the in-chat orchestrator worker card and keeps OrchestratorSettings + concurrency", () => {
  // In-chat worker card accessory must be removed.
  assert.doesNotMatch(source, /id:\s*"orchestrator-tasks"/);
  assert.doesNotMatch(source, /function OrchestratorCard/);
  // Settings section + Worker agent picker + Parallel conversations picker exist.
  assert.match(source, /h\(OrchestratorSettings,\s*\{\s*ui,\s*agent\s*\}\)/);
  assert.match(source, /h\(OrchestratorSettings,\s*\{\s*agent\s*\}\)/);
  assert.match(source, /title:\s*"Worker agent"/);
  assert.match(source, /label:\s*"Parallel conversations"/);
});

test("eligibleWorkerAgents excludes self, unactivated agents, and orchestrators (MAX_DEPTH=1)", () => {
  const { eligibleWorkerAgents } = loadWorkerFilterHelper();
  const self = "a".repeat(64);
  const agents = [
    { pubkey: self, name: "Conductor", activated: true, orchestrate: true },
    { pubkey: "b".repeat(64), name: "Workers", activated: true, orchestrate: false, concurrency: 4 },
    { pubkey: "c".repeat(64), name: "Alpha", activated: true, orchestrate: false, concurrency: 4 },
    { pubkey: "d".repeat(64), name: "OtherOrch", activated: true, orchestrate: true },
    { pubkey: "e".repeat(64), name: "Draft", activated: false, orchestrate: false },
  ];
  const eligible = eligibleWorkerAgents(agents, self);
  assert.deepEqual(
    eligible.map((a) => a.name),
    ["Alpha", "Workers"],
  );
});
