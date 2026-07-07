// Render-on-bulk helper (BULK-3): merge a seed's render subresource hosts into
// the per-host union count key. Extracted from the orchestrator (250-line limit).
// The maxRenderedSeeds cap is enforced in the orchestrator as a post-settle counter
// over render ATTEMPTS (a seed that was allowed to render AND was a JS shell —
// success or empty/failed attempt; a content page does not consume it). Honest
// overshoot ≤ maxConcurrency (in-flight attempts). See docs/contracts.md §"Tool:
// captatum_bulk".

/** Merge a seed's render subresource hosts (`Result.renderEgressHosts`) into the
 *  union-egress-host set the per-host count gate keys on, so a render-path directed
 *  victim is bounded by `maxPerHostInBulk` (BULK-3). Pure. */
export function mergeRenderEgressHosts(into: Set<string>, hosts: readonly string[] | undefined): void {
  if (!hosts) return;
  for (const h of hosts) if (h) into.add(h);
}
