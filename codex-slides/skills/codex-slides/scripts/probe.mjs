#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const CLI = join(SCRIPT_DIR, "codex-slides.mjs");
const live = process.argv.includes("--live");

function call(command, input = {}) {
  const result = spawnSync(process.execPath, [CLI, command, "--json", JSON.stringify(input)], {
    encoding: "utf8",
    timeout: 120_000,
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stdout || result.stderr || `${command} failed`);
  const output = JSON.parse(result.stdout);
  if (!output.ok) throw new Error(output.error || `${command} failed`);
  return output;
}

const capabilities = call("capabilities");
if (capabilities.commands.length !== 34) {
  throw new Error(`Expected 34 commands, got ${capabilities.commands.length}.`);
}
if (capabilities.capabilities.length < 36) {
  throw new Error(`Expected at least 36 capability surfaces, got ${capabilities.capabilities.length}.`);
}

const summary = {
  commands: capabilities.commands.length,
  capabilities: capabilities.capabilities.length,
  live: false,
};

if (live) {
  const projects = call("list");
  const templates = call("templates");
  const projectTemplates = call("project-templates");
  const scenarios = call("scenarios");
  const opened = call("open", { view: "scenarios", scenarioId: "new-deck" });
  if (!Array.isArray(projects.projects)) throw new Error("Project list is missing.");
  if (templates.categories?.length !== 15 || templates.templates?.length !== 45) {
    throw new Error(`Expected 15 categories and 45 templates, got ${templates.categories?.length}/${templates.templates?.length}.`);
  }
  if (!Array.isArray(projectTemplates.projectTemplates)) throw new Error("Project template list is missing.");
  if (scenarios.groups?.length !== 6 || scenarios.scenarios?.length !== 24) {
    throw new Error(`Expected 6 groups and 24 scenarios, got ${scenarios.groups?.length}/${scenarios.scenarios?.length}.`);
  }
  if (!opened.url?.startsWith("http://127.0.0.1:4311")) throw new Error("Browser URL is missing.");
  if (!opened.url.includes("view=scenarios") || !opened.url.includes("scenario=new-deck")) {
    throw new Error("Scenario Browser deep link is missing.");
  }
  if (!opened.browserHandoff?.required || opened.browserHandoff.url !== opened.url) {
    throw new Error("Browser handoff contract is missing.");
  }
  Object.assign(summary, {
    live: true,
    projects: projects.projects.length,
    categories: templates.categories.length,
    templates: templates.templates.length,
    scenarioGroups: scenarios.groups.length,
    scenarios: scenarios.scenarios.length,
    browserUrl: opened.url,
  });
}

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
