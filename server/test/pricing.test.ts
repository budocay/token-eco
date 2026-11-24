import { test } from "node:test";
import assert from "node:assert/strict";
import { PRICES, priceKey, requestPrice } from "../src/pricing.ts";
import { modelKey, priceFor } from "../src/sessions.ts";

test("log model ids resolve to a price (dated suffix, new models)", () => {
  assert.equal(modelKey("claude-fable-5-2"), "claude-fable-5.2");
  assert.equal(priceFor("claude-fable-5-2")?.input, 8);
  assert.equal(priceFor("claude-opus-4-7-20260115")?.output, 25);
  assert.equal(priceFor("claude-fable-5")?.cacheRead, 1);
});

test("unlisted version: priced like the newest listed model of its family", () => {
  assert.equal(priceKey("claude-opus-9.9"), "claude-opus-5.5");
  assert.equal(priceKey("claude-fable-6"), "claude-fable-5.2");
  assert.equal(priceKey("claude-unknown-1"), undefined);
  assert.equal(priceKey("gpt-5"), undefined);
  assert.equal(priceFor("<synthetic>"), undefined);
});

test("Haiku 5.5: a request above 100K prompt tokens pays every price x5", () => {
  const base = PRICES["claude-haiku-5.5"];
  assert.equal(requestPrice("claude-haiku-5.5", 100_000), base);
  assert.deepEqual(
    (({ input, cacheWrite5m, cacheRead, output }) => ({ input, cacheWrite5m, cacheRead, output }))(requestPrice("claude-haiku-5.5", 100_001)!),
    { input: 0.5, cacheWrite5m: 0.625, cacheRead: 0.05, output: 2.5 },
  );
  assert.equal(requestPrice("claude-opus-5.5", 900_000), PRICES["claude-opus-5.5"]);
});
