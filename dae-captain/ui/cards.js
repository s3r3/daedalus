// Dae Captain UI — structured action cards for chat (Fase 7).
//
// renderCard(kind, data, ctx) builds a card from SERVER data (never hardcoded
// HTML): outline rows, templates, fields, plans, and reports all come from
// API responses. Every button calls a real API through ctx.api — there are
// no decorative buttons.
//
// ctx: {
//   api,                 // createApiClient()
//   invoke,              // Tauri invoke (nullable in tests)
//   workspaceRoot,       // string
//   taskId,              // string|null — owning turn's task id (run_id for mutations)
//   runId,               // string|null — chat run id (timeline/undo scope)
//   notify(text),        // transient status line
//   say(text),           // assistant chat bubble
//   sendChat(text),      // dispatch a chat message ([🔄 Coba lagi], follow-ups)
//   openPreview(info),   // preview overlay { kind, name, path, url, report? }
//   onDeliverable(info), // a card produced a file -> deliverable card
//   onGenerated(engine), // a card started generation -> progress tracking
//   retryGoal,           // original user text for [🔄 Coba lagi]
// }
//
// Runs under node:test with jsdom (dae-captain/tests/chat-cards.test.js).

export const CARD_KINDS = [
  "slide-outline",
  "dokumen-outline",
  "dokumen-extraction",
  "sheets-blueprint",
  "sheets-analyze-plan",
  "research-plan",
  "research-report",
  "task-plan",
  "deliverable",
  "progress",
];

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

function h(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

/** Button that runs an async action with busy/disabled handling. Never throws into the DOM. */
function btn(label, cls, onClick) {
  const b = document.createElement("button");
  b.className = "card-btn" + (cls ? " " + cls : "");
  b.innerHTML = label; // labels are internal constants, never user data
  b.onclick = async () => {
    if (b.disabled) return;
    b.disabled = true;
    const old = b.innerHTML;
    b.classList.add("busy");
    try {
      await onClick(b);
    } finally {
      b.disabled = false;
      b.classList.remove("busy");
      if (b.isConnected) b.innerHTML = old;
    }
  };
  return b;
}

function cardShell(kind, titleHtml) {
  const card = document.createElement("div");
  card.className = `dc-card dc-${kind}`;
  card.dataset.cardKind = kind;
  const head = document.createElement("div");
  head.className = "dc-card-head";
  head.innerHTML = titleHtml;
  card.appendChild(head);
  const body = document.createElement("div");
  body.className = "dc-card-body";
  card.appendChild(body);
  return { card, body };
}

function cardError(body, message) {
  const p = h("p", "dc-error", message);
  body.appendChild(p);
  return p;
}

const baseName = (p) => String(p ?? "").split("/").pop() || String(p ?? "");

/** Slide title from content (title field, first bullet, or layout name). */
export function slideTitle(slide) {
  const c = slide?.content ?? {};
  if (typeof c.title === "string" && c.title.trim()) return c.title.trim();
  const bullets = Array.isArray(c.bullets) ? c.bullets.filter((x) => typeof x === "string" && x.trim()) : [];
  if (bullets.length) return String(bullets[0]).slice(0, 60);
  return slide?.layout ?? "Slide";
}

// ---------------------------------------------------------------------------
// Slide: outline card
// ---------------------------------------------------------------------------

function renderSlideOutline(data, ctx) {
  const deck = data?.deck ?? {};
  const slides = Array.isArray(deck.slides) ? deck.slides : [];
  const templates = Array.isArray(data?.templates) ? data.templates : [];
  const imported = Array.isArray(data?.importedTemplates) ? data.importedTemplates : [];
  const { card, body } = cardShell(
    "slide-outline",
    `📋 Outline: ${slides.length} slide${deck.title ? ` — ${esc(deck.title)}` : ""}`,
  );

  let expanded = false;
  const listBox = h("div", "dc-list");
  body.appendChild(listBox);

  function renderRows() {
    listBox.innerHTML = "";
    const shown = expanded ? slides : slides.slice(0, 3);
    shown.forEach((s, i) => {
      const row = h("div", "dc-row");
      const idx = slides.indexOf(s);
      const title = slideTitle(s);
      const info = h("span", "dc-row-main", `${idx + 1}. ${title}`);
      if (s.status === "skeleton") {
        const badge = h("span", "dc-badge", "kerangka");
        info.appendChild(document.createTextNode(" "));
        info.appendChild(badge);
      }
      row.appendChild(info);
      const edit = btn("✏️", "dc-icon", () => openSlideEditor(row, s, idx));
      edit.title = "Edit slide";
      edit.setAttribute("aria-label", `Edit slide ${idx + 1}`);
      row.appendChild(edit);
      listBox.appendChild(row);
    });
    if (slides.length > 3) {
      const more = btn(expanded ? "Tutup" : "Lihat semua", "dc-link", () => {
        expanded = !expanded;
        renderRows();
      });
      listBox.appendChild(more);
    }
    if (!slides.length) {
      listBox.appendChild(h("p", "dc-hint", "Outline kosong — belum ada slide."));
    }
  }

  function openSlideEditor(row, slide, idx) {
    if (row.querySelector(".dc-editor")) return;
    const ed = h("div", "dc-editor");
    const c = slide.content ?? {};
    const titleInput = document.createElement("input");
    titleInput.className = "dc-input";
    titleInput.value = typeof c.title === "string" ? c.title : "";
    titleInput.placeholder = "Judul slide";
    const bulletsInput = document.createElement("textarea");
    bulletsInput.className = "dc-input";
    bulletsInput.rows = 3;
    bulletsInput.placeholder = "Poin-poin (satu per baris)";
    bulletsInput.value = Array.isArray(c.bullets) ? c.bullets.join("\n") : "";
    const actions = h("div", "dc-row-actions");
    const save = btn("Simpan", "dc-primary", async () => {
      const bullets = bulletsInput.value.split("\n").map((x) => x.trim()).filter(Boolean);
      await ctx.api.slideUpdate({
        root: ctx.workspaceRoot,
        slide_id: slide.id,
        content: { title: titleInput.value.trim(), bullets },
        ...(ctx.taskId ? { run_id: ctx.taskId } : {}),
      });
      ctx.notify(`Slide ${idx + 1} diperbarui.`);
      ed.remove();
      await reload();
    });
    const cancel = btn("Batal", "", () => ed.remove());
    actions.append(save, cancel);
    ed.append(titleInput, bulletsInput, actions);
    row.appendChild(ed);
    titleInput.focus();
  }

  async function reload() {
    try {
      const fresh = await ctx.api.slideDeck(ctx.workspaceRoot);
      const nd = fresh?.deck;
      if (nd) {
        data.deck = nd;
        // re-render rows in place
        renderRows();
      }
    } catch {
      /* keep stale rows; the save already succeeded */
    }
  }

  renderRows();

  // Templates
  const tHead = h("div", "dc-subhead", "🎨 Template");
  body.appendChild(tHead);
  const tBox = h("div", "dc-templates");
  body.appendChild(tBox);
  let selectedId = data?.selectedTemplateId ?? deck?.theme?.templateId ?? null;

  function renderTemplates() {
    tBox.innerHTML = "";
    for (const t of templates) {
      const b = btn(esc(t.name ?? t.id), "dc-chip" + (selectedId === t.id ? " selected" : ""), async () => {
        await ctx.api.slideTheme({
          root: ctx.workspaceRoot,
          template_id: t.id,
          ...(ctx.taskId ? { run_id: ctx.taskId } : {}),
        });
        selectedId = t.id;
        renderTemplates();
        ctx.notify(`Template “${t.name ?? t.id}” dipakai.`);
      });
      b.title = t.id;
      tBox.appendChild(b);
    }
    for (const t of imported) {
      const b = btn("🗂 " + esc(t.name ?? t.id), "dc-chip" + (selectedId === t.id ? " selected" : ""), async () => {
        await ctx.api.slideTheme({
          root: ctx.workspaceRoot,
          template_id: t.id,
          ...(ctx.taskId ? { run_id: ctx.taskId } : {}),
        });
        selectedId = t.id;
        renderTemplates();
        ctx.notify(`Template impor “${t.name ?? t.id}” dipakai.`);
      });
      b.title = t.id;
      tBox.appendChild(b);
    }
    const imp = btn("＋ Impor", "dc-chip dc-import", () => fileInput.click());
    tBox.appendChild(imp);
  }

  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = ".pptx";
  fileInput.className = "dc-hidden";
  fileInput.onchange = async () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (!file) return;
    try {
      const res = await ctx.api.importPptTemplate(ctx.workspaceRoot, file);
      ctx.notify(`Template “${res?.template?.name ?? file.name}” diimpor.`);
      const fresh = await ctx.api.pptTemplates(ctx.workspaceRoot);
      data.importedTemplates = fresh?.templates ?? [];
      renderTemplates();
    } catch (e) {
      ctx.notify("Impor template gagal: " + errText(e));
    }
  };
  body.appendChild(fileInput);
  renderTemplates();

  const gen = btn("Buat Slide", "dc-primary dc-block", async () => {
    await ctx.api.slideGenerate({
      root: ctx.workspaceRoot,
      ...(ctx.taskId ? { run_id: ctx.taskId } : {}),
    });
    ctx.notify("Membuat slide…");
    ctx.onGenerated?.("slide");
  });
  body.appendChild(gen);

  return card;
}

// ---------------------------------------------------------------------------
// Dokumen: kerangka card
// ---------------------------------------------------------------------------

function renderDokumenOutline(data, ctx) {
  const doc = data?.document ?? {};
  const sections = Array.isArray(doc.sections) ? doc.sections : [];
  const { card, body } = cardShell(
    "dokumen-outline",
    `📄 Kerangka${doc.title ? `: ${esc(doc.title)}` : ""} — ${sections.length} bagian`,
  );

  const list = h("div", "dc-list");
  for (const s of sections) {
    const row = h("div", "dc-row");
    const idx = sections.indexOf(s) + 1;
    const main = h("span", "dc-row-main", `${idx}. ${s.title ?? "Tanpa judul"}`);
    if (s.thesisPoints?.length) {
      main.appendChild(document.createTextNode(" "));
      main.appendChild(h("span", "dc-badge", `${s.thesisPoints.length} poin`));
    }
    row.appendChild(main);
    list.appendChild(row);
  }
  if (!sections.length) list.appendChild(h("p", "dc-hint", "Kerangka kosong."));
  body.appendChild(list);

  // Format segmented [DOCX][PDF][MD]
  const formats = [
    ["docx", "📄 DOCX"],
    ["pdf", "📕 PDF"],
    ["md", "📝 MD"],
  ];
  let format = "docx";
  const seg = h("div", "dc-segmented");
  for (const [value, label] of formats) {
    const b = btn(label, "dc-chip" + (value === format ? " selected" : ""), () => {
      format = value;
      for (const c of seg.children) c.classList.remove("selected");
      b.classList.add("selected");
    });
    seg.appendChild(b);
  }
  body.appendChild(seg);

  const build = btn("Buat Makalah", "dc-primary dc-block", async () => {
    const res = await ctx.api.dokumenExportDocument({
      root: ctx.workspaceRoot,
      format,
      ...(ctx.taskId ? { run_id: ctx.taskId } : {}),
    });
    const path = res?.result?.path;
    if (!path) throw new Error("server tidak mengembalikan path hasil");
    ctx.onDeliverable?.({
      name: baseName(path),
      path,
      kind: res.result.format ?? format,
      engine: "dokumen",
      taskId: ctx.taskId,
      label: doc.title ?? "Makalah",
    });
    ctx.notify(`Makalah ${format.toUpperCase()} jadi.`);
  });
  body.appendChild(build);
  return card;
}

// ---------------------------------------------------------------------------
// Dokumen: extraction result card
// ---------------------------------------------------------------------------

function renderDokumenExtraction(data, ctx) {
  const doc = data?.document ?? {};
  const records = Array.isArray(doc.records) ? doc.records : [];
  const { card, body } = cardShell(
    "dokumen-extraction",
    `🧾 Hasil ekstraksi — ${records.length} record`,
  );

  const first = records[0];
  if (!first) {
    body.appendChild(h("p", "dc-hint", "Belum ada hasil ekstraksi."));
    return card;
  }
  const fields = first.fields ?? {};
  const table = h("div", "dc-fields");
  for (const [name, fv] of Object.entries(fields)) {
    const row = h("div", "dc-field-row");
    const conf = typeof fv?.confidence === "number" ? Math.round(fv.confidence * 100) : null;
    const low = fv?.status === "flagged" || fv?.status === "escalated" || (conf !== null && conf < 70);
    row.innerHTML =
      `<span class="dc-field-name">${esc(name)}</span>` +
      `<span class="dc-field-value">${esc(String(fv?.value ?? "—"))}</span>` +
      `<span class="dc-field-conf">${conf !== null ? conf + "%" : ""}${low ? ' <span class="dc-warn" title="Kepercayaan rendah / perlu tinjauan">⚠️</span>' : ""}</span>`;
    table.appendChild(row);
  }
  body.appendChild(table);
  if (records.length > 1) {
    body.appendChild(h("p", "dc-hint", `+ ${records.length - 1} record lain — unduh JSON/CSV untuk semua.`));
  }

  const actions = h("div", "dc-row-actions");
  const dl = async (format) => {
    const res = await ctx.api.dokumenExportData({
      root: ctx.workspaceRoot,
      format,
      ...(ctx.taskId ? { run_id: ctx.taskId } : {}),
    });
    const path = res?.result?.path;
    if (!path) throw new Error("server tidak mengembalikan path hasil");
    await ctx.api.downloadFile(ctx.api.captainDownloadUrl(ctx.workspaceRoot, path), baseName(path));
    ctx.notify(`${format.toUpperCase()} diunduh (${res.result.recordCount ?? records.length} record).`);
  };
  actions.append(
    btn("📥 JSON", "", () => dl("json")),
    btn("📥 CSV", "", () => dl("csv")),
    btn("📋 Copy", "", async () => {
      const text = JSON.stringify(records, null, 2);
      try {
        await navigator.clipboard.writeText(text);
        ctx.notify("Hasil disalin ke clipboard.");
      } catch {
        ctx.notify("Gagal menyalin — clipboard tidak tersedia.");
      }
    }),
  );
  body.appendChild(actions);
  return card;
}

// ---------------------------------------------------------------------------
// Spreadsheet: blueprint card
// ---------------------------------------------------------------------------

function renderSheetsBlueprint(data, ctx) {
  const wb = data?.workbook ?? {};
  const bp = wb.blueprint ?? {};
  const sheets = Array.isArray(bp.sheets) ? bp.sheets : [];
  const { card, body } = cardShell(
    "sheets-blueprint",
    `📐 Blueprint${wb.title ? `: ${esc(wb.title)}` : ""}`,
  );
  if (bp.goal) body.appendChild(h("p", "dc-goal", bp.goal));
  const list = h("div", "dc-list");
  for (const s of sheets) {
    const row = h("div", "dc-row");
    row.appendChild(h("span", "dc-row-main", `📊 ${s.name ?? s.title ?? "Sheet"}`));
    if (s.purpose) row.appendChild(h("span", "dc-hint", String(s.purpose).slice(0, 60)));
    list.appendChild(row);
  }
  if (!sheets.length && bp.notes) body.appendChild(h("p", "dc-hint", bp.notes));
  body.appendChild(list);

  const build = btn("Buat Workbook", "dc-primary dc-block", async () => {
    const res = await ctx.api.sheetsGenerate({
      root: ctx.workspaceRoot,
      ...(ctx.taskId ? { run_id: ctx.taskId } : {}),
    });
    ctx.notify(res?.summary ?? "Workbook dibuat.");
    ctx.onGenerated?.("spreadsheet");
  });
  body.appendChild(build);
  return card;
}

// ---------------------------------------------------------------------------
// Spreadsheet: analysis plan card
// ---------------------------------------------------------------------------

function renderSheetsAnalyzePlan(data, ctx) {
  const planId = data?.planId;
  const plan = data?.plan ?? {};
  const { card, body } = cardShell(
    "sheets-analyze-plan",
    `📊 Rencana analisis${plan.question ? "" : ""}`,
  );
  if (plan.question) body.appendChild(h("p", "dc-goal", plan.question));

  const list = h("div", "dc-list");
  const metrics = Array.isArray(plan.metrics) ? plan.metrics : [];
  for (const m of metrics.slice(0, 6)) {
    const row = h("div", "dc-row");
    row.appendChild(h("span", "dc-row-main", `ƒ ${m.name ?? m.column ?? "metrik"}`));
    if (m.aggregation) row.appendChild(h("span", "dc-badge", m.aggregation));
    list.appendChild(row);
  }
  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  for (const st of steps.slice(0, 4)) {
    const row = h("div", "dc-row");
    row.appendChild(h("span", "dc-row-main", `• ${st}`));
    list.appendChild(row);
  }
  if (data?.complexity) body.appendChild(h("p", "dc-hint", `Kompleksitas: ${data.complexity}`));
  body.appendChild(list);

  const run = btn("Setujui & Jalankan", "dc-primary dc-block", async () => {
    if (!planId) throw new Error("planId hilang");
    const res = await ctx.api.sheetsAnalyzeRun({ planId });
    const report = res?.report ?? res?.result ?? res;
    ctx.say(`Analisis selesai.${report?.summary ? " " + String(report.summary).slice(0, 300) : ""}`);
    ctx.onGenerated?.("spreadsheet");
  });
  body.appendChild(run);
  return card;
}

// ---------------------------------------------------------------------------
// Research: plan card
// ---------------------------------------------------------------------------

const RESEARCH_DEPTHS = [
  ["cepat", "Cepat"],
  ["standar", "Standar"],
  ["mendalam", "Mendalam"],
];

function renderResearchPlan(data, ctx) {
  let planId = data?.planId;
  let plan = data?.plan ?? {};
  let depth = data?.depth ?? "standar";
  const question = data?.question ?? plan.question ?? "";
  const { card, body } = cardShell("research-plan", "🔍 Rencana riset");

  function renderInner() {
    body.innerHTML = "";
    if (plan.question) body.appendChild(h("p", "dc-goal", plan.question));
    const subs = Array.isArray(plan.subQuestions) ? plan.subQuestions : [];
    const list = h("div", "dc-list");
    for (const sq of subs.slice(0, 6)) {
      const row = h("div", "dc-row");
      row.appendChild(h("span", "dc-row-main", `• ${sq.text ?? sq}`));
      list.appendChild(row);
    }
    body.appendChild(list);
    if (plan.sourceStrategy) body.appendChild(h("p", "dc-hint", plan.sourceStrategy));
    const budget = plan.budget;
    if (budget) {
      body.appendChild(
        h("p", "dc-hint", `Anggaran: ${budget.maxQueries ?? "?"} kueri · ${budget.maxSources ?? "?"} sumber`),
      );
    }

    const seg = h("div", "dc-segmented");
    for (const [value, label] of RESEARCH_DEPTHS) {
      const b = btn(label, "dc-chip" + (value === depth ? " selected" : ""), async () => {
        if (value === depth) return;
        const res = await ctx.api.researchPlan({
          question,
          root: ctx.workspaceRoot,
          depth: value,
        });
        if (!res?.planId) throw new Error("re-stage rencana gagal");
        planId = res.planId;
        plan = res.plan ?? plan;
        depth = res.depth ?? value;
        renderInner();
        ctx.notify(`Kedalaman: ${label}.`);
      });
      seg.appendChild(b);
    }
    body.appendChild(seg);

    const start = btn("Mulai Riset", "dc-primary dc-block", async () => {
      if (!planId) throw new Error("planId hilang");
      await ctx.api.researchRun({ planId });
      ctx.notify("Riset berjalan…");
      ctx.onGenerated?.("research", planId);
    });
    body.appendChild(start);
  }

  renderInner();
  return card;
}

// ---------------------------------------------------------------------------
// Research: report card
// ---------------------------------------------------------------------------

/** Build a BibTeX file from report sources (client-side, from server data). */
export function buildBibtex(report) {
  const lines = [];
  const sources = Array.isArray(report?.sources) ? report.sources : [];
  for (const s of sources) {
    const key = `src_${String(s.id ?? "").replace(/[^a-zA-Z0-9]/g, "") || "x"}`;
    const authors = Array.isArray(s.authors) && s.authors.length
      ? s.authors.join(" and ")
      : "Anonim";
    lines.push(`@misc{${key},`);
    lines.push(`  author = {${authors}},`);
    lines.push(`  title = {${String(s.title ?? "").replace(/[{}]/g, "")}},`);
    if (s.year) lines.push(`  year = {${s.year}},`);
    if (s.url) lines.push(`  url = {${s.url}},`);
    if (s.doi) lines.push(`  doi = {${s.doi}},`);
    lines.push(`  note = {diakses via Dae Captain}}`);
    lines.push(`}`);
    lines.push(``);
  }
  return lines.join("\n");
}

function downloadTextFile(filename, text, mime) {
  const blob = new Blob([text], { type: mime ?? "text/plain" });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
}

function renderResearchReport(data, ctx) {
  const report = data?.report ?? {};
  const claims = Array.isArray(report.claims) ? report.claims : [];
  const sources = Array.isArray(report.sources) ? report.sources : [];
  const v = report.verification ?? {};
  const { card, body } = cardShell("research-report", "📚 Laporan riset");

  if (report.question) body.appendChild(h("p", "dc-goal", report.question));
  const stats = h("p", "dc-hint",
    `✓ ${v.claimsVerified ?? claims.filter((c) => c.status === "verified").length} klaim terverifikasi` +
    ` · ✕ ${v.claimsDropped ?? claims.filter((c) => c.status === "dropped").length} dibuang` +
    ` · ${sources.length} sumber`);
  body.appendChild(stats);
  if (report.summary) {
    const sum = h("p", "dc-summary", String(report.summary).slice(0, 400));
    body.appendChild(sum);
  }

  const actions = h("div", "dc-row-actions");
  actions.append(
    btn("📄 PDF", "", () => {
      ctx.openPreview?.({ kind: "research-report", name: "laporan-riset", report });
    }),
    btn("📝 DOCX", "", async () => {
      if (!report.reportId) throw new Error("reportId hilang");
      await ctx.api.downloadFile(
        ctx.api.researchReportDocxUrl(report.reportId),
        `laporan-riset-${String(report.reportId).slice(0, 8)}.docx`,
      );
      ctx.notify("DOCX diunduh.");
    }),
    btn("📖 BibTeX", "", () => {
      downloadTextFile(
        `laporan-riset-${String(report.reportId ?? "x").slice(0, 8)}.bib`,
        buildBibtex(report),
        "text/plain",
      );
      ctx.notify("BibTeX diunduh.");
    }),
    btn("🔍 Telusur klaim", "", () => {
      traceBox.classList.toggle("dc-hidden");
    }),
  );
  body.appendChild(actions);

  // Claim-trace: tiap klaim -> sumber + kutipan + confidence.
  const traceBox = h("div", "dc-trace dc-hidden");
  for (const claim of claims) {
    const item = h("div", "dc-trace-item");
    const head = h("div", "dc-trace-head");
    head.innerHTML =
      `<span class="dc-badge dc-conf-${esc(claim.confidence ?? "moderate")}">${esc(claim.confidence ?? "?")}</span> ` +
      `<span class="dc-badge">${esc(claim.status ?? "?")}</span>`;
    const text = h("p", "dc-trace-text", claim.text);
    item.append(head, text);
    for (const sid of claim.sourceIds ?? []) {
      const src = sources.find((s) => s.id === sid);
      if (!src) continue;
      item.appendChild(h("p", "dc-trace-src", `↳ [${sid}] ${src.title ?? src.url}`));
    }
    for (const ex of (claim.excerpts ?? []).slice(0, 2)) {
      item.appendChild(h("p", "dc-trace-ex", `“${ex}”`));
    }
    traceBox.appendChild(item);
  }
  if (!claims.length) traceBox.appendChild(h("p", "dc-hint", "Tidak ada klaim."));
  body.appendChild(traceBox);

  return card;
}

// ---------------------------------------------------------------------------
// Task plan (decompose.ts) card
// ---------------------------------------------------------------------------

const PLAN_STATUS_LABEL = {
  waiting: "menunggu",
  running: "jalan",
  done: "selesai",
  failed: "gagal",
  skipped: "dilewati",
};

function renderTaskPlan(data, ctx) {
  const planId = data?.plan_id ?? data?.planId;
  const plan = data?.plan ?? {};
  const tasks = Array.isArray(plan.tasks) ? plan.tasks : [];
  const { card, body } = cardShell("task-plan", "🗂 Rencana multi-engine");

  if (plan.goal) body.appendChild(h("p", "dc-goal", plan.goal));
  const list = h("div", "dc-list");
  body.appendChild(list);

  function renderRows(execSubs) {
    list.innerHTML = "";
    for (const t of tasks) {
      const row = h("div", "dc-row");
      const main = h("span", "dc-row-main", `${t.id} · ${t.goal}`);
      row.appendChild(main);
      const eng = h("span", "dc-badge", t.engine ?? "?");
      row.appendChild(eng);
      if (t.dependsOn?.length) {
        row.appendChild(h("span", "dc-hint", `← ${t.dependsOn.join(", ")}`));
      }
      const live = execSubs?.find((s) => s.sub_id === t.id);
      if (live) {
        row.appendChild(h("span", "dc-badge", PLAN_STATUS_LABEL[live.status] ?? live.status));
      }
      list.appendChild(row);
    }
  }
  renderRows(data?.execution?.subTasks);

  const statusLine = h("p", "dc-hint", "");
  body.appendChild(statusLine);

  let polling = false;
  async function pollExecution() {
    if (polling || !planId) return;
    polling = true;
    try {
      for (;;) {
        const res = await ctx.api.captainPlanGet(planId);
        const exec = res?.execution;
        renderRows(exec?.subTasks);
        const subs = exec?.subTasks ?? [];
        const done = subs.filter((s) => ["done", "failed", "skipped"].includes(s.status)).length;
        statusLine.textContent = exec
          ? `${exec.status === "executing" ? "Menjalankan" : "Selesai"}: ${done}/${subs.length} sub-task`
          : "";
        if (!exec || exec.status !== "executing") {
          const failed = subs.filter((s) => s.status === "failed").length;
          ctx.say(
            failed
              ? `Rencana selesai dengan ${failed} sub-task gagal.`
              : "Rencana selesai — semua sub-task jalan.",
          );
          break;
        }
        await new Promise((r) => setTimeout(r, 3000));
      }
    } catch (e) {
      statusLine.textContent = "Gagal memantau eksekusi: " + errText(e);
    } finally {
      polling = false;
    }
  }

  const run = btn("Jalankan", "dc-primary dc-block", async () => {
    if (!planId) throw new Error("plan_id hilang");
    await ctx.api.captainPlanExecute(planId);
    ctx.notify("Rencana dijalankan…");
    run.disabled = true;
    void pollExecution();
  });
  body.appendChild(run);
  if (data?.execution?.status === "executing") {
    run.disabled = true;
    void pollExecution();
  }
  return card;
}

// ---------------------------------------------------------------------------
// Deliverable card: [📥 Download][👁️ Preview][✏️ Edit][🎨 Varian][↩️ Undo][📋 Versi][🔄 Coba lagi]
// ---------------------------------------------------------------------------

const KIND_ICON = {
  pptx: "📊", docx: "📄", pdf: "📕", xlsx: "📈", csv: "📑", md: "📝",
  bib: "📖", json: "🧾", html: "🌐",
};

function kindFromName(name) {
  const ext = String(name ?? "").split(".").pop()?.toLowerCase() ?? "";
  return KIND_ICON[ext] ? ext : "";
}

/** Per-engine edit affordance for a deliverable. Real editors only. */
function openDeliverableEditor(data, ctx, host) {
  const engine = data.engine;
  if (engine === "slide") {
    host.innerHTML = "";
    host.appendChild(h("p", "dc-hint", "Edit per slide — perubahan tersimpan via API:"));
    const list = h("div", "dc-list");
    host.appendChild(list);
    ctx.api.slideDeck(ctx.workspaceRoot).then((res) => {
      const slides = res?.deck?.slides ?? [];
      slides.forEach((s, i) => {
        const row = h("div", "dc-row");
        row.appendChild(h("span", "dc-row-main", `${i + 1}. ${slideTitle(s)}`));
        row.appendChild(btn("✏️", "dc-icon", () => {
          const title = prompt("Judul baru:", slideTitle(s));
          if (title === null) return;
          ctx.api.slideUpdate({
            root: ctx.workspaceRoot,
            slide_id: s.id,
            content: { ...(s.content ?? {}), title },
            ...(ctx.taskId ? { run_id: ctx.taskId } : {}),
          }).then(() => {
            ctx.notify(`Slide ${i + 1} diperbarui.`);
            openDeliverableEditor(data, ctx, host);
          }).catch((e) => ctx.notify("Edit gagal: " + errText(e)));
        }));
        list.appendChild(row);
      });
      if (!slides.length) list.appendChild(h("p", "dc-hint", "Deck kosong/tidak ditemukan."));
    }).catch((e) => host.appendChild(cardError(host, "Gagal memuat deck: " + errText(e))));
    return;
  }
  if (engine === "dokumen") {
    host.innerHTML = "";
    host.appendChild(h("p", "dc-hint", "Edit per bagian:"));
    const list = h("div", "dc-list");
    host.appendChild(list);
    ctx.api.dokumenDocument(ctx.workspaceRoot).then((res) => {
      const sections = res?.document?.sections ?? [];
      sections.forEach((s) => {
        const row = h("div", "dc-row");
        row.appendChild(h("span", "dc-row-main", s.title ?? s.id));
        row.appendChild(btn("✏️", "dc-icon", () => {
          const prose = prompt(`Prosa — ${s.title}:`, s.prose ?? "");
          if (prose === null) return;
          ctx.api.dokumenSection({
            root: ctx.workspaceRoot,
            id: s.id,
            prose,
            ...(ctx.taskId ? { run_id: ctx.taskId } : {}),
          }).then(() => ctx.notify(`Bagian “${s.title}” diperbarui.`))
            .catch((e) => ctx.notify("Edit gagal: " + errText(e)));
        }));
        list.appendChild(row);
      });
      if (!sections.length) list.appendChild(h("p", "dc-hint", "Dokumen kosong/tidak ditemukan."));
    }).catch((e) => host.appendChild(cardError(host, "Gagal memuat dokumen: " + errText(e))));
    return;
  }
  if (engine === "spreadsheet") {
    // Cell editor: read workbook.json, set one cell, write back validated.
    host.innerHTML = "";
    const form = h("div", "dc-editor");
    const sheetInput = document.createElement("input");
    sheetInput.className = "dc-input";
    sheetInput.placeholder = "Sheet (mis. Sheet1)";
    const cellInput = document.createElement("input");
    cellInput.className = "dc-input";
    cellInput.placeholder = "Sel (mis. B2)";
    const valInput = document.createElement("input");
    valInput.className = "dc-input";
    valInput.placeholder = "Nilai baru";
    const go = btn("Simpan sel", "dc-primary", async () => {
      const sheetName = sheetInput.value.trim();
      const cellRef = cellInput.value.trim().toUpperCase();
      if (!sheetName || !/^[A-Z]+[1-9][0-9]*$/.test(cellRef)) {
        throw new Error("Isi nama sheet dan sel (mis. B2).");
      }
      const res = await ctx.api.sheetsWorkbook(ctx.workspaceRoot);
      const wb = res?.workbook;
      if (!wb) throw new Error("workbook tidak ditemukan");
      const sheet = (wb.sheets ?? []).find((s) => s.name === sheetName);
      if (!sheet) throw new Error(`sheet “${sheetName}” tidak ada`);
      const m = /^([A-Z]+)([1-9][0-9]*)$/.exec(cellRef);
      const col = m[1].split("").reduce((a, ch) => a * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
      const rowIdx = parseInt(m[2], 10) - 1;
      sheet.cells = sheet.cells ?? {};
      const key = `${rowIdx},${col}`;
      sheet.cells[key] = { ...(sheet.cells[key] ?? {}), value: valInput.value };
      await ctx.api.sheetsWorkbookSave({ root: ctx.workspaceRoot, workbook: wb });
      ctx.notify(`Sel ${cellRef} di ${sheetName} diperbarui.`);
      host.innerHTML = "";
    });
    form.append(sheetInput, cellInput, valInput, go);
    host.appendChild(form);
    return;
  }
  // coding & others: open in the OS default app (real edit).
  if (ctx.invoke && data.path) {
    ctx.invoke("open_file", { path: data.path }).catch((e) => ctx.notify("Gagal membuka: " + errText(e)));
    ctx.say(`Membuka ${data.name} di aplikasi bawaan untuk diedit.`);
  } else {
    ctx.notify("Edit eksternal tidak tersedia di sini.");
  }
}

/** Version history card per engine. Only real restore paths. */
function openVersionHistory(data, ctx, host) {
  host.innerHTML = "";
  host.appendChild(h("p", "dc-hint", "Riwayat versi — pilih untuk dikembalikan:"));
  const list = h("div", "dc-list");
  host.appendChild(list);
  const engine = data.engine;

  if (engine === "slide") {
    ctx.api.slideArchive(ctx.workspaceRoot).then((res) => {
      const items = res?.archived ?? res?.items ?? [];
      if (!items.length) list.appendChild(h("p", "dc-hint", "Belum ada arsip."));
      for (const it of items) {
        const name = it.name ?? it.path ?? "?";
        const row = h("div", "dc-row");
        row.appendChild(h("span", "dc-row-main", `📦 ${name}`));
        row.appendChild(h("span", "dc-hint", it.archived_at ?? it.at ?? ""));
        row.appendChild(btn("Kembalikan", "", async () => {
          await ctx.api.slideArchiveRestore({
            root: ctx.workspaceRoot,
            name,
            ...(ctx.taskId ? { run_id: ctx.taskId } : {}),
          });
          ctx.notify("Deck dikembalikan dari arsip.");
          ctx.say("Deck dikembalikan ke versi arsip. Mau saya verifikasi ulang?");
        }));
        list.appendChild(row);
      }
    }).catch((e) => list.appendChild(cardError(list, "Gagal memuat arsip: " + errText(e))));
    return;
  }
  if (engine === "spreadsheet") {
    ctx.api.sheetsCheckpoints(ctx.workspaceRoot).then((res) => {
      const items = res?.checkpoints ?? [];
      if (!items.length) list.appendChild(h("p", "dc-hint", "Belum ada checkpoint."));
      for (const cp of items) {
        const id = cp.id ?? cp.name;
        const row = h("div", "dc-row");
        row.appendChild(h("span", "dc-row-main", `📸 ${cp.label ?? id}`));
        row.appendChild(h("span", "dc-hint", cp.created_at ?? cp.at ?? ""));
        row.appendChild(btn("Kembalikan", "", async () => {
          await ctx.api.sheetsRestore({ root: ctx.workspaceRoot, checkpoint_id: id });
          ctx.notify("Workbook dikembalikan ke checkpoint.");
        }));
        list.appendChild(row);
      }
    }).catch((e) => list.appendChild(cardError(list, "Gagal memuat checkpoint: " + errText(e))));
    return;
  }
  // dokumen (+ others with undo history): UndoStore entries as versions.
  ctx.api.captainUndoList(ctx.taskId ?? "", ctx.workspaceRoot).then((res) => {
    const items = (res?.entries ?? []).filter((e) => !data.engine || e.engine === data.engine);
    if (!items.length) list.appendChild(h("p", "dc-hint", "Belum ada riwayat perubahan."));
    for (const it of items) {
      const row = h("div", "dc-row");
      row.appendChild(h("span", "dc-row-main", `↩️ ${it.summary ?? it.action_type}`));
      row.appendChild(h("span", "dc-hint", (it.created_at ?? "").slice(0, 16).replace("T", " ")));
      row.appendChild(btn("Kembalikan", "", async () => {
        await ctx.api.captainUndoApply({ undo_id: it.undo_id, workspace_root: ctx.workspaceRoot });
        ctx.notify("Dikembalikan ke versi tersebut.");
      }));
      list.appendChild(row);
    }
  }).catch((e) => list.appendChild(cardError(list, "Gagal memuat riwayat: " + errText(e))));
}

function renderDeliverable(data, ctx) {
  const name = data?.name ?? "file";
  const kind = data?.kind ?? kindFromName(name);
  const icon = KIND_ICON[kind] ?? "📁";
  const { card, body } = cardShell(
    "deliverable",
    `${icon} ${esc(data?.label ?? name)}`,
  );
  body.appendChild(h("p", "dc-hint", name));

  const actions = h("div", "dc-row-actions");
  const dlUrl = data?.url ?? (data?.path ? ctx.api.captainDownloadUrl(ctx.workspaceRoot, data.path) : null);

  // [📥 Download] — real bytes via the server.
  if (dlUrl) {
    actions.append(btn("📥 Download", "", async () => {
      await ctx.api.downloadFile(dlUrl, name);
      ctx.notify(`${name} diunduh.`);
    }));
  }
  // [👁️ Preview] — overlay.
  actions.append(btn("👁️ Preview", "", () => {
    ctx.openPreview?.({ kind, name, path: data?.path, url: data?.url, report: data?.report });
  }));
  // [✏️ Edit] — per-engine real editors (hidden for research: immutable).
  if (data.engine !== "research") {
    actions.append(btn("✏️ Edit", "", () => openDeliverableEditor(data, ctx, subBox)));
  }
  // [🎨 Varian via AI] — slide only.
  if (data.engine === "slide") {
    actions.append(btn("🎨 Varian via AI", "", async () => {
      await ctx.api.slideRegenerate({
        root: ctx.workspaceRoot,
        ...(ctx.taskId ? { run_id: ctx.taskId } : {}),
      });
      ctx.notify("Varian dibuat — deck diperbarui.");
      ctx.say("Varian desain dibuat. Buka Preview untuk melihat hasilnya.");
    }));
  }
  // [↩️ Undo] — approval UndoStore via server.
  actions.append(btn("↩️ Undo", "", async () => {
    try {
      const res = await ctx.api.captainUndoApply({
        ...(ctx.taskId ? { run_id: ctx.taskId } : {}),
        workspace_root: ctx.workspaceRoot,
      });
      ctx.notify(`Undo: ${res?.summary ?? "dibatalkan"}.`);
      ctx.say(`Dibatalkan: ${res?.summary ?? "aksi terakhir"}.`);
    } catch (e) {
      ctx.notify(e?.data?.error === "nothing_to_undo" || e?.status === 404
        ? "Tidak ada aksi yang bisa di-undo."
        : "Undo gagal: " + errText(e));
    }
  }));
  // [📋 Versi] — real history per engine (hidden for research: immutable).
  if (data.engine !== "research") {
    actions.append(btn("📋 Versi", "", () => openVersionHistory(data, ctx, subBox)));
  }
  // [🔄 Coba lagi] — re-dispatch the original goal.
  if (ctx.retryGoal) {
    actions.append(btn("🔄 Coba lagi", "", () => ctx.sendChat(ctx.retryGoal)));
  }
  body.appendChild(actions);

  const subBox = h("div", "dc-subbox");
  body.appendChild(subBox);
  return card;
}

// ---------------------------------------------------------------------------
// Progress card (live, from timeline/task events)
// ---------------------------------------------------------------------------

function renderProgress(data, ctx) {
  const { card, body } = cardShell("progress", "⏳ Task berjalan");
  const phaseEl = h("p", "dc-goal", data?.phase ?? "Bekerja…");
  const barWrap = h("div", "dc-progress");
  const bar = h("div", "dc-progress-fill");
  barWrap.appendChild(bar);
  const meta = h("p", "dc-hint", "");
  const actions = h("div", "dc-row-actions");

  function render(d) {
    phaseEl.textContent = d.phase ?? "Bekerja…";
    const f = d.fraction;
    if (f && f.total > 0) {
      const pct = Math.max(0, Math.min(100, Math.round((f.current / f.total) * 100)));
      bar.style.width = pct + "%";
      barWrap.classList.remove("dc-indeterminate");
      meta.textContent = `${f.current}/${f.total}`;
    } else {
      barWrap.classList.add("dc-indeterminate");
      meta.textContent = d.status === "paused" ? "dijeda" : "";
    }
    actions.innerHTML = "";
    if (d.status === "paused") {
      actions.append(btn("▶️ Lanjutkan", "", async () => {
        await ctx.api.resumeTask(data.taskId);
        ctx.notify("Task dilanjutkan.");
      }));
    } else {
      actions.append(btn("⏸ Jeda", "", async () => {
        await ctx.api.pauseTask(data.taskId);
        ctx.notify("Task dijeda.");
      }));
    }
    actions.append(btn("✕ Batal", "dc-danger", async () => {
      await ctx.api.cancelTask(data.taskId);
      ctx.notify("Task dibatalkan.");
    }));
  }

  render(data);
  body.append(phaseEl, barWrap, meta, actions);
  // Live update hook used by app.js when new events arrive.
  card._updateProgress = render;
  return card;
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

const RENDERERS = {
  "slide-outline": renderSlideOutline,
  "dokumen-outline": renderDokumenOutline,
  "dokumen-extraction": renderDokumenExtraction,
  "sheets-blueprint": renderSheetsBlueprint,
  "sheets-analyze-plan": renderSheetsAnalyzePlan,
  "research-plan": renderResearchPlan,
  "research-report": renderResearchReport,
  "task-plan": renderTaskPlan,
  "deliverable": renderDeliverable,
  "progress": renderProgress,
};

/** Render one card. Throws for unknown kinds (caller shows a fallback). */
export function renderCard(kind, data, ctx) {
  const fn = RENDERERS[kind];
  if (!fn) throw new Error(`unknown card kind: ${kind}`);
  if (!ctx?.api) throw new Error("cards need ctx.api");
  return fn(data ?? {}, ctx);
}

/** Render a verify-fail as a chat bubble (mockup: "slide 5 overflow, saya perbaiki dulu..."). */
export function renderVerifyFail(reason) {
  const el = document.createElement("div");
  el.className = "bubble assistant verify-fail";
  el.innerHTML = `<div class="who">Dae Captain</div><div class="body">⚠️ ${esc(reason)} — saya perbaiki dulu…</div>`;
  return el;
}

function errText(e) {
  if (e == null) return "unknown error";
  if (typeof e === "string") return e || "unknown error";
  if (typeof e.message === "string" && e.message) return e.message;
  try {
    const j = JSON.stringify(e);
    return j && j !== "{}" ? j : String(e);
  } catch {
    return String(e);
  }
}
