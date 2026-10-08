#!/usr/bin/env node

import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, ".codex-plugin", "plugin.json"), "utf8"));
const sourceCandidate = process.env.CODEX_SLIDES_PLUGIN_SOURCE || join(homedir(), "plugins", manifest.name);
const runtimeRoot = (() => {
  try {
    const candidate = realpathSync(resolve(sourceCandidate));
    if (existsSync(join(candidate, "node_modules", "@modelcontextprotocol", "sdk"))) return candidate;
  } catch {
    // Fall back to this plugin root for repository and archive installs.
  }
  return root;
})();
const sdkRoot = join(runtimeRoot, "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm", "client");
const { Client } = await import(pathToFileURL(join(sdkRoot, "index.js")).href);
const { StdioClientTransport } = await import(pathToFileURL(join(sdkRoot, "stdio.js")).href);

const live = process.argv.includes("--live");
const expected = [
  "get_capabilities",
  "open_codex_slides",
  "start_project",
  "start_project_run",
  "get_project_run",
  "wait_project_run",
  "cancel_project_run",
  "get_onboarding_questions",
  "deep_research",
  "create_deck",
  "create_outline",
  "revise_outline",
  "rank_inspiration",
  "render_deck",
  "list_projects",
  "get_project",
  "get_speaker_notes",
  "update_speaker_notes",
  "generate_speaker_notes",
  "list_templates",
  "list_project_templates",
  "save_project_as_template",
  "delete_project_template",
  "list_scenarios",
  "list_design_files",
  "read_design_file",
  "write_design_file",
  "upload_design_file",
  "get_brand_design_system",
  "update_brand_design_system",
  "edit_deck",
  "restyle_deck",
  "manage_slide",
  "regenerate_slide",
  "upload_material",
  "upload_slide_image",
  "mark_edit_slide",
  "export_deck",
];

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve(root, "scripts/start-mcp.mjs")],
  cwd: root,
  env: {
    ...process.env,
    ...(live ? {} : { CODEX_SLIDES_NO_AUTO_START: "1" }),
  },
  stderr: "pipe",
});
const client = new Client({ name: "codex-slides-probe", version: "1.0.0" });

try {
  await client.connect(transport);
  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [...expected].sort(), "MCP tool inventory drifted");
  const createDeck = listed.tools.find((tool) => tool.name === "create_deck");
  assert.ok(createDeck?.inputSchema?.properties?.scenarioId, "create_deck must expose scenarioId");
  assert.ok(createDeck?.inputSchema?.properties?.materialContexts, "create_deck must expose materialContexts");
  assert.ok(createDeck?.inputSchema?.properties?.designSystem, "create_deck must expose designSystem");
  assert.ok(createDeck?.inputSchema?.properties?.projectTemplateId, "create_deck must expose projectTemplateId");
  const openTool = listed.tools.find((tool) => tool.name === "open_codex_slides");
  assert.ok(openTool?.inputSchema?.properties?.view, "open_codex_slides must expose Browser views");
  assert.ok(openTool?.inputSchema?.properties?.slideIndex, "open_codex_slides must focus a slide");
  assert.ok(openTool?.inputSchema?.properties?.panel, "open_codex_slides must focus a panel");
  assert.ok(openTool?.inputSchema?.properties?.versionId, "open_codex_slides must focus a version");
  assert.ok(openTool?.inputSchema?.properties?.mode, "open_codex_slides must expose play/presenter modes");
  const startProject = listed.tools.find((tool) => tool.name === "start_project");
  assert.ok(startProject?.inputSchema?.properties?.topic, "start_project must expose topic");
  assert.match(startProject?.description || "", /does not research|does not.*render/i, "start_project must remain a project-shell operation");

  const capabilities = await client.callTool({ name: "get_capabilities", arguments: {} });
  assert.equal(capabilities.isError, undefined);
  assert.equal(capabilities.structuredContent?.capabilities?.length, 40);
  assert.ok(capabilities.content.some((item) => item.type === "resource_link"));
  assert.equal(capabilities.structuredContent?.browserHandoff?.required, true);

  if (live) {
    const projects = await client.callTool({ name: "list_projects", arguments: {} });
    assert.equal(projects.isError, undefined);
    const templates = await client.callTool({ name: "list_templates", arguments: {} });
    assert.equal(templates.isError, undefined);
    assert.ok(templates.structuredContent?.templates?.length >= 45);
    const projectTemplates = await client.callTool({ name: "list_project_templates", arguments: {} });
    assert.equal(projectTemplates.isError, undefined);
    const scenarios = await client.callTool({ name: "list_scenarios", arguments: {} });
    assert.equal(scenarios.structuredContent?.groups?.length, 6);
    assert.equal(scenarios.structuredContent?.scenarios?.length, 24);
    const opened = await client.callTool({
      name: "open_codex_slides",
      arguments: { view: "scenarios", scenarioId: "new-deck" },
    });
    assert.ok(opened.content.some((item) => item.type === "resource_link"));
    assert.ok(opened.structuredContent?.url?.includes("view=scenarios"));
    assert.equal(opened.structuredContent?.browserHandoff?.preferredMode, "codex-internal-browser");
  }

  process.stdout.write(`MCP probe passed: ${expected.length} tools${live ? ", live API and Browser link" : ""}.\n`);
} finally {
  await client.close();
}
