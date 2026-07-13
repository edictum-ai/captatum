# Spec: #193 — recover misplaced extract tool knobs

- **Issue:** [#193](https://github.com/edictum-ai/captatum/issues/193)
- **Tier:** T3 — caller-supplied schema is untrusted input at a pre-egress boundary.
- **Status:** READY
- **Supersedes:** only the #153 expectation that every root schema `budget` is an unsupported keyword.
- **Spec trailer for downstream PRs:** `Spec: docs/specs/193-extract-schema-knob-recovery.md`

## Problem

Some MCP clients merge top-level tool arguments into `schema` when calling
`output: "extract"`. #153 correctly rejects unsupported schema keywords before
fetching, but rejects these otherwise-valid client calls too.

## Design

Before the supported-schema-keyword allowlist runs, Captatum may recover exactly
six root keys from a record-valued extract schema:

- `budget`
- `timeoutMs`
- `allowRender`
- `debug`
- `maxBytes`
- `transform`

For each candidate it uses the corresponding ordinary input parser without
coercion. A valid candidate is removed from a shallow schema clone. It becomes a
tool argument only if the true top-level field is absent; a true top-level value,
including `allowRender: false`, wins and causes the nested value to be discarded.
Each repair/discard emits a value-free `schema_knob_extracted` warning.

The recovery is root-only. It never mutates caller input or changes schema
property names. It never recovers URL, prompt, output, schema, URLs, or bulk cost
controls, so schema data cannot select a fetch target, output mode, or bulk cost
policy. The six allowlisted knobs may change their ordinary bounded fetch/render
behavior (`allowRender`/`maxBytes`/`timeoutMs`) only after field validation. An
invalid candidate remains in the schema and is rejected by the existing allowlist.
All other unsupported keywords remain a whole-call
`extract_schema_unsupported_keyword` reject before egress.

The uniform bulk schema follows the same rules once per call; its warnings live
at the bulk envelope, never once per seed.

## Authorization invariant

The MCP scope check must use the same effective output behavior as execution.
Therefore an omitted `output` on a provider-backed server resolves to summary and
requires `fetch:transform`; only providerless omitted output resolves to raw and
permits `fetch:read`. An explicit `raw` request never runs Transform and remains
`fetch:read` even when it carries an unused top-level `transform` override.

## Contract amendment and acceptance coverage

This is an intentional amendment to frozen #153. Its contract-level acceptance
cases assert valid root-knob recovery, cleaned schema input, and retained
pre-fetch rejection for genuine unsupported keywords. The acceptance manifest is
re-frozen alongside this contract change. Exhaustive value validation, caller
immutability, warning wording, all-six-key coverage, single/bulk propagation, and
scope behavior remain non-frozen regression tests.

## Verify bar

Run focused recovery, Captatum, bulk/MCP, shape, and authorization tests; then
`pnpm run check`, `pnpm test`, `pnpm run test:acceptance`, `pnpm run smoke`, and
integration coverage. Confirm an omitted-output provider-backed hosted request
with only `fetch:read` is denied before fetch or transform.
