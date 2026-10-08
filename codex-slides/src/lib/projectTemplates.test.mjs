import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const read = (relative) => fs.readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

test("project templates persist brand systems and bounded visual references", () => {
  const source = read("./projectTemplates.ts");
  assert.match(source, /filter\(\(item\) => item\.image\)\.slice\(0, 6\)/);
  assert.match(source, /designSystem: project\.config\.designSystem/);
  assert.match(source, /Project template visual reference/);
  assert.match(source, /applyProjectTemplateAssets/);
  assert.match(source, /sourceMaterialId/);
});

test("project template APIs support list, save, cover, and delete", () => {
  const collectionRoute = read("../app/api/templates/route.ts");
  const itemRoute = read("../app/api/templates/[id]/route.ts");
  const coverRoute = read("../app/api/templates/[id]/cover/route.ts");
  assert.match(collectionRoute, /projectTemplates: listProjectTemplates\(\)/);
  assert.match(collectionRoute, /export async function POST/);
  assert.match(itemRoute, /export async function DELETE/);
  assert.match(coverRoute, /readProjectTemplateCover/);
});

test("Electron data can be redirected outside the packaged application", () => {
  const dataPaths = read("./dataPaths.ts");
  const store = read("./store.ts");
  const materials = read("./materials.ts");
  assert.match(dataPaths, /CODEX_SLIDES_DATA_DIR/);
  assert.match(store, /path\.join\(DATA_ROOT, "projects"\)/);
  assert.match(materials, /path\.join\(DATA_ROOT, "materials-staging"\)/);
});

