/**
 * BULK-GATE (e): a REAL 50-URL captatum_bulk run verifying egress-byte accounting +
 * wall-clock against the 2 vCPU / 4 GiB admission sizing (the cerebralvalley lesson:
 * real input, not a synthetic green fixture). Run before declaring local-flavor bulk
 * ship-ready, and before flipping CAPTATUM_BULK_ENABLED on hosted.
 *
 *   node --no-warnings src/dev/bulk-probe.ts [output]    # output: raw (default) | summary
 *
 * Set OPENROUTER_API_KEY / OPENROUTER_MODELS or OLLAMA_BASE_URL / OLLAMA_MODEL for summary.
 * Override the URL list by editing DEFAULT_URLS below. Prints the BulkResult envelope +
 * a per-tier breakdown + the totals (bytes, egressBytes, durationMs, transform cost).
 */
import { createCaptatumUseCase } from "../application/use-cases/captatum.ts";
import { createCaptatumBulkUseCase } from "../application/use-cases/captatum-bulk.ts";
import { createAdapterRegistry } from "../application/adapters.ts";
import { extractHtml } from "../infrastructure/extract/index.ts";
import { createWreqGuardedFetcher } from "../infrastructure/wreq/requester.ts";
import { createDefaultLlmTransformer } from "../infrastructure/llm/model-router.ts";

const output = (process.argv[2] ?? "raw") as "raw" | "summary";

// A spread of real public pages: docs/article/job/product sites. Mix of static + JS-heavy +
// anti-bot — the realistic distribution a bulk caller actually hits.
const DEFAULT_URLS = [
  "https://example.com/", "https://www.iana.org/help/example-domains", "https://httpbin.org/html",
  "https://www.rfc-editor.org/rfc/rfc9110.html", "https://nodejs.org/en/about", "https://nodejs.org/api/http.html",
  "https://www.typescriptlang.org/docs/", "https://developer.mozilla.org/en-US/docs/Web/HTML/Element/article",
  "https://fastapi.tiangolo.com/", "https://www.python.org/about/", "https://go.dev/doc/",
  "https://rust-lang.org/", "https://www.rust-lang.org/learn", "https://kubernetes.io/docs/home/",
  "https://swagger.io/docs/specification/about/", "https://www.sqlite.org/docs.html",
  "https://www.postgresql.org/docs/", "https://redis.io/docs/", "https://www.docker.com/",
  "https://docs.docker.com/get-started/", "https://nginx.org/en/", "https://httpd.apache.org/docs/",
  "https://www.gnu.org/software/bash/manual/", "https://www.kernel.org/doc/html/latest/",
  "https://lwn.net/", "https://news.ycombinator.com/", "https://lobste.rs/",
  "https://github.com/torvalds/linux", "https://github.com/microsoft/typescript",
  "https://www.w3.org/TR/html/", "https://datatracker.ietf.org/doc/html/rfc2616",
  "https://www.cloudflare.com/learning/", "https://aws.amazon.com/what-is-cloud-computing/",
  "https://www.gnu.org/philosophy/free-sw.html", "https://www.eff.org/issues/open-access",
  "https://creativecommons.org/about/cclicenses/", "https://www.wikipedia.org/",
  "https://en.wikipedia.org/wiki/Hypertext_Transfer_Protocol", "https://en.wikipedia.org/wiki/Representational_state_transfer",
  "https://en.wikipedia.org/wiki/JSON", "https://en.wikipedia.org/wiki/JSON-LD",
  "https://en.wikipedia.org/wiki/Public_Suffix_List", "https://en.wikipedia.org/wiki/DNS_rebinding",
  "https://en.wikipedia.org/wiki/Server-side_request_forgery", "https://en.wikipedia.org/wiki/Cross-site_scripting",
  "https://en.wikipedia.org/wiki/Headless_browser", "https://en.wikipedia.org/wiki/Playwright_(software)",
  "https://en.wikipedia.org/wiki/OpenAI", "https://en.wikipedia.org/wiki/Anthropic",
];

const clock = { nowMs: () => Date.now() };
const captatum = createCaptatumUseCase({
  fetcher: createWreqGuardedFetcher(),
  extractHtml,
  transformer: await createDefaultLlmTransformer(),
  clock,
});
const bulk = createCaptatumBulkUseCase({
  executor: captatum,
  adapters: createAdapterRegistry(),
  clock,
  operator: { maxPerHostInflight: 2, crawlDelayMs: 1000, maxConcurrency: 4 },
});

const start = clock.nowMs();
const res = await bulk.execute({ urls: DEFAULT_URLS, output });
const wall = clock.nowMs() - start;

const byTier = new Map<string, number>();
for (const r of res.results) byTier.set(String(r.tier), (byTier.get(String(r.tier)) ?? 0) + 1);
console.log(JSON.stringify({
  count: res.count,
  passed: res.passed,
  failed: res.failed,
  status: res.status,
  deduped: res.deduped,
  truncated: res.truncated,
  totals: res.totals,
  capBreaches: res.capBreaches,
  clamp: res.clamp,
  byTier: Object.fromEntries(byTier),
  probeWallMs: wall,
  sizingBudget: "2 vCPU / 4 GiB — maxGlobalWallMs=180000, maxGlobalEgressBytes=104857600",
  egressBytesHonest: "sums result.egressBytes ?? result.bytes (deep egress incl. Tier-3 subresources, PR 3); render-on-bulk allowed",
  fails: res.results.filter((r) => r.status === "fail").map((r) => ({ url: r.url, code: r.codeText, tier: r.tier })),
}, null, 2));
process.exit(res.failed === res.count ? 1 : 0);
