// Pure domain policy for captatum_bulk: the BulkGuard caps, cross-domain input
// shaping (dedupe → per-host cap → total clamp), the union-egress-host key, and
// status classification. This is the amplification math — the security-critical
// foundation — so it has NO infrastructure imports (only node:crypto for the
// fence token, the PSL helper, and node: URL parsing). See docs/contracts.md
// §"Tool: captatum_bulk" and docs/threat-model.md §"Bulk fan-out".
import { randomBytes } from "node:crypto";
import { registrableDomain } from "./registrable-domain.ts";

/** Per-call caps bounding captatum_bulk's 50× amplification. The ONLY bound in v1
 *  (no per-tenant BulkQuotaPort yet). Server ceilings (BULK_GUARD_CEILINGS) are
 *  NOT caller-overridable; caller cost values are clamped to them + disclosed. */
export interface BulkGuard {
  readonly maxUrls: number;            // total across ALL hosts (50 raw / 10 summary|extract)
  readonly maxPerHostInBulk: number;   // directed-DoS COUNT bound, union-keyed
  readonly maxGlobalEgressBytes: number;
  readonly maxGlobalWallMs: number;
  readonly maxConcurrency: number;     // global fetch pool within a call (shared across hosts)
  readonly maxRenderedSeeds: number;
  readonly maxPerHostInflight: number; // per-host token-bucket BURST (union-keyed); operator-tunable
  readonly crawlDelayMs: number;       // per-host token-bucket REFILL (politeness)
  readonly maxTransformCostUsd: number; // caller-set, clamped; re-checked after each transform
  readonly perSeedTransformCostUsd: number; // concurrent-overshoot bound
}

export const BULK_SUMMARY_MAX_URLS = 10; // summary|extract drops the cap (N LLM bills)
export const BULK_RAW_MAX_URLS = 50;

export const BULK_GUARD_DEFAULTS: BulkGuard = {
  maxUrls: BULK_RAW_MAX_URLS,
  maxPerHostInBulk: 10,
  maxGlobalEgressBytes: 100 * 1024 * 1024,
  maxGlobalWallMs: 180_000,
  maxConcurrency: 4,
  maxRenderedSeeds: 10,
  maxPerHostInflight: 2,
  crawlDelayMs: 1000,
  maxTransformCostUsd: 0.5,
  perSeedTransformCostUsd: 0.05,
};

/** Hard server ceilings — caller values are clamped DOWN to these (clamp +
 *  disclose, decision 10). A caller may set a LOWER cost cap, never higher. */
export const BULK_GUARD_CEILINGS = {
  maxUrls: BULK_RAW_MAX_URLS,
  maxGlobalEgressBytes: 100 * 1024 * 1024,
  maxGlobalWallMs: 180_000,
  maxTransformCostUsd: 0.5,
  perSeedTransformCostUsd: 0.05,
  crawlDelayMsFloor: 500,
} as const;

/** A pre-validated seed: a normalized http(s) URL (the application layer ran
 *  normalizeContractUrl — scheme upgrade, userinfo/CRLF strip). The domain layer
 *  owns PSL resolution (single source of truth for the per-host key). */
export interface ValidatedSeed {
  readonly url: string;
}

/** Dedupe by the normalized URL string (normalizeContractUrl already stripped
 *  hash + credentials + upgraded http, so the string is the canonical key).
 *  Preserves first-seen order. */
export function dedupeSeeds(seeds: readonly ValidatedSeed[]): {
  seeds: ValidatedSeed[]; dropped: number;
} {
  const seen = new Set<string>();
  const out: ValidatedSeed[] = [];
  for (const s of seeds) {
    if (seen.has(s.url)) continue;
    seen.add(s.url);
    out.push(s);
  }
  return { seeds: out, dropped: seeds.length - out.length };
}

export interface PerHostTruncation {
  readonly host: string;
  readonly kept: number;
  readonly dropped: number;
}

/** Pre-egress directed-DoS bound: truncate each SEED registrable domain to
 *  maxPerHostInBulk, preserving first-seen order within each host. An IP/unknown
 *  host (null registrable domain) is keyed on its bare hostname, so distinct IPs
 *  are distinct buckets (no redirect-funnel collapse). */
export function applyPerHostCap(
  seeds: readonly ValidatedSeed[],
  maxPerHostInbulk: number,
): { seeds: ValidatedSeed[]; truncated: PerHostTruncation[] } {
  const counts = new Map<string, number>();
  const dropped = new Map<string, number>();
  const kept: ValidatedSeed[] = [];
  for (const s of seeds) {
    const key = seedRegistrableKey(s);
    const c = counts.get(key) ?? 0;
    if (c < maxPerHostInbulk) {
      counts.set(key, c + 1);
      kept.push(s);
    } else {
      dropped.set(key, (dropped.get(key) ?? 0) + 1);
    }
  }
  const truncated: PerHostTruncation[] = [];
  for (const [host, d] of dropped) truncated.push({ host, kept: maxPerHostInbulk, dropped: d });
  return { seeds: kept, truncated };
}

/** Total cap (decision 10): CLAMP to maxUrls + DISCLOSE (not silent reject).
 *  Keeps the first maxUrls in input order. */
export function applyTotalClamp(seeds: readonly ValidatedSeed[], maxUrls: number): {
  seeds: ValidatedSeed[]; clampedTo: number | null;
} {
  if (seeds.length <= maxUrls) return { seeds: [...seeds], clampedTo: null };
  return { seeds: seeds.slice(0, maxUrls), clampedTo: maxUrls };
}

export interface ShapedInput {
  readonly seeds: readonly ValidatedSeed[];
  readonly deduped: number;
  readonly perHostTruncated: readonly PerHostTruncation[];
  readonly totalClampedTo: number | null;
}

/** Full input-shaping pipeline (pure): dedupe → per-host cap → total clamp. The
 *  application layer pre-validates URLs + rejects Tier-2 boards per-entry BEFORE
 *  this. There is NO same-domain scope check in v1 (cross-domain is the normal
 *  case); the per-host cap IS the directed-DoS bound. */
export function shapeBulkInput(validated: readonly ValidatedSeed[], guard: BulkGuard): ShapedInput {
  const afterDedupe = dedupeSeeds(validated);
  const afterPerHost = applyPerHostCap(afterDedupe.seeds, guard.maxPerHostInBulk);
  const afterTotal = applyTotalClamp(afterPerHost.seeds, guard.maxUrls);
  return {
    seeds: afterTotal.seeds,
    deduped: afterDedupe.dropped,
    perHostTruncated: afterPerHost.truncated,
    totalClampedTo: afterTotal.clampedTo,
  };
}

/** The union of egress registrable hosts a seed touched: its seed host + every
 *  redirect host + the finalUrl host. The post-egress per-host count + rate caps
 *  key on this UNION so a redirect-funnel attack (N seeds on N distinct domains
 *  all 302→victim) cannot evade the per-host bound. Pure: extracts hosts from
 *  URLs only (no fetch). */
export function unionEgressHosts(args: {
  seedRegistrable: string | null;
  redirects: readonly string[];
  finalUrl: string;
}): string[] {
  const hosts = new Set<string>();
  if (args.seedRegistrable) hosts.add(args.seedRegistrable);
  for (const u of args.redirects) {
    const r = registrableDomain(hostOf(u));
    if (r) hosts.add(r);
  }
  const fr = registrableDomain(hostOf(args.finalUrl));
  if (fr) hosts.add(fr);
  return [...hosts];
}

export type BulkStatus = "pass" | "partial" | "fail";

/** Classify the overall bulk status: fail = all failed (or none processed);
 *  pass = every seed passed cleanly; otherwise partial (any per-seed partial
 *  surfaces a degradation worth disclosing — e.g. a transform fell back to raw). */
export function classifyBulkStatus(perSeed: readonly BulkStatus[]): BulkStatus {
  if (perSeed.length === 0) return "fail";
  const failed = perSeed.filter((s) => s === "fail").length;
  if (failed === perSeed.length) return "fail";
  const partial = perSeed.filter((s) => s === "partial").length;
  if (failed === 0 && partial === 0) return "pass";
  return "partial";
}

/** Server-generated random fence token framing each per-URL section in the
 *  delivered text (16 hex chars from the CSPRNG). A page can never emit this
 *  token, so it cannot forge a section boundary — prompt-injection hardening. */
export function generateFenceToken(): string {
  return randomBytes(8).toString("hex");
}

/** The per-host key for a SEED: its registrable domain, or its bare hostname
 *  when PSL cannot resolve it (IP literal / single-label / unknown) — distinct
 *  IPs stay distinct buckets. */
export function seedRegistrableKey(seed: ValidatedSeed): string {
  const r = registrableDomain(hostOf(seed.url));
  return r ?? hostOf(seed.url);
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
