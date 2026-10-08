import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const english = read("src/i18n/locales/en.ts");
const sourceKeys = new Set([...english.matchAll(/^\s+"([^"]+)":/gm)].map((match) => match[1]));
const placeholders = (value) => [...value.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]).sort();
const entries = (body) => new Map(
  [...body.matchAll(/^\s+"([^"]+)":\s*"((?:[^"\\]|\\.)*)",?$/gm)]
    .map((match) => [match[1], match[2]]),
);
const sourceEntries = entries(english);

if (!sourceKeys.size) throw new Error("English i18n dictionary has no keys");

const localeType = read("src/i18n/types.ts");
const localeMatch = localeType.match(/export const LOCALES:[^=]+ = \[([^\]]+)\]/);
if (!localeMatch) throw new Error("Could not read LOCALES from src/i18n/types.ts");
const locales = [...localeMatch[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);

for (const locale of locales) {
  const file = `src/i18n/locales/${locale}.ts`;
  if (!fs.existsSync(path.join(root, file))) throw new Error(`Missing locale dictionary: ${file}`);
  const localeBody = read(file);
  const localeKeys = [...localeBody.matchAll(/^\s+"([^"]+)":/gm)].map((match) => match[1]);
  const duplicateKeys = localeKeys.filter((key, index) => localeKeys.indexOf(key) !== index);
  if (duplicateKeys.length) throw new Error(`${locale} has duplicate keys: ${[...new Set(duplicateKeys)].join(", ")}`);
  const localeEntries = entries(localeBody);
  const missing = [...sourceKeys].filter((key) => !localeEntries.has(key));
  const extra = [...localeEntries.keys()].filter((key) => !sourceKeys.has(key));
  if (missing.length || extra.length) {
    throw new Error([
      `${locale} dictionary keys do not match English:`,
      ...missing.map((key) => `missing: ${key}`),
      ...extra.map((key) => `extra: ${key}`),
    ].join("\n"));
  }
  for (const key of sourceKeys) {
    const expected = placeholders(sourceEntries.get(key) ?? "");
    const actual = placeholders(localeEntries.get(key) ?? "");
    if (expected.join("|") !== actual.join("|")) {
      throw new Error(`${locale} placeholder mismatch for ${key}: expected ${expected.join(", ") || "none"}, got ${actual.join(", ") || "none"}`);
    }
  }
}

const sourceFiles = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (/\.(?:ts|tsx)$/.test(entry.name) && !file.includes(`${path.sep}locales${path.sep}`)) sourceFiles.push(file);
  }
}
walk(path.join(root, "src"));

const unknown = [];
for (const file of sourceFiles) {
  const body = fs.readFileSync(file, "utf8");
  for (const match of body.matchAll(/\bt\(\s*"([^"]+)"/g)) {
    if (!sourceKeys.has(match[1])) unknown.push(`${path.relative(root, file)}: ${match[1]}`);
  }
}
if (unknown.length) throw new Error(`Unknown i18n keys:\n${unknown.join("\n")}`);

const legacy = sourceFiles.filter((file) => fs.readFileSync(file, "utf8").includes("随意输入"));
if (legacy.length) throw new Error(`Legacy copy \"随意输入\" remains in:\n${legacy.map((file) => path.relative(root, file)).join("\n")}`);

process.stdout.write(`i18n check passed: ${locales.length} locales, ${sourceKeys.size} source keys\n`);
