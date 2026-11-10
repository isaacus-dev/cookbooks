import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

import { fixText } from "../helpers/ftfy.js";

const fixtures = JSON.parse(fs.readFileSync(new URL("./ftfy-fixtures.json", import.meta.url), "utf8"));

test("matches Python ftfy 6.3.1 reference outputs", () => {
  for (const { input, expected } of fixtures) {
    assert.equal(fixText(input), expected, JSON.stringify(input));
    assert.equal(fixText(expected), expected, `idempotence: ${JSON.stringify(input)}`);
  }
});

test("limits long segments without splitting an astral character", () => {
  const prefix = "a".repeat(999_999) + "😀";
  assert.equal(fixText(`${prefix}&amp;`), `${prefix}&`);
  assert.equal(fixText(`${prefix}<b>\n&amp;`), `${prefix}<b>\n&amp;`);
});
