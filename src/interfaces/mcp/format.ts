import type { Result } from "../../domain/result.ts";

export function resultToMcpText(result: Result): string {
  return `${provenanceLine(result)}\n${result.result}`;
}

function provenanceLine(result: Result): string {
  const fields = [
    ["tier", String(result.tier)],
    ["output", result.output],
    ["status", String(result.code)],
    ["bytes", String(result.bytes)],
    ["finalUrl", result.finalUrl],
    ["platform", result.platform.adapterId],
    ["jsRequired", String(result.jsRequired)],
    ["resolvedVia", result.resolvedVia],
  ];
  return `<!-- captatum ${fields.map(([key, value]) => `${key}=${escapeField(value)}`).join(" ")} -->`;
}

function escapeField(value: string): string {
  return JSON.stringify(value).slice(1, -1).replaceAll("--", "\\u002d\\u002d");
}
