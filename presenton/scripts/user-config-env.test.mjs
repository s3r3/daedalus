import assert from "node:assert/strict";
import test from "node:test";

import userConfigEnv from "./user-config-env.cjs";

const { buildUserConfigFromEnv } = userConfigEnv;

test("environment config accepts GPT Image 2 and its quality", () => {
  const config = buildUserConfigFromEnv({}, {
    IMAGE_PROVIDER: "gpt-image-2", GPT_IMAGE_2_QUALITY: "low",
  });
  assert.equal(config.IMAGE_PROVIDER, "gpt-image-2");
  assert.equal(config.GPT_IMAGE_2_QUALITY, "low");
});

for (const [legacyQuality, expected] of [["standard", "medium"], ["hd", "high"]]) {
  test(`saved DALL-E ${legacyQuality} quality migrates to GPT Image 2 ${expected}`, () => {
    const config = buildUserConfigFromEnv({
      IMAGE_PROVIDER: "dall-e-3", DALL_E_3_QUALITY: legacyQuality,
    }, {});
    assert.equal(config.IMAGE_PROVIDER, "gpt-image-2");
    assert.equal(config.GPT_IMAGE_2_QUALITY, expected);
    assert.equal("DALL_E_3_QUALITY" in config, false);
  });
}

test("legacy environment migrates without overriding explicit GPT Image 2 quality", () => {
  const config = buildUserConfigFromEnv({}, {
    IMAGE_PROVIDER: "dall-e-3", DALL_E_3_QUALITY: "hd", GPT_IMAGE_2_QUALITY: "low",
  });
  assert.equal(config.IMAGE_PROVIDER, "gpt-image-2");
  assert.equal(config.GPT_IMAGE_2_QUALITY, "low");
  assert.equal("DALL_E_3_QUALITY" in config, false);
});

test("choosing another provider discards obsolete DALL-E quality", () => {
  const config = buildUserConfigFromEnv({
    IMAGE_PROVIDER: "dall-e-3", DALL_E_3_QUALITY: "hd",
  }, { IMAGE_PROVIDER: "pexels" });
  assert.equal(config.IMAGE_PROVIDER, "pexels");
  assert.equal("DALL_E_3_QUALITY" in config, false);
});
