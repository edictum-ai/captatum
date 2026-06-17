/**
 * Integration harness: drives the REAL smart-fetch pipeline (real wreq-js
 * guarded fetcher, real Tier-1 extractor, real Playwright renderer, real
 * OpenRouter/Ollama transformer) in-process against real URLs.
 *
 * Mirrors the composition in src/interfaces/mcp/stdio-bridge.ts buildLocalDeps()
 * so the harness exercises the same engine the local binary serves.
 *
 * Secrets: the transformer reads OPENROUTER_API_KEY / OLLAMA_BASE_URL from env
 * (via config). The harness never reads or writes keys itself — set them in the
 * environment when invoking the live suite.
 */
import { createSmartFetchUseCase } from "../../src/application/use-cases/smart-fetch.ts";
import { extractHtml } from "../../src/infrastructure/extract/index.ts";
import { createDefaultLlmTransformer } from "../../src/infrastructure/llm/model-router.ts";
import { PlaywrightRenderer } from "../../src/infrastructure/render/index.ts";
import { createWreqGuardedFetcher } from "../../src/infrastructure/wreq/requester.ts";
import type { Result } from "../../src/domain/result.ts";

const clock = { nowMs: (): number => Date.now() };

export function isLive(): boolean {
  return process.env.LIVE === "1" || process.env.SMART_FETCH_LIVE === "1";
}

export function hasOpenRouterKey(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY && process.env.OPENROUTER_API_KEY.trim());
}

export interface BuildOpts {
  withRenderer?: boolean;
  withTransformer?: boolean;
}

/** Build a real use-case. Defaults to full pipeline; pass false to omit a stage. */
export async function buildUseCase(opts: BuildOpts = {}) {
  return createSmartFetchUseCase({
    fetcher: createWreqGuardedFetcher(),
    extractHtml,
    transformer: opts.withTransformer === false ? undefined : await createDefaultLlmTransformer(),
    renderer: opts.withRenderer === false ? undefined : new PlaywrightRenderer(),
    clock,
  });
}

export type SmartFetchInput = Record<string, unknown>;

/** Run smart_fetch against a real URL through the full real pipeline. */
export async function run(url: string, input: SmartFetchInput = {}): Promise<Result> {
  const useCase = await buildUseCase();
  return useCase.execute({ url, ...input });
}

/**
 * WebFetch-equivalent baseline: a plain fetch + strip <script>/<style> + tags.
 * Mimics what WebFetch does to HTML before summarizing — crucially it DROPS the
 * <script application/ld+json> blocks, which is exactly the content WebFetch
 * loses on SSR pages like Ashby. Used to prove smart-fetch's advantage.
 */
export async function webfetchBaseline(url: string): Promise<string> {
  const res = await fetch(url, {
    redirect: "follow",
    headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36", accept: "text/html,application/xhtml+xml,*/*;q=0.8" },
  });
  const html = await res.text();
  const noScripts = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
  return noScripts.replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim();
}

/** Concatenate the structured JSON-LD (if any) and the result text for matching. */
export function searchable(r: Result): string {
  const json = r.structured?.jsonLd ? JSON.stringify(r.structured.jsonLd) : "";
  return `${json} ${r.result ?? ""}`;
}

/** Assert the provenance fields that every Result must carry. */
import assert from "node:assert/strict";
export function assertProvenance(r: Result): void {
  assert.equal(r.schemaVersion, 1);
  assert.ok(Array.isArray(r.attempts) && r.attempts.length > 0, "attempts populated");
  assert.equal(typeof r.jsRequired, "boolean");
  assert.ok(r.platform && typeof r.platform.adapterId === "string");
  assert.ok(typeof r.resolvedVia === "string" && r.resolvedVia.length > 0);
}
