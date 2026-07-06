// Builds the lean MCP `structuredContent` for a captatum_bulk result. Mirrors the
// single-fetch shape's philosophy: the load-bearing primitives (url, status, tier, code,
// bytes, output, platform, contentSha256) per entry + the run envelope (totals, guard,
// capBreaches, clamp, fenceToken), with the per-entry `result` snippet ≤500 chars. The
// delivery is HARD-BOUNDED to ~25 KB via a 3-tier degradation: full (with snippets) → lean
// (drop per-entry result/content/transform) → compact (also clip url/finalUrl to 100 chars
// + drop contentSha256/redirectHosts), so even an adversarial 50×2048-char-URL input stays
// under the ceiling. The domain BulkResult is the full internal record; this never mutates
// it. See docs/contracts.md "MCP delivery".
import type { BulkResult, BulkSeedResult } from "../../domain/bulk-result.ts";
import { redactSignedQueryParams } from "../../infrastructure/llm/safety.ts";

const MAX_STRUCTURED_CHARS = 25_000;
const COMPACT_URL_CHARS = 100;
const COMPACT_MAX_FAILURES = 30; // bounds the compact-tier failures[] (an all-rejected bulk)
type RowTier = "full" | "lean" | "compact";

export function buildBulkStructuredContent(bulk: BulkResult, debug = false): Record<string, unknown> {
  const full = envelope(bulk, "full", debug);
  if (JSON.stringify(full).length <= MAX_STRUCTURED_CHARS) return full;
  const lean = envelope(bulk, "lean", debug);
  if (JSON.stringify(lean).length <= MAX_STRUCTURED_CHARS) return lean;
  const compact = envelope(bulk, "compact", debug);
  if (JSON.stringify(compact).length <= MAX_STRUCTURED_CHARS) return compact;
  return { ...compact, failures: [] }; // final hard fallback (defensive): drop failures entirely
}

function envelope(bulk: BulkResult, tier: RowTier, debug: boolean): Record<string, unknown> {
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
    results: bulk.results.map((r) => leanRow(r, tier, debug)),
    failures: safeFailures(bulk.failures, tier === "compact"),
    warnings: bulk.warnings,
    errors: bulk.errors,
  };
}

/** Redact signed query params from EVERY failure URL (a failed/rejected presigned seed would
 *  leak its signature into structuredContent otherwise — single-fetch redacts; bulk matches) +
 *  clip + cap on the compact tier. The envelope's `failed` count still reports the true total. */
function safeFailures(failures: BulkResult["failures"], compact: boolean): BulkResult["failures"] {
  const out = failures.map((f) => {
    const redacted = redactSignedQueryParams(f.url);
    return { ...f, url: compact && redacted.length > COMPACT_URL_CHARS ? `${redacted.slice(0, COMPACT_URL_CHARS - 1)}…` : redacted };
  });
  return compact ? out.slice(0, COMPACT_MAX_FAILURES) : out;
}

function leanRow(r: BulkSeedResult, tier: RowTier, debug: boolean): Record<string, unknown> {
  // Redact signed query params (presigned S3/Azure/access_token URLs) + clip on the compact tier.
  const clip = (s: string): string => {
    const redacted = redactSignedQueryParams(s);
    return tier === "compact" && redacted.length > COMPACT_URL_CHARS ? `${redacted.slice(0, COMPACT_URL_CHARS - 1)}…` : redacted;
  };
  const row: Record<string, unknown> = {
    url: clip(r.url),
    finalUrl: clip(r.finalUrl),
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
    ...(tier !== "compact" ? { redirectHosts: r.redirectHosts } : {}), // drop on compact (heaviest non-url field)
    ...(r.contentSha256 !== undefined && tier !== "compact" ? { contentSha256: r.contentSha256 } : {}),
    warnings: r.warnings,
    errors: r.errors,
  };
  if (tier === "full") {
    row.result = r.result; // ≤500-char snippet
    if (r.transform) row.transform = r.transform;
    if (debug) row.content = r.content; // the fuller text body, debug only
  }
  return row;
}
