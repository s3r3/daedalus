// Unit tests for dae-captain/ui/cards.js — chat action cards (Fase 7).
// Renders every card kind from sample SERVER data (never hardcoded HTML),
// clicks each button, and asserts the mocked api received the right call.
// Run: node --test tests/chat-cards.test.js
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", { url: "http://localhost/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
globalThis.Blob = dom.window.Blob;
globalThis.URL = dom.window.URL;
// jsdom has no clipboard — stub it.
let clipboardText = "";
globalThis.navigator.clipboard = {
  writeText: async (t) => {
    clipboardText = t;
  },
};

const { renderCard, renderVerifyFail, slideTitle, buildBibtex, CARD_KINDS } = await import("../ui/cards.js");

/** Mock api: every method records its call and resolves a canned value. */
function mockApi(overrides = {}) {
  const calls = [];
  const mk = (name, value) => async (...args) => {
    calls.push({ name, args });
    return typeof value === "function" ? value(...args) : value;
  };
  const api = {
    slideUpdate: mk("slideUpdate", { deck: {} }),
    slideTheme: mk("slideTheme", {}),
    slideGenerate: mk("slideGenerate", { task_id: "t-gen" }),
    slideRegenerate: mk("slideRegenerate", {}),
    slideDeck: mk("slideDeck", { deck: { title: "D", slides: [] } }),
    builtinTemplates: mk("builtinTemplates", { templates: [] }),
    pptTemplates: mk("pptTemplates", { templates: [] }),
    importPptTemplate: mk("importPptTemplate", { template: { name: "Impor" } }),
    slideArchive: mk("slideArchive", { archived: [] }),
    slideArchiveRestore: mk("slideArchiveRestore", {}),
    dokumenExportDocument: mk("dokumenExportDocument", { result: { path: ".daedalus/documents/1/exports/dokumen-x.md", format: "md" } }),
    dokumenExportData: mk("dokumenExportData", { result: { path: ".daedalus/documents/1/exports/data.json", recordCount: 2 } }),
    dokumenDocument: mk("dokumenDocument", { document: { sections: [] } }),
    dokumenSection: mk("dokumenSection", {}),
    sheetsGenerate: mk("sheetsGenerate", { summary: "ok" }),
    sheetsWorkbook: mk("sheetsWorkbook", { workbook: { sheets: [{ name: "S1", cells: {} }] } }),
    sheetsWorkbookSave: mk("sheetsWorkbookSave", {}),
    sheetsCheckpoints: mk("sheetsCheckpoints", { checkpoints: [] }),
    sheetsRestore: mk("sheetsRestore", {}),
    sheetsAnalyzeRun: mk("sheetsAnalyzeRun", { report: { summary: "Tren naik." } }),
    researchPlan: mk("researchPlan", { planId: "p2", plan: { question: "q", subQuestions: [] }, depth: "mendalam" }),
    researchRun: mk("researchRun", {}),
    researchReport: mk("researchReport", { report: {} }),
    captainPlanGet: mk("captainPlanGet", { execution: { status: "done", subTasks: [] } }),
    captainPlanExecute: mk("captainPlanExecute", { status: "executing", sub_tasks: [] }),
    captainUndoList: mk("captainUndoList", { entries: [] }),
    captainUndoApply: mk("captainUndoApply", { undone: true, summary: "edit slide 1" }),
    cancelTask: mk("cancelTask", {}),
    pauseTask: mk("pauseTask", {}),
    resumeTask: mk("resumeTask", {}),
    captainDownloadUrl: (root, path) => `http://x/captain/download?path=${path}`,
    researchReportDocxUrl: (id) => `http://x/captain/research/report/${id}/export?format=docx`,
    slideDownloadUrl: (root) => `http://x/slides/deck/download?root=${root}`,
    sheetsExportUrl: (root) => `http://x/sheets/workbook/download?root=${root}`,
    downloadFile: mk("downloadFile", true),
    ...overrides,
  };
  return { api, calls };
}

function mockCtx(api, extra = {}) {
  const events = [];
  return {
    ctx: {
      api,
      invoke: null,
      workspaceRoot: "/ws",
      taskId: "task-1",
      runId: "run-1",
      notify: (t) => events.push(["notify", t]),
      say: (t) => events.push(["say", t]),
      sendChat: (t) => events.push(["sendChat", t]),
      openPreview: (info) => events.push(["openPreview", info]),
      onDeliverable: (info) => events.push(["onDeliverable", info]),
      onGenerated: (engine) => events.push(["onGenerated", engine]),
      retryGoal: "buatkan slide",
      ...extra,
    },
    events,
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/** Click a button found by its visible text inside a card. */
async function clickBtn(card, text) {
  const btn = [...card.querySelectorAll("button")].find((b) => b.textContent.includes(text));
  assert.ok(btn, `button "${text}" exists`);
  btn.click();
  await tick();
  await tick();
  return btn;
}

describe("CARD_KINDS", () => {
  it("covers every engine card the design requires", () => {
    for (const k of [
      "slide-outline", "dokumen-outline", "dokumen-extraction",
      "sheets-blueprint", "sheets-analyze-plan",
      "research-plan", "research-report", "task-plan",
      "deliverable", "progress",
    ]) {
      assert.ok(CARD_KINDS.includes(k), k);
    }
  });

  it("throws for unknown kinds (caller shows a fallback)", () => {
    const { api } = mockApi();
    const { ctx } = mockCtx(api);
    assert.throws(() => renderCard("nope", {}, ctx), /unknown card kind/);
  });
});

describe("slide-outline card", () => {
  const deckData = () => ({
    deck: {
      title: "Skripsi",
      slides: [
        { id: "s1", layout: "title", content: { title: "Judul", bullets: ["a", "b"] }, status: "skeleton" },
        { id: "s2", layout: "bullets", content: { title: "Pustaka" }, status: "skeleton" },
        { id: "s3", layout: "bullets", content: { title: "Metode" }, status: "skeleton" },
        { id: "s4", layout: "bullets", content: { title: "Hasil" }, status: "skeleton" },
      ],
    },
    templates: [
      { id: "modern", name: "Modern" },
      { id: "elegan", name: "Elegan" },
    ],
    importedTemplates: [{ id: "imp1", name: "Kampus" }],
  });

  it("renders outline rows from server data + [Lihat semua]", async () => {
    const { api } = mockApi();
    const { ctx } = mockCtx(api);
    const card = renderCard("slide-outline", deckData(), ctx);
    // collapsed: 3 rows + [Lihat semua]
    assert.equal(card.querySelectorAll(".dc-row").length, 3);
    await clickBtn(card, "Lihat semua");
    assert.equal(card.querySelectorAll(".dc-row").length, 4);
    assert.match(card.textContent, /Judul/);
  });

  it("✏️ inline edit calls slideUpdate with the edited content", async () => {
    const { api, calls } = mockApi();
    const { ctx } = mockCtx(api);
    const card = renderCard("slide-outline", deckData(), ctx);
    await clickBtn(card, "✏️");
    const titleInput = card.querySelector(".dc-editor input");
    assert.ok(titleInput, "editor opens");
    titleInput.value = "Judul Baru";
    card.querySelector(".dc-editor textarea").value = "x\ny";
    await clickBtn(card, "Simpan");
    const call = calls.find((c) => c.name === "slideUpdate");
    assert.ok(call, "slideUpdate called");
    assert.deepEqual(call.args[0], {
      root: "/ws",
      slide_id: "s1",
      content: { title: "Judul Baru", bullets: ["x", "y"] },
      notes: "",
      run_id: "task-1",
    });
  });

  it("🗒️ speaker notes disimpan via slideUpdate + badge tampil di baris", async () => {
    const { api, calls } = mockApi();
    const { ctx } = mockCtx(api);
    const card = renderCard("slide-outline", deckData(), ctx);
    await clickBtn(card, "✏️");
    const areas = card.querySelectorAll(".dc-editor textarea");
    const notesArea = areas[areas.length - 1];
    notesArea.value = "Buka dengan salam, lalu jelaskan latar belakang.";
    await clickBtn(card, "Simpan");
    const call = calls.find((c) => c.name === "slideUpdate");
    assert.ok(call, "slideUpdate called");
    assert.equal(call.args[0].notes, "Buka dengan salam, lalu jelaskan latar belakang.");

    // Badge 🗒️ muncul pada baris yang sudah punya notes.
    const data = deckData();
    data.deck.slides[0].notes = "Catatan lama";
    const card2 = renderCard("slide-outline", data, ctx);
    assert.match(card2.textContent, /🗒️/);
  });

  it("template button calls slideTheme", async () => {
    const { api, calls } = mockApi();
    const { ctx } = mockCtx(api);
    const card = renderCard("slide-outline", deckData(), ctx);
    await clickBtn(card, "Elegan");
    const call = calls.find((c) => c.name === "slideTheme");
    assert.ok(call, "slideTheme called");
    assert.deepEqual(call.args[0], { root: "/ws", template_id: "elegan", run_id: "task-1" });
  });

  it("[Buat Slide] calls slideGenerate", async () => {
    const { api, calls } = mockApi();
    const { ctx, events } = mockCtx(api);
    const card = renderCard("slide-outline", deckData(), ctx);
    await clickBtn(card, "Buat Slide");
    const call = calls.find((c) => c.name === "slideGenerate");
    assert.ok(call, "slideGenerate called");
    assert.deepEqual(call.args[0], { root: "/ws", run_id: "task-1" });
    assert.ok(events.some((e) => e[0] === "onGenerated" && e[1] === "slide"));
  });
});

describe("dokumen-outline card", () => {
  const docData = () => ({
    document: {
      id: "d1",
      title: "Makalah AI",
      sections: [
        { id: "sec1", title: "Pendahuluan", thesisPoints: ["p1", "p2"] },
        { id: "sec2", title: "Metode", thesisPoints: [] },
      ],
    },
  });

  it("renders sections from server data", () => {
    const { api } = mockApi();
    const { ctx } = mockCtx(api);
    const card = renderCard("dokumen-outline", docData(), ctx);
    assert.match(card.textContent, /Pendahuluan/);
    assert.match(card.textContent, /2 poin/);
  });

  it("[MD] + [Buat Makalah] calls export-document with md and yields a deliverable", async () => {
    const { api, calls } = mockApi();
    const { ctx, events } = mockCtx(api);
    const card = renderCard("dokumen-outline", docData(), ctx);
    await clickBtn(card, "MD");
    await clickBtn(card, "Buat Makalah");
    const call = calls.find((c) => c.name === "dokumenExportDocument");
    assert.ok(call, "dokumenExportDocument called");
    assert.equal(call.args[0].format, "md");
    assert.equal(call.args[0].root, "/ws");
    const delivered = events.find((e) => e[0] === "onDeliverable");
    assert.ok(delivered, "deliverable emitted");
    assert.equal(delivered[1].kind, "md");
  });
});

describe("dokumen-extraction card", () => {
  const extData = () => ({
    document: {
      records: [
        {
          id: "r1",
          fields: {
            nama: { value: "PT Maju", confidence: 0.95, status: "auto" },
            npwp: { value: "12.345", confidence: 0.4, status: "flagged" },
          },
        },
        { id: "r2", fields: {} },
      ],
    },
  });

  it("renders fields with confidence and ⚠️ on low-confidence", () => {
    const { api } = mockApi();
    const { ctx } = mockCtx(api);
    const card = renderCard("dokumen-extraction", extData(), ctx);
    assert.match(card.textContent, /PT Maju/);
    assert.match(card.textContent, /95%/);
    assert.match(card.textContent, /40%/);
    assert.ok(card.querySelector(".dc-warn"), "warning marker present");
  });

  it("[JSON] exports then downloads real bytes", async () => {
    const { api, calls } = mockApi();
    const { ctx } = mockCtx(api);
    const card = renderCard("dokumen-extraction", extData(), ctx);
    await clickBtn(card, "JSON");
    const exp = calls.find((c) => c.name === "dokumenExportData");
    assert.ok(exp, "export-data called");
    assert.equal(exp.args[0].format, "json");
    const dl = calls.find((c) => c.name === "downloadFile");
    assert.ok(dl, "downloadFile called");
    assert.match(dl.args[0], /data\.json/);
  });

  it("[Copy] writes records JSON to the clipboard", async () => {
    clipboardText = "";
    const { api } = mockApi();
    const { ctx } = mockCtx(api);
    const card = renderCard("dokumen-extraction", extData(), ctx);
    await clickBtn(card, "Copy");
    assert.match(clipboardText, /PT Maju/);
  });
});

describe("sheets-blueprint card", () => {
  it("[Buat Workbook] calls sheetsGenerate", async () => {
    const { api, calls } = mockApi();
    const { ctx, events } = mockCtx(api);
    const card = renderCard("sheets-blueprint", {
      workbook: {
        title: "Penjualan",
        blueprint: {
          goal: "Rekap",
          sheets: [{ name: "Data", purpose: "Transaksi" }],
        },
      },
    }, ctx);
    assert.match(card.textContent, /Data/);
    await clickBtn(card, "Buat Workbook");
    const call = calls.find((c) => c.name === "sheetsGenerate");
    assert.ok(call, "sheetsGenerate called");
    assert.deepEqual(call.args[0], { root: "/ws", run_id: "task-1" });
    assert.ok(events.some((e) => e[0] === "onGenerated" && e[1] === "spreadsheet"));
  });
});

describe("sheets-analyze-plan card", () => {
  it("[Setujui & Jalankan] calls sheetsAnalyzeRun with the planId", async () => {
    const { api, calls } = mockApi();
    const { ctx, events } = mockCtx(api);
    const card = renderCard("sheets-analyze-plan", {
      planId: "ap-1",
      plan: {
        question: "Tren penjualan?",
        metrics: [{ name: "total", aggregation: "sum" }],
        steps: ["hitung total"],
      },
      complexity: "simple",
    }, ctx);
    assert.match(card.textContent, /Tren penjualan/);
    await clickBtn(card, "Setujui & Jalankan");
    const call = calls.find((c) => c.name === "sheetsAnalyzeRun");
    assert.ok(call, "sheetsAnalyzeRun called");
    assert.deepEqual(call.args[0], { planId: "ap-1" });
    assert.ok(events.some((e) => e[0] === "say" && /Tren naik/.test(e[1])));
  });
});

describe("research-plan card", () => {
  const planData = () => ({
    planId: "rp-1",
    plan: {
      question: "Apa itu Sinta?",
      subQuestions: [{ id: "q1", text: "Definisi" }],
      sourceStrategy: "Prioritaskan jurnal.",
      budget: { maxQueries: 8, maxSources: 10 },
    },
    depth: "standar",
  });

  it("[Mendalam] re-stages the plan with depth=mendalam", async () => {
    const { api, calls } = mockApi();
    const { ctx } = mockCtx(api);
    const card = renderCard("research-plan", planData(), ctx);
    await clickBtn(card, "Mendalam");
    const call = calls.find((c) => c.name === "researchPlan");
    assert.ok(call, "researchPlan called");
    assert.equal(call.args[0].depth, "mendalam");
    assert.equal(call.args[0].question, "Apa itu Sinta?");
  });

  it("[Mulai Riset] calls researchRun with the planId", async () => {
    const { api, calls } = mockApi();
    const { ctx } = mockCtx(api);
    const card = renderCard("research-plan", planData(), ctx);
    await clickBtn(card, "Mulai Riset");
    const call = calls.find((c) => c.name === "researchRun");
    assert.ok(call, "researchRun called");
    assert.deepEqual(call.args[0], { planId: "rp-1" });
  });
});

describe("research-report card", () => {
  const reportData = () => ({
    report: {
      reportId: "rep-12345678",
      question: "Apa itu Sinta?",
      summary: "Sinta adalah portal.",
      sections: [{ id: "s1", title: "Hasil", claimIds: ["c1"] }],
      claims: [
        {
          id: "c1", text: "Sinta mengindeks jurnal.",
          sourceIds: ["src1"], excerpts: ["mengindeks jurnal nasional"],
          confidence: "high", status: "verified",
        },
      ],
      sources: [
        { id: "src1", title: "Sinta", url: "https://sinta.kemdikbud.go.id", authors: ["Kemendikbud"], year: 2024 },
      ],
      conflicts: [],
      limitations: [],
      bibliography: { apa: [], ieee: [] },
      verification: { claimsVerified: 1, claimsDropped: 0, gatePassed: true },
    },
  });

  it("renders verification stats from server data", () => {
    const { api } = mockApi();
    const { ctx } = mockCtx(api);
    const card = renderCard("research-report", reportData(), ctx);
    assert.match(card.textContent, /1 klaim terverifikasi/);
    assert.match(card.textContent, /1 sumber/);
  });

  it("[DOCX] downloads via the real export URL", async () => {
    const { api, calls } = mockApi();
    const { ctx } = mockCtx(api);
    const card = renderCard("research-report", reportData(), ctx);
    await clickBtn(card, "DOCX");
    const dl = calls.find((c) => c.name === "downloadFile");
    assert.ok(dl, "downloadFile called");
    assert.match(dl.args[0], /\/captain\/research\/report\/rep-12345678\/export\?format=docx/);
    assert.match(dl.args[1], /\.docx$/);
  });

  it("[Telusur klaim] reveals claim → source trace", async () => {
    const { api } = mockApi();
    const { ctx } = mockCtx(api);
    const card = renderCard("research-report", reportData(), ctx);
    const trace = card.querySelector(".dc-trace");
    assert.ok(trace.classList.contains("dc-hidden"), "trace hidden first");
    await clickBtn(card, "Telusur klaim");
    assert.ok(!trace.classList.contains("dc-hidden"), "trace revealed");
    assert.match(trace.textContent, /Sinta mengindeks jurnal/);
    assert.match(trace.textContent, /mengindeks jurnal nasional/);
  });
});

describe("task-plan card", () => {
  const taskPlanData = () => ({
    plan_id: "plan-1",
    plan: {
      goal: "riset lalu slide",
      tasks: [
        { id: "s1", engine: "research", goal: "riset kopi", dependsOn: [] },
        { id: "s2", engine: "slide", goal: "slide kopi", dependsOn: ["s1"] },
      ],
    },
  });

  it("renders sub-tasks with engines and dependencies", () => {
    const { api } = mockApi();
    const { ctx } = mockCtx(api);
    const card = renderCard("task-plan", taskPlanData(), ctx);
    assert.match(card.textContent, /research/);
    assert.match(card.textContent, /← s1/);
  });

  it("[Jalankan] calls captainPlanExecute", async () => {
    const { api, calls } = mockApi();
    const { ctx } = mockCtx(api);
    const card = renderCard("task-plan", taskPlanData(), ctx);
    await clickBtn(card, "Jalankan");
    const call = calls.find((c) => c.name === "captainPlanExecute");
    assert.ok(call, "captainPlanExecute called");
    assert.equal(call.args[0], "plan-1");
  });
});

describe("deliverable card", () => {
  const delData = () => ({
    name: "presentasi.pptx",
    label: "Skripsi",
    kind: "pptx",
    engine: "slide",
    taskId: "task-1",
    url: "http://x/slides/deck/download?root=/ws",
  });

  it("renders every deliverable button for slide", () => {
    const { api } = mockApi();
    const { ctx } = mockCtx(api);
    const card = renderCard("deliverable", delData(), ctx);
    for (const label of ["Download", "Preview", "Edit", "Varian", "Undo", "Versi", "Coba lagi"]) {
      assert.ok([...card.querySelectorAll("button")].some((b) => b.textContent.includes(label)), label);
    }
  });

  it("[Download] fetches the real URL", async () => {
    const { api, calls } = mockApi();
    const { ctx } = mockCtx(api);
    const card = renderCard("deliverable", delData(), ctx);
    await clickBtn(card, "Download");
    const dl = calls.find((c) => c.name === "downloadFile");
    assert.ok(dl, "downloadFile called");
    assert.equal(dl.args[0], "http://x/slides/deck/download?root=/ws");
    assert.equal(dl.args[1], "presentasi.pptx");
  });

  it("[Preview] opens the overlay", async () => {
    const { api } = mockApi();
    const { ctx, events } = mockCtx(api);
    const card = renderCard("deliverable", delData(), ctx);
    await clickBtn(card, "Preview");
    const opened = events.find((e) => e[0] === "openPreview");
    assert.ok(opened, "openPreview called");
    assert.equal(opened[1].kind, "pptx");
  });

  it("[Undo] calls captainUndoApply with the run id", async () => {
    const { api, calls } = mockApi();
    const { ctx, events } = mockCtx(api);
    const card = renderCard("deliverable", delData(), ctx);
    await clickBtn(card, "Undo");
    const call = calls.find((c) => c.name === "captainUndoApply");
    assert.ok(call, "captainUndoApply called");
    assert.equal(call.args[0].run_id, "task-1");
    assert.ok(events.some((e) => e[0] === "say" && /edit slide 1/.test(e[1])));
  });

  it("[Coba lagi] re-sends the original goal", async () => {
    const { api } = mockApi();
    const { ctx, events } = mockCtx(api);
    const card = renderCard("deliverable", delData(), ctx);
    await clickBtn(card, "Coba lagi");
    const resent = events.find((e) => e[0] === "sendChat");
    assert.ok(resent, "sendChat called");
    assert.equal(resent[1], "buatkan slide");
  });

  it("research deliverables hide Edit/Versi/Varian (immutable report)", () => {
    const { api } = mockApi();
    const { ctx } = mockCtx(api);
    const card = renderCard("deliverable", { ...delData(), engine: "research", kind: "pdf" }, ctx);
    const labels = [...card.querySelectorAll("button")].map((b) => b.textContent);
    assert.ok(!labels.some((l) => l.includes("Varian")), "no Varian");
    assert.ok(!labels.some((l) => l.includes("Versi")), "no Versi");
    assert.ok(labels.some((l) => l.includes("Download")), "Download stays");
  });
});

describe("progress card", () => {
  it("renders fraction + [✕]/[⏸] wired to real task controls", async () => {
    const { api, calls } = mockApi();
    const { ctx } = mockCtx(api);
    const card = renderCard("progress", {
      taskId: "task-9",
      phase: "Mengisi slide 8/12",
      fraction: { current: 8, total: 12 },
      status: "running",
    }, ctx);
    assert.match(card.textContent, /8\/12/);
    await clickBtn(card, "Jeda");
    assert.ok(calls.some((c) => c.name === "pauseTask" && c.args[0] === "task-9"), "pauseTask called");
    await clickBtn(card, "Batal");
    assert.ok(calls.some((c) => c.name === "cancelTask" && c.args[0] === "task-9"), "cancelTask called");
  });

  it("paused state offers resume", async () => {
    const { api, calls } = mockApi();
    const { ctx } = mockCtx(api);
    const card = renderCard("progress", { taskId: "t", status: "paused" }, ctx);
    await clickBtn(card, "Lanjutkan");
    assert.ok(calls.some((c) => c.name === "resumeTask"), "resumeTask called");
  });
});

describe("verify-fail bubble", () => {
  it("renders the failure reason as a chat bubble", () => {
    const el = renderVerifyFail("slide 5 overflow");
    assert.match(el.textContent, /slide 5 overflow/);
    assert.match(el.textContent, /perbaiki dulu/);
    assert.ok(el.classList.contains("verify-fail"));
  });
});

describe("slideTitle + buildBibtex", () => {
  it("prefers content.title, falls back to first bullet, then layout", () => {
    assert.equal(slideTitle({ content: { title: "Judul" }, layout: "x" }), "Judul");
    assert.equal(slideTitle({ content: { bullets: ["Poin satu"] }, layout: "x" }), "Poin satu");
    assert.equal(slideTitle({ content: {}, layout: "title" }), "title");
  });

  it("builds valid BibTeX from report sources", () => {
    const bib = buildBibtex({
      sources: [
        { id: "s1", title: "Sinta", authors: ["Kemendikbud"], year: 2024, url: "https://x", doi: "10.1/y" },
      ],
    });
    assert.match(bib, /@misc\{src_s1,/);
    assert.match(bib, /author = \{Kemendikbud\}/);
    assert.match(bib, /doi = \{10\.1\/y\}/);
  });
});

// ---------------------------------------------------------------------------
// FASE C: fitur Dokumen Dae Captain v2 (desain 4.1 template dokumen).
// ---------------------------------------------------------------------------

describe("FASE C — dokumen-doc-templates card", () => {
  const templatesData = () => ({
    templates: [
      {
        id: "makalah",
        name: "Makalah",
        description: "Struktur akademik.",
        sections: [
          { title: "Abstrak", contentPrompt: "Ringkasan 150 kata." },
          { title: "Pendahuluan", contentPrompt: "Latar belakang." },
        ],
      },
      {
        id: "surat-resmi",
        name: "Surat Resmi",
        description: "Format surat dinas.",
        sections: [{ title: "Kop Surat", contentPrompt: "Nama instansi." }],
      },
    ],
  });

  it("is a registered card kind and renders every template from server data", () => {
    const { api } = mockApi();
    const { ctx } = mockCtx(api);
    assert.ok(CARD_KINDS.includes("dokumen-doc-templates"));
    const card = renderCard("dokumen-doc-templates", templatesData(), ctx);
    assert.match(card.textContent, /Makalah/);
    assert.match(card.textContent, /Surat Resmi/);
    assert.match(card.textContent, /2 bagian/);
  });

  it("Pilih stages the template outline via the real API and notifies", async () => {
    const { api, calls } = mockApi({
      dokumenOutline: async (body) => {
        calls.push({ name: "dokumenOutline", args: [body] });
        return { document: { sections: body.sections.map((s, i) => ({ id: `s${i}`, ...s })) } };
      },
      dokumenDocTemplates: async () => templatesData(),
    });
    const { ctx, events } = mockCtx(api);
    const card = renderCard("dokumen-doc-templates", templatesData(), ctx);
    await clickBtn(card, "Pilih");
    const call = calls.find((c) => c.name === "dokumenOutline");
    assert.ok(call, "dokumenOutline called");
    const body = call.args[0];
    assert.equal(body.root, "/ws");
    assert.equal(body.sections.length, 2);
    assert.equal(body.sections[0].title, "Abstrak");
    assert.deepEqual(body.sections[0].thesisPoints, ["Ringkasan 150 kata."]);
    assert.ok(events.some(([k, t]) => k === "notify" && /Makalah/.test(t)), "notify mentions template");
    assert.ok(events.some(([k, t]) => k === "say" && /terisi/.test(t)), "chat bubble explains next step");
  });

  it("shows a hint when the server has no templates", () => {
    const { api } = mockApi();
    const { ctx } = mockCtx(api);
    const card = renderCard("dokumen-doc-templates", { templates: [] }, ctx);
    assert.match(card.textContent, /tidak tersedia/);
  });
});
