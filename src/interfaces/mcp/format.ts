import type { AttemptTrace, Result } from "../../domain/result.ts";
import { classifyAccess, classifyContentType } from "../../application/classify.ts";
import { redactSignedQueryParams } from "../../infrastructure/llm/safety.ts";

/** Max attempt lines emitted in the debug text block (MCP debug + CLI --debug). */
const DEBUG_ATTEMPTS_CAP = 50;

function formatAttempt(a: AttemptTrace): string {
  return `attempt ${a.step}: tier ${a.tier} ${a.outcome}${a.status !== undefined ? ` ${a.status}` : ""} ${a.durationMs}ms${a.reason ? ` (${a.reason})` : ""}`;
}

/**
 * The MCP text returned to the caller: a machine provenance comment (always
 * present, model-visible), then a deterministic envelope header (for non-raw
 * outputs), then the result body. Raw output is unchanged so the contract
 * fixtures (all raw) stay byte-identical.
 */
export function resultToMcpText(result: Result, includeTextDebug = false): string {
  const provenance = provenanceLine(result);
  if (result.output === "raw") {
    // A raw Tier-2 roster (any application/json body) must stay parseable JSON for clients that read
    // content[0].text as JSON, so omit the comment for JSON bodies (it remains in structuredContent).
    // HTML/text raw bodies still get the prepended provenance line. (Debug-in-text never applies to
    // raw — the caller asked for clean content.)
    if (isJsonBody(result)) return result.result;
    return `${provenance}\n${result.result}`;
  }
  const header = envelopeHeader(result);
  const base = header ? `${provenance}\n\n${header}\n\n${result.result}` : `${provenance}\n${result.result}`;
  // #45: for text-forward clients (which render content[0].text but not structuredContent), surface a
  // compact diagnostics block inline so `debug:true` is actually visible there.
  return includeTextDebug ? `${base}\n\n${debugTextBlock(result)}` : base;
}

/**
 * A compact, human-readable diagnostics block for the TEXT channel (text-forward clients, debug on).
 * Mirrors the subset of the debug `structuredContent` fields that matter for triaging a fetch, so a
 * connector that can't render structuredContent still sees how the result was produced.
 */
export function debugTextBlock(result: Result): string {
  const lines: string[] = [
    "--- debug ---",
    `tier: ${result.tier}  resolvedVia: ${result.resolvedVia}  status: ${result.code}  bytes: ${result.bytes}  durationMs: ${result.durationMs}  jsRequired: ${result.jsRequired}`,
  ];
  // Cap attempts so a page that blocks many sub-resources can't turn this compact
  // diagnostics block into thousands of model-visible lines (the debug text channel
  // is shared by the MCP debug block and the CLI --debug block). When capping, keep
  // the FIRST (cap-1) and ALWAYS the terminal attempt — the last is often the
  // render/fetch failure reason, the most diagnostic line in the high-attempt case.
  const total = result.attempts.length;
  if (total <= DEBUG_ATTEMPTS_CAP) {
    for (const a of result.attempts) lines.push(formatAttempt(a));
  } else {
    const head = result.attempts.slice(0, DEBUG_ATTEMPTS_CAP - 1);
    for (const a of head) lines.push(formatAttempt(a));
    lines.push(`(+${total - DEBUG_ATTEMPTS_CAP} more attempts not shown)`);
    lines.push(formatAttempt(result.attempts[total - 1]));
  }
  if (result.transform) {
    const t = result.transform;
    lines.push(`transform: ${t.provider}${t.model ? ` ${t.model}` : ""}${t.reason ? ` (${t.reason})` : ""}${t.inTokens !== undefined ? ` in=${t.inTokens}` : ""}${t.outTokens !== undefined ? ` out=${t.outTokens}` : ""}${t.fallbackFrom ? ` fallbackFrom=${t.fallbackFrom}` : ""}`);
  }
  if (result.contentSha256) lines.push(`contentSha256: ${result.contentSha256}`);
  return lines.join("\n");
}

function isJsonBody(result: Result): boolean {
  return result.contentType.toLowerCase().startsWith("application/json");
}

/**
 * Backend-generated (not LLM) envelope summary, prepended to summary/extract
 * text so EVERY client sees the key fields — including clients (e.g. Claude
 * Code) that surface the `content` text but not the full `structuredContent`.
 * Deterministic, so it never contradicts itself or says a present field is
 * "not provided". Raw output is excluded (the caller asked for clean content).
 */
function envelopeHeader(result: Result): string {
  const access = classifyAccess(result);
  const images = result.structured?.images ?? [];
  const lines: Array<string | null> = [
    `contentType: ${classifyContentType(result)}`,
    result.title ? `title: ${clip(sanitizePrintable(result.title), 140)}` : null,
    `finalUrl: ${redactSignedQueryParams(result.finalUrl)}`,
    `access: ${access.gated ? `gated (${access.gateReason}${access.challengeProvider ? `: ${access.challengeProvider}` : ""})` : "public"}`,
    `images: ${images.length}${images[0] ? ` (e.g. ${images[0]})` : ""}`,
    result.transform?.model ? `transformModel: ${result.transform.model}` : null,
  ];
  return lines.filter((line): line is string => line !== null).join("\n");
}

function provenanceLine(result: Result): string {
  const fields = [
    ["tier", String(result.tier)],
    ["output", result.output],
    ["status", String(result.code)],
    ["bytes", String(result.bytes)],
    ["finalUrl", redactSignedQueryParams(result.finalUrl)],
    ["platform", result.platform.adapterId],
    ["jsRequired", String(result.jsRequired)],
    ["resolvedVia", result.resolvedVia],
  ];
  return `<!-- captatum ${fields.map(([key, value]) => `${key}=${escapeField(value)}`).join(" ")} -->`;
}

function escapeField(value: string): string {
  return JSON.stringify(value).slice(1, -1).replaceAll("--", "\\u002d\\u002d");
}

/** Strip ALL control chars (incl. CR/LF — header-line forging), bidi overrides,
 *  and zero-width chars from untrusted display fields (INJ-7). */
function sanitizePrintable(value: string): string {
  return value.replace(/[\x00-\x1f\x7f​-‏‪-‮]/g, "");
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}
