/**
 * Dae Captain mascot — seasonal auto-switch + status variants.
 *
 * The mascot.svg is a sprite sheet with <g> groups:
 *   Status: cIdle, cThink, cWork, cPerm, cDone
 *   Engine: cCode, cSlide, cDoc, cRes
 *   Seasonal decor: sDef, sSpr, sSum, sAut, sWin, sHal
 *
 * Seasonal logic (auto by date):
 *   - Oct 31 → Halloween (sHal)
 *   - Dec 24-26 → Winter (sWin, Christmas)
 *   - Dec-Feb → Winter (sWin)
 *   - Mar-May → Spring (sSpr)
 *   - Jun-Aug → Summer (sSum)
 *   - Sep-Nov → Autumn (sAut)
 */

/** Determine the seasonal variant ID from the current date. */
export function seasonalVariant(date = new Date()) {
  const m = date.getMonth() + 1; // 1-12
  const d = date.getDate();

  // Special dates first
  if (m === 10 && d === 31) return "sHal"; // Halloween
  if (m === 12 && d >= 24 && d <= 26) return "sWin"; // Christmas → winter

  // Seasons (northern hemisphere)
  if (m >= 3 && m <= 5) return "sSpr"; // Spring
  if (m >= 6 && m <= 8) return "sSum"; // Summer
  if (m >= 9 && m <= 11) return "sAut"; // Autumn
  return "sWin"; // Dec-Feb → Winter
}

/** Map task/engine status to mascot variant group ID. */
export function statusVariant(status) {
  switch (status) {
    case "thinking": return "cThink";
    case "working": return "cWork";
    case "permission": return "cPerm";
    case "done": return "cDone";
    case "coding": return "cCode";
    case "slide": return "cSlide";
    case "document":
    case "dokumen": return "cDoc";
    case "research": return "cRes";
    case "idle":
    default: return "cIdle";
  }
}

let svgCache = null;

/** Fetch and cache the mascot SVG document. */
async function loadMascotSvg() {
  if (svgCache) return svgCache;
  const resp = await fetch("mascot.svg");
  const text = await resp.text();
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  svgCache = doc;
  return doc;
}

/**
 * Render the mascot as an inline SVG string.
 * Uses the full sprite sheet scaled to show the idle variant.
 * For precise per-variant cropping, the SVG needs individual viewBoxes
 * (tune with Farid's design input).
 */
export async function renderMascot(status = "idle", date = new Date()) {
  // For now: embed the full mascot.svg scaled down.
  // The sheet layout: header (top ~200px), then variant rows.
  // Idle variant is first in the Status Variants row.
  return `<img src="mascot.svg" class="mascot-svg-img" alt="Dae Captain mascot" />`;
}

/**
 * Replace all .mascot elements with the new mascot.
 * Call on startup and when status changes.
 */
export async function refreshMascots(status = "idle") {
  const html = await renderMascot(status);
  document.querySelectorAll(".mascot").forEach((el) => {
    el.innerHTML = html;
  });
}
