export interface SchemaValidationResult {
  valid: boolean;
  message?: string;
  /**
   * Set when validation failed because the schema used a keyword this validator
   * does not support (and therefore cannot check). Callers distinguish this from
   * a supported-keyword value mismatch: an unsupported keyword cannot be
   * verified, so the safe behavior is to fail closed rather than accept
   * unvalidated structured data.
   */
  unsupported?: boolean;
}

export function schemaList(
  value: unknown,
  key: string,
  path: string,
): SchemaValidationResult & { value: unknown[] } {
  if (value === undefined) return { valid: true, value: [] };
  return Array.isArray(value)
    ? { valid: true, value }
    : { valid: false, message: `${path} schema ${key} must be an array`, value: [] };
}

export function objectMap(
  value: unknown,
  key: string,
  path: string,
): SchemaValidationResult & { value: Record<string, unknown> } {
  if (value === undefined) return { valid: true, value: {} };
  return isRecord(value)
    ? { valid: true, value }
    : { valid: false, message: `${path} schema ${key} must be an object`, value: {} };
}

export function nonNegativeInteger(
  schema: Record<string, unknown>,
  key: string,
  path: string,
): SchemaValidationResult {
  if (!(key in schema)) return ok();
  return Number.isInteger(schema[key]) && Number(schema[key]) >= 0
    ? ok()
    : invalid(`${path} schema ${key} must be a non-negative integer`);
}

const MAX_PATTERN_LENGTH = 128;

export function toRegExp(pattern: string, path: string): SchemaValidationResult & { value: RegExp } {
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return { valid: false, unsupported: true, message: `${path} schema pattern is too long (>${MAX_PATTERN_LENGTH} chars)`, value: /$./ };
  }
  if (isLikelyCatastrophicPattern(pattern)) {
    return { valid: false, unsupported: true, message: `${path} schema pattern may cause catastrophic backtracking`, value: /$./ };
  }
  try {
    return { valid: true, value: new RegExp(pattern) };
  } catch {
    return { valid: false, message: `${path} schema pattern is invalid`, value: /$./ };
  }
}

/**
 * Reject the classic ReDoS shapes (TRANSFORM-2/REDOS-5): a quantified group that
 * itself contains a quantifier — (a+)+, (a*)*, (a?)+ — AND a quantified group
 * with a duplicate alternative — (a|a)+ — where both branches match the same
 * input so the quantifier backtracks exponentially. Heuristic; RE2/timeout is
 * the bulletproof follow-up. Returns true (unsafe) on either construct.
 */
function isLikelyCatastrophicPattern(pattern: string): boolean {
  const isQuantifier = (ch: string | undefined): boolean =>
    ch === "*" || ch === "+" || ch === "?" || ch === "{";
  // Per open group: q = contains a quantifier (incl. a quantified child); u = contains
  // overlapping alternation or an unsafe child. Danger propagates to enclosing groups so
  // wrapper patterns like ((a|a))+ and ((a+))+ are caught at the outer quantifier.
  const stack: { q: boolean; u: boolean; alts: string[]; cur: string }[] = [];
  let escaped = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const ch = pattern[index];
    if (escaped) { escaped = false; if (stack.length > 0) stack[stack.length - 1].cur += ch; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === "(") { stack.push({ q: false, u: false, alts: [], cur: "" }); continue; }
    if (ch === "|") { if (stack.length > 0) { const g = stack[stack.length - 1]; g.alts.push(g.cur); g.cur = ""; } continue; }
    if (ch === ")" && stack.length > 0) {
      const g = stack.pop()!;
      g.alts.push(g.cur);
      const groupQuantified = isQuantifier(pattern[index + 1]);
      const danger = g.q || g.u || hasOverlappingAlternation(g.alts);
      if (groupQuantified && danger) return true;
      if (stack.length > 0) {
        const parent = stack[stack.length - 1];
        if (g.q || groupQuantified) parent.q = true;
        if (g.u || hasOverlappingAlternation(g.alts)) parent.u = true;
      }
      continue;
    }
    if (isQuantifier(ch) && stack.length > 0) { stack[stack.length - 1].q = true; continue; }
    if (stack.length > 0) stack[stack.length - 1].cur += ch;
  }
  return false;
}

/** Overlapping alternation in a quantified group: a duplicate alternative
 * ((a|a)+) OR two alternatives where one is a string-prefix of the other
 * ((a|aa)+, (a|ab)+, (\d+|\d)+) — distinct branches that can both match the same
 * input, so the quantifier backtracks catastrophically. Disjoint prefixes like
 * (a|b)+ are safe. Approximate on alternatives containing nested groups/escapes
 * (the raw branch text is compared), which is conservative — fail-closed. */
function hasOverlappingAlternation(alts: string[]): boolean {
  const compact = alts.filter((a) => a.length > 0);
  if (compact.length !== new Set(compact).size) return true; // exact duplicate
  for (let i = 0; i < compact.length; i += 1) {
    for (let j = i + 1; j < compact.length; j += 1) {
      const a = compact[i];
      const b = compact[j];
      if (a.startsWith(b) || b.startsWith(a)) return true; // prefix overlap
    }
  }
  return false;
}

export function matchesType(value: unknown, type: string): boolean {
  if (type === "array") return Array.isArray(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "object") return isRecord(value);
  if (type === "null") return value === null;
  return typeof value === type;
}

export function stripJsonFence(text: string): string {
  const match = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1] ?? text;
}

export function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function ok(): SchemaValidationResult {
  return { valid: true };
}

export function invalid(message: string): SchemaValidationResult {
  return { valid: false, message };
}

export function unsupported(message: string): SchemaValidationResult {
  return { valid: false, message, unsupported: true };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function deepEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

/**
 * Deterministic JSON so two objects equal up to key order compare equal —
 * uniqueItems/enum/const must treat {a:1,b:2} and {b:2,a:1} as the same value,
 * and JSON.stringify preserves insertion order (so it would not). Recursively
 * sorts object keys; arrays preserve order.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hasDuplicate(values: unknown[]): boolean {
  return values.some((value, index) => values.findIndex((other) => deepEqual(value, other)) !== index);
}

export function isMultipleOf(value: number, divisor: number): boolean {
  const quotient = value / divisor;
  return Math.abs(quotient - Math.round(quotient)) < Number.EPSILON * 100;
}
