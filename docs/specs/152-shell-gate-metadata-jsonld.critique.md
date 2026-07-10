# 152 spec — v1 critique (3-lens, independent)

Independent critique of spec v1 (Option A, narrow curated `DATA_TYPES`). 3 lenses, ~280k tokens. **Verdict: defects_found / pending_decisions — v1 was NOT freezable.** All findings are addressed in v2 (the *wide* path). Recorded here per the T3 process (critique is a separate artifact from the spec).

## HIGH (blockers)

1. **`SocialMediaPosting` omitted → breaks Pinterest.** Pinterest pins resolve at Tier-1 *only* because a `SocialMediaPosting` node satisfies the current "non-scaffolding typed node with a data key" path (`content-bearing.ts:64-68`); v1's strict-A drops that path and `SocialMediaPosting` was not in `DATA_TYPES`. Fixture-tested first-class path: `test/fixtures/extract/pinterest-pin.html` + `test/extract.test.ts:225` (asserts tier 1, `tier1-jsonld`, SocialMediaPosting `articleBody` leads). Pinterest is residential-egress-sensitive → a hosted render can fail. **v2 fix:** `socialmediaposting` ∈ `CONTENT_TYPES` (Pass 2, pin pages — unchanged restriction).
2. **`VideoObject`/`AudioObject` included → re-opens the bug.** In practice these are embedded-media/thumbnail metadata (Google rich-results pushes `VideoObject` onto any page with a video), not primary content; a JS-shell with just a `VideoObject` would satisfy → no render → empty — the exact failure. **v2 fix:** excluded from `CONTENT_TYPES`.
3. **Gate/harvester drift (deepest).** v1's `DATA_TYPES` had types the Tier-1 harvester does **not** extract (`HowTo`/`FAQPage`/`Question`/`Dataset`/`Movie`/`TVSeries`/…). Those would satisfy the gate but yield an empty/thin Tier-1 — the same failure moved to a different type set. The gate allowlist must equal the harvester's extractable set. **v2 fix (wide path):** widen the harvester (`CONTENT_FIELDS`) so the gate set == the harvester set == the classifier superset, single-sourced in `domain/content-bearing.ts` (#159 never-drift).
4. **`#109` reversal mislabelled.** v1 called the change "tightening" / "`#109` still holds unchanged." Strict-A *reverses* `#109`'s positive guard (`WebPage` + non-empty `description` no longer satisfies; `test/shell-gate.test.ts:258-265,280-286` assert it today). **v2 fix:** owns the reversal explicitly; affected non-frozen tests flipped in the impl PR.

## MEDIUM

5. **Bare-type / multi-type-array bypass.** `{"@type":"JobPosting"}` (no fields) or an attacker appending a data type to a `@type` array would satisfy on type alone. **v2 fix:** require ≥1 `CONTENT_FIELDS` content field to satisfy.
6. **`shortSchemaType` duplicated 4×, 2 behaviors.** `content-bearing.ts:14` + `images.ts:113` strip a trailing slash; `classify.ts:229` + `tier1-payload.ts:24` don't. **v2 fix:** consolidate to one domain export (trailing-slash + whitespace-trim form).
7. **`low_value` backstop claim inaccurate for StartupJobs.** `detectLowValue`'s title gate is English-only (`GENERIC_TITLES`); StartupJobs' Czech title isn't in it → the backstop doesn't fire. **v2 fix:** corrected; localized-title gap noted as out of scope.
8. **Acceptance asserted predicate-true, not result-non-empty.** Because of the drift, the predicate could be true while the Tier-1 result was empty. **v2 fix:** frozen suite asserts gate-satisfaction **and** a non-empty `buildPayload` harvest per type.

## LOW

9. `LocalBusiness`/`Restaurant`/`Store` excluded though primary content on business pages → **v2:** included on `description`.
10. `ItemList` excluded + `itemListElement` not in `NESTED_CONTENT_LINKS` → static list of data-typed children unreachable → **v2:** `itemListElement` added to the nested-content links.
11. `classify.primaryTypes` descends `@graph` but not `mainEntity`/`about` → a nested-`Article` page satisfies the gate yet classifies `unknown` → **v2:** descend `mainEntity`/`about`.
12. `shortSchemaType` doesn't trim whitespace / handle some CURI forms → false non-satisfaction (extra renders) → **v2:** whitespace-trim in the consolidated normalizer.
13. v1 referenced `test/content-bearing.test.ts` which doesn't exist (tests are in `test/shell-gate.test.ts` + `test/extract.test.ts`) → **v2:** corrected.

## What v1 got right (kept in v2)

- Option A direction (data-`@type` allowlist) + the allowlist-not-blocklist / threat-bound framing (O(1) `Set` lookup, depth-capped recursion, no ReDoS, strictly-stricter admission) — confirmed sound by the security lens.
- Root-cause diagnosis (NoFluffJobs/StartupJobs, the shared predicate) — confirmed.
- No frozen-suite breakage (146/151/153 assert no flippable JSON-LD shape; the lone acceptance JSON-LD is a `JobPosting` at `146/cross-callers:38`, stays valid).
- The nested-content rule (nested entity must be data-typed) breaks zero existing nested tests.
