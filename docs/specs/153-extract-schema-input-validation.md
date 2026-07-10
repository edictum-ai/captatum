# Spec: #153 — Extract: clearer schema-validation error + fail-fast at input

- **Issue:** [#153](https://github.com/edictum-ai/captatum/issues/153) (bug, MED)
- **Tier:** T3 — the caller-supplied JSON Schema for `output:"extract"` is **untrusted input**. This change adds keyword-allowlist validation at the **input boundary** (before any fetch/LLM), which crosses the trust boundary, so the full pipeline applies. Repo is Engineering OS tier **S**.
- **Status:** v2 — READY. A 3-lens critique (`…critique.md`) returned BLOCKED on one defect (no depth cap on the pre-fetch walker) + a P1 (test ripple); both resolved. A focused re-critique (different harness) confirmed READY and surfaced one more mechanical P1 — `TransformReason` must include `unsupported_provider` (`model-router.ts:84`), a pre-existing value the free-typed `reason?: string` never enforced. Folded in (the union is now 8 values). No open decision remains.
- **Spec trailer for downstream PRs:** `Spec: docs/specs/153-extract-schema-input-validation.md`

## Critique resolutions (v1 → v2)

The critique's core security posture was confirmed sound (walker is a verified superset of `validateAt`'s traversal; fail-closed before egress; no schema value echoed; status simplification is a real conformance fix). v2 resolves:

1. **(BLOCKER → fixed) Depth cap.** `findUnsupportedSchemaKeyword` now carries an explicit `MAX_SCHEMA_DEPTH = 64` and fails closed (`extract_schema_too_deep`) on exceed. v1's "no cap, matches `validateAt` precedent" was unsound: request-body **size** bounds total nodes, not nesting **depth** (a <1 MB body of nested objects reaches ~150K depth), and — decisively — the walker runs **pre-fetch, free to attack**, whereas `validateAt` is post-fetch/egress-rate-limited. The trust-boundary framing argues *for* a cap, not parity. The cap is also the **chokepoint**: a deep schema is rejected at input, so `validateAt` (same exposure, post-fetch) is protected for every captatum/bulk path. Threat-model wording corrected.
2. **(P1 → fixed) Test-ripple enumerated.** v1 falsely claimed "verified-clean." Real ripple (all enumerated in §"Test impact"): `finalize.test.ts:10` (`"test"`→valid), `mcp-shape.test.ts:96/105` (drop degrade-only `reason` from a success fixture), `llm-transform.test.ts:264` (`"failed"`→`"transform_failed"`), and **two whole test bodies** `llm-transform.test.ts:163–186` + `188–215` (currently assert a *returned* `extract_schema_invalid` degrade; after the input fail-fast, `execute()` *throws* `extract_schema_unsupported_keyword` — rewrite to `assert.throws`). `format.ts:66` added to the reader sweep.
3. **(P2 → decided) Walker ⊆ `validateAt` exactly; tuple-form `items` fail-closed.** v1 recursed into `$defs`/`definitions`, which `validateAt` **never** visits (no `$ref` support ⇒ `$defs` content is dead). Recursing there would *over-reject* schemas finalize accepts. **Dropped**: the walker visits exactly `validateAt`'s applied-subschema set. **Tuple-form `items` (array) is fail-closed at input** (codex round-3): the value validator does NOT hard-reject tuples — it returns a non-fatal *advisory* (`invalid`, `unsupported` unset → `finalize` returns parsed JSON + a `schemaIssue`), so a schema like `{type:"array", items:[{format:"email"}]}` would otherwise pass the input keyword check AND surface only an advisory, leaving the nested unsupported keyword unvalidated — a fail-closed-consistency hole. The walker now flags array-form `items` as `{kind:"tuple_items"}` → `extract_schema_tuple_unsupported` at input (consistent: an unverifiable schema *form* fails closed before fetch, like an unsupported keyword). Single-schema `items` (`items:{…}`) is still recursed normally.
4. **(P2 → decided) 8-value `TransformReason` kept, labeled scope expansion.** Preserves actionable router signal (`no_model_fit` ⇒ retry w/ larger budget; `unconfigured` ⇒ missing key; `unsupported_provider` ⇒ bad provider override). The 8th value (`unsupported_provider`) is a pre-existing literal the free-typed `reason?: string` never enforced — surfaced by the narrowing (re-critic P1). The ripple is inherent to narrowing+rename+fail-fast (all issue-required). Narrows **both** `ModelPick.reason` and `TransformInfo.reason` (no casts; both are genuinely degrade values in production).
5. **(P2 → fixed) Path segments capped.** v1 capped only the offending key; the **property-name** path segment is also caller-controlled. Both are length-capped now.
6. **(P2 → fixed) C2 strengthened** to an `execute()`-level assertion (fail-on-call fetcher + adapter) — honest proof of "before any fetch."
7. **(Nits)** "four"→"five" `noneReason` values; `finalize` defense-in-depth stated as dead in the production call graph (retained for hypothetical direct-`TransformPort` callers); `outputRequested` stated as stamped on `applyOutputMode` + `rejectResult` only.

**Layering (pre-finding, not from critique).** `captatum-input.ts` (application) cannot import `infrastructure/llm/json-schema.ts`. The supported-keyword set is **shared policy** both layers need, so it (and the pure walker + message helpers + depth cap) lives in a new **`src/domain/schema-allowlist.ts`**, imported by both `json-schema.ts` (infrastructure→domain, allowed) and `captatum-input.ts`/`bulk-input.ts` (application→domain, allowed).

## Problem (the bug)

An `output:"extract"` call whose `schema` uses an unsupported JSON Schema keyword (the repro used `budget` — meant for the *tool*, not the schema) returns a confusing, misleading error and silently degrades to `raw`:

```
captatum({ url, output: "extract",
  schema: { $schema: "...", type: "object", properties: { ... }, budget: 123 } })
  → errors: [{ code: "extract_schema_invalid",
               message: '$ schema keyword "budget" is not supported' }]
  → output degraded to "raw" (after a full fetch + LLM round-trip)
```

Two defects: (1) the message renders `$ schema keyword "budget"`, which the eye reads as `$schema keyword "budget"` — implicating `$schema` (supported) not `budget`; (2) the check runs only AFTER fetch + LLM (`finalize.ts:49`), wasting a round-trip + paid call before rejecting, with no receipt field saying what was asked for or why it degraded.

## Design

### (1) Rephrase the message to lead with the offending key (both caller-controlled strings capped)

`validateSupported` (`src/infrastructure/llm/json-schema.ts`) leads with the key name; the path stays visually separate. The key AND each property-name path segment are length-capped (≤80 chars + ellipsis) — both are caller-controlled, both subject to the no-bloat principle. **No schema value is ever echoed** (schema = data, never a directive). Shared helper in `domain/schema-allowlist.ts`:

```
Unsupported JSON Schema keyword "budget" at $ — captatum cannot verify it; remove it.
Unsupported JSON Schema keyword "format" at $.properties.email — captatum cannot verify it; remove it.
```

### (2) Fail-fast keyword-allowlist validation at the input boundary (+ depth cap)

New file **`src/domain/schema-allowlist.ts`** exports:

```ts
export const SUPPORTED_SCHEMA_KEYS: ReadonlySet<string>;      // moved from json-schema.ts (single source of truth)
export const MAX_SCHEMA_DEPTH = 64;                            // >> any legit schema (~20); << V8 ~10K-frame stack
export type SchemaKeywordFinding =
  | { kind: "unsupported"; key: string; path: string }
  | { kind: "too_deep"; path: string }
  | { kind: "tuple_items"; path: string };
export function findUnsupportedSchemaKeyword(schema: unknown): SchemaKeywordFinding | undefined;
export function messageForUnsupportedKeyword(key: string, path: string): string;
```

The walker is **pure + value-free**, checks each node's own keys against `SUPPORTED_SCHEMA_KEYS` (identical check to `validateSupported`), flags array-form `items` as `{kind:"tuple_items"}` (fail-closed — see critique resolution #3), and recurses into **exactly** the applied-subschema locations `validateAt` visits — `properties.*`, `items` (single-schema form `{…}` only), `additionalProperties` (when a schema), `allOf`/`anyOf`/`oneOf` (each element), `not`. It does **not** visit `$defs`/`definitions` (dead — no `$ref`). It carries a `depth` counter; `depth > MAX_SCHEMA_DEPTH` ⇒ `{ kind: "too_deep" }` (fail-closed). An object-identity `seen` Set guards cycles (JSON.parse can't cycle; cheap defense). Per-node key order matches `Object.keys` (same as `validateSupported`), so the first offending keyword found agrees with finalize on any schema both visit.

`normalizeCaptatumInput` (`src/application/use-cases/captatum-input.ts`) runs this **before returning** — before any fetch — and throws `CaptatumInputError` (→ JSON-RPC `InvalidParams` / HTTP `{error:{code,message}}`):

```ts
if (parsed.output === "extract" && parsed.schema !== undefined) {
  const finding = findUnsupportedSchemaKeyword(parsed.schema);
  if (finding) {
    if (finding.kind === "too_deep")
      throw new CaptatumInputError("extract_schema_too_deep",
        `JSON Schema nesting exceeds the supported depth (>${MAX_SCHEMA_DEPTH}); simplify it.`);
    if (finding.kind === "tuple_items")
      throw new CaptatumInputError("extract_schema_tuple_unsupported",
        `Tuple-form "items" (arrays) are not supported at ${finding.path} — captatum cannot verify tuple validation; use a single schema (items: {…}).`);
    throw new CaptatumInputError("extract_schema_unsupported_keyword",
      messageForUnsupportedKeyword(finding.key, finding.path));
  }
}
```

**Sibling path.** `normalizeBulkInput` (`src/application/use-cases/bulk-input.ts`) gets the same check (a bad uniform schema would waste N fetches); it throws at the tool level before any seed (same severity as `too_many_urls`).

**Defense-in-depth retained (dead in the production call graph).** `finalize.ts`'s unsupported-keyword branch is kept, not deleted. It is unreachable via captatum/bulk (normalize always runs first), and the only production `TransformPort` caller is `captatum.ts:159`. It is retained solely for a hypothetical future direct-`TransformPort` caller; its message uses (1) and its degrade reason becomes `schema_validation_failed` (3). `contracts.md` says "on the rare reach" — accurate.

### (3) Enrich the receipt: `outputRequested` + typed `reason` enum

**(3a) `outputRequested?: Output`** on `Result` (`src/domain/result.ts`) — what the caller *requested* (vs `output`, the *actual* post-degrade output). Stamped on `applyOutputMode` (`base.outputRequested = request.requestedOutput`) and `rejectResult` — **not** on synthetic bulk error results (`bulk-seed.ts` `abortedSeedResult`/`wallAbandonedResult`/`syntheticFail`, which are `tier:error`/`fail` where it adds nothing). Surfaced in the lean `structuredContent`. Excluded from `computeProvenanceHash` (no hash ripple).

**(3b) `TransformReason` typed union.** `TransformInfo.reason` (`src/domain/result.ts`) narrows `string` → closed union of the **actual** degrade causes:

```ts
export type TransformReason =
  | "unconfigured"                          // no transform provider configured
  | "unsupported_provider"                  // caller-requested provider id is unrecognized (not openrouter/ollama) — model-router.ts:84
  | "provider_unconfigured"                 // caller-requested provider has no candidates
  | "model_unavailable"                     // caller-requested model not present
  | "no_model_fit"                          // candidates exist but none fit budget/context/supportsJson
  | "sensitive_content_no_local_provider"   // sensitive page; no local provider permitted
  | "transform_failed"                      // provider ran but threw (was "failed")
  | "schema_validation_failed";             // extract output failed schema validation (unsupported keyword)
```

Issue #153 names 3 (`schema_validation_failed | transform_failed | unconfigured`); this is a **deliberate superset** — the 5 `noneReason` values (`router-helpers.ts:27-37`) plus the literal `unsupported_provider` (`model-router.ts:84`, when a caller `transform.provider` override is unrecognized) are real, actionable degrade causes (collapsing `no_model_fit`→`unconfigured` would mislead). **Scope expansion, explicitly flagged.** (Note: `unsupported_provider` is a pre-existing value the free-typed `reason?: string` never enforced — adding it to the enum is a contract *correction* surfaced by the narrowing, not a #153 design choice.) Rename `"failed"`→`"transform_failed"` (`captatum.ts:174`); the catch maps `extract_schema_invalid`→`schema_validation_failed`, else `transform_failed`. `noneReason` returns `TransformReason`; `rawFallback` takes `TransformReason`; `ModelPick.reason` narrows `string`→`TransformReason` (genuinely a `noneReason` value in production — no cast).

**(3c) Status conformance fix (related scope, not literal issue).** `provider:"none"` is set **only** on a degrade — direct writers `captatum.ts:145` (no transformer) + `:174` (transform threw), and the transform port itself via `rawFallback`/`noneReason` (`model-router.ts:84,117`); `:185`/`:194` are *readers* of that field. Explicit-`raw` requests return at `:137` before any transform is set; `rejectResult` sets no transform. `contracts.md:484` **already** mandates `partial` when `transform.provider === "none"`. So `shape.ts:76` + `bulk-seed.ts:35`'s brittle reason allowlist (`reason === "failed" || "unconfigured"`) both under-reports (router sub-reasons — incl. `unsupported_provider` — today mislabel `pass`) **and** would break under the rename. Simplify both to `t && t.provider === "none"` ⇒ `partial`: a conformance fix, not a contract change.

## Contract changes (`docs/contracts.md`) — already landed in v1; v2 adds the too_deep code

v1 landed: typed `TransformReason`; input-time `extract_schema_unsupported_keyword` reject; `outputRequested`; lean-payload `outputRequested`; `captatum_bulk` uniform-schema reject. **v2 adds** the `extract_schema_too_deep` hard-reject code (depth > 64). **v3 adds** `extract_schema_tuple_unsupported` (tuple-form `items` fail-closed at input — the value validator only advisories tuples, so the input walker now hard-rejects the unverifiable form). Both join the Error-shape input-validation list + Transform §. The status rule (`provider:"none"`⇒`partial`) was already in the contract (code now conforms).

## Threat-model note (`docs/threat-model.md`) — corrected in v2

The `output:"extract"` schema is untrusted input validated at the input boundary against the `SUPPORTED_SCHEMA_KEYS` allowlist (`findUnsupportedSchemaKeyword`) — fail-closed before any egress/LLM. Allowlist (not blocklist); key + property-name path segment length-capped; **no schema value echoed** (schema = data). Same check on `captatum_bulk`'s uniform schema (whole-call reject). **Depth:** the walker carries `MAX_SCHEMA_DEPTH = 64` and fails closed (`extract_schema_too_deep`) on exceed. v1 mis-stated the implicit bound as the request-body *size* limit; the real implicit bound is **V8's `JSON.parse` recursion limit** (~thousands of levels — a deep body throws `RangeError` at parse, before the walker). The walker is the **more exposed** path (pre-fetch, free) vs `validateAt` (post-fetch, egress-rate-limited), so it gets the explicit cap; the cap is also the chokepoint that protects `validateAt` for all captatum/bulk paths. (A `RangeError` from either path is caught by `callCaptatum`/`callBulk` → `toMcpError` → `InternalError` — no crash vector; the cap removes the free-reachable error entirely.)

## Sibling-sweep inventory (complete, per critique)

| Path | Surface | Handling |
|---|---|---|
| Single-fetch extract | `normalizeCaptatumInput` | (2) fail-fast throw |
| Bulk extract | `normalizeBulkInput` | (2) fail-fast throw (whole-call) |
| Transform seam | `finalize.ts` unsupported branch | (1) message + (3b) `schema_validation_failed`; dead in prod, retained for direct-`TransformPort` |
| Degrade-reason readers | `shape.ts` classifyStatus, `bulk-seed.ts`, **`format.ts:66`** (debug-text reason reader) | (3c) simplify to `provider==="none"` (shape/bulk-seed); `format.ts:66` renders the new value (display-only, no code change beyond the rename) |
| Receipt degrade signal | `Result.outputRequested`, lean payload | (3a) |

`bulk-result.ts:30` (`transform?: { …, reason?: string }`) is a loose envelope the spec leaves as-is (not a typed contract surface). Audit log (`ln.tool`) carries no `reason` — unaffected.

## Test impact (complete ripple — per critique P1)

- `test/finalize.test.ts:10` — `RecordingRouter` fake `reason:"test"` → `"unconfigured"` (`ModelPick.reason` now `TransformReason`).
- `test/mcp-shape.test.ts:96,105` — success-transform fixture `reason:"selected"` → **drop `reason`** (degrade-only; success never sets it). Keeps the leanTransform pass-through intent via a separate provider:`"none"` fixture if needed.
- `test/llm-transform.test.ts:264` — `reason:"failed"` → `"transform_failed"` (rename).
- `test/llm-transform.test.ts:163–186` + `188–215` — **rewrite**: currently assert a returned `{output:"raw", errors:[{code:"extract_schema_invalid",…}]}` for an extract schema with unsupported keywords (`format`; nested `anyOf`/`oneOf`/`not`). After (2), `execute()` throws `CaptatumInputError("extract_schema_unsupported_keyword")` before fetch → `assert.throws`. (Coverage of the retained finalize branch stays via `finalize.test.ts:56`.)
- **New** (acceptance + unit): see C1–C9 below. Re-grep for other `ModelRouterPort` fakes at impl time.

## Acceptance criteria (frozen suite, `test/acceptance/153/`)

Authored by a **different harness**, frozen (hash-manifest) in PR A, activated in PR B. Pure/unit-level (no browser), asserts DESIRED behavior:

- **C1 (message clarity):** `{ ..., budget: 1 }` reports `budget`; message leads with `Unsupported JSON Schema keyword "budget"` and does **not** contain `$schema` as the implicated key. A `$schema`-only schema is accepted.
- **C2 (input fail-fast, single — at the `execute()` boundary):** `CaptatumUseCase.execute({url, output:"extract", schema:{...,budget:1}})` throws `CaptatumInputError` (code `extract_schema_unsupported_keyword`) with **zero** fetcher invocations AND **zero** adapter invocations (fail-on-call mocks) — honest proof of "before any fetch." (Plus the direct `normalizeCaptatumInput` unit assertion.)
- **C3 (nested + path):** unsupported keyword nested in `properties.email` (`format`) caught at input, path `$.properties.email`.
- **C4 (bulk fail-fast):** `normalizeBulkInput({urls:[...], output:"extract", schema:{...,budget:1}})` throws `extract_schema_unsupported_keyword` before any seed.
- **C5 (outputRequested):** a degraded summary→raw carries `outputRequested:"summary"`, `output:"raw"`; lean `structuredContent` surfaces `outputRequested`.
- **C6 (typed reason + status):** transform-failed degrade ⇒ `reason:"transform_failed"`, `status:"partial"`; a `provider:"none"` degrade for `no_model_fit` ⇒ `status:"partial"` (conformance fix).
- **C7 (depth cap):** a schema nested > 64 deep ⇒ `CaptatumInputError("extract_schema_too_deep")` (no fetch); a 64-deep supported schema is accepted.
- **C7b (tuple-form items):** `findUnsupportedSchemaKeyword({type:"array", items:[{type:"string", format:"email"}]})` ⇒ `{kind:"tuple_items", path:"$.items"}`; `normalizeCaptatumInput` throws `extract_schema_tuple_unsupported`. Single-schema `items:{…}` is still recursed (a nested unsupported keyword there is caught normally).
- **C8 (finalize defense-in-depth):** `finalize()` called directly with an unsupported-keyword schema throws AND the resulting degrade reason (via the catch) is `schema_validation_failed`.
- **C9 (outputRequested on success):** a successful summary carries `outputRequested:"summary"` (non-degrade path).

## Verify bar

`pnpm run check` (syntax + 250-line + typecheck), `pnpm test`, real-Chromium `node --no-warnings --test test/integration/fixtures.test.ts` (NOT skipped), `pnpm run smoke`, `pnpm run test:acceptance` (phase 153 active), process-guard (freeze-hash · mixed-diff · stage-artifact) — all green. **Real-input empirical ×N:** reproduce the issue's exact case end-to-end and confirm (a) it rejects at input with the clear message and **no** fetch, (b) a valid extract still completes, (c) the supported-keyword mismatch advisory still returns parsed JSON + non-fatal `extract_schema_invalid`.
