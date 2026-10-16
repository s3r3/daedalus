import { describe, expect, test } from "vitest";
import {
  classify,
  getTaskEntries,
  resolveReferents,
  resolveResumeTarget,
  tokenize,
} from "../src/workflow/index.ts";
import { appendTurn, createWorkflowRun, updateTurn } from "../src/workflow/store.ts";
import type { RunContext } from "../src/workflow/types.ts";

/** coding (portfolio) + slide (presentasi skripsi) tasks, both done with artifacts. */
function runWithTwoTasks(): RunContext {
  const run = createWorkflowRun("/ws");
  const t1 = appendTurn(run, {
    engine: "coding",
    task_id: "t1",
    goal: "buat landing page portfolio pakai next.js",
    status: "running",
  });
  updateTurn(run, t1.turn_id, {
    status: "done",
    artifacts: [
      { kind: "files", label: "landing page portfolio", path: "portfolio/index.html" },
    ],
  });
  const t2 = appendTurn(run, {
    engine: "slide",
    task_id: "t2",
    goal: "buatkan slide presentasi skripsi 12 slide",
    status: "running",
  });
  updateTurn(run, t2.turn_id, {
    status: "done",
    artifacts: [
      { kind: "deck", label: "deck presentasi skripsi", path: "deck/deck.json" },
    ],
  });
  return run;
}

describe("classify", () => {
  test("interrupt signals", () => {
    const run = runWithTwoTasks();
    expect(classify("stop, ganti template jadi yang gelap", run)).toBe("interrupt");
    expect(classify("batalkan semuanya", run)).toBe("interrupt");
    expect(classify("jangan pakai tailwind", run)).toBe("interrupt");
  });

  test("resume beats interrupt when both present", () => {
    const run = runWithTwoTasks();
    expect(classify("balik ke presentasi tadi, ganti warnanya jadi hijau", run)).toBe(
      "resume",
    );
    expect(classify("lanjutkan yang tadi", run)).toBe("resume");
    expect(classify("kembali ke portfolio yang kemarin", run)).toBe("resume");
  });

  test("reference words -> continue", () => {
    const run = runWithTwoTasks();
    expect(classify("slide 3 kurang menarik", run)).toBe("continue");
    expect(classify("css-nya kurang bagus", run)).toBe("continue");
    expect(classify("ubah yang itu", run)).toBe("continue");
    expect(classify("tambahkan grafik ke deck tersebut", run)).toBe("continue");
    expect(classify("perbaiki error itu", run)).toBe("continue");
  });

  test("clear topic shift without reference -> new_topic", () => {
    const run = runWithTwoTasks();
    expect(classify("siapa windah basudara?", run)).toBe("new_topic");
    expect(classify("riset tentang efektivitas agentic AI untuk coding", run)).toBe(
      "new_topic",
    );
  });

  test("default = continue when the topic still overlaps", () => {
    const run = runWithTwoTasks();
    expect(classify("buat lebih minimalis", run)).toBe("continue");
    expect(classify("spacing-nya lebih lega", run)).toBe("continue");
  });

  test("empty timeline -> new_topic (nothing to continue)", () => {
    expect(classify("buatkan landing page", createWorkflowRun("/ws"))).toBe(
      "new_topic",
    );
    expect(classify("buatkan landing page", undefined)).toBe("new_topic");
  });
});

describe("getTaskEntries", () => {
  test("rebuilds latest task state from the timeline", () => {
    const entries = getTaskEntries(runWithTwoTasks());
    expect(entries).toHaveLength(2);
    expect(entries[0]!.taskId).toBe("t1");
    expect(entries[0]!.status).toBe("done");
    expect(entries[0]!.artifacts[0]!.path).toBe("portfolio/index.html");
    expect(entries[1]!.engine).toBe("slide");
  });
});

describe("resolveReferents", () => {
  test('"dari slide tadi" picks the slide task', () => {
    const r = resolveReferents("dari slide tadi tambahkan grafik", runWithTwoTasks());
    expect(r.kind).toBe("continue");
    expect(r.referents).toHaveLength(1);
    expect(r.referents[0]!.kind).toBe("deck");
    expect(r.best?.taskId).toBe("t2");
    expect(r.ambiguous).toBe(false);
    expect(r.needsConfirm).toBe(false);
  });

  test("ordinal reference resolves to the matching task", () => {
    const r = resolveReferents("slide 3 kurang menarik", runWithTwoTasks());
    expect(r.referents[0]!.kind).toBe("deck");
  });

  test("ambiguity: best wins, alternatives ride along, never blocks", () => {
    const run = createWorkflowRun("/ws");
    const a = appendTurn(run, {
      engine: "slide",
      task_id: "a",
      goal: "buatkan slide presentasi skripsi",
      status: "running",
    });
    updateTurn(run, a.turn_id, {
      status: "done",
      artifacts: [{ kind: "deck", label: "deck skripsi", path: "deck/a.json" }],
    });
    const b = appendTurn(run, {
      engine: "slide",
      task_id: "b",
      goal: "buatkan slide presentasi bisnis",
      status: "running",
    });
    updateTurn(run, b.turn_id, {
      status: "done",
      artifacts: [{ kind: "deck", label: "deck bisnis", path: "deck/b.json" }],
    });
    const r = resolveReferents("ubah yang itu", run);
    expect(r.ambiguous).toBe(true);
    expect(r.needsConfirm).toBe(false);
    expect(r.best).toBeDefined();
    expect(r.alternatives.length).toBeGreaterThanOrEqual(1);
    // UI can offer Undo / a picker from alternatives — no question asked.
    expect(r.alternatives[0]!.taskId).not.toBe(r.best!.taskId);
  });

  test("no reference signal -> no referents (old router contract)", () => {
    const r = resolveReferents("buatkan slide baru", runWithTwoTasks());
    expect(r.referents).toEqual([]);
  });

  test("running task without artifacts -> pending ref", () => {
    const run = createWorkflowRun("/ws");
    appendTurn(run, {
      engine: "coding",
      task_id: "t1",
      goal: "buat landing page Vue",
      status: "running",
    });
    const r = resolveReferents("perbaiki error itu", run);
    expect(r.referents).toHaveLength(1);
    expect(r.referents[0]!.kind).toBe("files");
    expect(r.referents[0]!.label).toContain("masih berjalan");
  });

  test("resume -> resumeTarget, not a scored referent", () => {
    const r = resolveReferents("balik ke presentasi tadi", runWithTwoTasks());
    expect(r.kind).toBe("resume");
    expect(r.resumeTarget?.taskId).toBe("t2");
    expect(r.referents[0]!.kind).toBe("deck");
  });
});

describe("resolveResumeTarget", () => {
  test('"balik ke X" finds X in the timeline', () => {
    const t = resolveResumeTarget(
      "balik ke presentasi tadi, ganti warnanya jadi hijau",
      runWithTwoTasks(),
    );
    expect(t?.taskId).toBe("t2");
    expect(t?.engine).toBe("slide");
  });

  test('"lanjutkan yang tadi" -> most recent finished task', () => {
    const t = resolveResumeTarget("lanjutkan yang tadi", runWithTwoTasks());
    expect(t?.taskId).toBe("t2");
  });

  test("empty run -> undefined", () => {
    expect(resolveResumeTarget("balik ke presentasi tadi", createWorkflowRun("/ws"))).toBeUndefined();
  });
});

describe("tokenize", () => {
  test('"-nya" contributes its stem', () => {
    expect(tokenize("hasilnya")).toContain("hasil");
  });
  test("stopwords removed", () => {
    expect(tokenize("buatkan slide yang bagus")).toEqual(
      expect.arrayContaining(["slide", "bagus"]),
    );
    expect(tokenize("buatkan slide yang bagus")).not.toContain("buatkan");
  });
});
