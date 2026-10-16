/**
 * Fase 5 — Model per peran (2 tier): mapping peran→tier sesuai tabel master
 * design §7, resolver, fallback, listRoles, dan config. Pure — tidak
 * menyentuh ~/.daedalus.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  CODING_ROLES,
  DOKUMEN_ROLES,
  MODEL_TIER_LABELS,
  RESEARCH_ROLES,
  ROLE_TIER_MAP,
  SLIDE_ROLES,
  SPREADSHEET_ROLES,
  getModelFor,
  listRoles,
  normalizeRoleModelConfig,
  resolveModel,
  roleModelConfigFrom,
  roleTier,
} from "../src/workflow/index.ts";
import type { RoleModelConfig } from "../src/workflow/index.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dae-captain-model-roles-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const FULL: RoleModelConfig = { default: "model-default", strong: "model-strong", light: "model-light" };

describe("ROLE_TIER_MAP — tabel master design §7", () => {
  test("Coding: tulis + plan → strong; baca + ringkas + chat → light", () => {
    expect(ROLE_TIER_MAP[CODING_ROLES.WRITE]).toBe("strong");
    expect(ROLE_TIER_MAP[CODING_ROLES.PLAN]).toBe("strong");
    expect(ROLE_TIER_MAP[CODING_ROLES.READ]).toBe("light");
    expect(ROLE_TIER_MAP[CODING_ROLES.SUMMARIZE]).toBe("light");
    expect(ROLE_TIER_MAP[CODING_ROLES.CHAT]).toBe("light");
  });

  test("Slide: outline/generate/refine/notes → strong; chat → light", () => {
    expect(ROLE_TIER_MAP[SLIDE_ROLES.OUTLINE]).toBe("strong");
    expect(ROLE_TIER_MAP[SLIDE_ROLES.GENERATE]).toBe("strong");
    expect(ROLE_TIER_MAP[SLIDE_ROLES.REFINE]).toBe("strong");
    expect(ROLE_TIER_MAP[SLIDE_ROLES.NOTES]).toBe("strong");
    expect(ROLE_TIER_MAP[SLIDE_ROLES.CHAT]).toBe("light");
  });

  test("Dokumen: classify/extract/generate/compare → strong; chat → light", () => {
    expect(ROLE_TIER_MAP[DOKUMEN_ROLES.CLASSIFY]).toBe("strong");
    expect(ROLE_TIER_MAP[DOKUMEN_ROLES.EXTRACT]).toBe("strong");
    expect(ROLE_TIER_MAP[DOKUMEN_ROLES.GENERATE]).toBe("strong");
    expect(ROLE_TIER_MAP[DOKUMEN_ROLES.COMPARE]).toBe("strong");
    expect(ROLE_TIER_MAP[DOKUMEN_ROLES.CHAT]).toBe("light");
  });

  test("Spreadsheet: plan/insight/blueprint → strong; chat → light", () => {
    expect(ROLE_TIER_MAP[SPREADSHEET_ROLES.PLAN]).toBe("strong");
    expect(ROLE_TIER_MAP[SPREADSHEET_ROLES.INSIGHT]).toBe("strong");
    expect(ROLE_TIER_MAP[SPREADSHEET_ROLES.BLUEPRINT]).toBe("strong");
    expect(ROLE_TIER_MAP[SPREADSHEET_ROLES.CHAT]).toBe("light");
  });

  test("Research: plan/synthesize/write/compare → strong; chat → light", () => {
    expect(ROLE_TIER_MAP[RESEARCH_ROLES.PLAN]).toBe("strong");
    expect(ROLE_TIER_MAP[RESEARCH_ROLES.SYNTHESIZE]).toBe("strong");
    expect(ROLE_TIER_MAP[RESEARCH_ROLES.WRITE]).toBe("strong");
    expect(ROLE_TIER_MAP[RESEARCH_ROLES.COMPARE]).toBe("strong");
    expect(ROLE_TIER_MAP[RESEARCH_ROLES.CHAT]).toBe("light");
  });

  test("semua peran terdaftar memakai prefix engine yang benar", () => {
    const engines = ["coding", "slide", "dokumen", "spreadsheet", "research"];
    for (const [role] of Object.entries(ROLE_TIER_MAP)) {
      const prefix = role.split(".")[0];
      expect(engines).toContain(prefix);
      expect(roleTier(role)).toBe(ROLE_TIER_MAP[role]);
    }
  });
});

describe("resolveModel", () => {
  test("peran strong → config.strong; peran light → config.light", () => {
    expect(resolveModel(CODING_ROLES.WRITE, FULL)).toBe("model-strong");
    expect(resolveModel(CODING_ROLES.PLAN, FULL)).toBe("model-strong");
    expect(resolveModel(CODING_ROLES.READ, FULL)).toBe("model-light");
    expect(resolveModel(CODING_ROLES.CHAT, FULL)).toBe("model-light");
    expect(resolveModel(SLIDE_ROLES.GENERATE, FULL)).toBe("model-strong");
    expect(resolveModel(SLIDE_ROLES.CHAT, FULL)).toBe("model-light");
    expect(resolveModel(DOKUMEN_ROLES.EXTRACT, FULL)).toBe("model-strong");
    expect(resolveModel(DOKUMEN_ROLES.CHAT, FULL)).toBe("model-light");
    expect(resolveModel(SPREADSHEET_ROLES.INSIGHT, FULL)).toBe("model-strong");
    expect(resolveModel(SPREADSHEET_ROLES.CHAT, FULL)).toBe("model-light");
    expect(resolveModel(RESEARCH_ROLES.SYNTHESIZE, FULL)).toBe("model-strong");
    expect(resolveModel(RESEARCH_ROLES.CHAT, FULL)).toBe("model-light");
  });

  test("fallback: light kosong → semua peran pakai default/strong", () => {
    const noLight: RoleModelConfig = { default: "model-default", strong: "model-strong" };
    expect(resolveModel(CODING_ROLES.CHAT, noLight)).toBe("model-default");
    expect(resolveModel(SLIDE_ROLES.CHAT, noLight)).toBe("model-default");
    expect(resolveModel(CODING_ROLES.WRITE, noLight)).toBe("model-strong");
  });

  test("default cerdas: 1 model saja → semua peran pakai itu", () => {
    const one: RoleModelConfig = { default: "satu-model" };
    for (const role of Object.keys(ROLE_TIER_MAP)) {
      expect(resolveModel(role, one)).toBe("satu-model");
    }
  });

  test("peran tak dikenal → default", () => {
    expect(resolveModel("coding.tidak-ada", FULL)).toBe("model-default");
    expect(resolveModel("", FULL)).toBe("model-default");
  });

  test("string kosong di override dihitung unset", () => {
    const cfg: RoleModelConfig = { default: "model-default", strong: "  ", light: "" };
    expect(resolveModel(CODING_ROLES.WRITE, cfg)).toBe("model-default");
    expect(resolveModel(CODING_ROLES.CHAT, cfg)).toBe("model-default");
  });
});

describe("listRoles", () => {
  test("tanpa filter: 24 peran (5+5+5+4+5) dengan tier sesuai map", () => {
    const all = listRoles();
    expect(all).toHaveLength(24);
    for (const info of all) {
      expect(info.tier).toBe(ROLE_TIER_MAP[info.role]);
      expect(info.label.length).toBeGreaterThan(0);
      expect(info.role.startsWith(`${info.engine}.`)).toBe(true);
    }
  });

  test("filter per engine", () => {
    expect(listRoles("coding")).toHaveLength(5);
    expect(listRoles("slide")).toHaveLength(5);
    expect(listRoles("dokumen")).toHaveLength(5);
    expect(listRoles("spreadsheet")).toHaveLength(4);
    expect(listRoles("research")).toHaveLength(5);
    expect(listRoles("slide").map((r) => r.role)).toEqual([
      "slide.outline",
      "slide.generate",
      "slide.refine",
      "slide.notes",
      "slide.chat",
    ]);
  });

  test("label tier tersedia untuk UI", () => {
    expect(MODEL_TIER_LABELS.strong).toContain("Kuat");
    expect(MODEL_TIER_LABELS.light).toContain("Ringan");
  });
});

describe("config", () => {
  test("normalizeRoleModelConfig: sampah diabaikan, kosong = unset", () => {
    expect(normalizeRoleModelConfig(undefined)).toEqual({ default: "" });
    expect(normalizeRoleModelConfig(null)).toEqual({ default: "" });
    expect(normalizeRoleModelConfig("bukan-object")).toEqual({ default: "" });
    expect(normalizeRoleModelConfig({ default: "  a  ", strong: "", light: " b " })).toEqual({
      default: "a",
      light: "b",
    });
    expect(normalizeRoleModelConfig({ default: 42, strong: "s" })).toEqual({ default: "", strong: "s" });
  });

  test("roleModelConfigFrom: default jatuh ke llm.model bila modelRoles kosong", () => {
    expect(roleModelConfigFrom({ llm: { model: "llm-model" } })).toEqual({ default: "llm-model" });
    expect(roleModelConfigFrom({ llm: { model: "llm-model" }, modelRoles: { light: "l" } })).toEqual({
      default: "llm-model",
      light: "l",
    });
    // modelRoles.default menang atas llm.model
    expect(roleModelConfigFrom({ llm: { model: "llm-model" }, modelRoles: { default: "d", strong: "s" } })).toEqual({
      default: "d",
      strong: "s",
    });
    expect(roleModelConfigFrom(undefined)).toEqual({ default: "" });
  });

  test("getModelFor: terima RoleModelConfig langsung", () => {
    expect(getModelFor("coding.write", FULL)).toBe("model-strong");
    expect(getModelFor("coding.chat", FULL)).toBe("model-light");
  });

  test("getModelFor: terima sumber ber-modelRoles (mis. Settings)", () => {
    const settingsLike = { llm: { model: "llm-model" }, modelRoles: { light: "light-model" } };
    expect(getModelFor("research.synthesize", settingsLike)).toBe("llm-model");
    expect(getModelFor("research.chat", settingsLike)).toBe("light-model");
  });

  test("getModelFor: tanpa config → string kosong, tidak throw", () => {
    expect(getModelFor("coding.write")).toBe("");
    expect(getModelFor("tidak-dikenal")).toBe("");
  });
});
