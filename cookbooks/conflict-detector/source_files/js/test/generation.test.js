import assert from "node:assert/strict";

import { test } from "node:test";

import { locate, parseAnswer, insertionPoint } from "../generation.js";

const INPUT = "# Terms\n\n1. The Customer pays 😀 the fees\nmonthly in advance.\n\n2. Either party may end it.\n";
const REFERENCE = "Fees are due within 30 days of the invoice. Late fees accrue at 1%.";
const PARTIES = [{ id: "provider", name: "the Provider", role: "Seller" }, { id: "customer", name: "the Customer", role: "Buyer" }];

test("locate counts code points and ignores differences in whitespace", () => {
  assert.deepEqual(locate(INPUT, "the fees"), { start: 32, end: 40 });
  assert.deepEqual(locate(INPUT, "the  fees monthly"), { start: 32, end: 48 });
  assert.equal(locate(INPUT, "not there"), null);
  assert.equal(locate(INPUT, ""), null);
  assert.equal(locate(INPUT, null), null);
});

test("insertionPoint is the end of the line the quote ends on", () => {
  const at = insertionPoint(INPUT, "monthly in");
  assert.equal(Array.from(INPUT)[at], "\n");
  assert.equal(Array.from(INPUT).slice(0, at).join("").endsWith("in advance."), true);
  assert.equal(insertionPoint(INPUT, "nowhere"), null);
});

test("parseAnswer keeps the validation rules", () => {
  const batch = [
    { id: "d1-0", kind: "changed", heading: null, keys: ["d1-0", "d1-1"] },
    { id: "r1", kind: "missing", heading: null, keys: ["r1"] },
    { id: "r2", kind: "missing", heading: null, keys: ["r2"] },
    { id: "i1", kind: "added", heading: null, keys: ["i1"] },
    { id: "i2", kind: "added", heading: null, keys: ["i2"] },
    { id: "d2-0", kind: "changed", heading: null, keys: ["d2-0"] },
    { id: "i3", kind: "added", heading: null, keys: ["i3"] },
    { id: "r3", kind: "missing", heading: null, keys: ["r3"] },
  ];
  const answer = {
    "d1-0": {
      summaries: [" First. ", "Second."], falsePositive: true, comment: "Same in effect.",
      referenceQuotes: ["Fees are due  within 30 days", "nowhere"],
      rewrite: "Shared.", parties: { provider: { action: "remove", reason: "r" }, customer: "junk" },
    },
    "r1": {
      summaries: ["Gap."], falsePositive: false, comment: "c", referenceQuotes: [], rewrite: "New clause.",
      insertAfter: "in advance.",
      parties: { provider: { action: "remove", reason: "r" }, customer: { action: "rewrite", reason: "r" } },
    },
    "r2": {
      summaries: ["Gap two."], falsePositive: false, comment: "c", referenceQuotes: [], rewrite: "New.",
      insertAfter: "missing anchor",
      parties: { provider: { action: "rewrite", reason: "r" }, customer: { action: null, reason: "r" } },
    },
    "i2": {
      summaries: ["One.", "Two."], falsePositive: false, comment: "c", referenceQuotes: [], rewrite: null,
      parties: { provider: { action: "ignore", reason: "r" }, customer: { action: "ignore", reason: "r" } },
    },
    "d2-0": {
      summaries: ["One."], falsePositive: false, comment: "c", referenceQuotes: [], rewrite: " ",
      parties: { provider: { action: "ignore", reason: "r" }, customer: { action: "ignore", reason: "r" } },
    },
    "r3": {
      summaries: ["Gap three."], falsePositive: false, comment: "c", referenceQuotes: [], rewrite: "New.",
      insertAfter: "the",
      parties: { provider: { action: "ignore", reason: "r" }, customer: { action: "ignore", reason: "r" } },
    },
    "i3": {
      summaries: ["One."], falsePositive: false, comment: "c", referenceQuotes: [], rewrite: null,
      parties: { provider: { action: "ignore", reason: "r" }, customer: { action: "ignore", reason: "r" } },
    },
  };
  const recommendations = { parties: PARTIES, findings: {} };
  const summaries = {};
  const problems = parseAnswer(`Here:\n${JSON.stringify(answer)}`, batch, {
    recommendations, summaries, input: INPUT, reference: REFERENCE,
  });
  const results = recommendations.findings;

  assert.deepEqual(results["d1-0"].parties.provider, { action: "ignore", reason: "r" });
  assert.deepEqual(results["d1-0"].parties.customer, { action: "ignore", reason: "" });
  assert.deepEqual(results["d1-0"].references, [{ start: 0, end: 27 }]);

  assert.equal(results.r1.parties.provider.action, "ignore");
  assert.equal(results.r1.insertAfter, "in advance.");
  assert.equal(Array.from(INPUT)[results.r1.insertAt], "\n");
  assert.equal(results.i3.rewrite, null);
  assert.deepEqual(Object.keys(results), ["d1-0", "r1", "i3"]);
  assert.deepEqual(summaries, { "d1-0": "First.", "d1-1": "Second.", "r1": "Gap.", "i3": "One." });
  assert.deepEqual(problems, [
    "d1-0: reference quote not found (dropped): nowhere",
    "r2: insertAfter not found in the input document: missing anchor",
    "i1: no answer",
    "i2: 2 summaries for 1 passages",
    "d2-0: no rewrite",
    "r3: insertAfter occurs more than once in the input document: the",
  ]);
  assert.throws(() => parseAnswer("no JSON", batch, { recommendations, summaries, input: INPUT, reference: REFERENCE }));
});
