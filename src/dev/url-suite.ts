/**
 * Real-URL verification suite — runs the REAL production pipeline (wreq-js
 * guarded fetch + Playwright renderer + extractHtml) against live URLs in every
 * tier and asserts the expected outcome per fix. This is the "test everything
 * against ground truth" harness; render-probe.ts is the single-URL diagnostic.
 *
 *   node --no-warnings src/dev/url-suite.ts
 *
 * Hits the public network. Exits non-zero if any assertion fails.
 */
import { createSmartFetchUseCase } from "../application/use-cases/smart-fetch.ts";
import { extractHtml } from "../infrastructure/extract/index.ts";
import { createWreqGuardedFetcher } from "../infrastructure/wreq/requester.ts";
import { PlaywrightRenderer } from "../infrastructure/render/index.ts";

const clock = { nowMs: () => Date.now() };
const smartFetch = createSmartFetchUseCase({
  fetcher: createWreqGuardedFetcher(),
  extractHtml,
  renderer: new PlaywrightRenderer(),
  clock,
});

interface Case {
  name: string;
  url: string;
  allowRender?: boolean;
  maxBytes?: number;
  expect: {
    tier?: number | string;
    rejected?: boolean;
    titleContains?: string;
    advisoryCode?: string;
    jsRequired?: boolean;
  };
}

const cases: Case[] = [
  {
    name: "Fix 1: Ashby direct stays Tier-1 even with allowRender=true",
    url: "https://jobs.ashbyhq.com/e2b/ab44a84f-4467-438a-a26c-2420237c54e2",
    allowRender: true,
    expect: { tier: 1, jsRequired: false, titleContains: "Platform Engineer" },
  },
  {
    name: "Tier-1 SSR marketing site",
    url: "https://edictum.ai",
    expect: { tier: 1, jsRequired: false },
  },
  {
    name: "Tier-3: Angular RealWorld (true empty SPA shell) renders",
    url: "https://angular.realworld.io/",
    allowRender: true,
    expect: { tier: 3 },
  },
  {
    // Angular static shell is ~1.4 KB (passes the fetch cap) but the rendered
    // DOM is ~4.6 KB, so a 3 KB cap passes fetch and truncates the render — the
    // exact path Fix 4 makes advisory. (A cap below the static fetch size would
    // hit the fetch-path hard reject instead, which is correct, separate behavior.)
    name: "Fix 4: rendered page truncates at the cap instead of rejecting",
    url: "https://angular.realworld.io/",
    allowRender: true,
    maxBytes: 3000,
    expect: { tier: 3, advisoryCode: "max_bytes" },
  },
  {
    name: "SSRF: loopback rejected",
    url: "http://127.0.0.1/",
    expect: { rejected: true },
  },
  {
    name: "SSRF: cloud metadata rejected",
    url: "http://169.254.169.254/latest/meta-data/",
    expect: { rejected: true },
  },
];

let pass = 0;
let fail = 0;
for (const c of cases) {
  const startedAt = Date.now();
  let result;
  try {
    result = await smartFetch.execute({
      url: c.url,
      output: "raw",
      allowRender: c.allowRender,
      ...(c.maxBytes ? { maxBytes: c.maxBytes } : {}),
    });
  } catch (error) {
    console.log(`✖ ${c.name} — threw: ${(error as Error).message}`);
    fail += 1;
    continue;
  }
  const elapsedMs = Date.now() - startedAt;
  const problems: string[] = [];
  if (c.expect.rejected) {
    if (result.code !== 0 || result.codeText !== "FETCH_REJECTED") {
      problems.push(`expected FETCH_REJECTED, got code=${result.code} codeText=${result.codeText}`);
    }
  } else {
    if (c.expect.tier !== undefined && result.tier !== c.expect.tier) {
      problems.push(`tier expected ${c.expect.tier} got ${result.tier}`);
    }
    if (c.expect.jsRequired !== undefined && result.jsRequired !== c.expect.jsRequired) {
      problems.push(`jsRequired expected ${c.expect.jsRequired} got ${result.jsRequired}`);
    }
    if (c.expect.titleContains && !(result.title ?? "").includes(c.expect.titleContains)) {
      problems.push(`title expected to contain "${c.expect.titleContains}" got "${result.title}"`);
    }
    if (c.expect.advisoryCode && !result.errors.some((e) => e.code === c.expect.advisoryCode)) {
      problems.push(`expected advisory error ${c.expect.advisoryCode}, got ${JSON.stringify(result.errors)}`);
    }
  }
  if (problems.length === 0) {
    pass += 1;
    console.log(`✔ ${c.name} (${elapsedMs}ms) tier=${result.tier} title="${result.title ?? ""}"`);
  } else {
    fail += 1;
    console.log(`✖ ${c.name} (${elapsedMs}ms) — ${problems.join("; ")}`);
  }
}

console.log(`\n${pass}/${pass + fail} cases passed`);
if (fail > 0) process.exit(1);
