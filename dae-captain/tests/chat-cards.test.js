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
    slideVariants: mk("slideVariants", {
      variants: [
        { id: "klasik", label: "Klasik", description: "Tata letak bawaan template.", positions: {} },
        { id: "terpusat", label: "Terpusat", description: "Judul di tengah atas.", positions: { title: { x: 0.22, y: 0.06, w: 0.56 } } },
        { id: "melebar", label: "Melebar", description: "Isi selebar slide.", positions: { title: { x: 0.08, y: 0.05, w: 0.84 } } },
      ],
    }),
    slideTheme: mk("slideTheme", {}),
    slideGenerate: mk("slideGenerate", { task_id: "t-gen" }),
    slideRegenerate: mk("slideRegenerate", {}),
    slideDeck: mk("slideDeck", { deck: { title: "D", slides: [] } }),
    slideRecommendTemplate: mk("slideRecommendTemplate", {
      template_id: "cendekia",
      name: "Naskah Cendekia",
      reason: "Cocok untuk sidang skripsi — formal dan bersih.",
    }),
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

  it("template button calls slideTheme with design_id (builtin design templates)", async () => {
    const { api, calls } = mockApi();
    const { ctx } = mockCtx(api);
    const card = renderCard("slide-outline", deckData(), ctx);
    await clickBtn(card, "Elegan");
    const call = calls.find((c) => c.name === "slideTheme");
    assert.ok(call, "slideTheme called");
    assert.deepEqual(call.args[0], { root: "/ws", design_id: "elegan", run_id: "task-1" });
  });

  it("⭐ rekomendasi: badge + alasan + chip terapkan via design_id", async () => {
    const { api, calls } = mockApi();
    const { ctx } = mockCtx(api);
    const data = deckData();
    data.templates = [
      { id: "standar", name: "Daedalus Standar" },
      { id: "cendekia", name: "Naskah Cendekia" },
    ];
    const card = renderCard("slide-outline", data, ctx);
    await tick(); await tick(); await tick();
    assert.match(card.textContent, /⭐ Direkomendasikan: Naskah Cendekia/);
    assert.match(card.textContent, /formal dan bersih/);
    const recBtn = [...card.querySelectorAll("button")].find((b) => b.textContent.startsWith("⭐"));
    assert.ok(recBtn, "recommended chip carries the star");
    recBtn.click();
    await tick(); await tick();
    const call = calls.find((c) => c.name === "slideTheme");
    assert.ok(call, "slideTheme called");
    assert.deepEqual(call.args[0], { root: "/ws", design_id: "cendekia", run_id: "task-1" });
  });

  it("🎨 varian per slide: tampilkan 3 opsi, Pilih terapkan positions", async () => {
    const { api, calls } = mockApi();
    const { ctx, events } = mockCtx(api);
    const card = renderCard("slide-outline", deckData(), ctx);
    await clickBtn(card, "🎨");
    assert.match(card.textContent, /A\. Klasik/);
    assert.match(card.textContent, /B\. Terpusat/);
    assert.match(card.textContent, /C\. Melebar/);
    const svCall = calls.find((c) => c.name === "slideVariants");
    assert.ok(svCall, "slideVariants called");
    assert.deepEqual(svCall.args[0], { root: "/ws", slide_id: "s1", run_id: "task-1" });
    await clickBtn(card, "Pilih");
    const upCall = calls.find((c) => c.name === "slideUpdate");
    assert.ok(upCall, "slideUpdate called");
    assert.deepEqual(upCall.args[0], { root: "/ws", slide_id: "s1", positions: {}, run_id: "task-1" });
    assert.ok(events.some((e) => e[0] === "say" && /Slide 1 pakai desain A/.test(e[1])), "say confirms the pick");
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

describe("FASE C — dokumen-compare card", () => {
  const comparison = () => ({
    blocks: [
      { kind: "same", oldIndex: 0, newIndex: 0, oldText: "KONTRAK", newText: "KONTRAK" },
      { kind: "changed", oldIndex: 1, newIndex: 1, oldText: "Denda 2% per hari.", newText: "Denda 5% per hari.", detail: "«2%» → «5%»" },
      { kind: "removed", oldIndex: 2, oldText: "Pasal lama dihapus." },
      { kind: "added", newIndex: 2, newText: "Pasal baru ditambah." },
    ],
    counts: { added: 1, removed: 1, changed: 1, same: 1 },
    summary: ["~ Denda 2%: «2%» → «5%»"],
  });

  it("is registered and renders the change list with markers", () => {
    const { api } = mockApi();
    const { ctx } = mockCtx(api);
    assert.ok(CARD_KINDS.includes("dokumen-compare"));
    const card = renderCard("dokumen-compare", { fileA: "v1.txt", fileB: "v2.txt", comparison: comparison() }, ctx);
    assert.match(card.textContent, /1 diubah/);
    assert.match(card.textContent, /Denda 2% per hari/);
    assert.ok(card.querySelectorAll("button").length >= 3, "each change has a detail button");
  });

  it("[👁️ Lihat detail] toggles a side-by-side word-highlighted pane", async () => {
    const { api } = mockApi();
    const { ctx } = mockCtx(api);
    const card = renderCard("dokumen-compare", { fileA: "v1.txt", fileB: "v2.txt", comparison: comparison() }, ctx);
    assert.equal(card.querySelectorAll(".dc-diff-detail").length, 0);
    await clickBtn(card, "Lihat detail");
    const panes = card.querySelectorAll(".dc-diff-detail");
    assert.equal(panes.length, 1);
    assert.match(panes[0].textContent, /Denda/);
    assert.ok(panes[0].querySelector(".dc-wdel") || panes[0].querySelector(".dc-wins"), "word highlight spans exist");
    await clickBtn(card, "Tutup detail");
    assert.equal(card.querySelectorAll(".dc-diff-detail").length, 0);
  });

  it("without comparison data, [⚖️ Bandingkan] calls the API and renders results", async () => {
    const { api, calls } = mockApi({
      dokumenCompare: async (body) => {
        calls.push({ name: "dokumenCompare", args: [body] });
        return { fileA: "v1.txt", fileB: "v2.txt", comparison: comparison() };
      },
    });
    const { ctx } = mockCtx(api);
    const card = renderCard("dokumen-compare", { fileA: "v1.txt", fileB: "v2.txt" }, ctx);
    await clickBtn(card, "Bandingkan sekarang");
    const call = calls.find((c) => c.name === "dokumenCompare");
    assert.ok(call, "dokumenCompare called");
    assert.deepEqual(call.args[0], { root: "/ws", pathA: "v1.txt", pathB: "v2.txt" });
    assert.match(card.textContent, /1 diubah/);
  });

  it("identical documents show the no-difference hint", () => {
    const { api } = mockApi();
    const { ctx } = mockCtx(api);
    const card = renderCard(
      "dokumen-compare",
      { fileA: "a.txt", fileB: "b.txt", comparison: { blocks: [], counts: { added: 0, removed: 0, changed: 0, same: 3 }, summary: [] } },
      ctx,
    );
    assert.match(card.textContent, /identik/);
  });
});

// ---------------------------------------------------------------------------
// FASE D: Spreadsheet — Dashboard 1 perintah + Tanya jawab data.
// ---------------------------------------------------------------------------

const faseDBlueprintData = () => ({
  workbook: {
    title: "Penjualan",
    stage: "ready",
    blueprint: { goal: "rekap penjualan", sheets: [{ name: "Data", columns: [] }], assumptions: [] },
  },
});

const faseDDashboardResponse = () => ({
  summary: "Dashboard dibuat dari sheet \"Data\" (24 baris).",
  dashboardSheet: "Dashboard",
  measureColumn: "Total",
  groupColumn: "Produk",
  kpis: [
    { label: "Total Total", formula: "=SUM(Data!E$2:E$25)", column: "Total" },
    { label: "Rata-rata Total", formula: "=AVERAGE(Data!E$2:E$25)", column: "Total" },
  ],
  categories: ["Kopi Tubruk"],
  downloadPath: "workbook/penjualan.xlsx",
  notes: [],
});

describe("FASE D — sheets-quick-tools card", () => {
  it("is a registered card kind and renders the dashboard button + QA input", () => {
    const { api } = mockApi();
    const { ctx } = mockCtx(api);
    assert.ok(CARD_KINDS.includes("sheets-quick-tools"));
    const card = renderCard("sheets-quick-tools", {}, ctx);
    assert.match(card.textContent, /Buat Dashboard/);
    assert.ok(card.querySelector("input[aria-label='Tanya jawab data']"), "QA input exists");
  });

  it("📊 Buat Dashboard calls the real API and renders KPIs + a working [📥 XLSX] link", async () => {
    const { api, calls } = mockApi({
      sheetsQuickDashboard: async (body) => {
        calls.push({ name: "sheetsQuickDashboard", args: [body] });
        return faseDDashboardResponse();
      },
      sheetsDownloadUrlFor: (root, rel) => `http://localhost/sheets/workbook/download?root=${root}&path=${rel}`,
    });
    const { ctx, events } = mockCtx(api);
    const card = renderCard("sheets-quick-tools", {}, ctx);
    await clickBtn(card, "Buat Dashboard");
    const call = calls.find((c) => c.name === "sheetsQuickDashboard");
    assert.ok(call, "sheetsQuickDashboard called");
    assert.deepEqual(call.args[0], { root: "/ws" });
    assert.match(card.textContent, /Total Total/);
    const dl = [...card.querySelectorAll("a")].find((a) => a.textContent.includes("XLSX"));
    assert.ok(dl, "[📥 XLSX] link exists");
    assert.match(dl.getAttribute("href"), /workbook\/penjualan\.xlsx/);
    assert.ok(events.some(([k, e]) => k === "onGenerated" && e === "spreadsheet"), "onGenerated(spreadsheet) fired");
  });

  it("❓ Tanya calls /sheets/qa and shows the answer with its method", async () => {
    const { api, calls } = mockApi({
      sheetsQa: async (body) => {
        calls.push({ name: "sheetsQa", args: [body] });
        return {
          ok: true,
          answer: "Total \"Total\": Rp 1.900.000.",
          method: "Dihitung dari 24 baris, kolom \"Total\" di sheet \"Data\".",
        };
      },
    });
    const { ctx } = mockCtx(api);
    const card = renderCard("sheets-quick-tools", {}, ctx);
    const input = card.querySelector("input[aria-label='Tanya jawab data']");
    input.value = "Berapa total penjualan?";
    await clickBtn(card, "Tanya");
    const call = calls.find((c) => c.name === "sheetsQa");
    assert.ok(call, "sheetsQa called");
    assert.deepEqual(call.args[0], { root: "/ws", question: "Berapa total penjualan?" });
    assert.match(card.textContent, /Rp 1\.900\.000/);
    assert.match(card.textContent, /Dihitung dari 24 baris/);
  });

  it("shows the server error honestly when the dashboard cannot be built", async () => {
    const { api } = mockApi({
      sheetsQuickDashboard: async () => {
        const err = new Error("HTTP 400 POST /sheets/dashboard/quick");
        err.data = { message: "Sheet \"Data\" tidak punya kolom numerik" };
        throw err;
      },
    });
    const { ctx } = mockCtx(api);
    const card = renderCard("sheets-quick-tools", {}, ctx);
    await clickBtn(card, "Buat Dashboard");
    assert.match(card.textContent, /tidak punya kolom numerik/);
  });
});

describe("FASE D — quick bar on existing spreadsheet cards", () => {
  it("sheets-blueprint card carries the 📊 Buat Dashboard action", () => {
    const { api } = mockApi();
    const { ctx } = mockCtx(api);
    const card = renderCard("sheets-blueprint", faseDBlueprintData(), ctx);
    assert.match(card.textContent, /Aksi cepat/);
    assert.match(card.textContent, /Buat Dashboard/);
  });
});

describe("FASE C — dokumen-batch card", () => {
  const docs = () => ({
    documents: [
      { docId: "d1", filename: "inv-001.pdf" },
      { docId: "d2", filename: "inv-002.pdf" },
    ],
  });
  const batchResult = () => ({
    type: "result",
    fileCount: 2,
    recordCount: 3,
    fieldCount: 9,
    csvPath: ".daedalus/documents/batch/exports/batch-x.csv",
    csvFilename: "batch-x.csv",
    reviewCount: 1,
    review: [{ file: "inv-002.pdf", recordId: "r2", field: "vendor", confidence: 0.4, status: "auto", reason: "confidence rendah (40%)" }],
    failed: [],
  });

  it("is registered and lists the documents with a start button", () => {
    const { api } = mockApi();
    const { ctx } = mockCtx(api);
    assert.ok(CARD_KINDS.includes("dokumen-batch"));
    const card = renderCard("dokumen-batch", docs(), ctx);
    assert.match(card.textContent, /inv-001\.pdf/);
    assert.match(card.textContent, /inv-002\.pdf/);
    assert.match(card.textContent, /0\/2 file diproses/);
  });

  it("[▶️ Mulai batch] streams progress then shows Jadi + CSV + review buttons", async () => {
    const progressCalls = [];
    const { api, calls } = mockApi({
      dokumenBatchExtract: async (body, onProgress) => {
        calls.push({ name: "dokumenBatchExtract", args: [body] });
        onProgress(1, 2, "inv-001.pdf");
        onProgress(2, 2, "inv-002.pdf");
        progressCalls.push([1, 2], [2, 2]);
        return batchResult();
      },
    });
    const { ctx } = mockCtx(api);
    const card = renderCard("dokumen-batch", docs(), ctx);
    await clickBtn(card, "Mulai batch");
    const call = calls.find((c) => c.name === "dokumenBatchExtract");
    assert.ok(call, "dokumenBatchExtract called");
    assert.deepEqual(call.args[0], { root: "/ws", docIds: ["d1", "d2"] });
    assert.deepEqual(progressCalls, [[1, 2], [2, 2]], "progress X/Y streamed");
    assert.match(card.textContent, /2\/2 file diproses/);
    assert.match(card.textContent, /Jadi\. 2 invoice → 1 CSV gabungan, 9 field\./);
    assert.ok([...card.querySelectorAll("button")].some((b) => b.textContent.includes("CSV gabungan")), "download button");
    assert.ok([...card.querySelectorAll("button")].some((b) => b.textContent.includes("1 field perlu review")), "review button");
  });

  it("[📥 CSV gabungan] downloads via the captain download URL", async () => {
    const { api, calls } = mockApi({
      dokumenBatchExtract: async () => batchResult(),
    });
    const { ctx } = mockCtx(api);
    const card = renderCard("dokumen-batch", docs(), ctx);
    await clickBtn(card, "Mulai batch");
    await clickBtn(card, "CSV gabungan");
    const dl = calls.find((c) => c.name === "downloadFile");
    assert.ok(dl, "downloadFile called");
    assert.match(dl.args[0], /batch\/exports\/batch-x\.csv/);
    assert.equal(dl.args[1], "batch-x.csv");
  });

  it("[⚠️ N field perlu review] toggles the review list", async () => {
    const { api } = mockApi({
      dokumenBatchExtract: async () => batchResult(),
    });
    const { ctx } = mockCtx(api);
    const card = renderCard("dokumen-batch", docs(), ctx);
    await clickBtn(card, "Mulai batch");
    assert.equal(card.querySelectorAll(".dc-review-list").length, 0);
    await clickBtn(card, "perlu review");
    const panes = card.querySelectorAll(".dc-review-list");
    assert.equal(panes.length, 1);
    assert.match(panes[0].textContent, /inv-002\.pdf/);
    assert.match(panes[0].textContent, /confidence rendah/);
  });

  it("shows a hint when there is nothing to batch", () => {
    const { api } = mockApi();
    const { ctx } = mockCtx(api);
    const card = renderCard("dokumen-batch", { documents: [] }, ctx);
    assert.match(card.textContent, /Belum ada dokumen/);
  });
});

describe("FASE C — dokumen-qa card", () => {
  it("is registered and renders the question form", () => {
    const { api } = mockApi();
    const { ctx } = mockCtx(api);
    assert.ok(CARD_KINDS.includes("dokumen-qa"));
    const card = renderCard("dokumen-qa", {}, ctx);
    assert.ok(card.querySelector(".dc-qa-input"), "input exists");
    assert.match(card.textContent, /berapa total/);
  });

  it("asks via the real API and shows the answer with its source", async () => {
    const { api, calls } = mockApi({
      dokumenQa: async (body) => {
        calls.push({ name: "dokumenQa", args: [body] });
        return { found: true, answer: "Total: 1.110.000.", confidence: 0.9, source: { recordId: "r1", field: "total", quote: "Total: Rp 1.110.000" } };
      },
    });
    const { ctx } = mockCtx(api);
    const card = renderCard("dokumen-qa", {}, ctx);
    card.querySelector(".dc-qa-input").value = "berapa total di invoice ini?";
    await clickBtn(card, "Tanya");
    const call = calls.find((c) => c.name === "dokumenQa");
    assert.ok(call, "dokumenQa called");
    assert.deepEqual(call.args[0], { root: "/ws", question: "berapa total di invoice ini?" });
    assert.match(card.textContent, /Total: 1\.110\.000/);
    assert.match(card.textContent, /Sumber: field "total"/);
  });

  it("honestly shows 'tidak menemukan' when the answer is not in the data", async () => {
    const { api } = mockApi({
      dokumenQa: async () => ({ found: false, confidence: 0, answer: "Saya tidak menemukan jawabannya di data hasil ekstraksi dokumen ini." }),
    });
    const { ctx } = mockCtx(api);
    const card = renderCard("dokumen-qa", {}, ctx);
    card.querySelector(".dc-qa-input").value = "apa warna mobilnya?";
    await clickBtn(card, "Tanya");
    assert.match(card.textContent, /tidak menemukan/);
    assert.ok(card.querySelector(".dc-qa-nofound"), "no-found styling applied");
  });

  it("does nothing on empty questions", async () => {
    const { api, calls } = mockApi({ dokumenQa: async () => ({}) });
    const { ctx } = mockCtx(api);
    const card = renderCard("dokumen-qa", {}, ctx);
    card.querySelector(".dc-qa-input").value = "   ";
    await clickBtn(card, "Tanya");
    assert.ok(!calls.some((c) => c.name === "dokumenQa"), "API not called");
  });
});
