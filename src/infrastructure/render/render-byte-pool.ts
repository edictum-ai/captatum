// RenderBytePool — the two cumulative byte pools (essential + non-essential) that bound a render's
// subresource egress, + their exceeded flags. Extracted from RenderRouteState to respect the
// 250-line limit. Each pool is capped (essential at ESSENTIAL_BUDGET_MULTIPLIER× maxBytes so heavy
// client apps load vs crash; non-essential at maxBytes). A blown non-essential pool still lets
// essential scripts/data through. See route-state.ts.
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
  /** Release essential bytes (a forwarded-POST reservation whose request was rejected). */
  releaseEssential(bytes: number): void { this.essential -= bytes; }
}
