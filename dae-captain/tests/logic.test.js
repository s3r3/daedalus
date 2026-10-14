// Unit tests for dae-captain/ui/logic.js — run: node --test tests/
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ENGINES,
  aggregateStatus,
  statusColor,
  pillText,
  turnSummary,
  formatResolvedArtifacts,
  approvalPayload,
  approvalTitle,
  chatRequestBody,
  isClarifyResponse,
  sameWorkspace,
  normalizeWorkspacePath,
  errText,
  engineLabel,
} from "../ui/logic.js";

const turn = (over = {}) => ({
  engine: "coding",
  task_id: "task-1234567890",
  goal: "buat landing page",
  status: "running",
  artifacts: [],
  ...over,
});
const run = (turns) => ({ run_id: "r1", turns });

describe("aggregateStatus", () => {
  it("idle when nothing runs", () => {
    assert.deepEqual(aggregateStatus([]), { status: "idle", running: 0, attention: 0 });
    assert.deepEqual(aggregateStatus([run([turn({ status: "done" })])]), {
      status: "idle", running: 0, attention: 0,
    });
  });
  it("working when a turn runs", () => {
    const agg = aggregateStatus([run([turn()])]);
    assert.equal(agg.status, "working");
    assert.equal(agg.running, 1);
  });
  it("attention wins over working when approvals pending", () => {
    const agg = aggregateStatus([
      run([turn({ pending_approvals: [{ key: "k", tool: "run_command" }] }), turn()]),
    ]);
    assert.equal(agg.status, "attention");
    assert.equal(agg.attention, 1);
    assert.equal(agg.running, 2);
  });
  it("counts pending questions as attention", () => {
    const agg = aggregateStatus([run([turn({ status: "done", pending_questions: [{ id: "q1" }] })])]);
    assert.equal(agg.status, "attention");
  });
});

describe("statusColor / pillText", () => {
  it("maps statuses to colors", () => {
    assert.equal(statusColor("attention"), "amber");
    assert.equal(statusColor("working"), "green");
    assert.equal(statusColor("idle"), "blue");
  });
  it("pill shows ! on attention, count when working", () => {
    assert.equal(pillText({ status: "attention", running: 2, attention: 1 }), "!");
    assert.equal(pillText({ status: "working", running: 3, attention: 0 }), "3");
    assert.equal(pillText({ status: "idle", running: 0, attention: 0 }), "");
  });
});

describe("turnSummary", () => {
  it("truncates long goals", () => {
    const s = turnSummary(turn({ goal: "x".repeat(100) }));
    assert.equal(s.goal.length, 43);
    assert.ok(s.goal.endsWith("…"));
  });
  it("labels staged research turns", () => {
    const s = turnSummary(turn({ engine: "research", live: "staged_awaiting_gate" }));
    assert.equal(s.label, "Research");
    assert.equal(s.detail, "menunggu gate");
  });
});

describe("formatResolvedArtifacts", () => {
  it("formats path artifacts", () => {
    assert.deepEqual(
      formatResolvedArtifacts([{ kind: "deck", label: "deck bisnis", path: "deck.json" }]),
      ["deck bisnis — deck.json"]
    );
  });
  it("handles empty", () => {
    assert.deepEqual(formatResolvedArtifacts([]), []);
    assert.deepEqual(formatResolvedArtifacts(null), []);
  });
});

describe("approvalPayload", () => {
  it("builds grant payload with key", () => {
    assert.deepEqual(approvalPayload({ key: "run_command:abc" }, "grant"), {
      decision: "grant", remember: false, key: "run_command:abc",
    });
  });
  it("omits empty key (server falls back to first pending)", () => {
    assert.deepEqual(approvalPayload({}, "deny", true), { decision: "deny", remember: true });
  });
  it("rejects bad decisions", () => {
    assert.throws(() => approvalPayload({}, "maybe"), /grant\|deny/);
  });
});

describe("approvalTitle", () => {
  it("includes engine, tool and short task id", () => {
    const t = approvalTitle("task-1234567890", turn(), { tool: "run_command", key: "k1" });
    assert.ok(t.includes("Coding"));
    assert.ok(t.includes("run_command"));
    assert.ok(t.includes("task-123"));
  });
});

describe("chatRequestBody", () => {
  it("includes workspace_root always, optional fields when set", () => {
    assert.deepEqual(
      chatRequestBody({ message: "halo", workspaceRoot: "/w" }),
      { message: "halo", workspace_root: "/w" }
    );
    const full = chatRequestBody({ message: "halo", runId: "r1", workspaceRoot: "/w", engineOverride: "slide" });
    assert.equal(full.run_id, "r1");
    assert.equal(full.engine_override, "slide");
  });
});

describe("isClarifyResponse / engineLabel", () => {
  it("detects clarify", () => {
    assert.ok(isClarifyResponse({ needs_clarify: true, options: ["coding"] }));
    assert.ok(!isClarifyResponse({ engine: "coding" }));
  });
  it("labels engines, passes unknown through", () => {
    assert.equal(engineLabel("slide"), "Slide");
    assert.equal(engineLabel("nope"), "nope");
  });
  it("engine list covers all five", () => {
    assert.deepEqual([...ENGINES].sort(), ["coding", "dokumen", "research", "slide", "spreadsheet"]);
  });
});

describe("sameWorkspace / normalizeWorkspacePath", () => {
  it("ignores trailing slashes (folder picker)", () => {
    assert.equal(normalizeWorkspacePath("/home/u/Skripsi/"), "/home/u/Skripsi");
    assert.ok(sameWorkspace("/home/u/Skripsi/", "/home/u/Skripsi"));
    assert.ok(sameWorkspace("/home/u/Skripsi", "/home/u/Skripsi/"));
  });
  it("distinguishes different roots", () => {
    assert.ok(!sameWorkspace("/home/u/Skripsi", "/home/u/Skripsi/Daedalus"));
    assert.ok(!sameWorkspace("/home/u/A", "/home/u/B"));
  });
  it("empty never matches", () => {
    assert.ok(!sameWorkspace("", ""));
    assert.ok(!sameWorkspace("/a", ""));
  });
});

describe("errText", () => {
  it("passes Tauri string rejections through (not undefined)", () => {
    assert.equal(errText("server exited during startup"), "server exited during startup");
  });
  it("reads Error.message", () => {
    assert.equal(errText(new Error("boom")), "boom");
  });
  it("never returns undefined", () => {
    assert.ok(errText(undefined) !== "undefined");
    assert.ok(errText(null) !== "undefined");
    assert.ok(!errText("x").includes("undefined"));
  });
});
