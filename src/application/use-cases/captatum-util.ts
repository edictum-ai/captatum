import { STATUS_CODES } from "node:http";
import { computeProvenanceHash, type Result } from "../../domain/result.ts";
import type { FetcherOptions, FetcherPort, FetcherResult, RejectResult } from "../ports/fetcher.ts";
import { errorMessage } from "./result-excerpt.ts";

/**
 * Small pure helpers shared by the Captatum use case + its output-mode step.
 * Extracted so captatum.ts stays within the file-size limit when new orchestration
 * (e.g. Tier-2 short-circuit) is added; these have no deps on the use case itself.
 */

/** Stamp total/fetch timings, derived HTTP code text, and the provenance hash. */
export function stampTotals(result: Result, totalMs: number, fetchMs: number): void {
  result.durationMs = totalMs;
  result.timings.totalMs = totalMs;
  result.timings.fetchMs = fetchMs;
  result.codeText = result.code === 0 ? result.codeText : STATUS_CODES[result.code] ?? "";
  result.provenanceHash = computeProvenanceHash(result);
}

/** Map a thrown fetch error to a safe RejectResult (the fetch never produced a guarded response). */
export function unexpectedReject(error: unknown): RejectResult {
  return {
    rejected: true,
    code: "network_error",
    message: errorMessage(error, "Fetch failed before a safe response was available"),
  };
}

/** Non-negative rounded elapsed milliseconds between two clock readings. */
export function elapsed(startMs: number, endMs: number): number {
  return Math.max(0, Math.round(endMs - startMs));
}

/**
 * Fetch a URL through the guarded fetcher, retrying ONCE on a zero-bytes `body_read_error`
 * reject (the body stream broke before ANY content arrived — a transient transport failure).
 * SINGLE-FETCH ONLY: when `signal` is present (a `captatum_bulk` seed under the wall) the
 * retry is skipped — the orchestrator cannot reserve a transparent in-`execute` retry's
 * egress against the byte cap, so the bulk egress bound stays airtight (#149). A mid-read
 * truncation (partial bytes) is NOT a reject (`readCappedBody` returns it as a successful
 * truncated FetcherResult), so this fires only on the zero-bytes total failure. Each attempt
 * is bounded by `opts.timeoutMs`, so the retry is bounded too.
 */
export async function fetchTier1WithBodyReadRetry(
  fetcher: FetcherPort,
  url: string,
  opts: FetcherOptions,
  signal: AbortSignal | undefined,
): Promise<FetcherResult | RejectResult> {
  let fetched: FetcherResult | RejectResult;
  try {
    fetched = await fetcher.fetchGuarded(url, opts);
  } catch (error) {
    fetched = unexpectedReject(error);
  }
  // INVARIANT: `signal` present === a captatum_bulk seed (the orchestrator always threads its
  // wall signal into execute) === egress is metered by the per-call byte cap. This retry is
  // egress-UNACCOUNTED (the orchestrator cannot reserve a transparent in-execute retry's bytes),
  // so it runs ONLY when there is no signal (single-fetch, where egress is unbounded). Do NOT
  // invoke this path for a bulk seed — and a future single-fetch caller that passes an abort
  // signal (e.g. HTTP-request cancellation) forgoes the retry by design (#149).
  if ("rejected" in fetched && fetched.code === "body_read_error" && !signal) {
    try {
      const retry = await fetcher.fetchGuarded(url, opts);
      if (!("rejected" in retry)) {
        fetched = retry; // got content (full or partial) → use it
      } else if (retry.code !== "body_read_error") {
        // The retry failed with a fresher, more representative code (e.g. timeout / network_error
        // on the second TCP path) — surface it rather than the stale first-attempt body_read_error.
        fetched = retry;
      }
      // else: retry also body_read_error → keep the original (equivalent) reject.
    } catch { /* keep the original body_read_error reject */ }
  }
  return fetched;
}
