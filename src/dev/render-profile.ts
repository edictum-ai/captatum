/**
 * #143 profiling harness — measures the Tier-3 render byte budget against REAL
 * heavy-SPA JS payloads. Drives PlaywrightRenderer DIRECTLY (forces the render
 * path; yields the structured `actions` array + the byte pool's egress total) and
 * wraps the FetcherPort to log every fulfilled subresource's decompressed byte
 * size. Budget aborts (which scripts get killed, and at what cumulative byte
 * count) come from `actions` with their EXACT resourceType. NO production-code
 * change. Output is a structured JSON report per URL — the data that should drive
 * the remove-vs-decouple decision (#143 founder mandate: analysis, not another
 * multiplier bump).
 *
 *   node --no-warnings src/dev/render-profile.ts <url> [<url>...] [--max-mb N]
 */
import { createWreqGuardedFetcher } from "../infrastructure/wreq/requester.ts";
import { PlaywrightRenderer } from "../infrastructure/render/playwright-renderer.ts";
import { P1BrowserUrlGuard } from "../infrastructure/render/browser-url-guard.ts";
import { ESSENTIAL_RENDER_BYTES } from "../infrastructure/render/route-state.ts";
import type { FetcherOptions, FetcherPort, FetcherResult, PostInit, RejectResult } from "../application/ports/fetcher.ts";
import type { RenderAction, RenderOutput } from "../application/ports/renderer.ts";

const argv = process.argv.slice(2);
const maxMbFlag = argv.filter((a) => a.startsWith("--max-mb="))[0];
const urls = argv.filter((a) => !a.startsWith("--"));
const MAX_BYTES = maxMbFlag ? Number.parseInt(maxMbFlag.split("=")[1], 10) * 1024 * 1024 : 5 * 1024 * 1024;
if (urls.length === 0) { console.error("usage: render-profile.ts <url> [<url>...] [--max-mb N]"); process.exit(2); }

const ESSENTIAL_CAP = ESSENTIAL_RENDER_BYTES;
const RENDER_TIMEOUT_MS = 30_000;

interface FetchLogEntry { url: string; method: string; status: number; bytes: number; contentType: string; rejected?: string; }
interface ResType { type: string; essential: boolean }

/** Infer the Playwright resourceType + essential-ness from contentType + URL (the fetcher sees neither).
 *  Essential = script/fetch/xhr/document (the client app needs them to hydrate). Aborts carry the EXACT
 *  resourceType from `actions`, so this inference only labels FULFILLED resources. */
function inferType(url: string, contentType: string): ResType {
  const ct = (contentType ?? "").toLowerCase(); const u = url.toLowerCase();
  if (ct.includes("javascript") || /\.(m|c)?js(\?|$)/.test(u)) return { type: "script", essential: true };
  if (ct.includes("css") || /\.css(\?|$)/.test(u)) return { type: "stylesheet", essential: false };
  if (ct.includes("html")) return { type: "document", essential: true };
  if (ct.includes("json") || /\/api\/|graphql|\.json(\?|$)/.test(u)) return { type: "fetch", essential: true };
  return { type: "other", essential: true };
}

/** Wrap a FetcherPort so every fulfilled subresource is buffered (to count decompressed
 *  bytes) + logged, then re-streamed to the renderer. Memory-bounded by per-response maxBytes. */
function profilingFetcher(inner: FetcherPort, log: FetchLogEntry[]): FetcherPort {
  return {
    async fetchGuarded(url: string, opts: FetcherOptions, postInit?: PostInit): Promise<FetcherResult | RejectResult> {
      const result = await inner.fetchGuarded(url, opts, postInit);
      if ("rejected" in result) { log.push({ url, method: postInit?.method ?? "GET", status: 0, bytes: 0, contentType: "", rejected: result.code }); return result; }
      const buf = new Uint8Array(await new Response(result.bodyStream).arrayBuffer());
      log.push({ url, method: postInit?.method ?? "GET", status: result.status, bytes: buf.byteLength, contentType: result.contentType });
      return { ...result, bodyStream: new Response(buf).body ?? new Response(buf).body! };
    },
  };
}

interface SiteProfile {
  url: string; finalUrl: string; status: number; rendered: boolean;
  contentLen: number; renderMs: number; egressBytes: number;
  errors: { code: string; message: string }[];
  essentialBytes: number; nonEssentialBytes: number; essentialCap: number; pctOfCap: number;
  crossingEntry: FetchLogEntry | null; crossingAfterBytes: number;
  abortedEssentials: { url: string; resourceType: string }[];
  abortedNonEssentials: { url: string; resourceType: string }[];
  abortedOther: { url: string; resourceType: string; reason: string }[];
  topEssentials: { url: string; bytes: number }[];
  fetchCount: number; abortCount: number;
  postForwards: { url: string; status: number; bytes: number }[];
}

async function profileUrl(url: string): Promise<SiteProfile> {
  const log: FetchLogEntry[] = [];
  const fetcher = profilingFetcher(createWreqGuardedFetcher(), log);
  const renderer = new PlaywrightRenderer({ guard: new P1BrowserUrlGuard() });
  const startedAt = Date.now();
  let out: RenderOutput;
  try {
    out = await renderer.render({ url, maxBytes: MAX_BYTES, timeoutMs: RENDER_TIMEOUT_MS, maxHops: 5, fetcher });
  } catch (e) {
    out = { rendered: false, rejected: true, code: "render_error", message: e instanceof Error ? e.message : String(e), actions: [] };
  }
  const renderMs = Date.now() - startedAt;
  const actions: RenderAction[] = out.actions ?? [];
  const contentLen = out.rendered ? (out.fetchResult.bytes ?? 0) : 0;

  // Tally fulfilled essential/non-essential bytes + find the crossing entry (cumulative essential > cap).
  let essentialBytes = 0, nonEssentialBytes = 0; let crossingEntry: FetchLogEntry | null = null; let crossingAfterBytes = 0;
  const essentialSizes: { url: string; bytes: number }[] = [];
  for (const e of log) {
    if (e.rejected || e.bytes === 0) continue;
    const { essential } = inferType(e.url, e.contentType);
    if (essential) { essentialBytes += e.bytes; essentialSizes.push({ url: e.url, bytes: e.bytes }); }
    else nonEssentialBytes += e.bytes;
    if (essential && !crossingEntry && essentialBytes > ESSENTIAL_CAP) { crossingEntry = e; crossingAfterBytes = essentialBytes; }
  }
  // Budget aborts from actions (EXACT resourceType). Essential types per route-state.ts.
  const essentialTypes = new Set(["script", "fetch", "xhr", "document"]);
  const abortedEssentials: { url: string; resourceType: string }[] = [];
  const abortedNonEssentials: { url: string; resourceType: string }[] = [];
  const abortedOther: { url: string; resourceType: string; reason: string }[] = [];
  for (const a of actions) {
    const isAbort = a.type === "resource-aborted" || a.type === "request-blocked";
    if (!isAbort) continue;
    if (a.reason === "render_byte_budget") {
      const rec = { url: a.url ?? "", resourceType: a.resourceType ?? "" };
      if (essentialTypes.has(a.resourceType ?? "")) abortedEssentials.push(rec); else abortedNonEssentials.push(rec);
    } else {
      abortedOther.push({ url: a.url ?? "", resourceType: a.resourceType ?? "", reason: a.reason ?? "" });
    }
  }
  const postForwards = actions
    .filter((a) => a.type === "request-forwarded-post")
    .map((a) => ({ url: a.url ?? "", status: 0, bytes: a.responseBytes ?? 0 }));
  const abortCount = actions.filter((a) => a.reason === "render_byte_budget").length;

  return {
    url,
    finalUrl: out.rendered ? out.fetchResult.finalUrl : url,
    status: out.rendered ? out.fetchResult.status : 0,
    rendered: out.rendered,
    contentLen, renderMs, egressBytes: out.egressBytes ?? 0,
    errors: out.rendered
      ? (out.notice ? [{ code: out.notice.code, message: out.notice.message }] : [])
      : [{ code: out.code, message: out.message }],
    essentialBytes, nonEssentialBytes, essentialCap: ESSENTIAL_CAP, pctOfCap: Math.round((essentialBytes / ESSENTIAL_CAP) * 100),
    crossingEntry, crossingAfterBytes, abortedEssentials, abortedNonEssentials,
    topEssentials: essentialSizes.sort((x, y) => y.bytes - x.bytes).slice(0, 12),
    fetchCount: log.filter((e) => !e.rejected).length, abortCount, abortedOther, postForwards,
  };
}

const report = {
  maxBytes: MAX_BYTES, essentialCap: ESSENTIAL_CAP, essentialRenderBytes: ESSENTIAL_RENDER_BYTES,
  renderTimeoutMs: RENDER_TIMEOUT_MS, sites: [] as SiteProfile[],
};
for (const u of urls) {
  process.stderr.write(`profiling ${u} ...\n`);
  try { report.sites.push(await profileUrl(u)); }
  catch (e) { process.stderr.write(`  FAILED: ${e instanceof Error ? e.message : String(e)}\n`); }
}
console.log(JSON.stringify(report, null, 2));
process.exit(0);
