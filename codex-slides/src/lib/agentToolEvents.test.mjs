import assert from "node:assert/strict";
import test from "node:test";
import { extractToolActivities } from "./agents.ts";

test("captures completed Codex Bash, file edit, and search events", () => {
  const stdout = [
    JSON.stringify({ type: "item.started", item: { id: "cmd-1", type: "command_execution", command: "rg outline data", status: "in_progress" } }),
    JSON.stringify({ type: "item.completed", item: { id: "cmd-1", type: "command_execution", command: "rg outline data", aggregated_output: "outline.md", exit_code: 0, status: "completed" } }),
    JSON.stringify({ type: "item.completed", item: { id: "edit-1", type: "file_change", changes: [{ path: "/tmp/outline.md", kind: "update" }], status: "completed" } }),
    JSON.stringify({ type: "item.completed", item: { id: "search-1", type: "web_search", query: "deck examples", status: "completed" } }),
  ].join("\n");

  const activities = extractToolActivities("codex", stdout);
  assert.equal(activities.length, 3);
  assert.deepEqual(
    activities.map((activity) => ({ id: activity.id, kind: activity.kind, state: activity.state })),
    [
      { id: "cmd-1", kind: "bash", state: "complete" },
      { id: "edit-1", kind: "edit", state: "complete" },
      { id: "search-1", kind: "search", state: "complete" },
    ],
  );
  assert.equal(activities[0]?.command, "rg outline data");
  assert.equal(activities[0]?.output, "outline.md");
});

test("ignores unsupported CLI output formats", () => {
  assert.deepEqual(extractToolActivities("claude", '{"result":"done"}'), []);
});
