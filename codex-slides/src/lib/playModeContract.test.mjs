import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
const component = readFileSync(new URL("../components/PlayMode.tsx", import.meta.url), "utf8");

test("audience controls reveal only from the fixed bottom hover zone", () => {
  assert.match(component, /className="playmode-control-trigger"/);
  assert.match(component, /onMouseEnter=\{showControls\}/);
  assert.doesNotMatch(component, /className=.*playmode[^\n]*onMouseMove/);
  assert.match(css, /\.playmode-control-trigger\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?bottom:\s*0;/);
});

test("showing playback chrome does not change stage padding or slide dimensions", () => {
  assert.doesNotMatch(css, /controls-hidden\s+\.playmode-stage/);
  assert.match(css, /\.playmode-stage\s*\{[\s\S]*?padding:\s*clamp\(8px, 1\.5vw, 24px\);/);
  assert.match(css, /\.playmode-slide\s*\{[\s\S]*?width:\s*100%;[\s\S]*?height:\s*100%;/);
});
