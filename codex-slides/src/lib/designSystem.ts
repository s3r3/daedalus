import { getCommunityTemplate } from "./community";
import { getTemplate } from "./templates";
import type { DeckDesignSystem, DesignDensity } from "./types";

export interface DesignSystemSeedInput {
  template?: string;
  style?: string;
  brandName?: string;
}

const HEX_RE = /^#([0-9a-f]{6})$/i;
const MATERIAL_ID_RE = /^[\w.-]+$/;

function cleanText(value: unknown, fallback = "", max = 500): string {
  if (typeof value !== "string") return fallback;
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function cleanHex(value: unknown, fallback: string): string {
  const candidate = typeof value === "string" ? value.trim() : "";
  return HEX_RE.test(candidate) ? candidate.toUpperCase() : fallback.toUpperCase();
}

function cleanNumber(value: unknown, fallback: number, min: number, max: number): number {
  const candidate = Number(value);
  return Number.isFinite(candidate) ? Math.min(max, Math.max(min, Math.round(candidate))) : fallback;
}

function mixWithWhite(color: string, ratio = 0.9): string {
  const match = color.match(HEX_RE);
  if (!match) return "#F4F4F5";
  const value = Number.parseInt(match[1], 16);
  const channels = [(value >> 16) & 255, (value >> 8) & 255, value & 255];
  const mixed = channels.map((channel) => Math.round(channel + (255 - channel) * ratio));
  return `#${mixed.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

function luminance(color: string): number {
  const match = color.match(HEX_RE);
  if (!match) return 1;
  const value = Number.parseInt(match[1], 16);
  const channels = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function densityFromTemplate(density?: "low" | "medium" | "high"): DesignDensity {
  if (density === "low") return "spacious";
  if (density === "high") return "compact";
  return "balanced";
}

/** Build an editable starting point without silently enabling it for legacy projects. */
export function createDeckDesignSystemSeed(input: DesignSystemSeedInput = {}): DeckDesignSystem {
  const template = getTemplate(input.template);
  const community = template ? undefined : getCommunityTemplate(input.template);
  const source = template ?? community;
  const palette = source?.palette ?? ["#4F46E5", "#18181B", "#FFFFFF", "#F97316"];
  const primary = cleanHex(palette[0], "#4F46E5");
  const paletteInk = cleanHex(palette[1], "#18181B");
  const paletteBackground = cleanHex(palette[2], "#FFFFFF");
  const accent = cleanHex(palette[3] ?? palette[0], "#F97316");
  const styleDirection = cleanText(source?.name ?? input.style ?? "", "", 160);
  const styleKeywords = cleanText(input.style || source?.description || "", "", 500);

  return {
    version: 1,
    brand: {
      name: cleanText(input.brandName, "", 120),
      tagline: "",
      voice: "Clear, confident, and concise",
      logoUsage: "Use the primary logo with clear space; never distort or recolor it.",
      assetMaterialIds: [],
    },
    style: {
      direction: styleDirection,
      keywords: styleKeywords,
      imageTreatment: cleanText(
        template?.imageStyle ?? community?.description ?? "Clean, coherent imagery with one consistent treatment",
        "",
        500,
      ),
    },
    colors: {
      primary,
      primaryTint: mixWithWhite(primary),
      accent,
      accentTint: mixWithWhite(accent),
      ink: luminance(paletteInk) < 0.5 ? paletteInk : "#18181B",
      surface: "#FFFFFF",
      background: luminance(paletteBackground) > 0.72 ? paletteBackground : "#F7F8FA",
      backgroundWarm: "#FBF7F2",
    },
    typography: {
      headingFont: cleanText(template?.font ?? "Inter / Helvetica Neue", "Inter / Helvetica Neue", 160),
      bodyFont: "Inter / Helvetica Neue",
      monoFont: "SFMono-Regular / Menlo",
      headingWeight: 700,
      bodyWeight: 400,
      scale: "Display 48–64, H1 32–40, H2 24–28, body 16–20, caption 12–14",
    },
    effects: {
      shadow: "Soft, low-elevation shadow; avoid heavy floating cards",
      border: "1px hairline using Ink at 12% opacity",
      texture: "Clean surfaces; use texture only when it belongs to the selected visual direction",
    },
    spacing: {
      density: densityFromTemplate(source?.density),
      baseUnit: 8,
      sectionGap: source?.density === "low" ? 48 : source?.density === "high" ? 24 : 32,
    },
    radius: {
      card: 16,
      control: 10,
      pill: 999,
    },
  };
}

/** Treat API/project JSON as untrusted while preserving a complete editable shape. */
export function normalizeDeckDesignSystem(
  raw: unknown,
  seedInput: DesignSystemSeedInput = {},
): DeckDesignSystem {
  const seed = createDeckDesignSystemSeed(seedInput);
  const source = raw && typeof raw === "object" ? raw as any : {};
  const brand = source.brand && typeof source.brand === "object" ? source.brand : {};
  const style = source.style && typeof source.style === "object" ? source.style : {};
  const colors = source.colors && typeof source.colors === "object" ? source.colors : {};
  const typography = source.typography && typeof source.typography === "object" ? source.typography : {};
  const effects = source.effects && typeof source.effects === "object" ? source.effects : {};
  const spacing = source.spacing && typeof source.spacing === "object" ? source.spacing : {};
  const radius = source.radius && typeof source.radius === "object" ? source.radius : {};
  const density: DesignDensity = ["compact", "balanced", "spacious"].includes(spacing.density)
    ? spacing.density
    : seed.spacing.density;

  return {
    version: 1,
    brand: {
      name: cleanText(brand.name, seed.brand.name, 120),
      tagline: cleanText(brand.tagline, seed.brand.tagline, 240),
      voice: cleanText(brand.voice, seed.brand.voice, 500),
      logoUsage: cleanText(brand.logoUsage, seed.brand.logoUsage, 500),
      assetMaterialIds: Array.from(new Set<string>(
        (Array.isArray(brand.assetMaterialIds) ? brand.assetMaterialIds : [])
          .map((id: unknown) => String(id))
          .filter((id: string) => MATERIAL_ID_RE.test(id)),
      )).slice(0, 16),
    },
    style: {
      direction: cleanText(style.direction, seed.style.direction, 160),
      keywords: cleanText(style.keywords, seed.style.keywords, 500),
      imageTreatment: cleanText(style.imageTreatment, seed.style.imageTreatment, 500),
    },
    colors: {
      primary: cleanHex(colors.primary, seed.colors.primary),
      primaryTint: cleanHex(colors.primaryTint, seed.colors.primaryTint),
      accent: cleanHex(colors.accent, seed.colors.accent),
      accentTint: cleanHex(colors.accentTint, seed.colors.accentTint),
      ink: cleanHex(colors.ink, seed.colors.ink),
      surface: cleanHex(colors.surface, seed.colors.surface),
      background: cleanHex(colors.background, seed.colors.background),
      backgroundWarm: cleanHex(colors.backgroundWarm, seed.colors.backgroundWarm),
    },
    typography: {
      headingFont: cleanText(typography.headingFont, seed.typography.headingFont, 160),
      bodyFont: cleanText(typography.bodyFont, seed.typography.bodyFont, 160),
      monoFont: cleanText(typography.monoFont, seed.typography.monoFont, 160),
      headingWeight: cleanNumber(typography.headingWeight, seed.typography.headingWeight, 100, 900),
      bodyWeight: cleanNumber(typography.bodyWeight, seed.typography.bodyWeight, 100, 900),
      scale: cleanText(typography.scale, seed.typography.scale, 300),
    },
    effects: {
      shadow: cleanText(effects.shadow, seed.effects.shadow, 300),
      border: cleanText(effects.border, seed.effects.border, 300),
      texture: cleanText(effects.texture, seed.effects.texture, 300),
    },
    spacing: {
      density,
      baseUnit: cleanNumber(spacing.baseUnit, seed.spacing.baseUnit, 2, 24),
      sectionGap: cleanNumber(spacing.sectionGap, seed.spacing.sectionGap, 8, 96),
    },
    radius: {
      card: cleanNumber(radius.card, seed.radius.card, 0, 48),
      control: cleanNumber(radius.control, seed.radius.control, 0, 32),
      pill: cleanNumber(radius.pill, seed.radius.pill, 0, 999),
    },
  };
}

/** Merge a partial Codex/UI patch without resetting untouched design-system sections. */
export function mergeDeckDesignSystem(
  current: DeckDesignSystem | undefined,
  patch: unknown,
  seedInput: DesignSystemSeedInput = {},
): DeckDesignSystem {
  const base = current
    ? normalizeDeckDesignSystem(current, seedInput)
    : createDeckDesignSystemSeed(seedInput);
  const next = patch && typeof patch === "object" ? patch as any : {};
  return normalizeDeckDesignSystem({
    ...base,
    ...next,
    brand: { ...base.brand, ...(next.brand && typeof next.brand === "object" ? next.brand : {}) },
    style: { ...base.style, ...(next.style && typeof next.style === "object" ? next.style : {}) },
    colors: { ...base.colors, ...(next.colors && typeof next.colors === "object" ? next.colors : {}) },
    typography: { ...base.typography, ...(next.typography && typeof next.typography === "object" ? next.typography : {}) },
    effects: { ...base.effects, ...(next.effects && typeof next.effects === "object" ? next.effects : {}) },
    spacing: { ...base.spacing, ...(next.spacing && typeof next.spacing === "object" ? next.spacing : {}) },
    radius: { ...base.radius, ...(next.radius && typeof next.radius === "object" ? next.radius : {}) },
  }, seedInput);
}

/** Serialize the project system once and inject the same block into every agent path. */
export function buildDeckDesignSystemContext(system?: DeckDesignSystem): string {
  if (!system) return "";
  const value = normalizeDeckDesignSystem(system);
  const brandIdentity = [value.brand.name, value.brand.tagline].filter(Boolean).join(" — ") || "Unnamed project brand";
  const assetRule = value.brand.assetMaterialIds.length
    ? `${value.brand.assetMaterialIds.length} persistent brand reference image(s) are attached. Treat them as authoritative logo/product/visual evidence.`
    : "No persistent brand reference image is attached; follow the written system exactly.";

  return [
    '<brand_design_system priority="always-on">',
    "This is the authoritative project-wide context for every slide generation and edit. Preserve it unless the user's latest instruction explicitly overrides a rule for a named scope.",
    `Brand identity: ${brandIdentity}.`,
    `Brand voice: ${value.brand.voice || "clear and concise"}.`,
    `Logo usage: ${value.brand.logoUsage || "preserve logo proportions and clear space"}.`,
    assetRule,
    `Visual direction: ${value.style.direction || "coherent with the current deck"}.`,
    `Style keywords: ${value.style.keywords || "consistent, intentional, presentation-ready"}.`,
    `Image treatment: ${value.style.imageTreatment}.`,
    `Semantic colors (use these exact hex values consistently): Primary ${value.colors.primary}; Primary Tint ${value.colors.primaryTint}; Accent ${value.colors.accent}; Accent Tint ${value.colors.accentTint}; Ink ${value.colors.ink}; Surface ${value.colors.surface}; Background ${value.colors.background}; Background Warm ${value.colors.backgroundWarm}.`,
    `Typography: headings ${value.typography.headingFont} at weight ${value.typography.headingWeight}; body ${value.typography.bodyFont} at weight ${value.typography.bodyWeight}; mono/data ${value.typography.monoFont}; scale ${value.typography.scale}.`,
    `Effects: shadow ${value.effects.shadow}; border ${value.effects.border}; texture ${value.effects.texture}.`,
    `Spacing: ${value.spacing.density} density on a ${value.spacing.baseUnit}px base unit, with about ${value.spacing.sectionGap}px between major sections.`,
    `Corner radii: cards ${value.radius.card}px; controls ${value.radius.control}px; pills ${value.radius.pill}px.`,
    "Keep page-to-page hierarchy, palette roles, typography, spacing rhythm, image treatment, and component geometry consistent. Do not invent a competing visual system on individual slides.",
    "</brand_design_system>",
  ].join("\n");
}
