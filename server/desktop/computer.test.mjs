import test from "node:test";
import assert from "node:assert/strict";
import { EXPOSED_TOOLS, prepareTools } from "./computer.mjs";
import { ATTENTION_TOOLS } from "../attention-core.mjs";
import { MEMORY_TOOLS } from "../memory.mjs";
import { ORCHESTRATOR_TOOLS } from "../orchestrator.mjs";

test("prepareTools filters cua-driver bloat and keeps total buzz MCP schema well under Antigravity eager budget", () => {
  const longProse = "A".repeat(400) + "\n\nSecond paragraph of verbose platform notes.";
  const fakeCua = [
    ...Array.from(EXPOSED_TOOLS, (name) => ({
      name,
      description: `Essential ${name}: ${longProse}`,
      inputSchema: {
        type: "object",
        properties: {
          x: { type: "number", description: longProse },
          y: { type: "number", description: longProse },
          target: {
            type: "object",
            description: longProse,
            properties: { kind: { type: "string", enum: ["window", "desktop"], description: longProse } },
            required: ["kind"],
          },
        },
        required: ["x", "y"],
      },
    })),
    // Deprecated / non-essential tools that caused Antigravity to evict watch_add & click
    { name: "get_window_state", description: "DEPRECATED " + longProse, inputSchema: { type: "object", properties: {} } },
    { name: "start_recording", description: longProse, inputSchema: { type: "object", properties: {} } },
    { name: "replay_trajectory", description: "DEPRECATED " + longProse, inputSchema: { type: "object", properties: {} } },
    { name: "install_ffmpeg", description: "DEPRECATED " + longProse, inputSchema: { type: "object", properties: {} } },
    { name: "set_agent_cursor_motion", description: longProse, inputSchema: { type: "object", properties: {} } },
    { name: "run_steps", description: longProse, inputSchema: { type: "object", properties: {} } },
  ];

  const prepared = prepareTools(fakeCua);
  const names = new Set(prepared.map((t) => t.name));

  assert.equal(prepared.length, EXPOSED_TOOLS.size);
  for (const required of ["get_desktop_state", "click", "type_text", "press_key", "hotkey", "scroll", "drag", "launch_app"]) {
    assert.ok(names.has(required), `must expose ${required}`);
  }
  for (const dropped of ["get_window_state", "start_recording", "replay_trajectory", "install_ffmpeg", "set_agent_cursor_motion", "run_steps"]) {
    assert.ok(!names.has(dropped), `must drop ${dropped}`);
  }

  // Descriptions are compacted without losing schema structure/enums/required fields.
  const click = prepared.find((t) => t.name === "click");
  assert.ok(click.description.length <= 180);
  assert.deepEqual(click.inputSchema.required, ["x", "y"]);
  assert.deepEqual(click.inputSchema.properties.target.properties.kind.enum, ["window", "desktop"]);

  // Combined buzz MCP server (memory + attention + orchestrator + curated computer)
  // stays well below Antigravity's ~57 KB global eager MCP schema budget so watch_add
  // and watch_update are never evicted.
  const ownTools = [...MEMORY_TOOLS, ...ATTENTION_TOOLS, ...ORCHESTRATOR_TOOLS].map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  }));
  const combinedBytes = JSON.stringify([...ownTools, ...prepared]).length;
  assert.ok(combinedBytes < 45_000, `expected combined MCP schema < 45KB, got ${combinedBytes}B`);
});
