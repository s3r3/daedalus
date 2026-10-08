// Inspiration step (post-outline): when the user hasn't picked a template, rank
// the community style catalog against their topic + outline so the best-fitting
// visual directions surface first. Codex does the semantic/cross-language match;
// the client falls back to the offline keyword scorer in lib/community.ts.

import { codexJson } from "./codex-text";
import { COMMUNITY_TEMPLATES } from "./community";

export interface InspireRank {
  ranked: string[]; // template ids, best-fit first (contains every catalog id once)
  reasons: Record<string, string>; // id -> one-line why (top few only)
}

export function buildInspirePrompt(requirement: string, outlineTitles: string[]): string {
  const list = COMMUNITY_TEMPLATES.map(
    (t) => `- ${t.id} | ${t.name} | ${t.group} | tags: ${t.tags.join(", ")} | ${t.description}`,
  ).join("\n");
  return [
    "You are a presentation art director helping a user pick a VISUAL STYLE for their slide deck.",
    "Below is a catalog of community styles (id | name | group | tags | description).",
    "Rank ALL styles from most to least fitting for the user's topic and outline. Weigh tone, subject,",
    "audience, and whether the style's layout grammar actually suits this content.",
    "",
    "Catalog:",
    list,
    "",
    `User topic: ${requirement}`,
    outlineTitles.length ? `Deck outline: ${outlineTitles.join(" / ")}` : "",
    "",
    "Return ONLY this JSON object:",
    '{"ranked": ["best-id", "next-id", ...EVERY id...], "reasons": {"best-id": "one short reason", "id2": "...", "id3": "...", "id4": "..."}}',
    'Include EVERY id from the catalog exactly once in "ranked". Give a reason for the top 4 only, in the user\'s language.',
  ]
    .filter(Boolean)
    .join("\n");
}

export async function rankCommunityTemplates(
  requirement: string,
  outlineTitles: string[],
  signal?: AbortSignal,
): Promise<InspireRank> {
  const raw = await codexJson<any>(buildInspirePrompt(requirement, outlineTitles), { signal });
  const validIds = new Set(COMMUNITY_TEMPLATES.map((t) => t.id));
  const ranked: string[] = [];
  const seen = new Set<string>();
  for (const id of Array.isArray(raw?.ranked) ? raw.ranked : []) {
    const s = String(id);
    if (validIds.has(s) && !seen.has(s)) {
      ranked.push(s);
      seen.add(s);
    }
  }
  // Keep the ranking complete even if the model dropped some ids.
  for (const t of COMMUNITY_TEMPLATES) if (!seen.has(t.id)) ranked.push(t.id);
  const reasons: Record<string, string> = {};
  if (raw?.reasons && typeof raw.reasons === "object") {
    for (const [k, v] of Object.entries(raw.reasons)) {
      if (validIds.has(k) && typeof v === "string" && v.trim()) reasons[k] = v.trim();
    }
  }
  return { ranked, reasons };
}
