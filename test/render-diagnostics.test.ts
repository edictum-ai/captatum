// Non-frozen impl-detail tests for #154: the output-boundary IP filter (redactEgressHost — the
// security pin) + the classifier thresholds. The CONTRACT is pinned effects-only in the frozen
// test/acceptance/154/. Per [[captatum-frozen-suite-contract-only]], impl-detail guards live here.
import assert from "node:assert/strict";
import { test } from "node:test";
import { redactEgressHost } from "../src/interfaces/mcp/egress-shaping.ts";
import {
  classifyRenderFailure,
  EXTRACTION_GAP_BYTES,
  EMPTY_DOM_BYTES,
  DOM_TEXT_PRESENT,
} from "../src/application/use-cases/render-diagnostics.ts";
import type { RenderOutput } from "../src/application/ports/renderer.ts";

test("#154 redactEgressHost: registrable domain kept; IP / single-label / IPv6 → [ip-literal]", () => {
  assert.equal(redactEgressHost("example.com"), "example.com");
  assert.equal(redactEgressHost("sub.example.com"), "example.com"); // normalized to registrable
  assert.equal(redactEgressHost("93.184.216.34"), "[ip-literal]", "public IPv4 never leaks");
  assert.equal(redactEgressHost("localhost"), "[ip-literal]", "single-label redacted");
  assert.equal(redactEgressHost("[::1]"), "[ip-literal]", "IPv6 literal redacted");
});

test("#154 classifyRenderFailure: !rendered → render-error", () => {
  const fail = { rendered: false, actions: [], code: "render_timeout", message: "x" } as unknown as RenderOutput;
  assert.equal(classifyRenderFailure(fail, undefined), "render-error");
});

test("#154 classifyRenderFailure: network-blocked when DOM present + Tier-3 egress 0 + no hosts", () => {
  const ok = { rendered: true, fetchResult: { bytes: 60_000 }, actions: [], egressBytes: 0, egressHosts: [] } as unknown as RenderOutput;
  assert.equal(classifyRenderFailure(ok, 8000), "network-blocked");
});

test("#154 classifyRenderFailure: extraction-gap (high DOM + high text) / empty-dom (low + low) / unknown (high DOM + low text)", () => {
  const mk = (bytes: number, egress = 40_000): RenderOutput =>
    ({ rendered: true, fetchResult: { bytes }, actions: [], egressBytes: egress, egressHosts: ["app.test"] } as unknown as RenderOutput);
  assert.equal(classifyRenderFailure(mk(60_000), 8000), "extraction-gap");
  assert.equal(classifyRenderFailure(mk(40), 2), "empty-dom");
  assert.equal(classifyRenderFailure(mk(60_000), 3), "unknown", "high DOM + LOW text → unknown (not a confident wall label)");
});

test("#154 thresholds are the calibrated constants (impl-detail pin)", () => {
  assert.equal(EXTRACTION_GAP_BYTES, 4096);
  assert.equal(EMPTY_DOM_BYTES, 2048);
  assert.equal(DOM_TEXT_PRESENT, 100);
});
