/**
 * Empirical probe: run the REAL production pipeline (wreq-js guarded fetch +
 * Playwright renderer + extractHtml) against a URL and dump what the extractor
 * actually produces. Used to diagnose Fix 2 (iframe title) and Fix 3 (rendered
 * extraction quality) against ground truth instead of guessing.
 *
 *   node --no-warnings src/dev/render-probe.ts <url> [--render] [--full]
 */
import { createSmartFetchUseCase } from "../application/use-cases/smart-fetch.ts";
import { extractHtml } from "../infrastructure/extract/index.ts";
import { createWreqGuardedFetcher } from "../infrastructure/wreq/requester.ts";
import { PlaywrightRenderer } from "../infrastructure/render/index.ts";

const url = process.argv[2];
const allowRender = process.argv.includes("--render");
const full = process.argv.includes("--full");
if (!url) {
  console.error("usage: render-probe.ts <url> [--render] [--full]");
  process.exit(2);
}

const clock = { nowMs: () => Date.now() };
const smartFetch = createSmartFetchUseCase({
  fetcher: createWreqGuardedFetcher(),
  extractHtml,
  renderer: new PlaywrightRenderer(),
  clock,
});

const startedAt = Date.now();
const result = await smartFetch.execute({ url, output: "raw", allowRender });
const elapsedMs = Date.now() - startedAt;

console.log(JSON.stringify({
  url,
  allowRender,
  elapsedMs,
  tier: result.tier,
  resolvedVia: result.resolvedVia,
  jsRequired: result.jsRequired,
  code: result.code,
  finalUrl: result.finalUrl,
  title: result.title,
  bytes: result.bytes,
  resultLen: result.result.length,
  resultHead: result.result.slice(0, full ? 4000 : 800),
  structuredKeys: result.structured ? Object.keys(result.structured) : [],
  jsonLdTypes: jsonLdTypes(result.structured?.jsonLd),
  errors: result.errors,
  attempts: result.attempts.map((a) => ({ tier: a.tier, outcome: a.outcome, reason: a.reason, status: a.status })),
  timings: result.timings,
}, null, 2));

function jsonLdTypes(jsonLd: unknown): string[] {
  if (jsonLd === undefined) return [];
  const items = Array.isArray(jsonLd) ? jsonLd : [jsonLd];
  const types: string[] = [];
  for (const item of items) {
    if (item && typeof item === "object" && "@type" in item) {
      const t = (item as { "@type": unknown })["@type"];
      types.push(Array.isArray(t) ? t.join(",") : String(t));
    }
  }
  return types;
}
