/**
 * Dae Captain — Panel Ganti Baju (wardrobe).
 *
 * Modul mandiri: tidak mengubah app.js. Cukup dimuat dari index.html:
 *   <script type="module" src="wardrobe.js"></script>
 * Pemicu: tombol #btn-wardrobe (header) dan #btn-open-wardrobe (Pengaturan → Penampilan).
 *
 * - Otomatis: dekorasi mengikuti tanggal/peristiwa (opsi "hanya peristiwa khusus").
 * - Manual: pilih salah satu dari 12 dekorasi atau 10 baju tradisional dunia.
 * - Pratinjau langsung (hover/fokus = sementara, klik = simpan ke
 *   localStorage "dae-captain:mascot-decor" lewat setMascotDecor()).
 */

import {
  DECOR_KEYS, COSTUME_KEYS, ALL_LABELS, getDecorPref, setMascotDecor, previewMascotDecor,
  getDecorInfo, currentDecor, eventDecor, mascotSvgString, mountMascots, ensureMascotAssets,
  triggerMascotAction,
} from "./mascot.js";

let root = null;      // elemen .wd
let opener = null;    // elemen yang membuka (untuk mengembalikan fokus)
let isOpen = false;

const $ = (id) => document.getElementById(id);

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const kid of kids) if (kid) n.append(kid);
  return n;
}

function thumbHtml(key) {
  return mascotSvgString({ decor: key, pose: "idle", size: "md", bare: true })
    .replace('class="dae-m"', 'class="dae-m dm-frozen"');
}

function card(key) {
  const [main, sub] = String(ALL_LABELS[key]).split(" · ");
  const btn = el("button", { class: "wd-card", type: "button", "data-key": key, "aria-pressed": "false", title: ALL_LABELS[key] });
  const thumb = el("span", { class: "wd-thumb", "aria-hidden": "true" });
  thumb.innerHTML = thumbHtml(key);
  btn.append(thumb, el("span", { class: "wd-name", text: main }));
  if (sub) btn.append(el("span", { class: "wd-name", style: "font-weight:500;opacity:.7", text: sub }));
  return btn;
}

function build() {
  const panel = $("panel");
  if (!panel) return null;
  ensureMascotAssets();

  const stageMascot = el("div", { class: "mascot", "aria-hidden": "true" });
  const stageName = el("strong", { id: "wd-stage-name" });
  const stageTag = el("span", { class: "wd-tag", id: "wd-stage-tag" });
  const stageNote = el("small", { id: "wd-stage-note" });
  const tryBtn = el("button", { class: "ghost-btn small", type: "button", text: "▶ Coba animasi klik", onclick: () => triggerMascotAction() });

  const btnAuto = el("button", { type: "button", id: "wd-mode-auto", text: "Otomatis", onclick: () => chooseMode("auto") });
  const btnManual = el("button", { type: "button", id: "wd-mode-manual", text: "Manual", onclick: () => chooseMode("manual") });
  const eventsOnly = el("input", { type: "checkbox", id: "wd-events-only" });
  eventsOnly.addEventListener("change", () => setMascotDecor(eventsOnly.checked ? "events" : "auto"));
  const optRow = el("label", { class: "wd-opt", id: "wd-opt-row" }, eventsOnly, el("span", { text: "Hanya peristiwa khusus (tanpa dekorasi musim)" }));

  const gridDecor = el("div", { class: "wd-grid", id: "wd-grid-decor", role: "group", "aria-label": "Dekorasi" });
  DECOR_KEYS.forEach((k) => gridDecor.append(card(k)));
  const gridCostume = el("div", { class: "wd-grid", id: "wd-grid-costume", role: "group", "aria-label": "Baju tradisional dunia" });
  COSTUME_KEYS.forEach((k) => gridCostume.append(card(k)));

  for (const grid of [gridDecor, gridCostume]) {
    grid.addEventListener("click", (e) => {
      const b = e.target.closest(".wd-card");
      if (b) chooseDecor(b.dataset.key);
    });
    // Pratinjau sementara saat hover / fokus; kembali ke pilihan tersimpan saat keluar.
    grid.addEventListener("pointerover", (e) => {
      const b = e.target.closest(".wd-card");
      if (b && e.pointerType !== "touch") previewMascotDecor(b.dataset.key);
    });
    grid.addEventListener("pointerleave", () => previewMascotDecor(null));
    grid.addEventListener("focusin", (e) => {
      const b = e.target.closest(".wd-card");
      if (b) previewMascotDecor(b.dataset.key);
    });
    grid.addEventListener("focusout", () => previewMascotDecor(null));
  }

  const closeBtn = el("button", { class: "icon-btn", type: "button", title: "Tutup", "aria-label": "Tutup panel ganti baju", text: "✕", onclick: close });
  const doneBtn = el("button", { class: "primary-btn", type: "button", text: "Selesai", onclick: close });

  const node = el("div", { class: "wd", id: "wardrobe", role: "dialog", "aria-modal": "true", "aria-label": "Ganti baju maskot" },
    el("div", { class: "wd-head" }, el("h2", { text: "👕 Ganti Baju" }), closeBtn),
    el("div", { class: "wd-body" },
      el("div", { class: "wd-stage" }, stageMascot, el("div", { class: "wd-info" }, stageTag, stageName, stageNote, tryBtn)),
      el("div", { class: "wd-seg", role: "group", "aria-label": "Mode" }, btnAuto, btnManual),
      optRow,
      el("h3", { class: "wd-title", text: "Dekorasi musiman & acara" }), gridDecor,
      el("h3", { class: "wd-title", text: "Baju tradisional dunia" }),
      el("p", { class: "hint", text: "Baju tradisional tidak terikat musim — hanya bisa dipilih manual." }),
      gridCostume,
    ),
    el("div", { class: "wd-foot" }, el("p", { class: "hint", text: "Pilihan tersimpan otomatis." }), doneBtn),
  );
  node.hidden = true;
  panel.append(node);
  mountMascots(node);
  return node;
}

function chooseMode(mode) {
  const pref = getDecorPref();
  if (mode === "auto") {
    setMascotDecor($("wd-events-only")?.checked ? "events" : "auto");
  } else if (pref === "auto" || pref === "events") {
    setMascotDecor(currentDecor()); // Manual: pertahankan tampilan sekarang, lalu pengguna memilih
  }
  render();
}

function chooseDecor(key) {
  previewMascotDecor(null);
  setMascotDecor(key); // simpan ke localStorage + terapkan ke semua maskot
  render();
}

function render() {
  if (!root) return;
  const pref = getDecorPref();
  const auto = pref === "auto" || pref === "events";
  const info = getDecorInfo();
  const today = currentDecor(new Date(), "auto");

  root.querySelector("#wd-mode-auto").setAttribute("aria-pressed", String(auto));
  root.querySelector("#wd-mode-manual").setAttribute("aria-pressed", String(!auto));
  root.querySelector("#wd-events-only").checked = pref === "events";
  root.querySelector("#wd-opt-row").style.display = auto ? "" : "none";

  root.querySelector("#wd-stage-name").textContent = info.label;
  const tag = info.previewing ? "Pratinjau" : auto ? "Otomatis" : "Manual";
  root.querySelector("#wd-stage-tag").textContent = tag;
  const note = info.kind === "costume"
    ? "Baju tradisional · hanya bisa dipilih manual"
    : info.kind === "event" ? "Peristiwa khusus hari ini" : auto ? "Mengikuti musim saat ini" : "Dekorasi pilihanmu";
  root.querySelector("#wd-stage-note").textContent = note;

  root.querySelectorAll(".wd-card").forEach((b) => {
    const key = b.dataset.key;
    b.setAttribute("aria-pressed", String(!auto && pref === key));
    const now = b.querySelector(".wd-now");
    const isToday = auto && key === (pref === "events" ? eventDecor() ?? "default" : today);
    if (isToday && !now) b.append(el("span", { class: "wd-now", text: "Hari ini" }));
    if (!isToday && now) now.remove();
  });
}

export function openWardrobe(from) {
  if (isOpen) return;
  if (!root) root = build();
  if (!root) return;
  opener = from instanceof HTMLElement ? from : document.activeElement;
  isOpen = true;
  root.classList.remove("wd-out");
  root.hidden = false;
  render();
  root.querySelector(".wd-card[aria-pressed='true'], .wd-seg button")?.focus({ preventScroll: true });
}

export function closeWardrobe() {
  close();
}

function close() {
  if (!isOpen || !root) return;
  isOpen = false;
  previewMascotDecor(null);
  root.classList.add("wd-out");
  const node = root;
  setTimeout(() => { if (!isOpen) node.hidden = true; }, 300);
  try { opener?.focus({ preventScroll: true }); } catch { /* abaikan */ }
}

function init() {
  const bind = (id) => {
    const b = $(id);
    if (b && !b.dataset.wdBound) {
      b.dataset.wdBound = "1";
      b.addEventListener("click", () => openWardrobe(b));
    }
  };
  bind("btn-wardrobe");
  bind("btn-open-wardrobe");
  // Esc menutup panel ini saja (tidak menciutkan island).
  document.addEventListener("keydown", (e) => {
    if (isOpen && e.key === "Escape") { e.stopPropagation(); e.preventDefault(); close(); }
  }, true);
  // Jaga pilihan terlihat benar bila dekorasi berubah dari tempat lain.
  window.addEventListener("dae:decor", () => { if (isOpen) render(); });
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();
