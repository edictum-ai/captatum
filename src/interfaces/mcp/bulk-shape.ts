// Builds the lean MCP `structuredContent` for a captatum_bulk result. Mirrors the
// single-fetch shape's philosophy: the load-bearing primitives (url, status, tier, code,
// bytes, output, platform, contentSha256) per entry + the run envelope (totals, guard,
// capBreaches, clamp, fenceToken), with the per-entry `result` snippet ≤500 chars. Over
// the ~25 KB cap, per-entry result/content/transform snippets are dropped (the URL + status
// + tier + code + finalUrl remain so the agent can re-fetch). The domain BulkResult is the
// full internal record; this never mutates it. See docs/contracts.md "MCP delivery".
import type { BulkResult, BulkSeedResult } from "../../domain/bulk-result.ts";

const MAX_STRUCTURED_CHARS = 25_000;

export function buildBulkStructuredContent(bulk: BulkResult, debug = false): Record<string, unknown> {
  const withSnippets = envelope(bulk, false, debug);
  if (JSON.stringify(withSnippets).length <= MAX_STRUCTURED_CHARS) return withSnippets;
  return envelope(bulk, true, debug); // overflow: drop per-entry result/content/transform
}

function envelope(bulk: BulkResult, dropSnippets: boolean, debug: boolean): Record<string, unknown> {
  return {
    schemaVersion: bulk.schemaVersion,
    kind: bulk.kind,
    bulkId: bulk.bulkId,
    ok: bulk.ok,
    status: bulk.status,
    count: bulk.count,
    passed: bulk.passed,
    failed: bulk.failed,
    totals: bulk.totals,
    guard: bulk.guard,
    capBreaches: bulk.capBreaches,
    clamp: bulk.clamp,
    fenceToken: bulk.fenceToken,
    results: bulk.results.map((r) => leanRow(r, dropSnippets, debug)),
    failures: bulk.failures,
    warnings: bulk.warnings,
    errors: bulk.errors,
  };
}

function leanRow(r: BulkSeedResult, dropSnippets: boolean, debug: boolean): Record<string, unknown> {
  const row: Record<string, unknown> = {
    url: r.url,
    finalUrl: r.finalUrl,
    status: r.status,
    tier: r.tier,
    code: r.code,
    codeText: r.codeText,
    bytes: r.bytes,
    egressBytes: r.egressBytes,
    output: r.output,
    platform: r.platform,
    jsRequired: r.jsRequired,
    resolvedVia: r.resolvedVia,
    redirectHosts: r.redirectHosts,
    ...(r.contentSha256 !== undefined ? { contentSha256: r.contentSha256 } : {}),
    warnings: r.warnings,
    errors: r.errors,
  };
  if (!dropSnippets) {
    row.result = r.result; // ≤500-char snippet
    if (r.transform) row.transform = r.transform;
  }
  if (debug && !dropSnippets) row.content = r.content; // the fuller text body, debug only
  return row;
}
