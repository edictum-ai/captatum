# Spec: #151 — Classify 429/DataDome/Imperva bot-verification walls as gated

- **Issue:** [#151](https://github.com/edictum-ai/captatum/issues/151)
- **Tier:** T2 (classifies untrusted response bodies at a security-relevant gating boundary — a decision downstream callers trust; touches a trust boundary, not a parser over untrusted input)
- **Status:** Draft (awaiting independent critique → `151-antibot-bot-verification.critique.md`)
- **Contract section affected:** `docs/contracts.md` `access.gateReason` union (+ the stale "captcha not yet emitted" note at line 512-513); `docs/threat-model.md` anti-bot-detection boundary
- **Spec trailer for downstream PRs:** `Spec: docs/specs/151-antibot-bot-verification.md`

## Problem

Make + Glassdoor are correctly `gated:true, gateReason:"captcha", challengeProvider:"cloudflare"`. But:
- **HashiCorp** (`https://www.hashicorp.com/careers/open-positions`) returns **429 "We're verifying your browser"** and is NOT classified as gated (passes through as content).
- **DataDome / Imperva (Incapsula)** challenge bodies are not recognized (no markers).

## Root cause (verified against `origin/main` @ `b2321f3`)

- `CHALLENGE_BODY_MARKERS` (`src/infrastructure/http/guarded-fetcher.ts:176`) = `/cdn-cgi\/challenge-platform|__cf_chl|cf-browser-verification|akamaighost|_abck|px-captcha|\/_px\//i` — covers Cloudflare/Akamai/PerimeterX only. **Missing DataDome** (`datadome`, `ddjs_key`, `/_dd/`) and **Imperva/Incapsula** (`/_Incapsula_Resource`).
- There is no **status-gated verification-phrase** detector: a 429/503 whose body is a generic "verifying your browser" interstitial (no vendor marker) is not recognized. `detectAntibotBlock` (`src/application/antibot.ts:26`) fires only on `hasCfMitigated`/`hasChallengeBody`.
- Flow today: `computeAntiBotEvidence` → `detectAntibotBlock` → `stampAntibotChallenge` sets `base.challengeProvider` → `classifyAccess` (`src/application/classify.ts:115`) maps a truthy `challengeProvider` to `gateReason:"captcha"`. There is no path to a distinct `bot_verification` classification.

## Design

Two additive, independent detections:

### (1) DataDome / Imperva body markers → existing `captcha` path

Extend `CHALLENGE_BODY_MARKERS` with vendor-specific markers:
```ts
const CHALLENGE_BODY_MARKERS = /cdn-cgi\/challenge-platform|__cf_chl|cf-browser-verification|akamaighost|_abck|px-captcha|\/_px\/|\/_Incapsula_Resource|datadome|ddjs_key|\/_dd\//i;
```
These are vendor-specific (like the existing entries) → `hasChallengeBody` → the existing `captcha` path. Extend `challengeProvider()` (`antibot.ts:35`) to attribute `datadome` (cookie/body marker) and `imperva`/`incapsula` (already partly handled via `serverVendor`) so the receipt names the vendor.

### (2) Status-gated verification-phrase → NEW `bot_verification` path

A new `AntiBotEvidence` field, computed **only when status ∈ {429, 503}** (the status gate is the FP control — a 200 page with these phrases is NOT gated):
```ts
hasVerificationPhrase: status === 429 || status === 503
  ? VERIFICATION_PHRASES.test(bodyHead)
  : false,
```
where `VERIFICATION_PHRASES` is a high-precision literal alternation (ReDoS-safe — no quantified backtracking):
```ts
const VERIFICATION_PHRASES = /verifying your browser|checking your browser|verify you are a human|press and hold/i;
```
- `detectAntibotBlock` returns a **distinct signal** `{ signal: "verification-phrase" }` for this case (vs `cf-mitigated`/`challenge-body`).
- `stampAntibotChallenge` records the signal type; for `verification-phrase` it does NOT set `challengeProvider` (the vendor is unknown/generic) but marks the result so `classifyAccess` emits `gateReason:"bot_verification"` (e.g. a `base.botVerification` flag or a distinct error code `bot_verification`).
- `classifyAccess` (`classify.ts:~115`): if the challenge was a verification-phrase → `gateReason:"bot_verification"`; else (vendor marker) → `gateReason:"captcha"`.

The result still `gated:true` + the body returned (so the agent can read the wall text), render/transform skipped (the existing `isChallenge` short-circuit in `captatum.ts:110`).

### Contract changes (contract-first)

- **`docs/contracts.md`** (`access.gateReason` union, line 471 + the `GateReason` type description ~484): add `"bot_verification"` — "a 429/503 whose body is a generic browser-verification interstitial (e.g. 'verifying your browser'), status-gated; the vendor is not always attributable." Update the type union in `classify.ts:15` to match.
- **Fix the stale note** (contracts.md:512-513): "`gateReason: 'captcha'` is reserved … not yet emitted (no detector)" is WRONG — the #41 detector emits it. Correct it: `captcha` is emitted for vendor-attributed challenge bodies/headers; `bot_verification` for status-gated verification phrases.
- **`docs/threat-model.md`**: note the status-gated phrase detector is an **allowlist of high-precision challenge signatures** (not a broad blocklist), gated on 429/503, so a legitimate 429/503 content page is NOT mis-gated. Patterns are literal alternations (ReDoS-safe). No new egress/SSRF surface.

## Acceptance criteria (frozen suite — `test/acceptance/151/`, authored independently)

1. **DataDome body** (200 or 403, body contains `datadome`/`ddjs_key`) → `gated:true`, `gateReason:"captcha"`, `challengeProvider:"datadome"`.
2. **Imperva body** (`/_Incapsula_Resource`) → `gated:true`, `gateReason:"captcha"`, `challengeProvider:"imperva"`.
3. **HashiCorp 429 "verifying your browser"** → `gated:true`, `gateReason:"bot_verification"` (the issue's repro).
4. **503 "checking your browser"** → `gated:true`, `gateReason:"bot_verification"`.
5. **Status-gate FP guard:** the SAME "verifying your browser" body at **200** → NOT gated (`gateReason:"none"` or content path) — the phrase alone must not gate.
6. **Content FP guard:** a 429 whose body is legit content with NO phrase + NO vendor marker (e.g. a real 429 JSON error) → NOT gated as a bot wall (it's `http_error`, not `bot_verification`).
7. **No regression:** Cloudflare (`cf-mitigated` / `cdn-cgi/challenge-platform`), Akamai (`_abck`), PerimeterX (`px-captcha`) → still `gateReason:"captcha"` with the right provider.
8. **ReDoS-safe:** a 429 body flood of the phrase markers completes in linear time (extend the marker-test timing family — literal alternation, no backtracking).

**Verify bar (real-input, not fixtures alone):** reproduce `https://www.hashicorp.com/careers/open-positions` (429 "verifying your browser") end-to-end → `gated:true, gateReason:"bot_verification"`. (Live HashiCorp may intermittently not challenge; capture a real challenge response or a faithful fixture of one.)

## Sibling sweep (required before review)

- The detection runs in `computeAntiBotEvidence` (Tier-1 fetch) — confirm Tier-2 adapters and Tier-3 render don't need a parallel check (they go through the fetcher; the gate is at the fetch result).
- Single-fetch vs bulk: the antibot gate is per-seed (each seed's fetch result is classified) — confirm the bulk path surfaces `bot_verification` per-seed (no per-host behavior change).
- GET vs non-GET render: the gate is on the initial fetch result; a POST first-party body (#111) fetch result is also classified — confirm no gap.

## Open questions for the critique

1. **Phrase-set precision:** are the 4 phrases (`verifying your browser`, `checking your browser`, `verify you are a human`, `press and hold`) high-precision given the 429/503 status gate? Any legitimate 429/503 page that contains one (FP)? The status gate + literal match should minimize it, but the critique should hunt for an FP.
2. **`bot_verification` vs reusing `captcha`:** the issue asks for a distinct `bot_verification`. Confirm a distinct value is right (vs `captcha` with an unknown provider) — the distinction (vendor-attributed vs generic-verification) is user-meaningful.
3. **challengeProvider for bot_verification:** leave unset (vendor unknown) or attribute when a marker IS present? Proposal: leave unset for the pure-phrase case; if a DataDome/Imperva marker co-occurs, the vendor-marker path (captcha) takes precedence.
4. **Status set:** 429 + 503 only, or also 403 (some DataDome walls are 403)? Proposal: 403 stays on the vendor-marker path (no phrase status-gate at 403 — too FP-prone); only 429/503 get the phrase gate.
