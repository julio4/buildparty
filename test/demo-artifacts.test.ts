import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { validateArtifact } from "../src/domain.ts";

const demos = ["product-launch", "decision-workshop", "learning-notebook", "worldbuilding"];

test("bundled demos are valid, self-contained BuildParty artifacts", async () => {
  for (const demo of demos) {
    const raw = await readFile(new URL(`../public/demo/${demo}/artifact.json`, import.meta.url), "utf8");
    const artifact = validateArtifact(JSON.parse(raw));
    assert.equal(artifact.blocks.length, 3, `${demo} should have three reviewable blocks`);
    for (const block of artifact.blocks) {
      assert.doesNotMatch(Object.values(block.source).join("\n"), /https?:\/\/|\bfetch\s*\(|\bimport\s*\(/, `${demo}/${block.id} must be self-contained`);
      if (block.source.js) new Function(block.source.js);
    }
  }
});
