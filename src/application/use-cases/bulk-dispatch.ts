// Pre-dispatch helpers for captatum_bulk, extracted from the orchestrator to
// respect the 250-line limit: per-entry rejection (Tier-2 boards + Ashby embeds),
// the per-tenant quota reservation (BULK-1), and the Ashby-embed jid extractor.
// See docs/contracts.md §"Tool: captatum_bulk" / "Hosted amplification controls".
import type { PlatformAdapterRegistry } from "../ports/platform-adapter.ts";
import type { BulkQuotaPort, QuotaAllow } from "../ports/bulk-quota.ts";
import { BulkQuotaError } from "../ports/bulk-quota.ts";
import type { ValidatedSeed } from "../../domain/bulk-policy.ts";

export interface PerEntryRejects {
  toProcess: ValidatedSeed[];
  boardRejected: ValidatedSeed[];
  ashbyRejected: ValidatedSeed[];
}

/** Per-entry rejection (roster-intact + egress-accounting invariants):
 *  - Tier-2 board-root seeds (roster expander → forbidden in bulk — single-fetch the board).
 *  - Ashby-embed (`?ashby_jid=`) seeds: the embed resolver performs an auxiliary host-page
 *    fetch NOT captured by v1's result.bytes egress accounting (BULK-5), so a caller adding
 *    ashby_jid to many URLs could spend up to another maxBytes/seed off the books. v1 closes
 *    this structurally (like render) — single-fetch embeds, or bulk the direct ashby job URLs.
 *  Per-JD URLs are not detected and flow through to Tier-1. */
export function rejectPerEntryBulk(adapters: PlatformAdapterRegistry, seeds: readonly ValidatedSeed[]): PerEntryRejects {
  const toProcess: ValidatedSeed[] = [];
  const boardRejected: ValidatedSeed[] = [];
  const ashbyRejected: ValidatedSeed[] = [];
  for (const s of seeds) {
    if (adapters.detect({ url: s.url })) boardRejected.push(s);
    else if (ashbyJidOf(s.url) !== null) ashbyRejected.push(s);
    else toProcess.push(s);
  }
  return { toProcess, boardRejected, ashbyRejected };
}

/** Reserve the call's processed-seed count against the calling tenant's rolling window.
 *  Fail-closed: a refusal (window exhausted OR store error OR missing tenant) throws
 *  BulkQuotaError → a tool-level error (retryable for `exceeded`, fail-closed refusal for
 *  `store_error`). Returns the QuotaAllow on success (for the audit summary event) or undefined
 *  when no quota port is configured (local-binary flavor). */
export async function reserveBulkQuota(quota: BulkQuotaPort | undefined, tenant: string | undefined, seeds: number): Promise<QuotaAllow | undefined> {
  if (!quota) return undefined;
  const res = await quota.tryReserve({ tenant: tenant ?? "", seeds });
  if (res.ok) return res;
  if (res.code === "bulk_quota_exceeded") {
    throw new BulkQuotaError(
      "bulk_quota_exceeded",
      `per-tenant bulk seed quota exceeded (${res.used}/${res.limit} seeds in the ${res.windowSeconds}s window)`,
      { retryable: true, ...(res.retryAfterMs !== undefined ? { retryAfterMs: res.retryAfterMs } : {}) },
    );
  }
  // bulk_quota_store_error — fail-closed refusal (missing tenant id OR store error).
  throw new BulkQuotaError("bulk_quota_store_error", res.message ?? "bulk quota store unavailable — refusing (fail-closed)");
}

/** Inline mirror of the Ashby-embed jid extractor (pure URL parsing; kept here to avoid
 *  an application→infrastructure import). Non-null ⇒ an ashby-embed seed. */
export function ashbyJidOf(url: string): string | null {
  try { return new URL(url).searchParams.get("ashby_jid"); } catch { return null; }
}
