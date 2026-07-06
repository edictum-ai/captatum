// Input parsing + per-entry URL validation for captatum_bulk. Mirrors captatum-input's
// zod shape for the uniform fields but: `urls` replaces `url`; the default `output` is
// always `raw` (NOT derived from the executor — an omitted-output hosted bulk must not
// silently run N transforms under the 10-URL summary cap); `allowRender` defaults false
// and is REJECTED as `true` (BULK-3: the per-host union gate does not cover Tier-3
// subresource egress hosts, so render-on-bulk is structurally closed in v1). Per-entry
// URL validation reuses normalizeContractUrl; a bad URL is a per-entry failure (one row
// in `invalid`), NOT a tool-level error — only schema failure / allowRender:true / auth
// / admission are tool-level. No per-seed overrides, no depth field (the anti-crawler
// guarantee). See docs/contracts.md §"Tool: captatum_bulk".
import { z } from "zod";
import type { Output } from "../../domain/tier.ts";
import type { TransformOverride } from "../ports/transformer.ts";
import type { ValidatedSeed } from "../../domain/bulk-policy.ts";
import {
  CaptatumInputError,
  DEFAULT_CAPTATUM_DEFAULTS,
  normalizeContractUrl,
  transformOverrideSchema,
} from "./captatum-input.ts";

export { CaptatumInputError };

/** Bulk per-seed Tier-1/2 timeout default (shorter than single-fetch's 15s — a bulk run
 *  is N fetches under one wall cap, so a stuck seed should fail fast for the next). */
export const BULK_DEFAULT_TIMEOUT_MS = 8000;
/** Per-entry URL length cap. Bounds the delivered payload (fence-framed section headers +
 *  structuredContent rows) so an adversarial caller can't inflate the ~25 KB / 50 KB delivery
 *  ceilings with a handful of multi-KB-path URLs. Single-fetch is unaffected (scoped to bulk). */
const BULK_MAX_URL_LENGTH = 2048;
/** Hard cap on the INPUT urls array (valid OR malformed). maxUrls (50/10) bounds PROCESSED
 *  seeds; this bounds the failures[]/structuredContent surface so a caller can't submit
 *  thousands of malformed/board URLs and bypass the per-call delivery ceilings. */
const BULK_MAX_INPUT_URLS = 200;
const DEFAULT_PROMPT = "Provide a concise summary of the page.";

const nonNegativeNumber = z.number().min(0);

const bulkInputSchema = z.object({
  urls: z.array(z.string().min(1)).min(1).max(BULK_MAX_INPUT_URLS),
  prompt: z.string().optional(),
  output: z.enum(["summary", "raw", "extract"]).optional(),
  schema: z.unknown().optional(),
  budget: z.number().int().positive().optional(),
  transform: transformOverrideSchema.optional(),
  maxBytes: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
  allowRender: z.boolean().optional(),
  debug: z.boolean().optional(),
  // Caller cost knobs — clamped to server ceilings by resolveBulkGuard (bulk-config.ts).
  maxTransformCostUsd: nonNegativeNumber.optional(),
  perSeedTransformCostUsd: nonNegativeNumber.optional(),
}).strict();

export interface NormalizedBulkRequest {
  readonly prompt: string;
  readonly requestedOutput: Output;
  readonly schema?: unknown;
  readonly budget?: number;
  readonly transform?: TransformOverride;
  readonly maxBytes: number;
  readonly timeoutMs: number;
  readonly allowRender: boolean; // always false in v1 (true rejected upstream)
  readonly debug: boolean;
  readonly maxTransformCostUsd?: number;
  readonly perSeedTransformCostUsd?: number;
}

/** A per-entry URL-validation failure (collected, not thrown — partial failure is normal). */
export interface BulkInputFailure {
  readonly url: string;
  readonly code: string;
  readonly message: string;
}

export interface NormalizedBulkInput {
  readonly request: NormalizedBulkRequest;
  /** URLs that passed normalizeContractUrl, in input order. The orchestrator board-detects +
   *  shapeBulkInput() these. May be empty if every URL was invalid (a 0-count bulk result). */
  readonly seeds: ValidatedSeed[];
  /** Per-entry URL-validation failures (bad URL → one row, never a tool-level error). */
  readonly invalid: BulkInputFailure[];
}

/**
 * Parse + validate a captatum_bulk input. Throws CaptatumInputError (→ tool-level
 * InvalidParams) ONLY for whole-call failures: a schema violation (`invalid_input`),
 * or `allowRender:true` (`bulk_render_not_supported`). Per-entry URL failures are
 * collected into `invalid` and the call proceeds with the valid seeds (partial is
 * the normal bulk outcome).
 */
export function normalizeBulkInput(value: unknown): NormalizedBulkInput {
  const parsed = parseInput(value);
  if (parsed.allowRender === true) {
    throw new CaptatumInputError(
      "bulk_render_not_supported",
      "captatum_bulk rejects allowRender:true in v1 — the per-host union gate does not yet cover Tier-3 subresource egress hosts (BULK-3). Render-on-bulk lands with the render-egress-host union plumbing.",
    );
  }
  const request: NormalizedBulkRequest = {
    prompt: parsed.prompt ?? DEFAULT_PROMPT,
    requestedOutput: parsed.output ?? "raw",
    schema: parsed.schema,
    budget: parsed.budget,
    transform: parsed.transform as TransformOverride | undefined,
    maxBytes: Math.min(parsed.maxBytes ?? DEFAULT_CAPTATUM_DEFAULTS.maxBytes, DEFAULT_CAPTATUM_DEFAULTS.maxBytesHardCap),
    timeoutMs: Math.min(parsed.timeoutMs ?? BULK_DEFAULT_TIMEOUT_MS, DEFAULT_CAPTATUM_DEFAULTS.timeoutMsHardCap),
    allowRender: false,
    debug: parsed.debug ?? false,
    ...(parsed.maxTransformCostUsd !== undefined ? { maxTransformCostUsd: parsed.maxTransformCostUsd } : {}),
    ...(parsed.perSeedTransformCostUsd !== undefined ? { perSeedTransformCostUsd: parsed.perSeedTransformCostUsd } : {}),
  };
  const invalid: BulkInputFailure[] = [];
  const seeds: ValidatedSeed[] = [];
  for (const raw of parsed.urls) {
    // Clip EVERY raw URL stored in a failure (not just the valid-but-too-long case) so a
    // multi-MB malformed URL can't be echoed into failures[] → structuredContent unchanged.
    const safeRaw = raw.length > BULK_MAX_URL_LENGTH ? `${raw.slice(0, BULK_MAX_URL_LENGTH)}…` : raw;
    try {
      const url = normalizeContractUrl(raw);
      if (url.length > BULK_MAX_URL_LENGTH) {
        invalid.push({ url: safeRaw, code: "url_too_long", message: `URL exceeds the ${BULK_MAX_URL_LENGTH}-char bulk limit` });
      } else {
        seeds.push({ url });
      }
    } catch (error) {
      const code = error instanceof CaptatumInputError ? error.body.error.code : "invalid_url";
      const message = error instanceof CaptatumInputError ? error.body.error.message : "URL is invalid";
      invalid.push({ url: safeRaw, code, message });
    }
  }
  return { request, seeds, invalid };
}

type ParsedBulkInput = z.infer<typeof bulkInputSchema>;

function parseInput(value: unknown): ParsedBulkInput {
  const result = bulkInputSchema.safeParse(value);
  if (result.success) return result.data;
  const first = result.error.issues[0];
  if (first?.path[0] === "urls") {
    if (first.code === "too_big") {
      throw new CaptatumInputError("too_many_urls", `\`urls\` must not exceed ${BULK_MAX_INPUT_URLS} entries (valid or malformed)`);
    }
    throw new CaptatumInputError("invalid_input", "`urls` must be a non-empty array of fully-formed http(s) URLs");
  }
  throw new CaptatumInputError("invalid_input", "captatum_bulk input is invalid");
}
