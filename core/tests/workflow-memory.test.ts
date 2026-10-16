import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SENSITIVE_KEY_PATTERNS, UserMemory } from "../src/workflow/index.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dae-captain-memory-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// preferences & facts
// ---------------------------------------------------------------------------

describe("preferences and facts", () => {
  test("remember/recall round-trips preferences and facts", () => {
    const mem = new UserMemory(dir, "farid");
    mem.rememberPreference("slide_template", "Elegan");
    mem.rememberPreference("items_per_page", 25);
    mem.rememberFact("nama", "Farid Arian");
    expect(mem.recall("slide_template")).toBe("Elegan");
    expect(mem.recall("items_per_page")).toBe(25);
    expect(mem.recall("nama")).toBe("Farid Arian");
    expect(mem.recall("tidak_ada")).toBeUndefined();
  });

  test("recall prefers preferences over facts for the same key", () => {
    const mem = new UserMemory(dir, "farid");
    mem.rememberPreference("format", "pdf");
    mem.rememberFact("format", "docx");
    expect(mem.recall("format")).toBe("pdf");
  });

  test("memory persists across instances (survives restarts)", () => {
    const a = new UserMemory(dir, "farid");
    a.rememberPreference("slide_template", "Elegan");
    a.rememberFact("proyek_aktif", "skripsi");
    const b = new UserMemory(dir, "farid");
    expect(b.recall("slide_template")).toBe("Elegan");
    expect(b.recall("proyek_aktif")).toBe("skripsi");
  });

  test("memory is per user — users do not see each other's data", () => {
    const a = new UserMemory(dir, "farid");
    const b = new UserMemory(dir, "budi");
    a.rememberFact("nama", "Farid Arian");
    expect(b.recall("nama")).toBeUndefined();
  });

  test("writes land in <root>/workflow/memory/<userId>.json", () => {
    const mem = new UserMemory(dir, "farid");
    mem.rememberFact("nama", "Farid Arian");
    const raw = JSON.parse(
      readFileSync(join(dir, "workflow", "memory", "farid.json"), "utf8"),
    );
    expect(raw.facts.nama).toBe("Farid Arian");
    expect(raw.userId).toBe("farid");
  });
});

// ---------------------------------------------------------------------------
// patterns & learnFromCorrection
// ---------------------------------------------------------------------------

describe("patterns and learnFromCorrection", () => {
  test("rememberPattern stores and upserts on (kind, pattern)", () => {
    const mem = new UserMemory(dir, "farid");
    mem.rememberPattern("correction", "format NPWP PT Maju Jaya", "12.345.678.9-012.345");
    mem.rememberPattern("correction", "format NPWP PT Maju Jaya", "12.345.678.9-012.000");
    const all = mem.getAllMemories();
    expect(all.patterns).toHaveLength(1);
    expect(all.patterns[0]).toMatchObject({
      kind: "correction",
      pattern: "format NPWP PT Maju Jaya",
      value: "12.345.678.9-012.000",
    });
    expect(typeof all.patterns[0]?.updatedAt).toBe("string");
  });

  test("different kinds/patterns accumulate", () => {
    const mem = new UserMemory(dir, "farid");
    mem.rememberPattern("correction", "a", "1");
    mem.rememberPattern("habit", "a", "2");
    mem.rememberPattern("correction", "b", "3");
    expect(mem.getAllMemories().patterns).toHaveLength(3);
  });

  test("learnFromCorrection stores a correction pattern with source prefix", () => {
    const mem = new UserMemory(dir, "farid");
    mem.learnFromCorrection({
      context: "format NPWP untuk PT Maju Jaya",
      corrected: "12.345.678.9-012.345",
      source: "dokumen",
    });
    const all = mem.getAllMemories();
    expect(all.patterns).toHaveLength(1);
    expect(all.patterns[0]).toMatchObject({
      kind: "correction",
      pattern: "[dokumen] format NPWP untuk PT Maju Jaya",
      value: "12.345.678.9-012.345",
    });
  });

  test("learnFromCorrection without source stores the bare context", () => {
    const mem = new UserMemory(dir, "farid");
    mem.learnFromCorrection({ context: "selalu pakai Elegan untuk sidang", corrected: "ya" });
    expect(mem.getAllMemories().patterns[0]?.pattern).toBe(
      "selalu pakai Elegan untuk sidang",
    );
  });
});

// ---------------------------------------------------------------------------
// forget / forgetAll
// ---------------------------------------------------------------------------

describe("forget", () => {
  test("forget removes from preferences and facts, reports what happened", () => {
    const mem = new UserMemory(dir, "farid");
    mem.rememberPreference("slide_template", "Elegan");
    mem.rememberFact("slide_template", "Minimal");
    expect(mem.forget("slide_template")).toBe(true);
    expect(mem.recall("slide_template")).toBeUndefined();
    expect(mem.forget("slide_template")).toBe(false);
    expect(mem.forget("tidak_ada")).toBe(false);
  });

  test("forgetAll wipes everything (user can inspect & delete)", () => {
    const mem = new UserMemory(dir, "farid");
    mem.rememberPreference("a", "1");
    mem.rememberFact("b", "2");
    mem.rememberPattern("correction", "c", "3");
    mem.forgetAll();
    const fresh = new UserMemory(dir, "farid");
    expect(fresh.getAllMemories()).toMatchObject({
      preferences: {},
      facts: {},
      patterns: [],
    });
  });

  test("getAllMemories returns a deep copy", () => {
    const mem = new UserMemory(dir, "farid");
    mem.rememberPreference("a", "1");
    const snap = mem.getAllMemories();
    snap.preferences["a"] = "MUTATED";
    snap.patterns.push({ kind: "x", pattern: "y", value: "z", updatedAt: "t" });
    expect(mem.recall("a")).toBe("1");
    expect(mem.getAllMemories().patterns).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// privacy rule
// ---------------------------------------------------------------------------

describe("privacy: sensitive keys are rejected", () => {
  test("blocked patterns are documented", () => {
    expect([...SENSITIVE_KEY_PATTERNS]).toEqual([
      "password",
      "token",
      "secret",
      "api_key",
      "credential",
    ]);
  });

  const sensitiveKeys = [
    "github_token",
    "GitHub_Token",
    "API_KEY",
    "api_key_openai",
    "db_password",
    "my-secret",
    "SECRET_SAUCE",
    "user_credential",
    "credentials",
  ];

  for (const key of sensitiveKeys) {
    test(`rememberPreference rejects "${key}"`, () => {
      const mem = new UserMemory(dir, "farid");
      expect(() => mem.rememberPreference(key, "xxx")).toThrow(/sensitive key/);
      expect(mem.recall(key)).toBeUndefined();
    });
    test(`rememberFact rejects "${key}"`, () => {
      const mem = new UserMemory(dir, "farid");
      expect(() => mem.rememberFact(key, "xxx")).toThrow(/sensitive key/);
      expect(mem.recall(key)).toBeUndefined();
    });
  }

  test("rememberPattern rejects a sensitive pattern identifier", () => {
    const mem = new UserMemory(dir, "farid");
    expect(() =>
      mem.rememberPattern("correction", "openai api_key format", "sk-..."),
    ).toThrow(/sensitive key/);
    expect(mem.getAllMemories().patterns).toHaveLength(0);
  });

  test("learnFromCorrection rejects a sensitive context", () => {
    const mem = new UserMemory(dir, "farid");
    expect(() =>
      mem.learnFromCorrection({ context: "my password hint", corrected: "x" }),
    ).toThrow(/sensitive key/);
  });

  test("nothing sensitive is persisted even when mixed with legit writes", () => {
    const mem = new UserMemory(dir, "farid");
    mem.rememberPreference("slide_template", "Elegan");
    expect(() => mem.rememberPreference("token", "abc")).toThrow();
    const raw = readFileSync(
      join(dir, "workflow", "memory", "farid.json"),
      "utf8",
    );
    expect(raw).not.toContain("abc");
    expect(raw).not.toContain("token");
  });

  test("empty keys are rejected too", () => {
    const mem = new UserMemory(dir, "farid");
    expect(() => mem.rememberPreference("  ", "x")).toThrow(/non-empty/);
    expect(() => mem.rememberFact("", "x")).toThrow(/non-empty/);
  });
});
