# Spec: #154 — renderDiagnostics on render_empty / render failures

- **Issue:** [#154](https://github.com/edictum-ai/captatum/issues/154)
- **Tier:** T2 (new client-visible output fields cross the output-redaction / data-exposure boundary)
- **Status:** v2 — READY (2-lens independent critique folded in; see "Critique resolutions" below). v1 was BLOCKED on a wrong egressBytes scope + a false renderEgressHosts security claim.
- **Spec trailer:** `Spec: docs/specs/154-render-diagnostics.md`

## Problem (verified live 2026-07-12)

`render_empty` is opaque: `tier:error, resolvedVia:tier3-playwright, "Render produced no content"`. Reproduced on `levels.fyi/…/prague-czechia` (Tier-1 empty-SPA-shell → Tier-3 `render_empty`, status 200, bytes 0). The caller cannot tell bot-wall vs empty-SPA vs network-blocked vs shadow-DOM vs cookie-wall vs needs-longer-idle.

Premise re-verified against `origin/main` (`d20ce75`):
- `egressBytes` IS bulk-surfaced (`bulk-shape.ts:87`) but absent from single-fetch `shape.ts`.
- `renderEgressHosts` is **internal-only** — absent from BOTH mcp shapes (feeds only the bulk orchestrator's union gate). Surfacing it is **net-new** in both shapes (NOT "bulk parity").
- `domTextLength` is not computed anywhere (issue's "render.ts:93" ref is stale).
- `RenderActionType` records only blocks/aborts/forwards/setup — **no `request-fulfilled`** (fulfilled GETs aggregate into `egressBytes`).
- `render-egress.ts:19` is `registrableDomain(h) ?? h`; `registrableDomain` returns null for IP literals (`registrable-domain.ts:27`) → a **public IP-literal subresource leaks as a raw IP** into `renderEgressHosts`. (Private/loopback are SSRF-blocked pre-egress; public IPs are not.)
- `Result.egressBytes = tier1Bytes + renderEgress` (`render.ts:59`) — **never 0** on a render_empty that followed a Tier-1 fetch.

## Design

### New field: `Result.renderDiagnostics` (`src/domain/result.ts`)

Populated ONLY on `render_empty` + `render_error`/render-failure (`rendered.rendered === false`). **Absent** on `render_unavailable` (no renderer ran → no actions/DOM), `render-blocked`, and Tier-1/2 success. Optional + additive.

```ts
export interface RenderDiagnostics {
  /** Rendered DOM byte size (RenderSuccess.fetchResult.bytes). Absent when the render failed
   *  before producing a DOM. */
  renderedBytes?: number;
  /** The browser's LIVE DOM text length (page.innerText().length), from the renderer. Captures
   *  shadow-DOM / computed-visible text the serialized-HTML extractor misses — so a page whose DOM
   *  HAS text the extractor dropped (high domTextLength) splits from a wall/stub (low domTextLength). */
  domTextLength?: number;
  /** Tier-3-ONLY subresource egress (rendered.egressBytes — the RenderSuccess value, NOT
   *  Result.egressBytes which includes the Tier-1 doc). 0 ⇒ no subresource loaded. */
  egressBytes?: number;
  /** Registrable domains the render loaded subresources from — FILTERED to registrable domains at
   *  the output boundary (raw IP / single-label hosts redacted to "[ip-literal]"); never a raw IP. */
  renderEgressHosts: string[];
  blockedRequests: number;     // request-blocked + resource-aborted + download-blocked + websocket-closed
  forwardedRequests: number;   // request-forwarded-post
  possibleReason: "render-error" | "network-blocked" | "extraction-gap" | "empty-dom" | "unknown";
}
```

### `possibleReason` classifier (conservative; `src/application/use-cases/render.ts`)

Pure function; first match wins; `unknown` is the default + catch-all. Thresholds IMPL-DETAIL (non-frozen tests pin boundaries, calibrated against real SPA shells during impl):

1. renderer threw / no DOM (`rendered.rendered === false` or `renderedBytes` absent) → **`render-error`**.
2. DOM present BUT Tier-3 `egressBytes === 0` AND no egress hosts (the browser loaded nothing beyond the doc) → **`network-blocked`** (a network/SSRF wall on subresources, or an SPA that fired no requests).
3. `renderedBytes ≥ EXTRACTION_GAP_BYTES` AND `domTextLength ≥ DOM_TEXT_PRESENT` (the DOM HAS text the extractor dropped) → **`extraction-gap`** (shadow-DOM / parser gap / text in a tag the extractor doesn't handle).
4. `renderedBytes < EMPTY_DOM_BYTES` AND `domTextLength < DOM_TEXT_PRESENT` → **`empty-dom`** (a stub shell that never hydrated / needs-longer-idle).
5. else → **`unknown`** (includes the markup-heavy-but-text-light challenge/cookie-wall case — `bot-wall` is deliberately NOT a reason; it can't be reliably split from extraction-gap by static signals, and a confident wrong label is worse than `unknown`. The `#151` `gateReason` antibot signal rides separately when attributable.)

Conservative by construction: anything ambiguous → `unknown`. Ordering is load-bearing only between branch 1 (no-DOM) and 2-4 (DOM present) — branches 3 + 4 are mutually exclusive on `domTextLength` (text-present vs not).

### domTextLength — renderer-port addition (`src/application/ports/renderer.ts`, playwright adapter)

`RenderSuccess` gains `domTextLength?: number` = `await page.innerText("body").length` (the browser's live, shadow-DOM-inclusive visible text). This is the signal the issue names + the one that splits extractor-gap from wall/stub. It is NOT hand-rolled HTML parsing (global rule) — it is the browser's own text. Threaded `rendered → render.ts → RenderDiagnostics`. Absent on `RenderFailure` (no page).

### egressBytes — Tier-3-only (the BLOCKER fix)

`RenderDiagnostics.egressBytes = rendered.egressBytes` (the `RenderSuccess`/`RenderFailure` Tier-3 subresource value, `renderer.ts:51/63`) — **NOT** `Result.egressBytes` (which is `tier1Bytes + renderEgress`, `render.ts:59`, never 0). The classifier's `network-blocked` branch checks this Tier-3 value. (On `render_empty`, `rendered` is a `RenderSuccess`, so `rendered.egressBytes` is the render's subresource egress; `Result.egressBytes` is left as-is for the byte budget.)

### renderEgressHosts — output-boundary registrable filter (the BLOCKER security fix)

The internal `render-egress.ts:19` `registrableDomain(h) ?? h` is KEPT (the bulk union-key gate relies on the raw fallback to key two IP subresources together). At the OUTPUT boundary (the shared shaper), filter the surfaced copy: `[...hosts].filter(h => registrableDomain(h) !== null)`, redacting IP/unknown hosts to a fixed sentinel `"[ip-literal]"` (so the count is preserved without leaking the raw IP). Re-state the security claim: **registrable domain, or a redacted sentinel — never a raw IP.**

### Surfacing — `src/interfaces/mcp/shape.ts` + `bulk-shape.ts` (net-new, honestly framed)

A NEW shared helper surfaces `egressBytes` (parity: bulk has it, single-fetch doesn't) + `renderEgressHosts` (NET-NEW in both — previously internal-only) + `renderDiagnostics` on the render-failure path. **Privacy trade-off (documented in threat-model + contracts):** callers gain the set of registrable domains the page loaded subresources from — a new host-identifier surface (bounded to public registrable domains + the `[ip-literal]` sentinel; no raw IPs, paths, or full URLs). This is the issue's explicit ask; the threat note records it is a net-new exposure.

### mainFrameUrl — omitted, justified

Not duplicated: `renderEgressHosts` already surfaces a redirect-to-challenge domain (the challenge host appears in the egress host set); the common 200-same-URL challenge keeps `mainFrameUrl === finalUrl` (already public on the result). A full `mainFrameUrl` would need `redactSignedQueryParams` treatment (it's a URL, not a count/domain) — deferred to keep v1 all-counts/domains/sentinel at the output boundary.

### bulk-retry (`src/application/use-cases/bulk-retry.ts`)

`renderDiagnostics` reflects the FINAL attempt only. `bulk-retry` spreads `...second` then overrides `egressBytes`/`renderEgressHosts` with summed values; `renderDiagnostics` rides through on `second` (the final attempt) unchanged. Documented: `renderDiagnostics.egressBytes` is Tier-3-only of the final attempt, NOT the aggregated `Result.egressBytes` — the two intentionally differ on the retry path.

### text-forward client profile

Deferred to v1.1: `renderDiagnostics` ships in `structuredContent` only. The text-forward diagnostic block (`content[0].text`, `contracts.md:66-68`) gains `possibleReason` + the counts when `debug` is on — a separate change (named here per the sibling-surface rule).

## Critique resolutions (v1 → v2)

- **BLOCKER (egressBytes scope):** use Tier-3 `rendered.egressBytes`, not `Result.egressBytes`; "do not recompute" directive dropped.
- **BLOCKER (IP leak):** output-boundary registrable-domain filter + `[ip-literal]` sentinel.
- **HIGH (renderedBytes can't split wall vs gap):** added `domTextLength` (renderer live text).
- **HIGH (renderEgressHosts is net-new, not parity):** re-framed + privacy note.
- **HIGH (EMPTY_DOM_BYTES=512 too low):** calibrate against real shells during impl (likely ≥2048); pin with a real fixture.
- **MEDIUM (render_unavailable inconsistency):** populate only on render_empty + render-error/failure.
- **MEDIUM (mainFrameUrl non-sequitur):** re-justified via renderEgressHosts.
- **LOW (bulk-retry desync):** documented final-attempt-only.
- **LOW (text-forward sibling):** named + deferred.
- **LOW (counts sound):** verified; optional type↔outcome equivalence test.

## Contract changes (contract-first — in this PR)

- **`docs/contracts.md`**: `renderDiagnostics` field (shape; present only on render_empty + render-error; `possibleReason` enum + conservative-hint semantics); `egressBytes` now surfaced in single-fetch (parity); `renderEgressHosts` **newly surfaced in both** (registrable domain or `[ip-literal]` sentinel, never a raw IP); `domTextLength` field. Privacy note: callers gain the page's subresource registrable-domains.
- **`docs/threat-model.md`** (output-exposure): renderDiagnostics surfaces counts/sizes/domains/sentinel/an enum — no raw URL/IP/path/query. `renderEgressHosts` is a NEW host-identifier surface (bounded). `domTextLength`/`renderedBytes` are sizes. `possibleReason` is a conservative heuristic over an untrusted render outcome (a hint, never a trusted diagnosis). No host/IP redactor exists; safety is by construction at the extractor boundary (registrable filter), not the redaction path.

## Acceptance criteria (frozen — `test/acceptance/154/`, authored independently, effects-only)

Assertions check OUTPUT SHAPE + the conservative-classifier contract, never threshold constants. Synthetic render outcomes via the single-fetch + bulk shapers.

1. **render_empty surfaces renderDiagnostics** (single + bulk): large DOM + high domTextLength + zero extracted text → `possibleReason: "extraction-gap"`, with `renderedBytes`, `domTextLength`, `egressBytes` (Tier-3), counts.
2. **extraction-gap vs empty-dom split** (the domTextLength win): large DOM + LOW domTextLength → `unknown` (or empty-dom if DOM small) — NOT extraction-gap (the DOM has no text); large DOM + HIGH domTextLength → `extraction-gap`.
3. **network-blocked**: DOM present + Tier-3 `egressBytes === 0` + no hosts → `possibleReason: "network-blocked"` (pins the Tier-3-egress fix).
4. **render-error**: renderer throw → `possibleReason: "render-error"`, `renderedBytes`/`domTextLength` absent.
5. **unknown**: ambiguous → `unknown` (never a confident guess; the markup-heavy-low-text challenge case lands here).
6. **net-new renderEgressHosts + egressBytes in single-fetch**: single-fetch now surfaces both on the failure path (egressBytes parity; renderEgressHosts net-new).
7. **absent when no render**: Tier-1 success + `render_unavailable` (no actions) → no `renderDiagnostics`.
8. **no raw-IP leak (security pin)**: a fixture with a PUBLIC IP-literal subresource in the egress host set → the surfaced `renderEgressHosts` contains `[ip-literal]` (or is filtered), NOT the raw IP. (Pins the output-boundary filter on the only IP kind that survives the SSRF guard.)

**Verify bar (real-input):** the three `levels.fyi` URLs via the REAL cli (`--output raw --debug`) → `renderDiagnostics` appears with a `possibleReason` matching the observed failure + `domTextLength`/`renderedBytes`/counts.

## Implementation PR

`test/render.test.ts`, `test/render-egress.test.ts`, `test/mcp-shape.test.ts` + `test/render-diagnostics.test.ts` (classifier boundaries + the registrable-domain/IP-sentinel filter — impl-detail, non-frozen). Calibrate `EMPTY_DOM_BYTES`/`EXTRACTION_GAP_BYTES`/`DOM_TEXT_PRESENT` against real levels.fyi + SPA-shell fixtures. Frozen `test/acceptance/154/` separate (PR A). Impl activates `phases.json "154": true`.

## Deferred

- `networkRequests.fulfilled` discrete count (renderer-port counter; `egressBytes` covers the signal).
- A confident `bot-wall`/`cookie-wall` reason (not reliably static; `#151` `gateReason` rides separately).
- `mainFrameUrl` (needs URL redaction; renderEgressHosts covers redirect-to-challenge).
- text-forward `renderDiagnostics` (v1.1).
