// node --test plugin/orchestrator.test.mjs
// Verifies plugin/plugin.js removes the in-chat worker card and dedicated
// worker-agent picker, while keeping OrchestratorSettings and Parallel
// conversations controls.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, "plugin.js"), "utf8");

test("plugin.js removes the in-chat worker card and Worker agent picker, keeping OrchestratorSettings + concurrency", () => {
  // In-chat worker card accessory and dedicated worker-agent picker must be removed.
  assert.doesNotMatch(source, /id:\s*"orchestrator-tasks"/);
  assert.doesNotMatch(source, /function OrchestratorCard/);
  assert.doesNotMatch(source, /function eligibleWorkerAgents/);
  assert.doesNotMatch(source, /title:\s*"Worker agent"/);
  // Settings section + Parallel conversations picker remain.
  assert.match(source, /h\(OrchestratorSettings,\s*\{\s*ui,\s*agent\s*\}\)/);
  assert.match(source, /h\(OrchestratorSettings,\s*\{\s*agent\s*\}\)/);
  assert.match(source, /label:\s*"Parallel conversations"/);
});
