# Spec: #151 — Classify 429/DataDome/Imperva bot-verification walls as gated

- **Issue:** [#151](https://github.com/edictum-ai/captatum/issues/151)
- **Tier:** T2 (classifies untrusted response bodies at a security-relevant gating boundary — a decision downstream callers trust; touches a trust boundary, not a parser over untrusted input)
- **Status:** Post-critique, ready (see [`151-antibot-bot-verification.critique.md`](151-antibot-bot-verification.critique.md) — 2 blockers + 3 highs resolved). This spec is the authoritative target for the frozen suite + implementation.
- **Contract section affected:** `docs/contracts.md` `access.gateReason` union + the gateReason prose + the stale "captcha not yet emitted" note; `docs/threat-model.md` anti-bot-detection boundary
- **Spec trailer for downstream PRs:** `Spec: docs/specs/151-antibot-bot-verification.md`

## Problem

Make + Glassdoor are correctly `gated:true, gateReason:"captcha", challengeProvider:"cloudflare"`. But:
- **HashiCorp** (`https://www.hashicorp.com/careers/open-positions`) returns **429 "We're verifying your browser"** and is NOT classified as gated (passes through as content / a generic 429).
- **DataDome / Imperva (Incapsula)** challenge bodies are not recognized (no markers).

## Root cause (verified against `origin/main` @ `6dd2aa7`)

- `CHALLENGE_BODY_MARKERS` (`src/infrastructure/http/guarded-fetcher.ts:176`) = `/cdn-cgi\/challenge-platform|__cf_chl|cf-browser-verification|akamaighost|_abck|px-captcha|\/_px\//i` — covers Cloudflare/Akamai/PerimeterX only. Missing DataDome + Imperva.
- There is no **status-gated verification-phrase** detector: a 429/503 whose body is a generic "verifying your browser" interstitial (no vendor marker) is not recognized. `detectAntibotBlock` (`src/application/antibot.ts:26`) fires only on `hasCfMitigated`/`hasChallengeBody`.
- Flow today: `computeAntiBotEvidence` → `detectAntibotBlock` → `stampAntibotChallenge` sets `base.challengeProvider` → `classifyAccess` (`src/application/classify.ts:114`) maps a truthy `challengeProvider` to `gateReason:"captcha"`. There is no path to a distinct `bot_verification` classification.

## Design (two additive, independent detections)

### (1) Vendor CHALLENGE-ONLY markers → existing `captcha` path

Extend the markers with **high-precision, challenge-only** signatures (status-INDEPENDENT, like the existing Cloudflare/Akamai/PerimeterX entries — NOT vendor names, which appear on every protected page):

```ts
// guarded-fetcher.ts — challenge-only markers (status-independent). The vendor NAME
// (bare `datadome`) and the inline sensor path (`/_Incapsula_Resource`) are deliberately
// EXCLUDED: a DataDome SDK tag (js.datadome.co/tags.js) and an Imperva SWJIYLWA sensor
// appear on every *protected* page, so they FP on passing 200 content (critique B1/H3).
const CF_AKAMAI_PX_MARKERS = /cdn-cgi\/challenge-platform|__cf_chl|cf-browser-verification|akamaighost|_abck|px-captcha|\/_px\//i;
const DATADOME_CHALLENGE = /captcha-delivery/i;        // ct.captcha-delivery.com — the challenge-delivery CDN, inlined in the challenge body
const IMPERVA_BLOCK = /incapsula incident id|powered by incapsula/i; // block/challenge-page body text only
```

Attribution: add `AntiBotEvidence.hasDataDomeBody` / `hasImpervaBody` (computed in `computeAntiBotEvidence` where `bodyHead` already lives). `hasChallengeBody` becomes the OR of `CF_AKAMAI_PX_MARKERS` + the two new markers. `challengeProvider()` (`antibot.ts:35`) branches on the per-vendor booleans → `"datadome"` / `"imperva"` (then the existing cf/akamai/perimeterx/incapsula `serverVendor` attribution).

### (2) Status-gated + non-JSON verification phrase → NEW `bot_verification` path

A new `AntiBotEvidence.hasVerificationPhrase`, computed ONLY when `status ∈ {429, 503}` AND the content type is not JSON (the status + non-JSON gates are the FP controls — a 200 page, or a JSON API error, with these phrases is NOT gated):

```ts
const VERIFICATION_PHRASES = /verifying your browser|checking your browser|verify you are a human/i;
// "press and hold" is deliberately EXCLUDED (generic UI/hardware text — residual FP even
// under the 429/503 gate; the 3 phrases above cover the HashiCorp-class repro — critique M6).
hasVerificationPhrase:
  (status === 429 || status === 503)
  && !isJsonContentType(contentType)            // inlined in guarded-fetcher.ts (no app-layer import)
  && VERIFICATION_PHRASES.test(bodyHead),
```

- `detectAntibotBlock` checks `hasChallengeBody` BEFORE `hasVerificationPhrase`, so a vendor-marker wall co-occurring with a phrase still classifies as `captcha` (vendor-attributed wins).
- `stampAntibotChallenge` branches on the signal:
  - `verification-phrase` → `base.botVerification = true`; **does NOT set `challengeProvider`**; message `"browser-verification wall — fetched bytes are a bot-protection interstitial, not page content (#151)."`
  - `cf-mitigated` / `challenge-body` → `base.challengeProvider = challengeProvider(fetched.antibot)` (existing message).

### Domain + classification

- Add `Result.botVerification?: boolean` (mirrors `challengeProvider` at `src/domain/result.ts:120`).
- `classifyAccess` (`src/application/classify.ts`) — **branch order is pinned** (each wall kind is ≥400, so `bot_verification` MUST precede `http_error` or it is dead code — critique B2/H4/H5):

  ```
  botVerification          → gateReason:"bot_verification"   (NEW, first)
  challengeProvider        → gateReason:"captcha"
  code >= 400              → gateReason:"http_error"
  paywall / byte_cap / js-required / none
  ```
- Harden status-coincidental correctness (critique L13): `applyOutputMode`'s raw-gate (`src/application/use-cases/captatum.ts:~138`) and the content-quality skip guard ALSO check `result.botVerification` (today both fire only via `code>=400`).

The result still `gated:true` + the body returned (so the agent can read the wall text); render/transform skipped (the existing `isChallenge` short-circuit in `captatum.ts:~110`).

### Contract changes (contract-first)

- **`docs/contracts.md`** — (a) add `"bot_verification"` to the `access.gateReason` union (~:472); (b) **backfill `"captcha"` AND add `"bot_verification"`** in the gateReason prose (~:485 — the prose currently omits `captcha` entirely, a pre-existing gap — critique M10): `captcha` = "vendor-attributed challenge body/header, with the vendor in `challengeProvider`"; `bot_verification` = "a 429/503 whose body is a generic browser-verification interstitial, status-gated + non-JSON; `challengeProvider` absent (vendor not attributable)"; (c) fix the stale note (~:512-513): `captcha` IS emitted by the #41 detector (not "reserved, not yet emitted"); `bot_verification` is emitted by the #151 phrase detector. The inline union is on `AccessInfo.gateReason` at `classify.ts:15` (there is no exported `GateReason` type).
- **`docs/threat-model.md`** — note this is a **narrow curated deny-list** (not "allowlist") of literal challenge signatures (critique N18): detection (2) gated on 429/503 + non-JSON so a legitimate 429/503/JSON content page is not mis-gated; detection (1) = high-precision challenge-only vendor markers. Patterns are ReDoS-safe literal alternations (no quantifiers); body/phrase scans are bounded by the 4096-byte `bodyHead` cap, `CHALLENGE_COOKIE` by the requester's HTTP max-header-size (critique N17). **No new egress/SSRF surface** — classification over an already-`guardedFetch`-ed body only.

## Acceptance criteria (frozen suite — `test/acceptance/151/`, authored independently)

1. **DataDome CHALLENGE** (403, bodyHead has `captcha-delivery`) → `gated:true`, `gateReason:"captcha"`, `challengeProvider:"datadome"`.
1b. **DataDome FP guard:** a 200 protected page whose bodyHead has only `js.datadome.co/tags.js` (NO `captcha-delivery`) → NOT gated (`gateReason:"none"`/content).
2. **Imperva BLOCK** (403, bodyHead has `Incapsula incident ID`) → `gated:true`, `gateReason:"captcha"`, `challengeProvider:"imperva"`.
2b. **Imperva FP guard:** a 200 protected page whose bodyHead has only `/_Incapsula_Resource?SWJIYLWA=` (no incident-id) → NOT gated.
3. **HashiCorp 429 "verifying your browser"** → `gated:true`, `gateReason:"bot_verification"`, `challengeProvider` absent (the issue's repro).
4. **503 "checking your browser"** → `gated:true`, `gateReason:"bot_verification"`.
5. **Status-gate FP guard:** the SAME "verifying your browser" body at **200** → NOT gated.
6. **Content FP guard:** a 429 JSON error (no phrase, no marker) → NOT `bot_verification` (it's `http_error`).
6b. **JSON-gate FP guard:** a 429 `application/json` whose message contains "verifying your browser" → NOT gated as `bot_verification` (JSON gate).
7. **No regression:** Cloudflare (`cf-mitigated` / `cdn-cgi/challenge-platform`), Akamai (`_abck`), PerimeterX (`px-captcha`) → still `gateReason:"captcha"` with the right provider.
8a. **ReDoS SHAPE:** `CF_AKAMAI_PX_MARKERS`, `DATADOME_CHALLENGE`, `IMPERVA_BLOCK`, `VERIFICATION_PHRASES` each `.test()` a large crafted flood (bypassing `bodyHead`) completing under a ceiling with a LARGE/SMALL ratio `< LIN_RATIO` (mirrors `test/dos-extraction.test.ts`) — an adversarial flood that maximizes alternation-prefix churn.
8b. **4096 CAP:** a marker placed at byte offset > 4096 → `hasChallengeBody`/`hasVerificationPhrase` are `false` (the cap truncates before the marker).
9. **Ordering guard:** a 429 bot wall yields `gateReason:"bot_verification"`, NOT `http_error`.
10. **Raw-gate guard:** a `bot_verification` result is returned `output:"raw"` (not summarized) and is NOT double-stamped `low_value`/`app_error`.

**Verify bar (real-input, not fixtures alone):** reproduce `https://www.hashicorp.com/careers/open-positions` (429 "verifying your browser") end-to-end → `gated:true, gateReason:"bot_verification"`.

## Sibling sweep (required before review — critique-corrected)

- **Tier-2:** `stampAntibotChallenge` never runs on a Tier-2 result. Safety = `fetchAtsBoard` returns null on non-2xx / unparseable-JSON → Tier-1 fallthrough → `stampAntibotChallenge` runs on the Tier-1 fetch; `tier2Result` hardcodes `code:200`, so no Tier-2 result can carry a challenge code. (Conclusion: no gap; rationale corrected vs the draft.)
- **Single-fetch vs bulk:** a bot-wall seed in `captatum_bulk` surfaces as a `429` `fail` + an `antibot_challenge` warning whose message distinguishes vendor vs generic. The lean `BulkResult.results[]` envelope carries no distinct `gateReason` by design (widening it is not asked for by #151). No per-host behavior change.
- **GET vs non-GET:** the POST (#111) first-party fetch result is classified by `computeAntiBotEvidence` identically (status + body); a 429 on a POST also gates. No gap.

## Open questions (resolved by the critique)

1. **Phrase-set precision** → the 3 phrases (status-gated + non-JSON) are high-precision; "press and hold" dropped (M6).
2. **`bot_verification` vs reusing `captcha`** → distinct value (vendor-attributed vs generic-verification) is user-meaningful; confirmed.
3. **`challengeProvider` for `bot_verification`** → unset for the phrase-only case; a co-occurring DataDome/Imperva marker takes precedence (captcha) via `detectAntibotBlock` order.
4. **Status set** → 429 + 503 for the phrase gate (403 stays on the vendor-marker path — a 403 phrase would be a true block, but status-gating phrases at 403 is FP-prone and not needed for the repro).
