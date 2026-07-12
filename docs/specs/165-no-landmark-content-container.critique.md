# Critique: #165 spec v1 — 3-lens independent review (fresh-context Workflow, 2026-07-12)

Three critics (premise/scope, regression/integration, trust-boundary/REDOS/process), each a fresh
context that did NOT see the author's reasoning. Verdicts: **READY / BLOCKED / BLOCKED**. Unanimous
scope assessment: **allowlist-first is the right v1; it fixes both named repros (cppr `#content`
96%, php `#layout-content` 91%); density is defensibly deferred.** The BLOCKED verdicts are spec-level
defects (wording/mechanism), not design rethinks. Resolutions below drive spec v2.

## Consensus defects → v2 resolution

1. **🔴 BLOCKER — REDOS bound mis-specified (trust-boundary lens).** v1 scored each candidate with
   `extractVisibleText` (~10 linear passes) and picked the richest → N×body×10 on nested 5MB candidates
   (the real cppr case: `#content`/`#bodyContent`/`#mw-content-text` nested). The "first-64 cap" does
   not help (nested ⇒ each ~full body), and the "length-floor short-circuit" is **logically impossible**
   under pick-richest (cannot know richest without scoring all). threat-model claimed a short-circuit
   that cannot exist.
   **Resolution:** (a) find candidate SPANS once (≤`MAX_CONTENT_CANDIDATES`=32, document order — a
   pathological-flood bound; real pages have 1–3), then PRESCORE by **raw `.content.length` (O(1))**;
   (b) run `extractVisibleText` on only the **top-K (K=3) by raw length**; (c) pick the text-richest of
   those clearing the floor. Cost: 1×`findStartTags`(O(body)) + ≤32×`findMatchingClose`(O(body)) +
   3×`extractVisibleText`. Worst case on a 5MB body ≈ 300–600ms, inside the 25s `MULTI_CEILING_MS`.
   Cap is a flood bound only. `assertLinear` test (NESTED allowlist-class opens) pins it. Sibling
   `selectMainContentHtml` has the same N×`extractVisibleText` shape at tiny real counts (≤2
   `<article>`/`<main>`); documented as a residual, not patched in this PR (low blast radius).

2. **🔴 HIGH — 0.5 length floor silently DROPS content (regression lens).** A docs page with the prose
   in `<div id="content">` (55%) + examples in a non-allowlisted sibling (45%) → 0.55 ≥ 0.5 → container
   accepted → 45% examples dropped from the trusted feed. Also a hostile page can put ≥50% of text in an
   allowlisted `#content` and hide the real article in a bare `<div>`. The "never loses content" claim
   only holds BELOW the floor.
   **Resolution:** raise `CONTENT_CONTAINER_MIN_FRACTION` to **0.7** (clears both repros 0.96/0.91 with
   margin; rejects the ambiguous 50–70% band) AND require **clear majority over the next-richest
   candidate** (`richest ≥ 0.5 × (richest + next)`) so a two-container split falls back to whole body.
   Weaken the fail-safe wording to honest bounds: "a below-floor false positive never loses content;
   an above-floor wrong container can narrow the feed away from content held elsewhere." Threat-model
   notes the selector is a heuristic a hostile author can game (acceptable: the threat model for
   reference/doc pages is legitimate-but-noisy authors, and a hostile author can dominate the feed
   regardless).

3. **🔴 HIGH — 250-line CI cap (regression + premise lenses).** main-content.ts is 214/250; the function
   + allowlist adds ~55–85 lines → CI red.
   **Resolution:** new file **`src/infrastructure/extract/content-container.ts`** (pure; imports
   `findStartTags`/`findElements`/`extractVisibleText` from `html.ts`; reuses `findMatchingClose` —
   export it from `main-content.ts`). Imported from `index.ts` alongside `selectMainContentHtml`.

4. **🔴 HIGH — tag-set ambiguity (all 3 lenses).** v1's sentence "`<div>`/`<section>`/`<main>` is
   unnecessary here" is garbled; a div-only reading **misses php.net's `<section id="layout-content">`**
   (the actual php.net fix, 94% of body).
   **Resolution:** pin the scan set = **{`<div>`, `<section>`}**. `<main>`/`<article>` are absent by
   definition on the no-landmark path. `<table>`/`<ul>`/`<form>` (the bare chrome carriers) are NOT
   scanned — they are what we drop, not select.

5. **🟡 MEDIUM — frozen criteria leak impl-detail (trust-boundary lens; #151 anti-pattern,
   [[captatum-frozen-suite-contract-only]]).** v1 criteria pinned "scope is `#content`" / "5% of text" —
   a later density reorder (the documented extension) would fail them though the contract holds.
   **Resolution:** rewrite frozen criteria **effects-only** (mirror `test/acceptance/146/`): "the
   top-bar/sidebar chrome is NOT in the head of `extractVisibleText`; the article prose leads" /
   "a container holding a SMALL MINORITY of page text is rejected → whole body kept." Selector identity
   + the 0.7/200 constants live in non-frozen `test/*.test.ts`.

6. **🟡 MEDIUM — class-tokenization (premise lens).** `parseAttributes` returns `class` as one string;
   a whole-string `Set.has` misses multi-class containers (`entry-content wp-content`).
   **Resolution:** split `attrs.class` on `/\s+/`, check each token against `allowlistClasses`;
   `id` is a single-token `Set.has`.

7. **🟡 MEDIUM — `findMatchingClose` opens-array precondition (regression lens).** The `opens` arg must
   be the **FULL same-tag open array** (every `<div>`/`<section>` open), not the allowlisted subset, or
   depth-counting pairs the container open with a premature inner close → truncated span → silent
   content loss.
   **Resolution:** gather ALL div+section opens for depth-counting; filter to allowlisted candidates
   only AFTER pairing each open with its matching close. Spec states this explicitly.

8. **🟡 MEDIUM — `MIN_CHARS`≥80 cross-file coupling (regression lens).** A selected container always has
   ≥200 chars ≥ `hasContent`'s 80 threshold, so the `landmarkFound=false` tag-check branch is never
   reached today — but the invariant is unstated.
   **Resolution:** pin `CONTENT_CONTAINER_MIN_CHARS` (200) with a code comment + assertion linking it to
   `hasContent`'s 80. NOT adding a `containerFound` shell-gate flag (it would let a short JS
   loading-skeleton container pass `hasContent` and skip a needed render — the ≥80-char skeleton case
   is **status-quo** shell-gate behavior, not a #165 regression; scoping to a container is neutral-
   to-safer for escalation since the container is a subset of the body). Add an AC pinning that an
   empty/short container still escalates.

9. **🟡 MEDIUM — footer-keep layering (regression lens).** Scoping to a container drops `<footer>` text,
   seemingly contradicting #144's footer-keep.
   **Resolution:** document the layering — footer-keep governs the **whole-body** no-landmark fallback
   (a static page may carry content in a footer); a **high-confidence content container** (≥0.7 of body)
   is a STRONGER content signal and correctly overrides it (the page clearly has a main area). When no
   container clears the floor, the whole-body fallback (footer kept) stands unchanged.

10. **🟡 MEDIUM — scope/mechanism sign-off (premise lens).** Issue #165 is titled "density reorder"; v1
    ships an allowlist + re-defers density. Needs maintainer sign-off on the re-scope, not silent
    assertion.
    **Resolution:** FLAGGED to the maintainer. Proceeding with allowlist v1 on the unanimous critique
    assessment + the house minimal-machinery/verify-don't-assert rules; density re-scoped to a filed
    follow-up. PR description states the deviation explicitly.

11. **🟢 LOW — stale grounding (premise lens).** `.refentry` is 9% on php.net (fails the floor, never
    selected) — the php.net fix is `#layout-content`, not `.refentry`. `.headsup` is an intermittent
    banner. The "verified live 2026-07-12" framing overstated both.
    **Resolution:** correct the grounding in spec v2 — php.net fix = `#layout-content` (a `<section>`);
    `.refentry` kept in the allowlist for other refentry-shaped pages but inert on the php.net repro;
    `.headsup` marked intermittent. Verify bar pinned to `#layout-content`, not `.refentry`/`.headsup`.

12. **🟢 LOW — contract drift (trust-boundary lens).** contracts.md named only the fraction floor.
    **Resolution:** contracts.md says "a length floor (a fraction of the page's visible text AND an
    absolute minimum)" — two-axis guard visible at contract altitude without freezing the 200 constant.

## Verdict → spec v2 is READY to implement (all defects resolved above). The maintainer scope
sign-off (#10) is the only non-technical item; proceeding on the critique's unanimous assessment.
