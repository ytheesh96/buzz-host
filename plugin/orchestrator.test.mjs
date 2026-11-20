// node --test plugin/orchestrator.test.mjs
// Verifies plugin/plugin.js syntax, orchestrator accessory registration, and
// pure task-filtering / formatting helpers.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, "plugin.js"), "utf8");

function loadOrchHelpers() {
  const start = source.indexOf("  // ----- Orchestrator, in Settings and as an in-chat worker card -----");
  const end = source.indexOf("  // Coalesce concurrent/rapid", start);
  assert.ok(start >= 0 && end > start, "orchestrator helper block present");
  const snippet = source.slice(start, end);
  return new Function(
    `${snippet}\nreturn { ORCH_LIVE_STATUSES, orchRuntimeTitle, orchBadgeText, orchFormatElapsed, orchStatusMeta, orchSelectTasks };`,
  )();
}

test("plugin.js registers orchestrator-tasks response accessory at order 11", () => {
  assert.match(source, /id:\s*"orchestrator-tasks"[\s\S]*?placement:\s*"response"[\s\S]*?order:\s*11[\s\S]*?component:\s*OrchestratorCard/);
  assert.match(source, /h\(OrchestratorSettings,\s*\{\s*ui,\s*agent\s*\}\)/);
  assert.match(source, /h\(OrchestratorSettings,\s*\{\s*agent\s*\}\)/);
});

test("orchestrator UI helpers format badges, elapsed time, and select turn tasks", () => {
  const { orchBadgeText, orchFormatElapsed, orchStatusMeta, orchSelectTasks } = loadOrchHelpers();

  assert.equal(orchBadgeText({ runtime: "claude", model: "opus", effort: "high" }), "Claude Code · opus · high");
  assert.equal(orchBadgeText({ runtime: "hermes", model: "", effort: "" }), "Hermes");

  assert.equal(orchFormatElapsed(0), "0s");
  assert.equal(orchFormatElapsed(14_900), "14s");
  assert.equal(orchFormatElapsed(125_000), "2m 05s");
  assert.equal(orchFormatElapsed(3_720_000), "1h 02m");

  assert.equal(orchStatusMeta("running").label, "Running");
  assert.equal(orchStatusMeta("completed").label, "Done");
  assert.equal(orchStatusMeta("timed_out").label, "Timed out");
  assert.equal(orchStatusMeta("interrupted").label, "Interrupted");

  const tasks = [
    { taskId: "t1", originEventId: "e1", status: "completed", createdAt: 1000 },
    { taskId: "t2", originEventId: "e2", status: "running", createdAt: 2000 },
    { taskId: "t3", originEventId: "e1", status: "failed", createdAt: 1500 },
    { taskId: "t4", originEventId: "", status: "running", createdAt: 2100 },
  ];
  // Exact originEventId match wins over other live tasks in the chat.
  assert.deepEqual(
    orchSelectTasks(tasks, { messageId: "e1", since: 1900, live: false }).map((t) => t.taskId),
    ["t1", "t3"],
  );
  // Older completed turn with no matching originEventId never latches onto later/live tasks.
  assert.deepEqual(
    orchSelectTasks(tasks, { messageId: "e-old", since: 500, live: false }).map((t) => t.taskId),
    [],
  );
  // Live turn with no exact match falls back ONLY to unscoped (no originEventId) tasks.
  assert.deepEqual(
    orchSelectTasks(tasks, { messageId: "e-live", since: 2050, live: true }).map((t) => t.taskId),
    ["t4"],
  );
});
