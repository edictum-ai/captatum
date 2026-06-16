import type { ProvenanceError } from "../../domain/result.ts";
import { findElements } from "./html.ts";
import { parseSafeJson, type SafeJsonIssue } from "./safe-json.ts";

interface AppStateBag {
  [key: string]: unknown;
}

const INITIAL_STATE_RE =
  /(?:(?:window|globalThis|self)\s*\.\s*)?__INITIAL_STATE__\s*=/g;

export function extractAppState(html: string, errors: ProvenanceError[]): unknown | undefined {
  const state = {} as AppStateBag;

  for (const script of findElements(html, "script")) {
    const id = script.tag.attrs.id;
    if (id === "__NEXT_DATA__") {
      parseInto("__NEXT_DATA__", script.content.trim(), state, errors);
    }

    for (const literal of findInitialStateLiterals(script.content)) {
      parseInto("__INITIAL_STATE__", literal, state, errors);
    }
  }

  return Object.keys(state).length > 0 ? state : undefined;
}

function parseInto(
  key: "__NEXT_DATA__" | "__INITIAL_STATE__",
  source: string,
  state: AppStateBag,
  errors: ProvenanceError[],
): void {
  if (!source) return;
  const parsed = parseSafeJson(source);
  if (!parsed.ok) {
    pushJsonErrors(errors, key, parsed.issues);
    return;
  }
  state[key] = parsed.value;
  pushJsonErrors(errors, key, parsed.issues);
}

function findInitialStateLiterals(source: string): string[] {
  const literals = [] as string[];
  for (const match of source.matchAll(INITIAL_STATE_RE)) {
    const offset = match.index === undefined ? -1 : match.index + match[0].length;
    if (offset < 0) continue;
    const literalStart = skipWhitespace(source, offset);
    const literal = readJsonLiteral(source, literalStart);
    if (literal) literals.push(literal);
  }
  return literals;
}

function readJsonLiteral(source: string, start: number): string | null {
  const first = source[start];
  const closeFor = first === "{" ? "}" : first === "[" ? "]" : "";
  if (!closeFor) return null;

  const stack = [closeFor];
  let inString = false;
  let escaped = false;

  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
    } else if (char === "{" || char === "[") {
      stack.push(char === "{" ? "}" : "]");
    } else if (char === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) return source.slice(start, index + 1);
    }
  }

  return null;
}

function skipWhitespace(source: string, offset: number): number {
  let cursor = offset;
  while (cursor < source.length && /\s/.test(source[cursor] ?? "")) cursor += 1;
  return cursor;
}

function pushJsonErrors(
  errors: ProvenanceError[],
  key: string,
  issues: SafeJsonIssue[],
): void {
  for (const issue of issues) {
    errors.push({
      code: issue.code === "invalid_json" ? "invalid_app_state" : "unsafe_json_key",
      message: `${key}: ${issue.message}`,
    });
  }
}
