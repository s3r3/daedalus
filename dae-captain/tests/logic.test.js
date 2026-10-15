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
  pendingApprovals,
  normalizeWorkspacePath,
  errText,
  spawnServerArgs,
  engineLabel,
  enabledEngines,
  canDisableEngine,
  trustToAutoApprove,
  autoApproveToTrust,
  queueRow,
  queueRows,
  THINKING_LEVELS,
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
      [{ label: "deck bisnis", path: "deck.json", url: null, display: "deck bisnis — deck.json" }]
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

describe("pendingApprovals", () => {
  const runs = [
    { run_id: "r1", turns: [
      { task_id: "t1", pending_approvals: [{ tool: "write_file", key: "k1" }, { tool: "run_command" }] },
      { task_id: "t2", pending_approvals: [] },
      { task_id: "t3" },
    ]},
    { run_id: "r2", turns: [
      { task_id: "t4", pending_approvals: [{ tool: "x" }] },
    ]},
    { run_id: "r3" },
  ];
  it("flattens every pending approval with its task id", () => {
    const list = pendingApprovals(runs);
    assert.equal(list.length, 3);
    assert.deepEqual(list.map((x) => x.taskId), ["t1", "t1", "t4"]);
    assert.equal(list[0].approval.key, "k1");
  });
  it("returns empty for no runs / no approvals", () => {
    assert.deepEqual(pendingApprovals([]), []);
    assert.deepEqual(pendingApprovals(null), []);
    assert.deepEqual(pendingApprovals([{ turns: [] }]), []);
  });
});

describe("enabledEngines / canDisableEngine", () => {
  it("filters disabled engines for chips", () => {
    assert.deepEqual(enabledEngines([]), [...ENGINES]);
    assert.deepEqual(enabledEngines(["slide", "research"]), ["coding", "dokumen", "spreadsheet"]);
  });
  it("never strands the user with zero engines", () => {
    const allButOne = ENGINES.slice(1);
    assert.equal(canDisableEngine("coding", allButOne), false);
    assert.equal(canDisableEngine("slide", ["research"]), true);
    assert.equal(canDisableEngine("slide", ["slide"]), true); // re-enable always fine
  });
});

describe("trust mapping", () => {
  it("maps dropdown to boolean autoApprove", () => {
    assert.equal(trustToAutoApprove("auto"), true);
    assert.equal(trustToAutoApprove("ask"), false);
    assert.equal(autoApproveToTrust(true), "auto");
    assert.equal(autoApproveToTrust(false), "ask");
    assert.equal(autoApproveToTrust(undefined), "ask");
  });
  it("thinking levels cover the server tiers", () => {
    assert.deepEqual([...THINKING_LEVELS].sort(), ["high", "low", "medium", "off"]);
  });
});

describe("queueRow", () => {
  it("badges running/done/failed/cancelled honestly", () => {
    assert.equal(queueRow({ engine: "coding", status: "running", goal: "x" }).badge, "progress");
    assert.equal(queueRow({ engine: "slide", status: "done", goal: "x" }).badge, "done");
    assert.equal(queueRow({ engine: "dokumen", status: "failed", goal: "x" }).badge, "failed");
    assert.equal(queueRow({ engine: "research", status: "cancelled", goal: "x" }).badge, "cancelled");
  });
  it("flags approval badge when approvals pending", () => {
    const r = queueRow({ engine: "coding", status: "running", goal: "x", pending_approvals: [{ key: "k" }] });
    assert.equal(r.badge, "approval");
    assert.equal(r.approvals.length, 1);
  });
  it("queueRows maps every turn", () => {
    const rows = queueRows({ turns: [
      { engine: "coding", status: "running", goal: "a", task_id: "t1" },
      { engine: "slide", status: "done", goal: "b", task_id: "t2" },
    ]});
    assert.equal(rows.length, 2);
    assert.equal(rows[0].label, "Coding");
    assert.equal(rows[1].badge, "done");
  });
});

describe("spawnServerArgs", () => {
  it("uses camelCase keys (Tauri command default)", () => {
    assert.deepEqual(Object.keys(spawnServerArgs("/r", "/w")), ["repoRoot", "workspace"]);
  });
});

describe("spawn_server JS/Rust arg contract", () => {
  it("JS payload keys match Tauri's camelCase mapping of the Rust params", async () => {
    // Tauri #[tauri::command] maps Rust param names to camelCase by default.
    // Read the real Rust signature so drift on either side breaks this test,
    // not the app on Farid's laptop.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src-tauri/src/main.rs", import.meta.url), "utf8");
    const m = src.match(/fn spawn_server\(([\s\S]*?)\)\s*->/);
    assert.ok(m, "spawn_server signature not found");
    const params = [...m[1].matchAll(/(\w+)\s*:\s*(?:String|bool|u16|Vec<DirEntry>)/g)]
      .map((x) => x[1])
      .filter((p) => p !== "app" && p !== "state"); // injected by Tauri, not from payload
    const toCamel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    const expected = params.map(toCamel).sort();
    const actual = Object.keys(spawnServerArgs("/r", "/w")).sort();
    assert.deepEqual(actual, expected);
  });
});

describe("summarizeTaskEvents", () => {
  it("extracts thoughts and tool calls in order", async () => {
    const { summarizeTaskEvents } = await import("../ui/logic.js");
    const s = summarizeTaskEvents([
      { type: "THOUGHT", payload: { text: "  perlu baca file dulu  " } },
      { type: "TOOL_CALL_STARTED", payload: { call: { id: "c1", tool: "read_file" } } },
      { type: "TOOL_CALL_FINISHED", payload: { call: { id: "c1", tool: "read_file" }, result: { status: "ok" } } },
      { type: "TOOL_CALL_STARTED", payload: { call: { id: "c2", tool: "run_command" } } },
    ]);
    assert.deepEqual(s.thoughts, ["perlu baca file dulu"]);
    assert.deepEqual(s.tools, [
      { tool: "read_file", status: "ok", args: "" },
      { tool: "run_command", status: "running", args: "" },
    ]);
  });

  it("marks failed tool calls", async () => {
    const { summarizeTaskEvents } = await import("../ui/logic.js");
    const s = summarizeTaskEvents([
      { type: "TOOL_CALL_FINISHED", payload: { call: { id: "c9", tool: "write_file" }, result: { status: "denied" } } },
    ]);
    assert.deepEqual(s.tools, [{ tool: "write_file", status: "denied", args: "" }]);
  });

  it("ignores empty thoughts and unknown events", async () => {
    const { summarizeTaskEvents } = await import("../ui/logic.js");
    const s = summarizeTaskEvents([
      { type: "THOUGHT", payload: { text: "   " } },
      { type: "TASK_STARTED", payload: {} },
      null,
    ]);
    assert.deepEqual(s.thoughts, []);
    assert.deepEqual(s.tools, []);
  });
});

describe("renderMarkdown", () => {
  it("renders code blocks with copy button", async () => {
    const { renderMarkdown } = await import("../ui/logic.js");
    const html = renderMarkdown("```js\nconst x = 1;\n```");
    assert.ok(html.includes('class="code-block"'));
    assert.ok(html.includes("const x = 1;"));
    assert.ok(html.includes("Salin"));
  });

  it("renders inline code, bold, italic", async () => {
    const { renderMarkdown } = await import("../ui/logic.js");
    const html = renderMarkdown("Use `npm install` for **bold** and *italic*");
    assert.ok(html.includes('<code class="inline-code">npm install</code>'));
    assert.ok(html.includes("<strong>bold</strong>"));
    assert.ok(html.includes("<em>italic</em>"));
  });

  it("renders headers and lists", async () => {
    const { renderMarkdown } = await import("../ui/logic.js");
    const html = renderMarkdown("# Title\n- item1\n- item2\n1. first\n2. second");
    assert.ok(html.includes("<h3"));
    assert.ok(html.includes("<ul"));
    assert.ok(html.includes("<ol"));
  });

  it("escapes HTML", async () => {
    const { renderMarkdown } = await import("../ui/logic.js");
    const html = renderMarkdown("<script>alert(1)</script>");
    assert.ok(!html.includes("<script>"));
    assert.ok(html.includes("&lt;script&gt;"));
  });
});
