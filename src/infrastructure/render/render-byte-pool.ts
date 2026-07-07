// RenderBytePool — the two cumulative byte pools (essential + non-essential) that bound a render's
// subresource egress, + their exceeded flags. Extracted from RenderRouteState to respect the
// 250-line limit. Each pool is capped (essential at a fixed ESSENTIAL_RENDER_BYTES — 48MB, decoupled
// from maxBytes since #143 so heavy client apps load vs crash; non-essential at maxBytes). A blown
// non-essential pool still lets essential scripts/data through. See route-state.ts.
export class RenderBytePool {
  private essential = 0;
  private nonEssential = 0;
  private essentialExceeded = false;
  private nonEssentialExceeded = false;
  private readonly essentialCap: number;
  private readonly nonEssentialCap: number;

  constructor(essentialCap: number, nonEssentialCap: number) {
    this.essentialCap = essentialCap;
    this.nonEssentialCap = nonEssentialCap;
  }

  /** Total egress across both pools → Result.egressBytes (BULK-5). */
  total(): number { return this.essential + this.nonEssential; }
  used(essential: boolean): number { return essential ? this.essential : this.nonEssential; }
  cap(essential: boolean): number { return essential ? this.essentialCap : this.nonEssentialCap; }
  isExceeded(essential: boolean): boolean { return essential ? this.essentialExceeded : this.nonEssentialExceeded; }
  markExceeded(essential: boolean): void {
    if (essential) this.essentialExceeded = true; else this.nonEssentialExceeded = true;
  }
  add(essential: boolean, bytes: number): void {
    if (essential) this.essential += bytes; else this.nonEssential += bytes;
  }
  /** Release essential bytes for a POST body whose request was REJECTED after resolve() ran — the body
   *  may already have egressed (e.g. body_read_error returns only after fetchGuarded has a response
   *  stream), so the bytes still count; do NOT clear the exceeded flag (codex P2 on #147: clearing here
   *  would reopen the pool for bytes that were actually sent). */
  releaseEssential(bytes: number): void { this.essential -= bytes; }

  /** Release essential bytes for a POST body reservation that NEVER egressed — the post-acquire re-gate
   *  aborted before resolve() ran, so the body was never sent. Such a reservation can transiently mark
   *  the pool exceeded (markExceeded at dispatch); clear the flag when used drops back to/under the cap
   *  so later essentials are not falsely aborted despite unused budget. DoS-safe: `essential` still
   *  bounds cumulative egress, and the flag only re-opens budget that genuinely exists (the fetchSem
   *  re-gate still bounds concurrent past-the-gate fetches to N → used ≤ cap + N×maxBytes). */
  releaseUnsentEssential(bytes: number): void {
    this.essential -= bytes;
    if (this.essentialExceeded && this.essential <= this.essentialCap) this.essentialExceeded = false;
  }
}
