// Builds the MCP `content[0].text` for a captatum_bulk result: a provenance header
// (always model-visible) carrying the per-call fence token, then per-URL sections framed
// by that server-generated random token, then a bounded summary tail. The fence token is
// never echoable from page content (16 hex chars from the CSPRNG), so a malicious page
// cannot forge a section boundary (prompt-injection hardening). Caps: 50 KB total, 8 KB
// per-URL section; overflow degrades each section to a ≤500-char snippet + finalUrl, and a
// final hard clip guards the total. See docs/contracts.md "MCP delivery".
import type { BulkResult, BulkSeedResult } from "../../domain/bulk-result.ts";

const MAX_TOTAL_TEXT_CHARS = 50_000;
const SNIPPET_CHARS = 500;

export function bulkResultToMcpText(bulk: BulkResult): string {
  const header = provenanceHeader(bulk);
  const tail = summaryTail(bulk);
  const full = bulk.results.map((r, i) => section(i, bulk.results.length, r, bulk.fenceToken, false)).join("\n\n");
  let text = `${header}\n\n${full}\n\n${tail}`;
  if (text.length <= MAX_TOTAL_TEXT_CHARS) return text;
  // Overflow: re-render sections at the ≤500-char snippet tier (+ finalUrl) to fit more URLs.
  const slim = bulk.results.map((r, i) => section(i, bulk.results.length, r, bulk.fenceToken, true)).join("\n\n");
  text = `${header}\n\n${slim}\n\n${tail}`;
  return text.length <= MAX_TOTAL_TEXT_CHARS ? text : `${text.slice(0, MAX_TOTAL_TEXT_CHARS - 1)}…`;
}

function provenanceHeader(bulk: BulkResult): string {
  const f = (k: string, v: string | number | boolean): string => `${k}=${JSON.stringify(String(v)).slice(1, -1)}`;
  return `<!-- captatum ${[
    f("kind", "bulk"),
    f("count", bulk.count),
    f("ok", bulk.ok),
    f("status", bulk.status),
    f("passed", bulk.passed),
    f("failed", bulk.failed),
    f("bulkId", bulk.bulkId),
    f("fence", bulk.fenceToken),
  ].join(" ")} -->`;
}

function section(idx: number, total: number, r: BulkSeedResult, fence: string, slim: boolean): string {
  const head = `=== [${idx + 1}/${total}] ${r.url} (fence=${fence}) status=${r.status} tier=${r.tier} code=${r.code} bytes=${r.bytes} output=${r.output} ===`;
  const body = slim ? `${r.result.slice(0, SNIPPET_CHARS)}${r.finalUrl !== r.url ? `\nfinalUrl: ${r.finalUrl}` : ""}` : r.content;
  return `${head}\n${body}\n=== end (fence=${fence}) ===`;
}

function summaryTail(bulk: BulkResult): string {
  const lines = [
    `=== summary (fence=${bulk.fenceToken}) ===`,
    `totals: bytes=${bulk.totals.bytes} egressBytes=${bulk.totals.egressBytes} durationMs=${bulk.totals.durationMs} costUsd=${bulk.totals.transformCostUsd} inTokens=${bulk.totals.transformInTokens} outTokens=${bulk.totals.transformOutTokens}`,
    `clamp: input=${bulk.clamp.inputUrls} afterDedupe=${bulk.clamp.afterDedupe} afterPerHostCap=${bulk.clamp.afterPerHostCap} processed=${bulk.clamp.processed}${bulk.clamp.totalClampedTo !== null ? ` totalClampedTo=${bulk.clamp.totalClampedTo}` : ""}`,
  ];
  if (bulk.capBreaches.length) lines.push(`capBreaches: ${bulk.capBreaches.join(", ")}`);
  lines.push(`=== end (fence=${bulk.fenceToken}) ===`);
  return lines.join("\n");
}
