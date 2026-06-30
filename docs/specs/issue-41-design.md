# #41 — HTTPS anti-bot via Tier-3 browser-fetch fallback

**Status:** spec (build-time blueprint). Source: 6-agent design + adversarial-security
workflow + codex review. **Verdict: go-with-changes** — SSRF-safe *if built to the
invariants below*. This is decision support and the build contract.

## Goal

Close the gap behind the product's #1 red flag: the anti-bot/TLS-fingerprint
advantage is HTTP-only; HTTPS uses a checked-IP Node path with no fingerprint, so
captatum does not beat Cloudflare/anti-bot over HTTPS (where most hard targets
are). When the Tier-1 HTTPS fetch comes back anti-bot-blocked, **retry the FETCH
through the Tier-3 browser** (`page.goto → page.content()`) — a real Chromium
TLS+JS identity passes challenges the Node path can't — and feed the resulting
HTML to the existing extractor.

This is a **FETCH retry that yields HTML**, not a new render-for-JS mode. It is
gated on detecting a real anti-bot block, and it must not widen the audit's #1
Tier-3 SSRF surface.

## Honest scope (do not overclaim, even after this ships)

- Handles **Chromium-passable** challenges (server-side JS/cookie challenges a real
  browser clears automatically).
- Does **not** help interactive-captcha challenges (hCaptcha/Turnstile/reCAPTCHA
  that need a human).
- Does **not** give the Node HTTPS path a TLS fingerprint.
- So the honest post-#41 claim is "fetches Chromium-passable challenge pages," not
  "fetch any HTTPS site." The MCP tool description (`schema.ts`) must reflect this.

## Build-time invariants (NON-NEGOTIABLE — each is a release blocker)

1. **SSRF: the retry reuses the existing `page.route` fetcher-fulfillment path** —
   `RenderRouteState` → `FetcherRouteFulfiller.resolve` → `fetchGuarded`, exactly
   as `render()` does. `route.continue()` is used nowhere; the browser never
   resolves/connects by name. The retry inherits the full Tier-3 SSRF posture for
   free. **Verify at build: no new egress primitive is introduced.**
2. **Server-controlled, not client-controlled.** The retry does NOT key off the
   client's `allowRender` (ChatGPT sends `allowRender=false`; keying on it would
   no-op the feature for the common caller). Gate it on a hosted env kill-switch
   (`CAPTATUM_ANTIBOT_BROWSER_RETRY`, server-side), with the client `allowRender`
   remaining the JS-render opt-in.
3. **Concurrency + rate-limit.** `fetchHtml()` MUST go through the existing render
   semaphore (`limitRenderConcurrency`, `render/index.ts`) — today it wraps only
   `render()`. Plus a per-task rate limit on browser-fetch retries (the detector
   is an amplification surface: attacker-served vendor headers could force a
   Chromium spawn per request).
4. **Vendor-attributed detection only.** Require a vendor-attributed signal
   (`cf-mitigated`, `x-px-captcha`, datadome cookie, `x-akamai-*`), NOT a forgeable
   `Server: cloudflare` + body tokens. Ship **negative fixtures** (ordinary
   403-auth / 503-unavailable / empty 4xx must NOT spawn a browser) as blocking tests.
5. **Buffer the body once.** `bodyStream` is one-shot (`tier1-extract.ts:41`
   consumes it). Detection peeks the head → buffer the full body once in
   `guarded-fetcher` (it is already in memory); detection reads the buffered head,
   extract reads the same buffer. Do NOT tee.
6. **Post-render challenge re-check.** `page.goto(domcontentloaded) + page.content()`
   may capture the challenge interstitial, not the cleared page. Re-run the detector
   on the rendered bytes; if it still matches → `outcome: "block"`,
   `gateReason: "captcha"`, surface the body only as advisory. **Never attest
   challenge HTML as a clean Tier-3 success.**
7. **Double-render short-circuit.** If the post-challenge page is a JS shell,
   `jsRequired=true` and `maybeRender` would fire a SECOND full render. Pass an
   explicit `antibotRetryPerformed` flag into `maybeRender` (do NOT key on
   `resolvedVia` — `extractTier1FromFetchResult` overwrites it at `tier1-extract.ts:74`).
8. **Retry URL is always `request.url`** (the `normalizeContractUrl`-sanitized URL),
   never anything parsed from the challenge body (following challenge-redirect
   text would be untrusted-data-as-control-flow).
9. **Curated `AntiBotEvidence`, not a raw header bag.** Expose typed boolean/enum
   fields (`serverVendor`, `hasCfMitigated`, `hasCfRay`, `hasDataDomeCookie`)
   computed in `guarded-fetcher`; the application layer never sees raw attacker
   headers. The log allow-list (`threat-model.md`) must not pick these up unless
   explicitly added.
10. **Budget bound.** Pass a residual `maxBytes` into the retry (subtract the
    Tier-1 bytes already spent) and a shared deadline; worst case =
    `timeoutMs + renderTimeoutMs` and ~2× `maxBytes`. Document this.

## Component changes

- `src/application/ports/fetcher.ts` — add `antibot?: AntiBotEvidence` to
  `FetcherResult`; define the curated `AntiBotEvidence` type.
- `src/infrastructure/http/guarded-fetcher.ts` — compute `AntiBotEvidence` from
  response headers in `finalResult()` (today it drops everything but contentType);
  buffer the body once.
- `src/application/use-cases/classify.ts` (or a new `antibot.ts`) — pure
  `detectAntibotBlock(fetched): { signal: string } | null` predicate (vendor-attributed).
- `src/application/ports/renderer.ts` — add `fetchHtml(input): Promise<RenderOutput>`
  to `RenderPort` (distinct from `render()`; no networkidle settle, no iframe concat).
- `src/infrastructure/render/index.ts` — wrap `fetchHtml` in the semaphore;
  `unavailableRenderer` gets a `fetchHtml` stub.
- `src/infrastructure/render/playwright-renderer.ts` — implement `fetchHtml()`
  (new `RenderRouteState`, `page.route("**/*", state.handle)`,
  `page.goto(url,{waitUntil:"domcontentloaded",timeout}) → page.content()`, the
  post-render challenge re-check, return a `FetcherResult`).
- `src/application/use-cases/captatum.ts` — between line 80 (fetch resolved) and
  line 87 (extract): detect → (https + kill-switch on + renderer present) →
  `renderer.fetchHtml()` → replace `fetched`; stamp provenance
  (`resolvedVia: "tier3-antibot-fallback"`, tier 3, distinct attempts); pass
  `antibotRetryPerformed` to `maybeRender`.
- `src/application/use-cases/render.ts` — short-circuit `maybeRender` when
  `antibotRetryPerformed`.
- `src/config.ts` — `CAPTATUM_ANTIBOT_BROWSER_RETRY` (server kill-switch) + the
  per-task retry rate limit.
- `docs/threat-model.md` — the two-fetch content-fidelity TOCTOU (not SSRF;
  per-fetch guard-revalidated), the amplification-surface note, the honest scope.

## Test plan (the #46 lesson: green unit ≠ fixed)

- **Unit fixtures** (no browser): mock anti-bot 403/503 responses — (a) Cloudflare
  challenge (cf-mitigated + "Just a moment" body), (b) Akamai/PerimeterX/DataDome,
  (c) **negatives**: plain 403-auth, 503-service-unavailable, empty 4xx — assert
  the detector fires only on (a)/(b), never (c). Assert `fetchHtml` is NOT called
  on negatives or when the kill-switch is off.
- **SSRF unit**: assert `fetchHtml` constructs a `RenderRouteState` and installs
  `page.route` (i.e. routes through the guard, never `route.continue`).
- **Post-render honesty**: a fixture where the rendered bytes STILL match the
  challenge → assert `outcome:"block"`, `gateReason:"captcha"`, no clean Tier-3 attestation.
- **Double-render**: assert a JS-shell post-challenge body does NOT trigger a
  second `render()`.
- **End-to-end ×N on a REAL Cloudflare-challenge HTTPS page** (the gate): N≥5
  consecutive calls return real content (not the challenge interstitial),
  `resolvedVia:"tier3-antibot-fallback"`, `access:"public"`. **Needs a genuine
  challenge-gated test URL** (not a Cloudflare-*hosted* page). This is the
  #46-standard verification — unit + gate tests do not substitute.

## Open decisions (need from owner)

1. **The challenge-gated HTTPS test URL** for end-to-end verification (or
   confirmation to research/select one).
2. **Kill-switch default**: `CAPTATUM_ANTIBOT_BROWSER_RETRY` default ON (fixes the
   common caller; requires the concurrency+rate-limit infra live) or OFF (safe
   opt-in; doesn't fix the common case until enabled). Needed at deploy.
