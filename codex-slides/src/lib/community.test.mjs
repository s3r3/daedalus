import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  COMMUNITY_GROUPS,
  COMMUNITY_SOURCES,
  COMMUNITY_TEMPLATES,
  getCommunityTemplate,
  matchCommunityTemplates,
} from "./community.ts";

const read = (relative) => fs.readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

test("community library has broad, attributed PPT coverage", () => {
  assert.ok(COMMUNITY_TEMPLATES.length >= 70, `expected at least 70 styles, got ${COMMUNITY_TEMPLATES.length}`);
  assert.equal(new Set(COMMUNITY_TEMPLATES.map((template) => template.id)).size, COMMUNITY_TEMPLATES.length);

  for (const group of COMMUNITY_GROUPS) {
    assert.ok(COMMUNITY_TEMPLATES.some((template) => template.group === group), `${group} has no styles`);
  }

  const sourceIds = new Set(COMMUNITY_SOURCES.map((source) => source.id));
  const representedSources = new Set(COMMUNITY_TEMPLATES.flatMap((template) => template.sourceIds ?? []));
  for (const source of COMMUNITY_SOURCES) {
    assert.match(source.url, /^https:\/\//);
    assert.match(source.licenseUrl, /^https:\/\//);
    assert.ok(representedSources.has(source.id), `${source.id} has no catalog attribution`);
  }
  for (const template of COMMUNITY_TEMPLATES) {
    assert.ok(template.styleBlock.length >= 60, `${template.id} has a weak style block`);
    assert.ok(template.cover.startsWith("/") || template.cover.startsWith("https://"), `${template.id} has an invalid cover`);
    for (const sourceId of template.sourceIds ?? []) assert.ok(sourceIds.has(sourceId), `${template.id} has unknown source ${sourceId}`);
  }
});

test("offline matching expands Chinese presentation intent", () => {
  const business = matchCommunityTemplates("专业商业汇报，面向投资人展示增长数据", 12);
  assert.ok(business.some((template) => template.group === "Business & Report"));
  assert.ok(business.some((template) => template.group === "Data & Map" || template.group === "Infographic"));
});

test("selected community style reaches the image prompt and visual-reference contract", () => {
  assert.match(getCommunityTemplate("gi2-document-publishing")?.styleBlock ?? "", /disciplined publication grid/i);
  assert.match(read("./prompts.ts"), /FIRST reference image is the user's selected COMMUNITY STYLE/);
  assert.match(read("./pipeline.ts"), /loadCommunityStyleReference/);
  assert.match(read("./pipeline.ts"), /refImages: referenceBuffers/);
  assert.match(read("./store.ts"), /selectedStyle:/);
});
