/**
 * Sticky per-model health for the transform router (#82). Replaces the old EMA "bandit", which
 * demoted on EVERY failure (jumpy — it unfairly demoted `deepseek-v4-flash` on transient empty
 * completions, which is why #48-C pinned selection to the configured order and made the bandit
 * unreachable). This sticky model tolerates transient failures and demotes only on SUSTAINED
 * hard failure, so the configured primary stays primary unless it is genuinely unreliable.
 *
 * Acts ONLY on hard outcomes (provider throw / empty completion / non-2xx / invalid JSON /
 * unsupported schema keyword). "Soft" output (a parseable-but-schema-mismatched extract, which is
 * "garbage-ish" and can't be reliably distinguished from a legit short answer) is an explicit
 * no-op — it must not feed demotion. Within-request hard-fail fallback (`exclude: tried` in the
 * router) is orthogonal and untouched.
 */

/** Per-model health state. */
export interface ModelHealth {
  /** Last HEALTH_WINDOW outcomes (true = hard failure). Newest at the end. */
  recent: boolean[];
  /** Consecutive successes since the last failure — drives recovery. */
  consecutiveSuccesses: number;
  /** Rank offset added to the configured order: 0 = healthy, 1 = demoted one rank. Capped at 1. */
  demotion: number;
}

/** What a finalize/feedback call reports about one model attempt. */
export type HealthOutcome = "success" | "hard_fail" | "soft";

export const HEALTH_WINDOW = 5;
/** ≥ this many hard failures in the last HEALTH_WINDOW attempts → demote one rank. */
export const FAIL_THRESHOLD = 3;
/** This many consecutive successes → recover (clear demotion + window). */
export const RECOVER_SUCCESSES = 2;

export function emptyHealth(): ModelHealth {
  return { recent: [], consecutiveSuccesses: 0, demotion: 0 };
}

/**
 * Fold one outcome into the model's health. Mutates `health` in place.
 * - hard_fail: push into the window, reset consecutive successes, demote one rank if sustained.
 * - success: increment consecutive successes, recover if sustained.
 * - soft: no-op (does not push, does not reset successes — garbage-ish output is tolerated).
 */
export function recordOutcome(health: ModelHealth, outcome: HealthOutcome): void {
  if (outcome === "soft") return;
  if (outcome === "hard_fail") {
    health.recent.push(true);
    if (health.recent.length > HEALTH_WINDOW) health.recent.shift();
    health.consecutiveSuccesses = 0;
    if (health.demotion === 0 && health.recent.filter(Boolean).length >= FAIL_THRESHOLD) {
      health.demotion = 1;
    }
    return;
  }
  health.consecutiveSuccesses += 1;
  if (health.demotion > 0 && health.consecutiveSuccesses >= RECOVER_SUCCESSES) {
    health.demotion = 0;
    health.consecutiveSuccesses = 0;
    health.recent = [];
  }
}
