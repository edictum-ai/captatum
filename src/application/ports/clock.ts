/**
 * Caller/infrastructure-provided clock. Core use cases must not call ambient
 * wall-clock APIs directly because tests and audit provenance need deterministic
 * timings.
 */
export interface ClockPort {
  nowMs(): number;
}
