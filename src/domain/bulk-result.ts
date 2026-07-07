// The BulkResult envelope returned by captatum_bulk — the lean internal record.
// The MCP layer (bulk-shape/bulk-format) builds content[0].text +
// structuredContent from it. Pure domain: only type imports. See
// docs/contracts.md §"Tool: captatum_bulk" / "BulkResult envelope".
import type { Tier, Output } from "./tier.ts";
import type { BulkGuard, BulkStatus, PerHostTruncation } from "./bulk-policy.ts";

/** One per processed seed, INPUT ORDER preserved. `result` is a hard snippet
 *  (<=500 chars) or a per-entry reject message (used in structuredContent + failures[]);
 *  `content` is the fuller text-channel body (<=8 KB) framed by the fence token in
 *  content[0].text. `redirectHosts` + `contentSha256` are the anti-tamper / re-fetch
 *  handles. */
export interface BulkSeedResult {
  url: string;
  finalUrl: string;
  status: BulkStatus;
  tier: Tier;
  code: number;
  codeText: string;
  bytes: number;
  egressBytes: number;
  output: Output;
  platform: string; // adapterId
  jsRequired: boolean;
  resolvedVia: string;
  redirectHosts: string[];
  contentSha256?: string;
  result: string;
  content: string;
  transform?: { provider: string; model?: string; reason?: string; costUsd?: number; inTokens?: number; outTokens?: number };
  warnings: { code: string; message: string }[];
  errors: { code: string; message: string }[];
}

export interface BulkTotals {
  bytes: number;
  egressBytes: number;
  durationMs: number;
  transformInTokens: number;
  transformOutTokens: number;
  transformCostUsd: number;
}

export interface BulkFailure {
  url: string;
  code: string;
  message: string;
}

/** Disclosure of the input-shaping stages (decision 10: clamp + disclose). */
export interface BulkClamp {
  inputUrls: number;
  afterDedupe: number;
  afterPerHostCap: number;
  processed: number;
  perHostTruncated: readonly PerHostTruncation[];
  totalClampedTo: number | null;
}

/** Disclosure of the per-tenant quota reservation (BULK-1) — present on hosted when a
 *  BulkQuotaPort is configured. Carried onto the summary audit event (quotaReserved /
 *  quotaWindowSeconds) so per-tenant bulk spend is auditable. Absent on the local flavor. */
export interface BulkQuotaReceipt {
  reserved: number;
  windowSeconds: number;
  limit: number;
}

export interface BulkResult {
  schemaVersion: 1;
  kind: "bulk";
  bulkId: string;
  ok: boolean;
  status: BulkStatus;
  count: number;
  passed: number;
  failed: number;
  truncated: number;
  deduped: number;
  totals: BulkTotals;
  guard: BulkGuard;
  capBreaches: string[];
  clamp: BulkClamp;
  fenceToken: string;
  results: BulkSeedResult[];
  failures: BulkFailure[];
  warnings: { code: string; message: string }[];
  errors: { code: string; message: string }[];
  /** Per-tenant quota reservation receipt (hosted, BULK-1). Absent on local (no quota port). */
  quota?: BulkQuotaReceipt;
}

export const EMPTY_BULK_TOTALS: BulkTotals = {
  bytes: 0,
  egressBytes: 0,
  durationMs: 0,
  transformInTokens: 0,
  transformOutTokens: 0,
  transformCostUsd: 0,
};
