import { isRecord } from "./json-schema-utils.ts";

/**
 * The JSON Schema keywords captatum's extract validator can actually ENFORCE. This is an
 * ALLOWLIST (a trust-boundary decision, never a blocklist): any caller keyword outside this
 * set is rejected at the input boundary (#153), because captatum cannot verify it and
 * refuses to accept structured data it cannot check. Kept in lockstep with the value
 * validator's per-node `validateSupported` in json-schema.ts — add a keyword here ONLY when
 * the value validator learns to check it.
 */
export const SUPPORTED_KEYS = new Set([
  "$comment", "$defs", "$id", "$schema", "additionalProperties", "allOf", "anyOf", "const",
  "default", "deprecated", "description", "enum", "examples", "exclusiveMaximum",
  "exclusiveMinimum", "items", "maxItems", "maxLength", "maxProperties", "maximum",
  "minItems", "minLength", "minProperties", "minimum", "multipleOf", "not", "oneOf",
  "pattern", "properties", "readOnly", "required", "title", "type", "uniqueItems",
  "writeOnly", "definitions",
]);

/** Bound on caller-schema complexity — a DoS guard so a huge/cyclic schema cannot stall the
 *  iterative scan. Legitimate schemas are far smaller; exceeding this fails closed. */
export const MAX_SCHEMA_NODES = 10_000;
/** Bound on the caller schema's TOTAL serialized byte size. The node/depth caps bound STRUCTURE,
 *  not payload — a single-node schema with a multi-MB `description`/`enum`/`examples` would pass
 *  them, then get `JSON.stringify`'d into the transform prompt (prompts.ts) + tokenized. This cap
 *  rejects oversized payloads fail-fast at the boundary before any fetch/LLM (#153). Generous for
 *  real extract schemas (rarely >10 KB). */
export const MAX_SCHEMA_BYTES = 64 * 1024;
/** Bound on caller-schema NESTING depth — caps this iterative scan AND (same value) the
 *  value-validator's recursion in json-schema.ts. A pathologically DEEP all-supported schema
 *  passes the node cap (few nodes) but would stack-overflow the recursive value validator after
 *  a billed LLM call; capping depth at the boundary rejects it fail-fast, and the matching cap in
 *  validateAt is defense-in-depth for any path that bypasses this scan. Generous for real schemas
 *  (rarely >50 deep); far below the ~2000-level Node stack-overflow threshold. (#153) */
export const MAX_SCHEMA_DEPTH = 256;

export type SchemaKeywordScan =
  | { ok: true }
  | { ok: false; kind: "unsupported"; key: string; path: string }
  | { ok: false; kind: "unsupported_value"; key: string; path: string }
  | { ok: false; kind: "malformed"; path: string }
  | { ok: false; kind: "too_large"; path: string };

/**
 * Rephrase an unsupported-keyword finding to LEAD WITH THE OFFENDING KEY, then its path —
 * so `budget` at `$` reads `Unsupported JSON Schema keyword "budget" at $` and cannot
 * visually merge into `$schema` (the old `${path} schema keyword "${key}" is not supported`
 * read as `$ schema keyword "budget"`, hiding that `budget` — not `$schema` — was the
 * offender) (#153). Shared by the input-boundary reject and the value-validator backstop.
 */
export function unsupportedKeywordMessage(key: string, path: string): string {
  return `Unsupported JSON Schema keyword "${key}" at ${path} — captatum cannot verify it; remove it.`;
}

/**
 * Scan a caller-supplied extract schema for the FIRST defect that prevents captatum from
 * verifying it. Iterative (no recursion → no stack overflow), visited-set-guarded (cycle-safe),
 * node-capped AND depth-capped. Used at the input boundary to fail closed before any fetch/LLM.
 * Pure key-membership + structural value-form checks — no regex on attacker input, so no ReDoS
 * surface. Detects: an unsupported KEYWORD, an unsupported VALUE-FORM of a supported key (tuple
 * `items` — the value validator can't check positional items), a malformed (non-object/boolean)
 * node, or a too-large/too-deep schema. Boolean schemas (`true`/`false`) are valid.
 */
export function findUnsupportedSchemaKeyword(schema: unknown): SchemaKeywordScan {
  const visited = new Set<unknown>();
  const stack: Array<{ node: unknown; path: string; depth: number }> = [{ node: schema, path: "$", depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    if (++nodes > MAX_SCHEMA_NODES) return { ok: false, kind: "too_large", path: "$" };
    const { node, path, depth } = stack.pop()!;
    // `>=` (not `>`) so the boundary rejects at the SAME depth validateAt does: validateAt counts
    // the root in stack.size and rejects stack.size > MAX_SCHEMA_DEPTH, i.e. scan-depth >= cap
    // (root is depth 0 here). A `>` would let a cap-deep schema fetch+LLM then fail at finalize.
    if (depth >= MAX_SCHEMA_DEPTH) return { ok: false, kind: "too_large", path };
    if (node === true || node === false) continue;
    if (!isRecord(node)) return { ok: false, kind: "malformed", path };
    if (visited.has(node)) continue;
    visited.add(node);
    for (const key of Object.keys(node)) {
      if (!SUPPORTED_KEYS.has(key)) return { ok: false, kind: "unsupported", key, path };
    }
    // Supported key, unsupported VALUE-FORM: tuple (array-valued) `items`. The value validator
    // cannot check positional tuple items (it rejects them), so reject at the boundary rather
    // than accept-then-advise after a billed LLM call (#153: scan and validator must agree).
    if (Array.isArray(node.items)) return { ok: false, kind: "unsupported_value", key: "items", path };
    // A schema-valued keyword whose value is the wrong STRUCTURE (a scalar `items`/`not`/
    // `additionalProperties`, a non-object `properties`/`$defs`, or a non-array combiner) is
    // malformed — reject at the boundary instead of silently ignoring it (a scalar `items` would
    // otherwise pass, fetch+LLM, then be accepted for an empty array or advisory-mismatch).
    const malformed = schemaValuedMalformed(node, path);
    if (malformed) return malformed;
    pushChildSchemas(node, path, depth, stack);
  }
  return { ok: true };
}

/** Validate the STRUCTURE of every schema-valued keyword (the skeleton the scan descends into):
 *  map keywords (`properties`/`$defs`/`definitions`) must be objects, combiners must be arrays,
 *  and single-schema keywords (`items`/`additionalProperties`/`not`) must be a schema object or
 *  boolean. A wrong-type value is malformed and fails closed at the boundary (#153). Returns the
 *  finding or undefined if every schema-valued keyword is well-formed (or absent). */
function schemaValuedMalformed(node: Record<string, unknown>, path: string): SchemaKeywordScan | undefined {
  for (const key of ["properties", "$defs", "definitions"] as const) {
    if (key in node && !isRecord(node[key])) return { ok: false, kind: "malformed", path: `${path}.${key}` };
  }
  for (const key of ["allOf", "anyOf", "oneOf"] as const) {
    if (key in node && !Array.isArray(node[key])) return { ok: false, kind: "malformed", path: `${path}.${key}` };
  }
  for (const key of ["items", "additionalProperties", "not"] as const) {
    const value = node[key];
    if (value !== undefined && value !== true && value !== false && !isRecord(value)) {
      return { ok: false, kind: "malformed", path: `${path}.${key}` };
    }
  }
  return undefined;
}

/** Enqueue the nested schema fragments of a node — only keys whose VALUES are themselves
 *  schemas (`properties`/`items`/`additionalProperties`/`not`/`allOf`/`anyOf`/`oneOf`/
 *  `$defs`/`definitions`). Scalar/array-value keys (`enum`, `required`, `pattern`, `type`,
 *  …) are terminal and need no descent. Children inherit `depth + 1` so the depth cap bounds
 *  nesting. */
function pushChildSchemas(node: Record<string, unknown>, path: string, depth: number, stack: Array<{ node: unknown; path: string; depth: number }>): void {
  const child = (value: unknown, childPath: string): void => { stack.push({ node: value, path: childPath, depth: depth + 1 }); };
  const properties = node.properties;
  if (isRecord(properties)) {
    for (const [name, value] of Object.entries(properties)) child(value, `${path}.properties.${name}`);
  }
  const items = node.items;
  if (isRecord(items)) child(items, `${path}.items`);
  // (Tuple items — Array.isArray(items) — are rejected above before reaching here.)
  const additional = node.additionalProperties;
  if (isRecord(additional)) child(additional, `${path}.additionalProperties`);
  const not = node.not;
  if (isRecord(not)) child(not, `${path}.not`);
  for (const combiner of ["allOf", "anyOf", "oneOf"] as const) {
    const branches = node[combiner];
    if (Array.isArray(branches)) {
      for (let index = 0; index < branches.length; index += 1) child(branches[index], `${path}.${combiner}[${index}]`);
    }
  }
  for (const defs of ["$defs", "definitions"] as const) {
    const map = node[defs];
    if (isRecord(map)) {
      for (const [name, value] of Object.entries(map)) child(value, `${path}.${defs}.${name}`);
    }
  }
}

/** Iteratively measure the JSON byte size of a schema, early-exiting once it exceeds `cap` — so a
 *  multi-MB schema is rejected without walking/allocating the whole thing. Visited-set-guarded
 *  (cycle-safe), non-recursive (no stack overflow). Reads `.length` on existing strings (no new
 *  allocation). Approximate (within ~5% of JSON.stringify, incl. quotes/commas) — exactness is not
 *  needed for a DoS cap. The node/depth caps bound STRUCTURE; this bounds PAYLOAD (a one-node
 *  schema with a huge `description`/`enum`/`examples`), which the scan's node count misses (#153). */
export function schemaByteSize(schema: unknown, cap: number): number {
  let total = 2;
  const visited = new Set<unknown>();
  const stack: unknown[] = [schema];
  while (stack.length > 0) {
    if (total > cap) return total;
    const node = stack.pop()!;
    if (typeof node === "string") {
      total += node.length + 2; // "…"
    } else if (typeof node === "number") {
      total += `${node}`.length;
    } else if (typeof node === "boolean") {
      total += node ? 4 : 5;
    } else if (node === null) {
      total += 4;
    } else if (Array.isArray(node)) {
      total += 2 + Math.max(0, node.length - 1); // [] + commas
      if (!visited.has(node)) { visited.add(node); for (const element of node) stack.push(element); }
    } else if (isRecord(node)) {
      if (!visited.has(node)) {
        visited.add(node);
        for (const [key, value] of Object.entries(node)) { total += key.length + 4; stack.push(value); } // "key": + comma
      }
    }
  }
  return total;
}
