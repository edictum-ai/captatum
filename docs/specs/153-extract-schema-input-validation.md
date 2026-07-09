# Spec: #153 — Extract: clearer schema-validation error + fail-fast at input

- **Issue:** [#153](https://github.com/edictum-ai/captatum/issues/153) (bug, MED)
- **Tier:** T3 — the caller-supplied JSON Schema for `output:"extract"` is **untrusted input**. This change adds keyword-allowlist validation at the **input boundary** (before any fetch/LLM), which crosses the trust boundary, so the full pipeline applies. Repo is Engineering OS tier **S**.
- **Status:** v1 — awaiting independent critique.
- **Spec trailer for downstream PRs:** `Spec: docs/specs/153-extract-schema-input-validation.md`

## Problem (the bug)

An `output:"extract"` call whose `schema` uses an unsupported JSON Schema keyword (the repro used `budget` — clearly meant for the *tool*, not the schema) returns a confusing, misleading error and silently degrades to `raw`:

```
captatum({ url, output: "extract",
  schema: { $schema: "...", type: "object", properties: { ... }, budget: 123 } })
  → errors: [{ code: "extract_schema_invalid",
               message: '$ schema keyword "budget" is not supported' }]
  → output degraded to "raw" (after a full fetch + LLM round-trip)
```

Two defects:

1. **The error message visually lies.** `validateSupported`
   (`src/infrastructure/llm/json-schema.ts:52-55`) emits
   `` `${path} schema keyword "${key}" is not supported` `` with `path = "$"`. That renders
   as **`$ schema keyword "budget"`**, which the eye reads as **`$schema keyword "budget"`** —
   implicating `$schema` (which *is* supported) instead of the real offender `budget`.
2. **The check runs only AFTER fetch + LLM** (`finalize.ts:49`, inside the transform). A
   schema that can never produce a valid extract still burns a network round-trip + a paid
   model call before being rejected, then degrades to `raw` with no receipt field saying what
   the caller *asked for* or *why* it degraded. Hard to diagnose; wasteful.

### Root cause

`$schema` IS in `SUPPORTED_KEYS` (`json-schema.ts:8`); the offender was `budget`. The
keyword-allowlist check (`validateSupported`) is correct in *result* (it does reject `budget`)
but is (a) phrased so the key name merges into the path, and (b) invoked only from
`validateAt`, which runs during `finalize` — i.e. after the fetch + transform.

## Design

Three changes, all contract-first (contract deltas in the next section).

### (1) Rephrase the message to lead with the offending key

`validateSupported` (`src/infrastructure/llm/json-schema.ts`) leads with the key name and
keeps the path visually separate. The key is the schema's own property name (untrusted data),
so it is length-capped before interpolation and **no schema value is ever echoed** — the
schema is treated as data, never a directive:

```ts
function validateSupported(schema: Record<string, unknown>, path: string): SchemaValidationResult {
  const unsupportedKey = Object.keys(schema).find((key) => !SUPPORTED_KEYS.has(key));
  return unsupportedKey
    ? unsupported(`${messageForUnsupportedKeyword(unsupportedKey, path)}`)
    : ok();
}
```

`messageForUnsupportedKeyword` (shared by the input-boundary check and the finalize
defense-in-depth path):

```
Unsupported JSON Schema keyword "budget" at $ — captatum cannot verify it; remove it.
Unsupported JSON Schema keyword "format" at $.properties.email — captatum cannot verify it; remove it.
```

The key name is truncated to ≤ 80 chars (an adversarial megabyte-long key must not bloat the
error / receipt). The path (`$`, `$.properties.email`, …) is constructed by captatum — never
echoes caller data beyond the property name.

### (2) Fail-fast keyword-allowlist validation at the input boundary

A new **pure, value-free** recursive walker exported from `json-schema.ts` walks the schema
graph and returns the first keyword not in `SUPPORTED_KEYS` (with its path), or `undefined`.
This is an **allowlist** (the issue's requirement: name what is permitted, not what is denied):

```ts
export interface UnsupportedSchemaKeyword { key: string; path: string }
export function findUnsupportedSchemaKeyword(schema: unknown): UnsupportedSchemaKeyword | undefined
```

The walk recurses into every subschema location the JSON Schema subset defines:
`properties.*`, `items`, `additionalProperties` (when a schema), `allOf`/`anyOf`/`oneOf.*`,
`not`, `$defs.*`, `definitions.*`. It checks each node's own keys against `SUPPORTED_KEYS`
exactly as `validateSupported` does, so the two never disagree. An object-identity visited
`Set` guards against programmatic cycles (JSON.parse cannot cycle, but the guard is cheap
defense-in-depth and matches `validateAt`'s pattern).

`normalizeCaptatumInput` (`src/application/use-cases/captatum-input.ts`) runs this **before
returning** — i.e. before any fetch — and throws `CaptatumInputError` (→ JSON-RPC
`InvalidParams` / HTTP `{error:{code,message}}`) when a finding is present:

```ts
// After parseInput, before building the normalized object:
if (parsed.output === "extract" && parsed.schema !== undefined) {
  const finding = findUnsupportedSchemaKeyword(parsed.schema);
  if (finding) {
    throw new CaptatumInputError(
      "extract_schema_unsupported_keyword",
      messageForUnsupportedKeyword(finding.key, finding.path),
    );
  }
}
```

This rejects the repro **before any egress or LLM call**, with the now-clear message.

**Sweep — sibling path.** `normalizeBulkInput` (`src/application/use-cases/bulk-input.ts`)
accepts the same uniform `schema` + `output:"extract"`. A bulk extract with an unsupported
keyword would otherwise waste **N** fetches. The same check is added there: a bad schema is a
**whole-call** failure (it applies uniformly to every seed), so it throws `CaptatumInputError`
(tool-level `InvalidParams`) before any seed is processed — the same severity as
`too_many_urls`.

**Defense-in-depth retained.** The `finalize.ts` unsupported-keyword branch
(`finalize.ts:52-58`) is kept, not removed. It is unreachable via the normal flow after (2)
(normalize always runs before fetch), but the transform seam is a trust boundary in its own
right: a future caller that invokes `TransformPort` directly (bypassing normalize) must still
fail closed rather than accept unvalidated structured data. Its message is updated via (1) and
its degrade reason becomes `schema_validation_failed` (see (3)).

**Recursion-depth note.** The walker recurses without an explicit depth cap, **matching the
existing precedent** of `validateAt` (which recurses into the same untrusted schema without a
cap). Total schema size is bounded upstream by the request-body size limit + `JSON.parse`, so
practical nesting is bounded; the residual (deep-nesting stack pressure) is shared with the
existing finalize path and is **not introduced** by this change. Recorded in
`docs/threat-model.md`; iterative-walk + depth cap is noted as future hardening if profiling
shows need. (A depth cap on *only* the new walker would diverge from the existing path for no
net soundness gain — least machinery.)

### (3) Enrich the receipt: `outputRequested` + a typed `reason` enum

**(3a) `outputRequested`.** Add `outputRequested?: Output` to `Result`
(`src/domain/result.ts`) — the output the caller *requested*, distinct from `output` (the
*actual* output after degradation). Stamped on every agent-facing Result: at the top of
`applyOutputMode` (`base.outputRequested = request.requestedOutput`) and in `rejectResult`.
Surfaced in the lean `structuredContent` (`src/interfaces/mcp/shape.ts`) so an agent can
compare `output !== outputRequested` to detect a silent degrade — the issue's "hard to tell
why it degraded" complaint.

**(3b) Typed `TransformReason` enum.** `TransformInfo.reason` (`src/domain/result.ts:28`) is
today a free `string`. It becomes a **closed union** of the *actual* degrade causes:

```ts
export type TransformReason =
  | "unconfigured"                          // no transform provider configured
  | "provider_unconfigured"                 // caller-requested provider has no candidates
  | "model_unavailable"                     // caller-requested model not present
  | "no_model_fit"                          // candidates exist but none fit budget/context/supportsJson
  | "sensitive_content_no_local_provider"   // sensitive page; no local provider permitted
  | "transform_failed"                      // provider ran but threw (LLM/network/invalid-JSON/billing)  [was "failed"]
  | "schema_validation_failed";             // extract output failed schema validation (unsupported keyword)
```

The issue lists three values (`schema_validation_failed | transform_failed | unconfigured`);
this union is a **superset** — the four `noneReason` values (`router-helpers.ts:27-37`) are
real degrade causes an agent can act on (e.g. `"no_model_fit"` ⇒ retry with a larger budget;
`"unconfigured"` ⇒ a missing key, not a budget problem). Collapsing them into `"unconfigured"`
would destroy actionable signal and *mislead* (providers can exist under `no_model_fit`). The
issue's three are the high-level categories; the router contributes finer sub-reasons. All
seven are "degraded" for status purposes (below).

**Rename `failed` → `transform_failed`** (`captatum.ts:174`). The catch maps the
`extract_schema_invalid` TransformError code to `schema_validation_failed`, every other thrown
error to `transform_failed`:

```ts
const reason: TransformReason =
  transformErrorCode(error) === "extract_schema_invalid" ? "schema_validation_failed" : "transform_failed";
base.transform = { provider: "none", reason, latencyMs: transformMs, … };
```

**Type ripple.** `noneReason` (`router-helpers.ts`) returns `TransformReason`; `rawFallback`
takes `TransformReason`; `ModelPick.reason` (`application/ports/model-router.ts`) narrows from
`string` to `TransformReason` (it is only ever set from `noneReason`). No new values invented.

**Status-classification simplification + latent-bug fix.** Two readers gate `status:"partial"`
on a brittle reason-string allowlist:
- `src/interfaces/mcp/shape.ts:76` — `t.provider === "none" && (t.reason === "failed" || t.reason === "unconfigured")`
- `src/application/use-cases/bulk-seed.ts:35` — same.

`provider:"none"` is set **only** on a degrade-to-raw summary/extract (it never appears on a
clean summary or an explicitly-`raw` request). So the reason-gated check is both brittle (the
rename would break it) and a **latent bug**: a summary that degraded because `"no_model_fit"`
/`"provider_unconfigured"`/`"model_unavailable"`/`"sensitive_content_no_local_provider"`
currently reports `status:"pass"` — mislabeling a degrade as success, exactly the "hard to
tell it degraded" complaint. Both readers simplify to `t && t.provider === "none"` (robust
under the rename; fixes the latent bug; aligns with the issue's clarity goal).

## Contract changes (`docs/contracts.md`)

1. **Transform §** (`extract` validation, ~L577): unsupported schema keywords are now
   **rejected at the input boundary** (`extract_schema_unsupported_keyword`, JSON-RPC
   `InvalidParams`, before any fetch/LLM), not as a post-LLM `extract_schema_invalid`. The
   post-LLM unsupported-keyword path is retained only as defense-in-depth at the transform
   seam. Supported-keyword value mismatches remain the non-fatal `extract_schema_invalid`
   advisory (unchanged).
2. **Transform §** (~L583): `reason` values are now the typed `TransformReason` set;
   `"failed"` → `"transform_failed"`; add `"schema_validation_failed"`. Enumerate all seven.
3. **Result schema §** (~L410/L426): add `outputRequested: "summary" | "raw" | "extract"`
   (the requested output; `output` remains the actual post-degrade output).
4. **structuredContent §** (~L448/L483): the lean payload carries `outputRequested`; `status`
   is `partial` whenever `transform.provider === "none"` (any degrade reason — was a brittle
   reason allowlist that under-reported).
5. **Error shape §** (~L677/L699): add `extract_schema_unsupported_keyword` to the
   input-validation reject codes (hard reject before egress; distinct from the non-fatal
   `extract_schema_invalid` advisory). Note `extract_schema_invalid` is advisory-only,
   unchanged.
6. **captatum_bulk §** (~L98/L333): a bulk extract whose uniform `schema` uses an unsupported
   keyword is a tool-level `extract_schema_unsupported_keyword` reject (before any seed),
   consistent with `too_many_urls`.

## Threat-model note (`docs/threat-model.md`)

Add to the input/parsing controls: the `output:"extract"` schema is **untrusted input**
validated at the **input boundary** against the `SUPPORTED_KEYS` allowlist
(`findUnsupportedSchemaKeyword`) — fail-closed (`CaptatumInputError`) before any egress/LLM.
Allowlist (not blocklist); the key name is length-capped and no schema value is echoed (schema
= data, never a directive). Recursion-depth residual is shared with the pre-existing
`validateAt` path (no depth cap on either; bounded in practice by request-body limit +
JSON.parse) — not introduced here; iterative walk + depth cap noted as future hardening.

## Sibling sweep inventory (the "fixed here, forgotten there" guard)

Captatum sibling axes for this change and where each is handled:

| Path | Surface | Handling |
|---|---|---|
| Single-fetch extract | `normalizeCaptatumInput` | (2) fail-fast throw |
| **Bulk** extract | `normalizeBulkInput` | (2) fail-fast throw (whole-call) |
| Transform seam (defense-in-depth) | `finalize.ts` unsupported branch | (1) new message + (3b) `schema_validation_failed` reason |
| Degrade-reason readers | `shape.ts` classifyStatus, `bulk-seed.ts` | (3b) simplify to `provider==="none"` |
| Receipt degrade signal | `Result.outputRequested`, lean payload | (3a) |

Grep confirms no other `transform.reason` constructor or `reason ===` reader outside the
above (the bulk-result envelope `transform.reason` is a separate, loosely-typed shape and is
left as-is — it carries the same values but is not a typed contract surface; a sweep grep at
implementation time will re-confirm).

## Acceptance criteria (frozen suite, `test/acceptance/153/`)

Authored by a **different harness** than the coder, frozen (hash-manifest) in PR A, activated
in PR B. The suite is pure/unit-level (no browser) and asserts DESIRED behavior:

- **C1 (message clarity):** `validateSupported`/`findUnsupportedSchemaKeyword` on
  `{ ..., budget: 1 }` reports `budget` as the offender, and the message leads with
  `Unsupported JSON Schema keyword "budget"` and does **not** contain `$schema` as the
  implicated key. A `$schema`-only schema is accepted.
- **C2 (input fail-fast, single):** `normalizeCaptatumInput({url, output:"extract",
  schema:{...,budget:1}})` throws `CaptatumInputError` with code
  `extract_schema_unsupported_keyword` **before any fetch** (no fetcher invoked). A supported
  schema does not throw.
- **C3 (nested):** an unsupported keyword nested in `properties.email` (`format`) is caught
  at input with path `$.properties.email`.
- **C4 (bulk fail-fast):** `normalizeBulkInput({urls:[...], output:"extract",
  schema:{...,budget:1}})` throws `CaptatumInputError` (`extract_schema_unsupported_keyword`)
  before any seed is processed.
- **C5 (outputRequested):** a degraded summary→raw result carries
  `outputRequested:"summary"` and `output:"raw"`; the lean `structuredContent` surfaces
  `outputRequested`.
- **C6 (typed reason + status):** a transform-failed degrade yields
  `transform.reason:"transform_failed"` and `status:"partial"`; a `provider:"none"` degrade
  for *any* reason (incl. `no_model_fit`) is `status:"partial"` (the latent-bug fix).

## Verify bar

- `pnpm run check` (syntax + 250-line + typecheck), `pnpm test`, real-Chromium
  `node --no-warnings --test test/integration/fixtures.test.ts` (NOT skipped),
  `pnpm run smoke`, `pnpm run test:acceptance` (phase 153 active), and the process-guard
  check (freeze-hash · mixed-diff · stage-artifact) all green.
- **Real-input empirical verification (×N):** reproduce the issue's exact case end-to-end —
  `captatum({url, output:"extract", schema:{$schema:"...", type:"object", properties:{...},
  budget:...}})` — and confirm (a) it now rejects at input with the clear message and **no**
  fetch, and (b) a valid extract schema still completes. Plus the supported-keyword mismatch
  advisory path still returns parsed JSON + non-fatal `extract_schema_invalid`.
