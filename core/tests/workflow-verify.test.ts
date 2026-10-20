import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  VerifyGate,
  createDefaultVerifyGate,
  createWorkflowRun,
  emitCompositeVerify,
  failureSignature,
  getEvents,
  runWithRetry,
  verifyComposite,
} from "../src/workflow/index.ts";
import type {
  AnyTimelineEvent,
  TimelineEvent,
  VerifyCheck,
  VerifyContext,
  VerifyGateResult,
  VerifyFailure,
} from "../src/workflow/index.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dae-captain-verify-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function ctx(overrides: Partial<VerifyContext> = {}): VerifyContext {
  return { engine: "coding", workspaceRoot: dir, ...overrides };
}

function isVerifyEvent(e: AnyTimelineEvent): e is TimelineEvent<"verify"> {
  return e.type === "verify";
}

// ---------------------------------------------------------------------------
// Framework: register / run / tiers
// ---------------------------------------------------------------------------

describe("VerifyGate framework", () => {
  test("quick checks run first; deep tier skipped when a quick check fails", () => {
    const order: string[] = [];
    const gate = new VerifyGate().register("coding", [
      {
        name: "deep-expensive",
        run: async () => {
          order.push("deep-expensive");
          return { ok: true };
        },
      },
      {
        name: "quick-cheap-fails",
        quick: true,
        run: async () => {
          order.push("quick-cheap-fails");
          return { ok: false, reason: "boom" };
        },
      },
      {
        name: "quick-cheap-ok",
        quick: true,
        run: async () => {
          order.push("quick-cheap-ok");
          return { ok: true };
        },
      },
    ]);
    return gate.run("coding", ctx()).then((r) => {
      expect(r.ok).toBe(false);
      expect(r.failures).toHaveLength(1);
      expect(r.failures[0]).toEqual({ check: "quick-cheap-fails", reason: "boom" });
      // Both quick checks ran (registration order within tier), deep never ran.
      expect(order).toEqual(["quick-cheap-fails", "quick-cheap-ok"]);
    });
  });

  test("deep tier runs only after every quick check passes", async () => {
    const order: string[] = [];
    const mk = (name: string, quick?: boolean): VerifyCheck => ({
      name,
      ...(quick ? { quick } : {}),
      run: async () => {
        order.push(name);
        return { ok: true };
      },
    });
    const gate = new VerifyGate().register("slide", [
      mk("deep-a"),
      mk("quick-a", true),
      mk("deep-b"),
      mk("quick-b", true),
    ]);
    const r = await gate.run("slide", ctx({ engine: "slide" }));
    expect(r.ok).toBe(true);
    expect(r.passed).toEqual(["quick-a", "quick-b", "deep-a", "deep-b"]);
    expect(order).toEqual(["quick-a", "quick-b", "deep-a", "deep-b"]);
  });

  test("a throwing check becomes a failure, not a crash", async () => {
    const gate = new VerifyGate().register("coding", [
      {
        name: "throws",
        quick: true,
        run: async () => {
          throw new Error("kaput");
        },
      },
    ]);
    const r = await gate.run("coding", ctx());
    expect(r.ok).toBe(false);
    expect(r.failures[0].reason).toContain("kaput");
  });

  test("skipped checks do not fail the gate and are recorded", async () => {
    const gate = new VerifyGate().register("coding", [
      {
        name: "skipped-one",
        quick: true,
        run: async () => ({ ok: true, skipped: true, reason: "no compiler" }),
      },
    ]);
    const r = await gate.run("coding", ctx());
    expect(r.ok).toBe(true);
    expect(r.skipped).toEqual(["skipped-one"]);
    expect(r.passed).toEqual([]);
  });

  test("register rejects duplicate check names", () => {
    const gate = new VerifyGate();
    const c: VerifyCheck = { name: "x", run: async () => ({ ok: true }) };
    expect(() => gate.register("coding", [c, c])).toThrow(/duplicate/);
  });

  test("unregistered engine has an empty checklist and passes vacuously", async () => {
    const r = await new VerifyGate().run("coding", ctx());
    expect(r.ok).toBe(true);
    expect(r.passed).toEqual([]);
  });

  test("failureSignature is order-stable", () => {
    const a: VerifyFailure[] = [
      { check: "b", reason: "r2" },
      { check: "a", reason: "r1" },
    ];
    const b: VerifyFailure[] = [
      { check: "a", reason: "r1" },
      { check: "b", reason: "r2" },
    ];
    expect(failureSignature(a)).toBe(failureSignature(b));
    expect(failureSignature([{ check: "a", reason: "r1" }])).not.toBe(
      failureSignature(a),
    );
  });
});

// ---------------------------------------------------------------------------
// runWithRetry
// ---------------------------------------------------------------------------

describe("runWithRetry", () => {
  function flipGate(getMode: () => "ok" | "bad"): VerifyGate {
    return new VerifyGate().register("coding", [
      {
        name: "flip",
        quick: true,
        run: async () =>
          getMode() === "ok" ? { ok: true } : { ok: false, reason: "same old error" },
      },
    ]);
  }

  test("gives up after 2 retries of the SAME error (3 attempts, 2 fixes)", async () => {
    const gate = flipGate(() => "bad");
    let fixes = 0;
    const report = await runWithRetry(gate, "coding", ctx(), {
      execute: async () => {},
      fix: async (failures) => {
        fixes += 1;
        expect(failures[0].reason).toContain("same old error");
      },
    });
    expect(report.ok).toBe(false);
    expect(report.attempts).toBe(3);
    expect(report.fixes).toBe(2);
    expect(fixes).toBe(2);
    expect(report.failures).toHaveLength(1);
  });

  test("succeeds when the fix works (no retry needed afterwards)", async () => {
    let calls = 0;
    // execute() runs before gate.run(), so the first attempt sees calls === 1.
    const gate = flipGate(() => (calls === 1 ? "bad" : "ok"));
    const report = await runWithRetry(gate, "coding", ctx(), {
      execute: async () => {
        calls += 1;
      },
      fix: async () => {},
    });
    expect(report.ok).toBe(true);
    expect(report.attempts).toBe(2);
    expect(report.fixes).toBe(1);
    expect(report.failures).toEqual([]);
  });

  test("a DIFFERENT error resets the retry counter", async () => {
    // Attempts fail with: A, B, B, B. B differs from A -> counter resets,
    // then B repeats twice more -> give up on the 4th attempt.
    let mode: string = "A";
    const gate = new VerifyGate().register("coding", [
      {
        name: "flip",
        quick: true,
        run: async () => ({ ok: false, reason: `error ${mode}` }),
      },
    ]);
    const seq = ["A", "B", "B", "B"];
    let i = 0;
    const report = await runWithRetry(gate, "coding", ctx(), {
      execute: async () => {
        mode = seq[i];
        i += 1;
      },
      fix: async () => {},
    });
    expect(report.ok).toBe(false);
    expect(report.attempts).toBe(4);
    expect(report.fixes).toBe(3);
    expect(report.failures[0].reason).toContain("error B");
  });

  test("each attempt appends one verify event to the timeline", async () => {
    const run = createWorkflowRun(dir);
    const gate = flipGate(() => "bad");
    const report = await runWithRetry(
      gate,
      "coding",
      ctx({ run, taskId: "t-retry" }),
      { execute: async () => {}, fix: async () => {} },
    );
    expect(report.ok).toBe(false);
    const evs = getEvents(run).filter(isVerifyEvent);
    expect(evs).toHaveLength(3);
    expect(evs.every((e) => e.payload.result === "fail")).toBe(true);
    expect(evs[0].payload.task_id).toBe("t-retry");
    expect(evs[0].payload.reason).toContain("flip");
  });
});

// ---------------------------------------------------------------------------
// verifyComposite
// ---------------------------------------------------------------------------

describe("verifyComposite", () => {
  const okPart = (label: string): { label: string; engine: "coding"; result: VerifyGateResult } => ({
    label,
    engine: "coding",
    result: { ok: true, passed: ["a"], skipped: [], failures: [] },
  });

  test("passes when every part passes", () => {
    const c = verifyComposite([okPart("riset"), okPart("slide")]);
    expect(c.ok).toBe(true);
    expect(c.passed).toEqual(["riset/a", "slide/a"]);
  });

  test("fails when any part fails, with labeled check names", () => {
    const c = verifyComposite([
      okPart("riset"),
      {
        label: "slide",
        engine: "slide",
        result: {
          ok: false,
          passed: [],
          skipped: [],
          failures: [{ check: "slide-pptx-exists", reason: "deck.pptx tidak ditemukan di workspace" }],
        },
      },
    ]);
    expect(c.ok).toBe(false);
    expect(c.failures).toEqual([
      {
        check: "slide/slide-pptx-exists",
        reason: "deck.pptx tidak ditemukan di workspace",
      },
    ]);
  });

  test("emitCompositeVerify appends one verify event", () => {
    const run = createWorkflowRun(dir);
    const c = verifyComposite([okPart("riset")]);
    emitCompositeVerify(run, "riset-ke-slide", c, "t-comp");
    const evs = getEvents(run).filter(isVerifyEvent);
    expect(evs).toHaveLength(1);
    expect(evs[0].payload.result).toBe("ok");
    expect(evs[0].payload.task_id).toBe("t-comp");
    expect(evs[0].payload.reason).toContain("riset-ke-slide");
  });
});

// ---------------------------------------------------------------------------
// Built-in checklists per engine
// ---------------------------------------------------------------------------

describe("createDefaultVerifyGate", () => {
  test("registers all five engines", () => {
    const gate = createDefaultVerifyGate();
    expect(gate.registered("coding").length).toBe(2);
    expect(gate.registered("slide").length).toBe(3);
    expect(gate.registered("dokumen").length).toBe(2);
    expect(gate.registered("spreadsheet").length).toBe(2);
    expect(gate.registered("research").length).toBe(2);
  });
});

describe("coding checks", () => {
  test("ok: deliverables exist and syntax is valid", async () => {
    writeFileSync(join(dir, "app.ts"), "export const x: number = 1;\n");
    writeFileSync(join(dir, "style.css"), "body { color: red; }\n");
    const r = await createDefaultVerifyGate().run(
      "coding",
      ctx({ coding: { files: ["app.ts", "style.css"] } }),
    );
    expect(r.ok).toBe(true);
    expect(r.passed).toEqual(["coding-deliverables-exist", "coding-syntax-valid"]);
  });

  test("fail: missing file names the file in the reason", async () => {
    const r = await createDefaultVerifyGate().run(
      "coding",
      ctx({ coding: { files: ["style.css"] } }),
    );
    expect(r.ok).toBe(false);
    expect(r.failures[0].check).toBe("coding-deliverables-exist");
    expect(r.failures[0].reason).toContain("style.css tidak ditemukan di workspace");
    // Deep tier must not run when the quick check failed.
    expect(r.passed).toEqual([]);
  });

  test("fail: invalid TS syntax names the file", async () => {
    writeFileSync(join(dir, "broken.ts"), "const x: = ;\n");
    const r = await createDefaultVerifyGate().run(
      "coding",
      ctx({ coding: { files: ["broken.ts"] } }),
    );
    expect(r.ok).toBe(false);
    const syntaxFail = r.failures.find((f) => f.check === "coding-syntax-valid");
    expect(syntaxFail).toBeDefined();
    expect(syntaxFail!.reason).toContain("broken.ts");
  });

  test("syntax check skips cleanly when there is nothing to parse", async () => {
    writeFileSync(join(dir, "style.css"), "body {}\n");
    const r = await createDefaultVerifyGate().run(
      "coding",
      ctx({ coding: { files: ["style.css"] } }),
    );
    expect(r.ok).toBe(true);
    expect(r.skipped).toEqual(["coding-syntax-valid"]);
  });
});

describe("slide checks", () => {
  function deck(slides: unknown[]) {
    return { version: 1, id: "d", title: "t", theme: {}, slides };
  }
  const slide = (id: string, text: string) => ({
    id,
    layout: "title",
    content: { title: text, body: "isi" },
  });

  test("ok: pptx exists, count matches, no overflow", async () => {
    writeFileSync(join(dir, "deck.pptx"), Buffer.alloc(100));
    writeFileSync(join(dir, "deck.json"), JSON.stringify(deck([slide("s1", "Halo"), slide("s2", "Dunia")])));
    const r = await createDefaultVerifyGate().run(
      "slide",
      ctx({ engine: "slide", slide: { expectedSlides: 2 } }),
    );
    expect(r.ok).toBe(true);
    expect(r.passed).toHaveLength(3);
  });

  test("fail: slide count mismatch states both numbers", async () => {
    writeFileSync(join(dir, "deck.pptx"), Buffer.alloc(100));
    writeFileSync(join(dir, "deck.json"), JSON.stringify(deck([slide("s1", "Halo")])));
    const r = await createDefaultVerifyGate().run(
      "slide",
      ctx({ engine: "slide", slide: { expectedSlides: 2 } }),
    );
    expect(r.ok).toBe(false);
    const f = r.failures.find((x) => x.check === "slide-count-matches");
    expect(f!.reason).toContain("1");
    expect(f!.reason).toContain("2");
  });

  test("fail: overflow names the slide", async () => {
    writeFileSync(join(dir, "deck.pptx"), Buffer.alloc(100));
    writeFileSync(
      join(dir, "deck.json"),
      JSON.stringify(deck([slide("s1", "x".repeat(2000))])),
    );
    const r = await createDefaultVerifyGate().run(
      "slide",
      ctx({ engine: "slide", slide: { maxCharsPerSlide: 1500 } }),
    );
    expect(r.ok).toBe(false);
    const f = r.failures.find((x) => x.check === "slide-no-overflow");
    expect(f!.reason).toContain("s1");
    expect(f!.reason).toContain("1500");
  });

  test("fail: missing pptx has a clear reason", async () => {
    const r = await createDefaultVerifyGate().run("slide", ctx({ engine: "slide" }));
    expect(r.ok).toBe(false);
    expect(r.failures[0].reason).toContain("deck.pptx tidak ditemukan di workspace");
  });
});

describe("dokumen checks", () => {
  test("ok: all fields confident and output exists", async () => {
    writeFileSync(join(dir, "hasil.md"), "# hasil\n");
    const r = await createDefaultVerifyGate().run(
      "dokumen",
      ctx({
        engine: "dokumen",
        dokumen: {
          fields: [
            { name: "nama", confidence: 0.95 },
            { name: "total", confidence: 0.7 },
          ],
          outputPath: "hasil.md",
        },
      }),
    );
    expect(r.ok).toBe(true);
  });

  test("fail: low-confidence field is named with its score", async () => {
    writeFileSync(join(dir, "hasil.md"), "# hasil\n");
    const r = await createDefaultVerifyGate().run(
      "dokumen",
      ctx({
        engine: "dokumen",
        dokumen: {
          fields: [
            { name: "nama", confidence: 0.95 },
            { name: "total", confidence: 0.45 },
          ],
          outputPath: "hasil.md",
        },
      }),
    );
    expect(r.ok).toBe(false);
    const f = r.failures.find((x) => x.check === "dokumen-fields-confident");
    expect(f!.reason).toContain('"total"');
    expect(f!.reason).toContain("0.45");
    expect(f!.reason).toContain("0.7");
  });
});

describe("spreadsheet checks", () => {
  test("ok: xlsx exists and numbersVerified is true", async () => {
    writeFileSync(join(dir, "laporan.xlsx"), Buffer.alloc(50));
    const r = await createDefaultVerifyGate().run(
      "spreadsheet",
      ctx({
        engine: "spreadsheet",
        spreadsheet: { xlsxPath: "laporan.xlsx", numbersVerified: true },
      }),
    );
    expect(r.ok).toBe(true);
  });

  test("fail: numbersVerified false is reported honestly (no recompute)", async () => {
    writeFileSync(join(dir, "laporan.xlsx"), Buffer.alloc(50));
    const r = await createDefaultVerifyGate().run(
      "spreadsheet",
      ctx({
        engine: "spreadsheet",
        spreadsheet: { xlsxPath: "laporan.xlsx", numbersVerified: false },
      }),
    );
    expect(r.ok).toBe(false);
    const f = r.failures.find((x) => x.check === "spreadsheet-numbers-verified");
    expect(f!.reason).toContain("numbersVerified=false");
  });
});

describe("research checks", () => {
  const good = {
    claims: [
      { id: "c1", sourceIds: ["s1", "s2"] },
      { id: "c2", sourceIds: ["s1"] },
    ],
    sourcesVerified: true,
  };

  test("ok: every claim has a source and sources passed", async () => {
    const r = await createDefaultVerifyGate().run(
      "research",
      ctx({ engine: "research", research: good }),
    );
    expect(r.ok).toBe(true);
  });

  test("fail: unsourced claim is named", async () => {
    const r = await createDefaultVerifyGate().run(
      "research",
      ctx({
        engine: "research",
        research: { ...good, claims: [{ id: "c9", sourceIds: [] }] },
      }),
    );
    expect(r.ok).toBe(false);
    const f = r.failures.find((x) => x.check === "research-claims-have-sources");
    expect(f!.reason).toContain('"c9"');
  });

  test("fail: sourcesVerified false is reported", async () => {
    const r = await createDefaultVerifyGate().run(
      "research",
      ctx({ engine: "research", research: { ...good, sourcesVerified: false } }),
    );
    expect(r.ok).toBe(false);
    const f = r.failures.find((x) => x.check === "research-sources-passed");
    expect(f!.reason).toContain("sourcesVerified=false");
  });
});

// ---------------------------------------------------------------------------
// Timeline integration
// ---------------------------------------------------------------------------

describe("verify timeline events", () => {
  test("gate failure appends one verify event with reason and task_id", async () => {
    const run = createWorkflowRun(dir);
    const r = await createDefaultVerifyGate().run(
      "dokumen",
      ctx({
        engine: "dokumen",
        taskId: "t-doc-1",
        run,
        dokumen: { fields: [], outputPath: "hasil.md" },
      }),
    );
    expect(r.ok).toBe(false);
    const evs = getEvents(run).filter(isVerifyEvent);
    expect(evs).toHaveLength(1);
    expect(evs[0].payload.result).toBe("fail");
    expect(evs[0].payload.task_id).toBe("t-doc-1");
    expect(evs[0].payload.reason).toContain("dokumen-fields-confident");
  });

  test("gate success appends an ok verify event (silent in chat, visible in timeline)", async () => {
    writeFileSync(join(dir, "laporan.xlsx"), Buffer.alloc(50));
    const run = createWorkflowRun(dir);
    const r = await createDefaultVerifyGate().run(
      "spreadsheet",
      ctx({
        engine: "spreadsheet",
        run,
        spreadsheet: { xlsxPath: "laporan.xlsx", numbersVerified: true },
      }),
    );
    expect(r.ok).toBe(true);
    const evs = getEvents(run).filter(isVerifyEvent);
    expect(evs).toHaveLength(1);
    expect(evs[0].payload.result).toBe("ok");
    expect(evs[0].payload.reason).toContain("spreadsheet");
  });

  test("no event is appended when ctx.run is absent", async () => {
    const r = await createDefaultVerifyGate().run("coding", ctx());
    expect(r.ok).toBe(false);
    // Nothing to assert on a timeline — the call must simply not throw.
  });
});
