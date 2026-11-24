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

test("sessions: a period only counts the turns inside it (session resumed for months)", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { listSessions, encodeProject } = await import("../src/sessions.ts");
  const root = await mkdtemp(join(tmpdir(), "token-eco-since-")), proj = "/tmp/long-project", dir = join(root, encodeProject(proj));
  await mkdir(dir, { recursive: true });
  const usage = { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0, output_tokens: 50 };
  const msg = (id: string, ts: string) => JSON.stringify({ type: "assistant", cwd: proj, timestamp: ts, message: { id, model: "claude-opus-5", usage, content: [] } });
  const now = new Date().toISOString();
  await writeFile(join(dir, "s.jsonl"), [msg("old1", "2020-01-01T10:00:00Z"), msg("old2", "2020-01-01T10:01:00Z"), msg("new1", now), msg("new2", now)].join("\n"));
  assert.equal(listSessions({ project: proj, days: 30 }, root)[0].turns, 2);
  assert.equal(listSessions({ project: proj }, root)[0].turns, 4);
  await rm(root, { recursive: true, force: true });
});

test("insights: overlapping sessions of one project get disjoint call windows", async () => {
  const { callWindows } = await import("../src/insights.ts");
  const w = callWindows([
    { id: "b", project: "/p", start: "2026-11-03T00:00:00Z", end: "2026-11-24T00:00:00Z" },
    { id: "a", project: "/p", start: "2026-10-27T00:00:00Z", end: "2026-11-17T00:00:00Z" },
    { id: "in", project: "/p", start: "2026-11-09T00:00:00Z", end: "2026-11-09T01:00:00Z" },
    { id: "other", project: "/q", start: "2026-11-05T00:00:00Z", end: "2026-11-06T00:00:00Z" },
  ]);
  assert.equal(w.get("a"), "2026-10-27T00:00:00Z");
  assert.equal(w.get("b"), "2026-11-17T00:00:00Z"); // the overlap stays with the earlier session
  assert.ok(w.get("in")! > "2026-11-09T01:00:00Z"); // fully inside another one: empty window
  assert.equal(w.get("other"), "2026-11-05T00:00:00Z");
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
