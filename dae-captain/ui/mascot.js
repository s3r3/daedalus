/**
 * Dae Captain mascot — seasonal auto-switch + status variants.
 *
 * Individual SVG files per variant in ./mascot/:
 *   idle, thinking, working, permission, done,
 *   coding, slide, document, research
 *
 * Seasonal decor: applied via CSS class on the wrapper
 * (the SVG sheet has sSpr/sSum/sAut/sWin/sHal groups;
 *  per-variant SVGs include seasonal overlay when applicable).
 *
 * Seasonal logic (auto by date):
 *   - Oct 31 → halloween
 *   - Dec 24-26 → winter (Christmas)
 *   - Dec-Feb → winter
 *   - Mar-May → spring
 *   - Jun-Aug → summer
 *   - Sep-Nov → autumn
 */

/** Determine the season key from the current date. */
export function currentSeason(date = new Date()) {
  const m = date.getMonth() + 1;
  const d = date.getDate();
  if (m === 10) return "halloween"; // October → Halloween season
  if (m >= 3 && m <= 5) return "spring";
  if (m >= 6 && m <= 8) return "summer";
  if (m >= 9 && m <= 11) return "autumn";
  return "winter"; // Dec-Feb
}

/** Map a status/engine to a mascot variant file. */
export function variantFor(status) {
  const map = {
    // Pill statuses
    idle: "idle",
    working: "working",
    waiting_approval: "permission",
    error: "error",
    failed: "error",
    paused: "paused",
    pause: "paused",
    verifying: "verify",
    verify: "verify",
    fixing: "fix",
    fix: "fix",
    queued: "queued",
    queue: "queued",
    done: "done",
    thinking: "thinking",
    // Engines
    coding: "coding",
    slide: "slide",
    document: "document",
    dokumen: "document",
    research: "research",
    spreadsheet: "working", // no spreadsheet variant in design → fallback to working
    sheets: "working",
    screenshot: "screenshot",
  };
  return map[status] ?? "idle";
}

/**
 * Render mascot <img> HTML for a status.
 * In Halloween season (October), the idle variant uses the Halloween costume.
 * Other statuses keep their normal variants.
 */
export function mascotHtml(status = "idle", cls = "") {
  const season = currentSeason();
  let variant = variantFor(status);
  // Halloween: idle gets the costume variant
  if (season === "halloween" && variant === "idle") {
    variant = "season-halloween";
  }
  return `<img src="mascot/mascot-${variant}.svg" class="mascot-svg-img ${cls}" data-season="${season}" data-variant="${variant}" alt="Dae Captain (${variant})" />`;
}

/**
 * Replace all .mascot placeholders with the new mascot image.
 * Keeps the existing .mascot-sm sizing classes.
 */
export function refreshMascots(status = "idle") {
  const html = mascotHtml(status);
  document.querySelectorAll(".mascot").forEach((el) => {
    // Preserve size class from the span itself
    el.innerHTML = html;
  });
}

/** Update mascot variant when task status changes. */
export function setMascotStatus(status) {
  refreshMascots(status);
}
