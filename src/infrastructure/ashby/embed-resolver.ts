import type { FetcherPort } from "../../application/ports/fetcher.ts";
import { decodeBody } from "../http/body.ts";

/**
 * Tier-2 resolver for Ashby-embedded careers pages. A host page (e.g.
 * e2b.dev/careers?ashby_jid=<id>) renders the job client-side in an Ashby iframe,
 * so the Tier-1 host HTML has only marketing content (no job). This resolves it to
 * the direct Ashby job URL (jobs.ashbyhq.com/<org>/<id>), which serves a clean SSR
 * JobPosting JSON-LD at Tier-1 — no render, no marketing chrome. The org alias is
 * read from the host page's Ashby embed script (<script src="jobs.ashbyhq.com/<org>/embed">).
 *
 * Returns null for non-ashby URLs (fast, no fetch) or when the host has no Ashby
 * embed (→ fall through to the normal fetch path).
 */

export function extractAshbyJid(url: string): string | null {
  try {
    return new URL(url).searchParams.get("ashby_jid");
  } catch {
    return null;
  }
}

export async function resolveAshbyEmbedUrl(
  url: string,
  fetcher: FetcherPort,
  opts: { maxBytes: number; timeoutMs: number; maxHops: number; signal?: AbortSignal },
): Promise<string | null> {
  const jid = extractAshbyJid(url);
  if (!jid) return null;
  // The opts carry the caller's abort signal (the captatum_bulk wall deadline) so
  // a bulk seed stuck resolving an Ashby embed aborts at the deadline instead of
  // running to its own per-tier timeout. `opts` is structurally a FetcherOptions.
  const result = await fetcher.fetchGuarded(url, opts);
  if ("rejected" in result) return null;
  const html = await decodeBody(result.bodyStream, result.contentType);
  const org = /jobs\.ashbyhq\.com\/([a-z0-9_-]+)\/embed/i.exec(html)?.[1];
  return org ? `https://jobs.ashbyhq.com/${org}/${jid}` : null;
}
