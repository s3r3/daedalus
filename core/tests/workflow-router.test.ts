import { describe, expect, test } from "vitest";
import {
  RULE_CONFIDENCE_THRESHOLD,
  buildLayerBPrompt,
  formatResolvedForGoal,
  isConversationalMessage,
  parseLayerBResponse,
  resolveReferences,
  routeByRules,
} from "../src/workflow/router.ts";
import { createWorkflowRun, appendTurn, updateTurn } from "../src/workflow/store.ts";
import type { RunContext } from "../src/workflow/types.ts";

describe("routeByRules — classification matrix (ID + EN)", () => {
  const cases: Array<[string, string]> = [
    // slide
    ["buatkan slide presentasi untuk bisnis saya", "slide"],
    ["make a pitch deck for investors", "slide"],
    ["dari landing page tadi buatkan slide presentasi", "slide"],
    // spreadsheet
    ["catat pemasukan subscriber di spreadsheet", "spreadsheet"],
    ["buatkan tabel anggaran di excel", "spreadsheet"],
    ["rekap pengeluaran bulan ini", "spreadsheet"],
    // research
    ["riset apakah landing page saya sudah benar", "research"],
    ["telaah literatur tentang agentic workflow", "research"],
    ["research whether this claim is valid", "research"],
    // dokumen
    ["buatkan semuanya dalam bentuk PDF", "dokumen"],
    ["tulis surat penawaran kerjasama", "dokumen"],
    ["write the contract as a docx", "dokumen"],
    // coding
    ["buka folder X, buat landing page pakai Vue", "coding"],
    ["fix the login bug", "coding"],
    ["refactor fungsi ini jadi lebih rapi", "coding"],
    ["deploy server ke VPS", "coding"],
  ];
  for (const [message, engine] of cases) {
    test(`"${message}" → ${engine}`, () => {
      const result = routeByRules(message);
      expect(result.engine).toBe(engine);
      expect(result.confidence).toBeGreaterThanOrEqual(
        RULE_CONFIDENCE_THRESHOLD,
      );
    });
  }
});

describe("routeByRules — continuation", () => {
  test('"lanjutkan" follows the previous engine', () => {
    const result = routeByRules("lanjutkan", { previousEngine: "slide" });
    expect(result.engine).toBe("slide");
    expect(result.matchedRule).toBe("continuation");
  });

  test('"perbaiki itu" follows the previous engine', () => {
    const result = routeByRules("perbaiki itu", { previousEngine: "coding" });
    expect(result.engine).toBe("coding");
  });

  test("last engine mention wins on cross-engine continuation", () => {
    const routed = routeByRules("dari slide tadi catat pemasukan di spreadsheet", {
      previousEngine: "slide",
    });
    expect(routed.engine).toBe("spreadsheet");
    expect(routed.confidence).toBe(0.9);
  });

  test("continuation without a previous turn falls through to verbs", () => {
    const result = routeByRules("perbaiki bug ini");
    expect(result.engine).toBe("coding");
    expect(result.matchedRule).toBe("domain_verb");
  });
});

describe("routeByRules — ambiguity handling", () => {
  test("multi-engine hit drops below threshold (→ layer B / clarify)", () => {
    const result = routeByRules("buatkan presentasi dari data spreadsheet");
    expect(result.confidence).toBeLessThan(RULE_CONFIDENCE_THRESHOLD);
    expect(result.matchedRule).toBe("domain_verb_multi");
  });

  test('"tolong bereskan ini" is low-confidence (→ clarify path)', () => {
    const result = routeByRules("tolong bereskan ini");
    expect(result.confidence).toBeLessThan(RULE_CONFIDENCE_THRESHOLD);
  });

  test("engine override always wins", () => {
    const result = routeByRules("buatkan slide presentasi", {
      engineOverride: "research",
    });
    expect(result.engine).toBe("research");
    expect(result.confidence).toBe(1);
    expect(result.matchedRule).toBe("engine_override");
  });

  test("unknown message defaults to coding, low confidence", () => {
    const result = routeByRules("halo");
    expect(result.engine).toBe("coding");
    expect(result.matchedRule).toBe("default");
  });
});

describe("resolveReferences", () => {
  function runWithArtifacts(): RunContext {
    const run = createWorkflowRun("/ws");
    // Artifacts go through the timeline (updateTurn -> task_end event);
    // resolveReferences queries the timeline, not the deprecated turns view.
    const t1 = appendTurn(run, {
      engine: "coding",
      task_id: "t1",
      goal: "buat landing page Vue",
      status: "running",
    });
    updateTurn(run, t1.turn_id, {
      status: "done",
      artifacts: [{ kind: "files", label: "landing page Vue", path: "index.html" }],
    });
    const t2 = appendTurn(run, {
      engine: "slide",
      task_id: "t2",
      goal: "buatkan slide",
      status: "running",
    });
    updateTurn(run, t2.turn_id, {
      status: "done",
      artifacts: [{ kind: "deck", label: "deck presentasi", path: "deck/deck.json" }],
    });
    return run;
  }

  test('"dari landing page tadi" resolves the latest artifacts', () => {
    const refs = resolveReferences("dari landing page tadi buatkan slide", runWithArtifacts());
    expect(refs).toHaveLength(1);
    expect(refs[0]!.kind).toBe("deck");
  });

  test('"dari slide tadi" resolves the slide turn', () => {
    const refs = resolveReferences("dari slide tadi tambahkan grafik", runWithArtifacts());
    expect(refs[0]!.path).toBe("deck/deck.json");
  });

  test("running turn without artifacts → pending ref from its goal", () => {
    const run = createWorkflowRun("/ws");
    appendTurn(run, {
      engine: "coding",
      task_id: "t1",
      goal: "buat landing page Vue",
      status: "running",
    });
    const refs = resolveReferences("dari landing page tadi buatkan slide", run);
    expect(refs).toHaveLength(1);
    expect(refs[0]!.kind).toBe("files");
    expect(refs[0]!.label).toContain("buat landing page Vue");
    expect(refs[0]!.label).toContain("masih berjalan");
  });

  test("no continuation word → no refs", () => {
    expect(resolveReferences("buatkan slide baru", runWithArtifacts())).toEqual([]);
  });

  test("empty run → no refs", () => {
    expect(resolveReferences("lanjutkan itu", createWorkflowRun("/ws"))).toEqual([]);
  });
});

describe("formatResolvedForGoal", () => {
  test("renders refs as goal context", () => {
    const text = formatResolvedForGoal([
      { kind: "deck", label: "deck presentasi", path: "deck/deck.json" },
    ]);
    expect(text).toContain("deck/deck.json");
    expect(text).toContain("jangan dibuat ulang");
  });

  test("empty refs → empty string", () => {
    expect(formatResolvedForGoal([])).toBe("");
  });
});

describe("isConversationalMessage — chat-first guard", () => {
  const chat = [
    "1 + 1 berapa?",
    "Siapa Windah Basudara?",
    "Apa perbedaan React dan Vue?",
    "Kenapa langit berwarna biru?",
    "Bagaimana cara membuat landing page?",
    "Jelaskan kode ini tanpa mengubahnya.",
    "how to create a landing page?",
    "explain this code without modifying it",
  ];
  for (const message of chat) {
    test(`chat: "${message}"`, () => {
      expect(isConversationalMessage(message)).toBe(true);
    });
  }

  const work = [
    "Buatkan landing page HTML tentang AI di folder huhu.",
    "Perbaiki bug pada project ini.",
    "Refactor modul autentikasi.",
    "Buatkan PPTX tentang kecerdasan buatan.",
    "Analisis spreadsheet ini dan buat laporan.",
    "Buatkan dokumen proposal di workspace ini.",
  ];
  for (const message of work) {
    test(`work: "${message}"`, () => {
      expect(isConversationalMessage(message)).toBe(false);
    });
  }

  test("explicit override still wins: guard is bypassed by the caller", () => {
    const routed = routeByRules("Bagaimana cara membuat landing page?", {
      engineOverride: "coding",
    });
    expect(routed.engine).toBe("coding");
    expect(routed.matchedRule).toBe("engine_override");
  });
});

describe("layer B prompt + parse", () => {
  test("prompt lists all five engines and demands closed JSON", () => {
    const { system } = buildLayerBPrompt("tolong bereskan ini");
    for (const engine of ["coding", "slide", "dokumen", "spreadsheet", "research"]) {
      expect(system).toContain(engine);
    }
    expect(system).toContain("needs_clarify");
  });

  test("parses a valid closed JSON answer", () => {
    const parsed = parseLayerBResponse(
      'Hasil:\n{"engine": "slide", "confidence": 0.8, "needs_clarify": false}',
    );
    expect(parsed).toEqual({ engine: "slide", confidence: 0.8, needs_clarify: false });
  });

  test("rejects unknown engine", () => {
    expect(
      parseLayerBResponse('{"engine": "music", "confidence": 0.9, "needs_clarify": false}'),
    ).toBeUndefined();
  });

  test("rejects garbage", () => {
    expect(parseLayerBResponse("maaf tidak tahu")).toBeUndefined();
    expect(parseLayerBResponse('{"engine": "slide"}')).toBeDefined();
  });

  test("clamps confidence and defaults it", () => {
    expect(parseLayerBResponse('{"engine": "coding", "confidence": 9}')!.confidence).toBe(1);
    expect(parseLayerBResponse('{"engine": "coding"}')!.confidence).toBe(0.5);
  });
});
