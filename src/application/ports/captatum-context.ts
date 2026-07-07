// CaptatumContext — the per-call context threaded through CaptatumUseCase.execute
// and (via CaptatumExecutorPort) through the bulk orchestrator. Lives in ports/
// so both the concrete use case and the executor port depend on it without a
// layering inversion (ports must not import from use-cases).
//
// `signal` (the wall-clock AbortController for captatum_bulk) is additive and
// added when the bulk orchestrator lands; single-fetch callers pass nothing and
// behavior is unchanged. See docs/contracts.md §"Tool: captatum_bulk".
export interface CaptatumContext {
  /** Caller-injected ISO timestamp (no Date.now() in core). Carried onto Result.fetchedAt. */
  fetchedAt?: string;
  /** Optional abort signal. RESERVED but NOT YET CONSUMED by CaptatumUseCase in
   *  the foundation PR — `execute` still passes only maxBytes/timeoutMs/maxHops
   *  to fetchGuarded (which makes its own per-tier timeout controller). PR 2
   *  threads this into FetcherOptions (composed with the per-tier timeout) so a
   *  captatum_bulk wall-deadline abort actually cancels in-flight fetches; until
   *  then the wall cap is dispatch-level only. Additive: single-fetch passes
   *  nothing and is unchanged. */
  signal?: AbortSignal;
  /** The OAuth client id (hosted). Threaded by the MCP handler so the bulk
   *  orchestrator can key the per-tenant `BulkQuotaPort` reservation (BULK-1).
   *  Absent on single-fetch + local-binary. Additive (PR 3). */
  clientId?: string;
}
