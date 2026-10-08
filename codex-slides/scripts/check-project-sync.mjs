#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");

const deckView = read("src/components/DeckView.tsx");
assert.match(deckView, /\/api\/projects\/\$\{encodeURIComponent\(projectId\)\}\/runs/);
assert.match(deckView, /ACTIVE_PROJECT_POLL_MS\s*:\s*IDLE_PROJECT_POLL_MS/);
assert.match(deckView, /"If-None-Match": projectResponseEtagRef\.current/);
assert.match(deckView, /checkpointSignature\(patch\)/);
assert.match(deckView, /window\.addEventListener\("focus", refresh\)/);
assert.match(deckView, /document\.addEventListener\("visibilitychange", onVisibility\)/);
assert.match(deckView, /setSlides\([\s\S]*reconcileProjectSlides/);
assert.match(deckView, /latest\.conversations/);

const runRoute = read("src/app/api/projects/[id]/runs/route.ts");
assert.match(runRoute, /ensureProjectRun\(params\.id\)/);
assert.match(runRoute, /activeRun: project\.activeRun \?\? null/);
assert.match(runRoute, /getProjectRun\(project, runId\)/);
assert.match(runRoute, /queuedRequestId/);
assert.match(runRoute, /status: 304/);

const projectRuns = read("src/lib/projectRuns.ts");
assert.match(projectRuns, /__codexSlidesProjectRuns/);
assert.match(projectRuns, /project\.activeRun = run/);
assert.match(projectRuns, /project\.runHistory =/);
assert.match(projectRuns, /archiveRun\(projectId, run, finalStatus/);
assert.match(projectRuns, /saveProject\(project\)/);

const live = process.argv.includes("--live");
if (live) {
  const base = (process.env.CODEX_SLIDES_URL || "http://127.0.0.1:4311").replace(/\/$/, "");
  const projectsResponse = await fetch(`${base}/api/projects`);
  assert.equal(projectsResponse.ok, true, `Project list returned HTTP ${projectsResponse.status}`);
  const projects = (await projectsResponse.json()).projects ?? [];
  const requestedProjectId = process.env.CODEX_SLIDES_PROJECT_ID;
  const candidate = requestedProjectId
    ? projects.find((project) => project.id === requestedProjectId)
    : projects.find((project) => project.rendered > 0);
  assert.ok(candidate, requestedProjectId
    ? `Live sync check could not find project ${requestedProjectId}`
    : "Live sync check needs at least one rendered project");

  const runResponse = await fetch(`${base}/api/projects/${encodeURIComponent(candidate.id)}/runs`, {
    headers: { Accept: "application/json" },
  });
  assert.equal(runResponse.ok, true, `Project run snapshot returned HTTP ${runResponse.status}`);
  const payload = await runResponse.json();
  const project = payload.project;
  assert.equal(project.id, candidate.id);
  const projectEtag = runResponse.headers.get("etag");
  assert.ok(projectEtag, "Project run snapshot did not include an ETag");
  const unchangedRunResponse = await fetch(`${base}/api/projects/${encodeURIComponent(candidate.id)}/runs`, {
    headers: { Accept: "application/json", "If-None-Match": projectEtag },
  });
  assert.equal(unchangedRunResponse.status, 304, "Unchanged project snapshot was transferred again");
  const rendered = (project.pages ?? []).filter((page) => page.status === "rendered" && page.image);
  assert.equal(rendered.length, candidate.rendered, "Project list and canonical run snapshot disagree");

  for (const page of rendered) {
    const imageResponse = await fetch(`${base}/api/files/${encodeURIComponent(project.id)}/${encodeURIComponent(page.image)}?v=${page.imageUpdatedAt ?? 1}`);
    assert.equal(imageResponse.ok, true, `Missing persisted image for slide ${page.index}`);
    assert.match(imageResponse.headers.get("content-type") || "", /^image\//);
    assert.match(imageResponse.headers.get("cache-control") || "", /immutable/);
  }
  process.stdout.write(`Project sync live check passed: ${project.title}, ${rendered.length} persisted slide image(s).\n`);
} else {
  process.stdout.write("Project sync contract passed.\n");
}
