# Critique: #151 — Classify 429/DataDome/Imperva bot-verification walls as gated

- **Spec under review:** [`151-antibot-bot-verification.md`](151-antibot-bot-verification.md) (draft, pre-critique)
- **Method:** Independent 4-lens adversarial review (false-positives / control-flow correctness / ReDoS-DoS / contract-type), each lens reading the spec + live source (`antibot.ts`, `classify.ts`, `guarded-fetcher.ts`, `fetcher.ts` port, `result.ts`, `captatum.ts`, `shape.ts`, `bulk-seed.ts`, `tier2.ts`) blind to the others. Findings reconciled against `docs/contracts.md` + `docs/threat-model.md`.
- **Verdict:** **NOT implementable as drafted** — 2 blockers make the headline output (`gateReason:"bot_verification"`) unreachable and would frozen-encode a real-content false-positive. Both blockers + all highs are resolved below; the resolved design is what the frozen suite + impl target. No ReDoS hole; the contract change is additive (zero blast radius).

## Resolved design (the authoritative target after this critique)

Two additive detections at the anti-bot gating boundary (a trust boundary downstream callers trust):

**(1) Vendor challenge markers → existing `captcha` path** — extend `CHALLENGE_BODY_MARKERS` with **high-precision, challenge-only** signatures (status-INDEPENDENT, like the existing Cloudflare/Akamai/PerimeterX entries), NOT vendor names:
- DataDome: `captcha-delivery` (the challenge-delivery CDN host `ct.captcha-delivery.com`, inlined in the challenge page body; a *passing* page loads the SDK as an *external* `<script src="js.datadome.co/tags.js">`, so `captcha-delivery` is NOT in its `bodyHead`).
- Imperva: `incapsula incident id`, `powered by incapsula` (block/challenge-page body text; a *passing* page's inline `/_Incapsula_Resource?SWJIYLWA=` sensor is NOT one of these).
- **Dropped** the bare `datadome` (FP on every protected page's SDK tag) and bare `/_Incapsula_Resource` (FP on every protected page's inline sensor).
- Attribution: add per-vendor booleans `AntiBotEvidence.hasDataDomeBody` / `hasImpervaBody` (computed in `computeAntiBotEvidence` where `bodyHead` already lives); `challengeProvider()` branches on them → `"datadome"` / `"imperva"`.

**(2) Status-gated + non-JSON verification phrase → NEW `bot_verification` path:**
- Phrases (ReDoS-safe literal alternation): `verifying your browser|checking your browser|verify you are a human`. **"press and hold" dropped** (generic UI text; residual FP even under the status gate).
- Gate: `status ∈ {429,503}` AND `!isJsonContentType(contentType)` (no interstitial is JSON; closes the JSON-error-message FP at zero recall cost).
- New `AntiBotEvidence.hasVerificationPhrase`; `detectAntibotBlock` returns signal `"verification-phrase"` **checked AFTER `hasChallengeBody`** so a vendor-marker wall co-occurring with a phrase still classifies as `captcha` (vendor-attributed wins).

**Domain / flow:**
- Add `Result.botVerification?: boolean`.
- `stampAntibotChallenge` branches on the signal: `verification-phrase` → `base.botVerification = true`, **does NOT set `challengeProvider`**, message `"browser-verification wall — fetched bytes are a bot-protection interstitial, not page content (#151)."`; vendor signal → `base.challengeProvider = challengeProvider(...)`, existing message. (No `${undefined}` interpolation.)
- `classifyAccess` branch order is pinned: **`botVerification` → `challengeProvider`(captcha) → `code>=400`(http_error) → `paywall` → `byte_cap` → `js-required` → `none`**. `botVerification` MUST precede `http_error` (a 429/503 wall is ≥400) or it is dead code.
- Harden the status-coincidental correctness: `applyOutputMode`'s raw-gate (`captatum.ts`) and the content-quality skip guard also check `result.botVerification` (today they fire only via `code>=400`; making it explicit survives a future widening of the phrase status set to a non-4xx status).

**Contract:** `docs/contracts.md` — add `"bot_verification"` to the union (~:472); **backfill `"captcha"` AND add `"bot_verification"`** in the gateReason prose (~:485 — the prose currently omits `captcha` entirely, a pre-existing gap); fix the stale "captcha not yet emitted" note (~:512-513). `docs/threat-model.md` — a narrow **curated deny-list** (not "allowlist") of literal challenge signatures, gated on 429/503 + non-JSON for detection (2); detection (1) = high-precision challenge-only vendor markers. ReDoS-safe literal alternations; body/phrase scans bounded by the 4096-byte `bodyHead` cap, `CHALLENGE_COOKIE` by the requester's max-header-size. **No new egress/SSRF surface** (classification over an already-`guardedFetch`-ed body only).

**Sibling sweep (corrected):**
- Tier-2: `stampAntibotChallenge` never runs on a Tier-2 result — safety comes from `fetchAtsBoard` returning null on non-2xx / unparseable-JSON → Tier-1 fallthrough → `stampAntibotChallenge` runs on the Tier-1 fetch; `tier2Result` hardcodes `code:200`, so no Tier-2 result can carry a challenge code. Conclusion unchanged; rationale corrected.
- Bulk: a bot-wall seed surfaces as a `429` `fail` + an `antibot_challenge` **warning** (the warning *message* distinguishes vendor vs generic). The lean `BulkResult.results[]` envelope carries **no distinct `gateReason`** by design — corrected the over-stated spec claim (widening `BulkSeedResult` is not asked for by #151).
- GET vs non-GET: the POST (#111) first-party fetch result is classified by `computeAntiBotEvidence` identically (status + body), so a 429 on a POST also gates. No gap.

## Findings (ranked) + per-finding resolution

### BLOCKER B1 — bare `datadome` body marker FP's on every DataDome-protected passing page
- **Trigger:** a DataDome-protected site that PASSES for a residential/fingerprinted visitor returns 200 with normal content + `<script src="https://js.datadome.co/tags.js">` in `<head>` (DataDome's mandated integration). Bare `datadome` matches `js.datadome.co` in `bodyHead`.
- **Why it bites:** `hasChallengeBody` is status-INDEPENDENT → gates a 200 content page as `captcha` → silent content loss. Exactly the #44-class FP the existing comment (`guarded-fetcher.ts:172-175`) says the markers were chosen to avoid. AC #1 as drafted would frozen-encode the FP.
- **Resolution:** marker = `captcha-delivery` (challenge-delivery CDN; not in a passing page's `bodyHead`). Verify empirically + add a **negative** acceptance case (200 + `js.datadome.co/tags.js` + no `captcha-delivery` → NOT gated). *(FP lens)*

### BLOCKER B2 — `bot_verification` is unreachable
- **Trigger:** HashiCorp repro — 429 "verifying your browser", no vendor marker, no `cf-mitigated`.
- **Why it bites:** `stampAntibotChallenge` (`antibot.ts:48`) sets `base.challengeProvider = challengeProvider(e)` UNCONDITIONALLY; for a pure phrase `challengeProvider()` returns the truthy literal `"unknown"` (`:40`); `classifyAccess`'s FIRST branch (`classify.ts:114`) returns `gateReason:"captcha"`. AC #3 can never pass. The spec's "distinct error code `bot_verification`" alternative is impossible — `classifyAccess` never branches on error codes for gating.
- **Resolution:** pin ONE mechanism — `Result.botVerification?: boolean`. `stampAntibotChallenge` branches on the signal; `classifyAccess` gains `if (result.botVerification)` as its FIRST branch. Reject the error-code path explicitly. *(Correctness + Contract lenses)*

### HIGH H3 — `/_Incapsula_Resource` FP's on every Imperva-protected passing page
- **Trigger:** a passing Imperva-protected page (200) carries the inline `<script src="/_Incapsula_Resource?SWJIYLWA=…">` sensor; substring match gates it.
- **Resolution:** markers = `incapsula incident id` + `powered by incapsula` (block/challenge-page text only). Add a negative acceptance case (200 + `/_Incapsula_Resource?SWJIYLWA=` + no incident-id → NOT gated). *(FP lens)*

### HIGH H4/H5 — `bot_verification` branch must precede `code>=400 → http_error`
- **Why it bites:** every `bot_verification` wall is 429/503 (≥400); placed after `http_error` it is dead code and the wall is mislabeled `http_error` (the very mis-classification #151 exists to fix).
- **Resolution:** hard spec rule — order is `botVerification → captcha → http_error → paywall → byte_cap → js-required → none`. Acceptance test: a 429 bot wall yields `bot_verification`, NOT `http_error`. *(Correctness + Contract lenses)*

### MEDIUM M6 — "press and hold" is the weakest phrase
- **Resolution:** drop it. The 3 remaining phrases cover the HashiCorp-class repro with high precision. *(FP lens)*

### MEDIUM M7 — `challengeProvider()` can't attribute datadome/imperva from a single bool
- **Why it bites:** `hasChallengeBody` is one aggregate bool; AC #1/#2 (`challengeProvider:"datadome"/"imperva"`) need to know WHICH vendor matched, but `challengeProvider()` only reads cf/server signals.
- **Resolution:** add `hasDataDomeBody` / `hasImpervaBody`; `challengeProvider()` branches on them. Pinned as a required design step (the frozen suite asserts the exact provider strings). *(Correctness lens)*

### MEDIUM M8 — bulk does NOT surface `bot_verification` (spec claim false)
- **Resolution:** correct the claim — bulk surfaces a 429 bot wall as `fail` + an `antibot_challenge` warning (message distinguishes vendor vs generic); no `gateReason` in the lean `BulkResult` envelope by design. *(Correctness lens)*

### MEDIUM M9 — criterion 8 ("ReDoS-safe … linear time") is vacuous under the 4096 cap
- **Why it bites:** `bodyHead` is hard-capped at 4096 bytes, so any body-flood through `computeAntiBotEvidence` is trivially O(1) and passes for ANY regex shape — durable false confidence in a FROZEN suite.
- **Resolution:** split into 8a (SHAPE: test the regexes DIRECTLY over a large crafted flood bypassing `bodyHead`, ratio `< LIN_RATIO`, mirroring `dos-extraction.test.ts`) + 8b (CAP: a marker past byte 4096 is not detected). *(ReDoS lens)*

### MEDIUM M10 — `contracts.md:485` prose omits `captcha` already
- **Resolution:** the prose backfills BOTH `captcha` (pre-existing gap) and `bot_verification`. Explicit, numbered contract edit. *(Contract lens)*

### LOW L11 — phrase detector should require non-JSON body
- **Resolution:** gate the phrase detector on `!isJsonContentType(contentType)` (inlined in `guarded-fetcher.ts` to avoid an application-layer import). Zero recall loss. Acceptance case 6b. *(FP lens)*

### LOW L12 — Tier-2 sibling-sweep rationale was wrong
- **Resolution:** corrected above (real safety = `fetchAtsBoard` non-2xx fallthrough + `tier2Result` hardcoded 200). Conclusion unchanged. *(Correctness lens)*

### LOW L13 — raw-output + content-quality correctness is status-coincidental
- **Resolution:** harden both guards to also key on `result.botVerification`. *(Correctness lens)*

### LOW L14 — `stampAntibotChallenge` would emit `undefined` for the phrase case
- **Resolution:** branched message in B2's restructure. *(Contract lens)*

### LOW L15 — `hasVerificationPhrase` required breaks the test fixture builder
- **Resolution:** required (always computable); update `test/antibot.test.ts` helper + any literal. *(Contract lens)*

### NIT N16 — status-gate framing incomplete
- **Resolution:** the status gate controls detection (2) ONLY; detection (1)'s FP control is the precision of the (now challenge-only) marker strings. *(FP lens)*

### NIT N17 — `CHALLENGE_COOKIE` is the one family regex NOT capped to `bodyHead`
- **Resolution:** pre-existing + safe (single quantifier; bounded by the requester's HTTP max-header-size). Documented in the threat-model note. Cookies alone never gate (`detectAntibotBlock` ignores `hasChallengeCookie`). *(ReDoS lens)*

### NIT N18 — "allowlist" is a misnomer for a deny-list
- **Resolution:** reworded to "narrow curated deny-list." This is content-classification over an already-fetched body, not a trust-boundary permission — the allowlist-vs-blocklist rule does not strictly apply, and NO new egress/SSRF surface is introduced (confirmed: `computeAntiBotEvidence` inspects only already-`guardedFetch`-ed bytes). *(Contract lens)*

### NIT N19 — spec referenced a non-existent `GateReason` type
- **Resolution:** concrete targets — the inline union on `AccessInfo.gateReason` at `classify.ts:15`, the union at `contracts.md:~472`, the prose at `contracts.md:~485`. *(Contract lens)*
