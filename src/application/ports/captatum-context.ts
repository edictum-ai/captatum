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
  /** Optional abort signal. Today only captatum_bulk ties this to the per-call
   *  wall deadline (maxGlobalWallMs) so in-flight fetches abort on expiry. The
   *  single-fetch path passes nothing. */
  signal?: AbortSignal;
}
