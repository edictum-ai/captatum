import type { Result } from "../../domain/result.ts";
import { classifyAccess, classifyContentType } from "../../application/classify.ts";
import { redactSignedQueryParams } from "../../infrastructure/llm/safety.ts";

/**
 * The MCP text returned to the caller: a machine provenance comment (always
 * present, model-visible), then a deterministic envelope header (for non-raw
 * outputs), then the result body. Raw output is unchanged so the contract
 * fixtures (all raw) stay byte-identical.
 */
export function resultToMcpText(result: Result): string {
  const provenance = provenanceLine(result);
  if (result.output === "raw") return `${provenance}\n${result.result}`;
  const header = envelopeHeader(result);
  return header ? `${provenance}\n\n${header}\n\n${result.result}` : `${provenance}\n${result.result}`;
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
    result.title ? `title: ${clip(result.title, 140)}` : null,
    `finalUrl: ${redactSignedQueryParams(result.finalUrl)}`,
    `access: ${access.gated ? `gated (${access.gateReason})` : "public"}`,
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

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}
