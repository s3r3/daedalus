import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const typescript = require("typescript");
const read = (relative) => fs.readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

function installTypeScriptRequire(t) {
  const previous = require.extensions[".ts"];
  require.extensions[".ts"] = (module, filename) => {
    const source = fs.readFileSync(filename, "utf8");
    const output = typescript.transpileModule(source, {
      compilerOptions: {
        target: typescript.ScriptTarget.ES2022,
        module: typescript.ModuleKind.CommonJS,
        moduleResolution: typescript.ModuleResolutionKind.NodeJs,
        esModuleInterop: true,
      },
      fileName: filename,
    }).outputText;
    module._compile(output, filename);
  };
  t.after(() => {
    if (previous) require.extensions[".ts"] = previous;
    else delete require.extensions[".ts"];
  });
}

test("deck versions keep independent assets, group multi-step edits, and restore as a new current version", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-slides-versions-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  process.env.CODEX_SLIDES_DATA_DIR = root;
  installTypeScriptRequire(t);

  const { saveProject, saveSlideImage, loadProject } = require("./store.ts");
  const versions = require("./deckVersions.ts");
  const { buildPdf, buildPptx } = require("./assemble.ts");
  const firstPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const project = {
    id: "version-test-project",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    config: {
      requirement: "Build the first deck",
      aspect: "16:9",
      pages: 1,
      language: "en",
      resolution: "2K",
      engine: "codex",
    },
    agent: "codex",
    title: "First deck",
    outline: [{ title: "First slide", points: ["One"] }],
    pages: [{
      index: 1,
      title: "First slide",
      points: ["One"],
      image: "01.png",
      imageUpdatedAt: 1,
      status: "rendered",
      transition: "fade",
      speakerNotes: "First notes",
    }],
    status: "ready",
    workflow: { stage: "deck" },
  };
  saveSlideImage(project.id, 1, firstPng);
  saveProject(project);

  const first = await versions.captureDeckVersion(project.id, {
    prompt: "Build the first deck",
    promptSource: "project",
    source: "ai",
  });
  assert.equal(first.version, 1);

  const changed = loadProject(project.id);
  changed.title = "Second deck";
  changed.pages[0].title = "Second slide";
  changed.pages[0].speakerNotes = "Second notes";
  changed.pages[0].imageUpdatedAt = 2;
  saveSlideImage(project.id, 1, Buffer.from("version-two"));
  saveProject(changed);
  const second = await versions.captureDeckVersion(project.id, {
    prompt: "Make a second version",
    promptSource: "message",
    source: "ai",
    groupId: "edit-group-1",
  });
  assert.equal(second.version, 2);

  const grouped = loadProject(project.id);
  grouped.pages[0].speakerNotes = "Second notes, revised";
  saveProject(grouped);
  const groupedUpdate = await versions.captureDeckVersion(project.id, {
    prompt: "Make a second version",
    promptSource: "message",
    source: "ai",
    groupId: "edit-group-1",
  });
  assert.equal(groupedUpdate.id, second.id);
  assert.equal(versions.listDeckVersions(project.id).length, 2);
  const unchanged = await versions.ensureCurrentDeckVersion(project.id, {
    prompt: "No content change",
    promptSource: "manual",
    source: "manual",
  });
  assert.equal(unchanged.id, second.id);
  assert.equal(versions.listDeckVersions(project.id).length, 2);

  const explicitCheckpoint = await versions.captureDeckVersion(project.id, {
    prompt: "Save a manual checkpoint",
    promptSource: "manual",
    source: "manual",
    force: true,
  });
  assert.equal(explicitCheckpoint.version, 3);
  assert.equal(explicitCheckpoint.source, "manual");
  assert.equal(versions.listDeckVersions(project.id).length, 3);
  assert.equal(versions.readDeckVersion(project.id, first.id).project.title, "First deck");
  assert.deepEqual(versions.readDeckVersionImage(project.id, first.id, "01.png"), firstPng);
  const firstDetail = versions.readDeckVersion(project.id, first.id);
  const historicalImage = (name) => versions.readDeckVersionImage(project.id, first.id, name);
  const pdf = await buildPdf(firstDetail.project, historicalImage);
  const pptx = await buildPptx(firstDetail.project, historicalImage);
  assert.equal(pdf.subarray(0, 4).toString(), "%PDF");
  assert.equal(pptx.subarray(0, 2).toString(), "PK");

  const restored = await versions.restoreDeckVersion(project.id, first.id);
  assert.equal(restored.project.title, "First deck");
  assert.equal(restored.project.pages[0].transition, "fade");
  assert.equal(restored.project.pages[0].speakerNotes, "First notes");
  assert.deepEqual(fs.readFileSync(path.join(root, "projects", project.id, "01.png")), firstPng);
  assert.equal(restored.version.version, 4);
  assert.equal(restored.version.source, "restore");
  assert.equal(restored.version.restoreFromVersionId, first.id);
  assert.deepEqual(
    versions.listDeckVersions(project.id).map((version) => version.current),
    [false, false, false, true],
  );
});

test("historical playback and export use version-owned slide routes", () => {
  const component = read("../components/DeckVersionDialog.tsx");
  const exportRoute = read("../app/api/projects/[id]/versions/[versionId]/export/route.ts");
  assert.match(component, /deckVersionSlideUrl/);
  assert.match(component, /<PlayMode/);
  assert.match(component, /deckVersionExportUrl\(projectId, selectedVersion\.id, "pdf"\)/);
  assert.match(component, /deckVersionExportUrl\(projectId, selectedVersion\.id, "pptx"\)/);
  assert.match(exportRoute, /buildPptx\(detail\.project, readImage\)/);
  assert.match(exportRoute, /buildPdf\(detail\.project, readImage\)/);
});
