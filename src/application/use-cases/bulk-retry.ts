// Per-seed 429/503 retry for captatum_bulk (PR 3). One jittered retry: on a
// 429/503 result carrying a curated `retryAfterMs`, wait (bounded by the bulk wall
// + a politeness cap) + a small CSPRNG jitter, then re-execute ONCE. The second
// attempt's result wins (freshest). Single-fetch is unchanged — no auto-retry.
// Extracted from the orchestrator (250-line limit). See docs/contracts.md
// §"Tool: captatum_bulk" / bulk error codes (`bulk_retried_429`).
import { randomInt } from "node:crypto";
import type { Result } from "../../domain/result.ts";
import { abortableSleep } from "./bulk-concurrency.ts";

/** Politeness cap on a single retry wait, so a hostile `Retry-After: 300` cannot
 *  make one seed's retry wait dominate the bulk wall. The wall signal bounds the
 *  wait further (abortableSleep returns immediately when it fires). */
const RETRY_WAIT_CAP_MS = 30_000;
/** Max CSPRNG jitter added to the wait (ms). */
const RETRY_JITTER_MAX_MS = 250;

export interface SeedRetryCtx {
  /** The bulk wall signal — aborts the wait + stops a retry past the deadline. */
  signal: AbortSignal;
  /** Returns true when the bulk wall deadline has passed (stop retrying). */
  wallExceeded: () => boolean;
  /** Reserve an additional per-seed byte unit for the retry's second fetch; returns false (skip
   *  the retry) when it would not fit under the global byte cap (codex P2). */
  reserveRetry: () => boolean;
  /** Release a retry reservation whose 2nd attempt did not run (e.g. it threw) — codex R8 P2. */
  releaseRetry: () => void;
}

/** Run a seed once; if the result is a retriable 429/503 with a `retryAfterMs` and
 *  the wall budget allows, wait + run it once more. Returns the final result, whether a retry
 *  occurred (`retried`), AND whether a retry byte-unit was reserved (`retryReserved`) — the caller
 *  MUST release `retryReserved` against the byte budget even when the retry is skipped after
 *  reserving (e.g. the wall fires during the Retry-After sleep), or the unit leaks (codex R8 P2).
 *  The returned result's `egressBytes` is the SUM of both attempts' egress (the first 429/503 body
 *  IS read from the network up to maxBytes, so it must be counted — not discarded). */
export async function executeSeedWithRetry(
  run: () => Promise<Result>,
  ctx: SeedRetryCtx,
): Promise<{ result: Result; retried: boolean; retryReserved: boolean }> {
  const first = await run();
  if (!isRetriable(first) || first.retryAfterMs === undefined) return { result: first, retried: false, retryReserved: false };
  if (ctx.signal.aborted || ctx.wallExceeded()) return { result: first, retried: false, retryReserved: false };
  // Reserve a second per-seed byte unit for the retry's fetch; if it would breach the global byte
  // cap, skip the retry (settle with the first attempt) — codex P2.
  if (!ctx.reserveRetry()) return { result: first, retried: false, retryReserved: false };
  const wait = Math.min(RETRY_WAIT_CAP_MS, first.retryAfterMs) + randomInt(0, RETRY_JITTER_MAX_MS);
  await abortableSleep(wait, ctx.signal);
  if (ctx.signal.aborted || ctx.wallExceeded()) return { result: first, retried: false, retryReserved: true };
  let second: Result;
  try {
    second = await run();
  } catch (err) {
    ctx.releaseRetry(); // the reserved retry unit did not run (2nd attempt threw) — release it (codex R8 P2)
    throw err;
  }
  // Both attempts egressed to the network. Fold the FIRST attempt's egress into the retry result:
  // bytes (the 429/503 body is read up to maxBytes), the redirect/finalUrl hosts, AND any render
  // subresource hosts — so the byte budget + the per-host union count gate see the real first-
  // attempt egress (codex P2: dropping the first attempt's hosts lets a retried redirect/render
  // funnel evade maxPerHostInBulk across many retried seeds). finalUrl + bytes stay the retry's.
  const firstEgress = first.egressBytes ?? first.bytes;
  const secondEgress = second.egressBytes ?? second.bytes;
  const mergedRenderHosts = [...(first.renderEgressHosts ?? []), ...(second.renderEgressHosts ?? [])];
  return {
    result: {
      ...second,
      egressBytes: firstEgress + secondEgress,
      redirects: [...first.redirects, ...second.redirects],
      ...(mergedRenderHosts.length > 0 ? { renderEgressHosts: mergedRenderHosts } : {}),
    },
    retried: true,
    retryReserved: true,
  };
}

function isRetriable(r: Result): boolean {
  return r.code === 429 || r.code === 503;
}
