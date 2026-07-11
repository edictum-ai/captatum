# 152 — shell-gate: metadata JSON-LD must not satisfy the gate (data-`@type` allowlist, aligned to a widened harvester)

**Status:** contract-first spec, **v3** (Option A, *wide* path). T3. Not yet implemented.
**Fixes:** #152 (reframed) + the #179/StartupJobs residual.
**Prior critiques:** `…critique.md` (v1, 3-lens) + `…critique-v2.md` (v2, 3-lens). v3 incorporates all v1+v2 findings. The v2 *security* lens returned **proceed**; the v1/v2 *correctness* findings are all addressed below.

## Decision

Option A, **wide**: (1) **widen the Tier-1 harvester** to extract real content from the broader data-`@type` set into `result.text`; (2) the **shell-gate's JSON-LD path is satisfied ONLY by that same set** (`CONTENT_TYPES`) — a positive allowlist, single-sourced in `domain/content-bearing.ts` — and only when the node carries a harvestable content field; (3) the contentType classifier is widened to match. The gate set == the harvester set == the classifier superset (the load-bearing invariant; see "Invariant" below). Scaffolding / `@type`-less / metadata-only JSON-LD no longer satisfies on its own. **Allowlist, not blocklist**, at the trust boundary (the current predicate is effectively a blocklist — house-rule violation).

## Why (root cause, verified live)

Two job-board repros, one root cause (analysis: `issuecomment-4938914941`): pages whose static HTML lacks the JS-rendered listings, but `hasContentBearingJsonLd` (`src/domain/content-bearing.ts`, shared by the shell-gate `shell-gate.ts:65` and `low_value` `content-quality.ts:52`, #159) over-counts **metadata** JSON-LD → shell-gate stops at Tier-1 → never renders → empty/thin. NoFluffJobs = `{@context,@graph:[metadata]}` (no data `@type`, empty result — the original `invalid_app_state`/`max_bytes` framing is **obsolete**, 714 KB not truncated); StartupJobs = scaffolding `@types` + a marketing `description` (thin chrome). Next tightening — and partial **reversal** — of #109.

## Contract

### Single source of truth — `src/domain/content-bearing.ts` (domain)

1. **`shortSchemaType(value)`** — consolidated normalizer (one copy; today 4 divergent copies: `content-bearing.ts:14`, `classify.ts:229`, `tier1-payload.ts:24`, `images.ts:113`). **Order matters and matches the existing correct code:** lowercase → strip the `https://schema.org/` prefix → strip a trailing `/` → take the last `/`-segment → trim surrounding whitespace. (v2 had the order wrong — stripping the slash after the segment turn `JobPosting/` into `""`.) **CURIE/prefix forms** (`schema:JobPosting`, `s:JobPosting`) are **explicitly out of scope**: they are not normalized and fail the `Set` lookup (→ an extra render on such a page; safe, non-bypass). Whitespace, full-IRI, trailing-slash, and array forms ARE handled.

2. **`CONTENT_TYPES`** — the frozen allowlist (gate set == harvester set == classifier superset):

   ```
   article, newsarticle, blogposting, techarticle, scholarlyarticle, report   // Article family
   jobposting                                                                 // jobs
   product, event, course                                                     // commerce / listings / courses
   recipe, review                                                             // food / reviews
   howto, faqpage, question                                                   // knowledge / Q&A        (NEW — harvested)
   softwareapplication, webapplication                                        // software
   musicrecording, book, movie, tvseries, tvepisode, game                     // media titles           (NEW — harvested)
   dataset                                                                    // data                   (NEW — harvested)
   localbusiness, restaurant, store                                           // business pages         (NEW — description-harvested)
   socialmediaposting                                                         // pin captions — PIN-DETAIL PAGES ONLY (see Invariant)
   ```

   **Excluded** (harvested into `structured.jsonLd` for `debug`/`raw`, not gate-satisfying): scaffolding (`WebPage`/`WebSite`/`CollectionPage`/`SearchResultPage`/`BreadcrumbList`/`SiteNavigationElement`/`AboutPage`/`ContactPage`/`ProfilePage`), `@type`-less nodes, and metadata types (`Organization`/`Person`/`Offer`/`Place`/`ImageObject`/`ItemList`/`AggregateRating`/`VideoObject`/`AudioObject`). `VideoObject`/`AudioObject` excluded because Google rich-results pushes them onto any page with an embedded video — admitting them re-opens the bug (v1 finding). `ItemList` reachable indirectly via `itemListElement` nesting (below).

3. **`CONTENT_FIELDS`** — the per-type harvest map. A node satisfies the gate **iff** it has a `@type` ∈ `CONTENT_TYPES` **and** ≥1 **non-trivial** field from its row (closes the bare-`{"@type":"JobPosting"}` and multi-type-array-append bypass). Fields are schema.org-correct (v2 had JobPosting wrong — its title field is `title`, not `name`, per `shell-gate.test.ts:24`):

   | type(s) | harvested fields (first non-trivial wins) |
   |---|---|
   | Article family | `articleBody`, `headline`, `description` (v2 missed `headline`, which today's `CONTENT_PROPERTIES` includes — `shell-gate.test.ts:283,329,331`) |
   | `jobposting` | **`title`**, `description` (`title` is JobPosting's title property — `shell-gate.test.ts:24`; v2's `name` was wrong) |
   | `review` | `reviewBody`, `description` |
   | `recipe` | `recipeInstructions` (**descended**: `Text` used directly; `HowToStep[]`/`ItemList` → per-element `.text`, NOT string-coerced — v2 would have yielded `[object Object]`), `description` |
   | `howto` | `description`; + `step[]` descended: `HowToStep`→`.text`, **`HowToSection`→ recurse its `.itemListElement`/`.step`** (depth-capped, cycle-guarded — v2 read only the section `.name`, losing the grouped steps) |
   | `faqpage` | `mainEntity[]` → per `Question`: `name` + `acceptedAnswer.text` (Q&A pairs) |
   | `question` | `name` + `acceptedAnswer.text` |
   | `product`, `event`, `course`, `dataset`, `softwareapplication`, `webapplication`, `musicrecording`, `book`, `movie`, `tvseries`, `tvepisode`, `game`, `localbusiness`, `restaurant`, `store` | `description` (**`name` is NOT a fallback for these** — a bare `{"@type":"Movie","name":"Inception"}` injected by rich-results must not satisfy; v2's name-fallback re-opened the bug for media/data/business types) |
   | `socialmediaposting` | `articleBody` — **PIN-DETAIL PAGES ONLY** (see Invariant; Pass 2 restriction unchanged) |

### The gate predicate — `hasContentBearingJsonLd(jsonLd, url?)`

A node is content-bearing **iff** it (or a nested content entity via `mainEntity`/`mainEntityOfPage`/`about`/`subject`/`hasPart`/`itemListElement`, depth-capped + cycle-guarded) declares a `@type` ∈ `CONTENT_TYPES` **and** carries ≥1 non-trivial `CONTENT_FIELDS` field. **Dropped** paths (the bug): scaffolding+content-prop no longer counts; `@type`-less nodes no longer count. **Signature change (v2 finding):** the predicate takes an optional `url` so that **`socialmediaposting` counts ONLY on a pin-detail page** (`isPinDetailPage(url)`) — aligning the gate's scope for that type with the harvester's Pass-2 scope (see Invariant). `evaluateShellGate` is threaded the URL (the extract pipeline has it); `content-quality.ts:52` passes `result.finalUrl`. `shortSchemaType` normalizes `@type` before the lookup. The `@type` array is **count-capped (first 64)** in `nodeTypes` so a 100k-`@type` array is O(64), not O(n) (v2 finding).

### The harvester — `leadDescription` (`tier1-payload.ts`)

Widened to use `CONTENT_FIELDS`. **Iterates `candidateNodes` and emits the first node that YIELDS non-empty `CONTENT_FIELDS` text — continuing past content-typed nodes whose fields are absent/empty** (v2 finding: a field-less `Recipe` before an `Article` must not strand the harvest). Today Pass 1 reads only `node.description` (length >50) — so `Review.reviewBody`, FAQ Q&As, HowTo steps, a JobPosting `title` were never promoted (v2 finding). Array/structured fields (`step[]`, `mainEntity[]`, `recipeInstructions`, HowToSection descent) are extracted per-element. **Caps (pinned, v2 open-Q #2 closed):** each field value is **length-capped to ~4 KiB** and array fields are **count-capped to the first 50 elements**, applied **slice-then-normalize** (slice to first-N *before* any HTML-strip/map/join, so a 100k-element `step[]`/`mainEntity[]` is O(N) not O(100k) — v2 DoS finding). Pass 2 (SocialMediaPosting `articleBody`, pin pages) unchanged. `buildPayload` already leads with `desc` then `text`.

### The contentType classifier — `classify.ts`

`mapType` widened so gate-satisfying ⇒ non-`unknown` contentType. Pin pages already classify `pin` via the `isPinHost` check that **precedes** JSON-LD (so `socialmediaposting` need not be in `mapType` — consistent once it's gate-scoped to pin pages). `primaryTypes` descends `mainEntity`/`about` **only for scaffolding-only wrapper nodes** (mirrors the gate's `isScaffoldingOnly` guard) so a content node's own `about` can't misclassify it (e.g. an `Article` about a `Product` stays `article` — v2 finding). Exact `ContentType` enum widening is an impl detail (non-frozen).

### What does NOT change

- The shell-gate's visible-text `hasContent` path (content-present) and the empty-shell escalation (render). A page with metadata-only JSON-LD **and** real visible text still passes via the text path — **no extra render**.
- Named-framework app-state satisfaction (`__NEXT_DATA__`/…). The Pinterest pin Tier-1 path (Pass 2). (v1 finding.)

## Invariant (load-bearing): gate set == harvester set == classifier superset

For every `CONTENT_TYPES` entry, the gate must be satisfiable **and** the harvester must be able to produce a non-empty `result.text` from the same shape, on the same page scope. v3 closes the three v2 holes: (a) `jobposting` harvests `title` (not just `description`); (b) `socialmediaposting` is gate-scoped to pin pages (matching Pass 2); (c) the harvester skips field-less content-typed nodes. The frozen suite asserts **both** gate-satisfaction **and** non-empty `buildPayload` per type.

## `#109` reversal (owned) — ALL flipped tests enumerated

Strict-A **reverses `#109`'s positive guard**: a scaffolding node with a non-empty content prop no longer satisfies. Non-frozen tests that flip in the impl PR (v2 found v1 under-enumerated these):
- `test/shell-gate.test.ts:258-265` + the usable-entry list `:280-286` — `{"@type":"WebPage","description":"Real summary."}` → now `false`.
- `:283` `["WebPage","Article"]` + `headline` → still **true** (Article ∈ CONTENT_TYPES, headline ∈ its fields) — does NOT flip (v2 flagged v1 wrongly implied it might; it stays satisfied via the Article).
- `:329`/`:331` `{"@type":"Article","headline":"x"}` → still **true** (headline ∈ Article CONTENT_FIELDS).
- `:24-29` `{"@type":"JobPosting","title":"Engineer"}` → still **true** (title ∈ JobPosting CONTENT_FIELDS — v3 fix; v2 would have flipped it).
- `:284`/`:286` `{JobPosting,title}` (incl. nested via `about`) → still **true**.
Net: the **scaffolding-type + content-prop** cases flip (the `WebPage`+description family), AND **bare data-typed nodes with no content field** flip (e.g. `shell-gate.test.ts:330` `[{"@type":"Product"}]` — true under the old "any data key" path, false under "need a `CONTENT_FIELDS` field"). The data-typed **+ content-field** cases (`Article`+headline, `JobPosting`+title) stay satisfied. `#109`'s negative half (empty-content scaffolding) is unchanged.

## Blast radius (wide path)

- **Intended fix:** StartupJobs / NoFluffJobs (+ class) → metadata-only JSON-LD → not satisfied → render (hosted/Mac mini residential: the JS listings) → real content; no-browser runtime → honest `render-unavailable`/`render-blocked` fail (not a silent empty Tier-1 "pass").
- **Wide benefit:** HowTo / FAQPage / Question / Dataset / media / Review-body / Recipe-instructions / business-description pages now yield content at Tier-1 (no render).
- **Preserved:** Pinterest pins (Pass 2). `Article`+headline, `JobPosting`+title Tier-1 (v3).
- **Cost:** more renders on the empty/thin-text + metadata-only-JSON-LD class → render latency + the datacenter-ASN egress wall (Fargate loses on some anti-bot sites; Mac mini residential fine). Bounded by `maxRenderedSeeds` in bulk.
- **Accepted precision tradeoff (v2 finding):** `dataset`/`localbusiness`/`restaurant`/`store` on `description` alone re-introduce a *flavor* of the metadata-satisfies-gate pattern (a JS data-portal with a `Dataset` catalog-description could satisfy and skip a render). Accepted: the description must be non-trivial, and a render is still the backstop on text-thin pages. Recorded in the threat model.
- **`low_value` (corrected, v1):** the backstop does NOT fire for StartupJobs (Czech title ∉ English-only `GENERIC_TITLES`, `content-quality.ts:25`) — a localized-title page that can't render stays `pass`-with-thin-text. Closing that is a separate `low_value` change, out of scope.
- **Diagnostic gap (#154):** the bare empty-`fail` becomes `render-blocked`/`render-unavailable` (clearer); a positive diagnostic is #154.

## Threat model (`docs/threat-model.md`)

- `CONTENT_TYPES` membership is a `Set` lookup on `shortSchemaType`-normalized `@type` — O(1), no regex, no ReDoS. `@type` array count-capped (first 64). `@graph` + nested-entity recursion depth-capped (`MAX_NESTED_DEPTH = 4`) + cycle-guarded.
- The widened harvester reads more untrusted JSON-LD fields pre-render; the **safe-json reviver (`safe-json.ts`) runs at parse (`metadata.ts`) BEFORE the gate/harvester read `structured.jsonLd`** (confirmed by the v2 security lens — no raw-`JSON.parse` bypass). `stripHtmlTags` is linear/cursor-advancing/quote-aware (ReDoS-safe). Caps: field ~4 KiB, arrays first-50, `@type` first-64, **slice-then-normalize**. Values are DATA (string-coerced, linear HTML-stripped, never a directive).
- Net: **strictly stricter-or-equal admission** vs today (v2 security lens confirmed — the new predicate admits a subset). No new bypass; removes one. Residual: description-only admission for Dataset/business is an accepted precision tradeoff (above). `videoobject` title-extraction is dropped on consolidation (a VideoObject-only page's title falls back to `<title>` — acceptable, VideoObject is excluded everywhere by intent).

## Acceptance criteria (frozen suite — `test/acceptance/152/`, own PR before impl)

`CONTENT_TYPES`, `CONTENT_FIELDS`, and the gate rule are **contract values** → frozen. Phase `152`, added **unactivated** (`"152": false`) until impl. The suite asserts gate-satisfaction **and** non-empty `buildPayload` per type:
- **Positive (satisfy + non-empty harvest):** representative `CONTENT_TYPES` (`JobPosting`+`title`, `Article`+`headline`, `Product`+`description`, `Review`+`reviewBody`, `Recipe`+`recipeInstructions`(HowToStep[]), `HowTo`+`step[]`(incl. a `HowToSection`), `FAQPage`+`mainEntity[]`, `Question`, `Dataset`+`description`, `SoftwareApplication`, `Movie`+`description`, `Restaurant`+`description`, `SocialMediaPosting`+`articleBody` **on a pin-detail URL**) → gate `true` → `structured-data-found` (no render) **AND** `buildPayload` contains the harvested field.
- **Negative (not satisfied — the bug class):** scaffolding+non-empty `description` (StartupJobs); `@type`-less node with data keys; `{@context,@graph:[metadata-only]}` (NoFluffJobs); `BreadcrumbList`/`Organization`; `VideoObject`/`AudioObject` only; bare `{"@type":"JobPosting"}` (no field); `["WebPage","JobPosting"]` with no JobPosting field; `{"@type":"Movie","name":"Inception"}` (name-only, no description); `SocialMediaPosting`+`articleBody` on a **non-pin** URL. Each → `false`.
- **Nested:** `WebPage.mainEntity→Article` → `true`; `ItemList.itemListElement→[Article,…]` → `true`; `WebPage.mainEntity→WebPage` → `false`.
- **Reversal guard:** `WebPage` + non-empty `description` → `false` (the `#109` positive case, now reversed).

Impl-detail guards (exact `CONTENT_TYPES` count, `shortSchemaType` normalization specifics, cap values, timing, the 100k-array DoS bound) go in **non-frozen** `test/*.test.ts`. The non-frozen DoS test feeds a 100k-element `step[]`/`mainEntity[]` + a 100k-`@type` array + a content-last `@graph` and asserts bounded work (not just bounded output).

## Out of scope

- Original #152 app-state items (truncated-script handling, lenient/partial-JSON fallback, raise `maxBytesHardCap`) — demoted; separate T3 if a >5 MB embedded-state page appears.
- New platform adapters — with the shell-gate fixed these render and yield content.
- The empty-extraction diagnostic (#154) and the `low_value` localized-title gap.

## Open questions — CLOSED (v3)

- **Q1 (business fields):** `localbusiness`/`restaurant`/`store` on `description` only for now (accepted precision tradeoff). Harvesting structured business fields (address/menu/hours) is separate work.
- **Q2 (caps):** pinned — field ~4 KiB, arrays first-50, `@type` first-64, slice-then-normalize.
- **Q3 (ContentType enum):** impl detail (non-frozen); the contract only requires gate-satisfying ⇒ non-`unknown`.
