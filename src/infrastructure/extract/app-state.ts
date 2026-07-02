import type { ProvenanceError } from "../../domain/result.ts";
import { findElements } from "./html.ts";
import { parseSafeJson, type SafeJsonIssue } from "./safe-json.ts";

interface AppStateBag {
  [key: string]: unknown;
}

// JS-assignment app-state globals, in priority of how often they appear:
// __PRELOADED_STATE__ (Redux), __INITIAL_STATE__ (generic), __APOLLO_STATE__
// (Apollo Client cache), __NUXT_DATA__ (Nuxt 3 sometimes inlines it this way).
const APP_STATE_GLOBAL_RE =
  /(?:(?:window|globalThis|self)\s*\.\s*)?__(INITIAL_STATE|PRELOADED_STATE|APOLLO_STATE|NUXT_DATA)__\s*=/g;

// Upper bound on id-less application/json scripts harvested, so a page that floods
// the 1 MB extraction cap with thousands of tiny JSON blocks can't inflate the
// app-state bag (the per-page state is for debug/structured access, not indexing).
const SYNTHETIC_SCRIPT_CAP = 256;

export function extractAppState(html: string, errors: ProvenanceError[]): unknown | undefined {
  const state = {} as AppStateBag;
  let syntheticCount = 0;

  for (const script of findElements(html, "script")) {
    // Any <script type="application/json"> is harvested: Next.js __NEXT_DATA__,
    // Nuxt __NUXT_DATA__, or a generic embedded JSON blob (id="__APP_DATA__", etc.).
    // Keyed by id; id-less scripts get a monotonic synthetic key (O(1), capped).
    if (scriptContentType(script.tag.attrs.type) === "application/json") {
      const content = script.content.trim();
      if (content) {
        const key = safeScriptKey(script.tag.attrs.id) ?? nextSyntheticKey(syntheticCount);
        if (key) {
          if (key.synthetic) syntheticCount += 1;
          parseInto(key.value, content, state, errors);
        }
      }
    }

    for (const { name, literal } of findGlobalStateLiterals(script.content)) {
      parseInto(name, literal, state, errors);
    }
  }

  return Object.keys(state).length > 0 ? state : undefined;
}

function scriptContentType(type: string | undefined): string {
  return (type ?? "").toLowerCase().split(";")[0]?.trim() ?? "";
}

/** An id safe to use as an appState key (drops the prototype-pollution triple and
 *  empty ids). An arbitrary page-controlled id used directly as `state[id]` could
 *  otherwise hit `__proto__`/`constructor`/`prototype`. */
function safeScriptKey(id: string | undefined): { value: string; synthetic: boolean } | undefined {
  if (typeof id !== "string" || id.length === 0) return undefined;
  if (id === "__proto__" || id === "constructor" || id === "prototype") return undefined;
  return { value: id, synthetic: false };
}

/** The next monotonic synthetic key for an id-less script, or undefined once the
 *  cap is hit. O(1) — a counter, not a rescan — so N id-less scripts harvest in
 *  O(N), not O(N²). */
function nextSyntheticKey(count: number): { value: string; synthetic: boolean } | undefined {
  if (count >= SYNTHETIC_SCRIPT_CAP) return undefined;
  return { value: `__json_script_${count}__`, synthetic: true };
}

function parseInto(
  key: string,
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
  assignState(state, key, parsed.value);
  pushJsonErrors(errors, key, parsed.issues);
}

/** Assign without risking prototype pollution (defense-in-depth even though keys
 *  are filtered upstream). */
function assignState(state: AppStateBag, key: string, value: unknown): void {
  if (key === "__proto__" || key === "constructor" || key === "prototype") return;
  state[key] = value;
}

function findGlobalStateLiterals(source: string): Array<{ name: string; literal: string }> {
  const found: Array<{ name: string; literal: string }> = [];
  let markersProcessed = 0;
  for (const match of source.matchAll(APP_STATE_GLOBAL_RE)) {
    // Cap MARKERS processed (DoS): count every marker, not just successful parses,
    // so malformed/unterminated markers still hit the cap.
    if (markersProcessed >= 32) break;
    markersProcessed += 1;
    const name = `__${match[1]}__`;
    const offset = match.index === undefined ? -1 : match.index + match[0].length;
    if (offset < 0) continue;
    const literalStart = skipWhitespace(source, offset);
    const literal = readJsonLiteral(source, literalStart);
    if (literal) found.push({ name, literal });
  }
  return found;
}

function readJsonLiteral(source: string, start: number): string | null {
  const first = source[start];
  const closeFor = first === "{" ? "}" : first === "[" ? "]" : "";
  if (!closeFor) return null;

  const stack = [closeFor];
  let inString = false;
  let escaped = false;
  // Cap the scan (DoS): an unterminated literal otherwise scans to EOS, and many
  // markers make it quadratic (audit: ~807ms at 3,200 markers). 256 KiB is far
  // beyond any real __INITIAL_STATE__ payload.
  const maxScan = start + 1 + 256 * 1024;

  for (let index = start + 1; index < source.length && index <= maxScan; index += 1) {
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
