# smart-fetch — Handoff Brief for Next Session

## Context

smart-fetch is deployed and working on AWS (ECS/Fargate + Cloudflare Tunnel + TiDB + OAuth + Cloudflare Access). Connected to both ChatGPT and Claude.ai. The core pipeline (fetch → extract → render → iframe capture → compact response) works end-to-end. 4/4 original URLs fetch content, but there are quality issues to fix.

**Deployed at:** `https://smart-fetch.arnoldcartagena.com/mcp`
**Latest image tag:** `d50a3c9`
**AWS profile:** `personal-arnold`
**SSO login needed:** `aws sso login --profile personal-arnold`

## Build + deploy cycle

```bash
cd /Users/acartagena/project/smart-fetch
export AWS_PROFILE=personal-arnold
corepack pnpm run check          # syntax + lines + typecheck
git add -A && git commit -m "fix: ..."
TAG=$(git rev-parse --short HEAD)
docker buildx build --platform linux/arm64 \
  -t 291807115868.dkr.ecr.eu-central-1.amazonaws.com/personal-memory-prod-smart-fetch:$TAG --push .
cd /Users/acartagena/project/personal-memory/personal-memory-infra/opentofu/envs/prod
tofu apply -var smart_fetch_desired_count=1 -var smart_fetch_image_tag=$TAG -auto-approve
aws ecs update-service --cluster personal-memory-prod-smart-fetch \
  --service personal-memory-prod-smart-fetch --force-new-deployment --profile personal-arnold
```

**IMPORTANT:** Always pass `-var smart_fetch_desired_count=1` to tofu apply (default is 0).

## 5 fixes needed (priority order)

### Fix 1: Revert the `allowRender` bypass (BIGGEST IMPACT)

**Problem:** `src/application/use-cases/render.ts` line 22 was changed from:
```ts
if (!input.result.jsRequired) return input.result;
```
to:
```ts
if (!input.request.allowRender && !input.result.jsRequired) return input.result;
```

This means when `allowRender=true` is passed (ChatGPT sends it on ALL calls), EVERY page renders via Playwright — even SSR pages that already have content. Result: all responses show `tier: 3` + 3s+ latency, when most should be `tier: 1` (instant JSON-LD extraction).

**Fix:** Revert to the original — the shell-gate (`jsRequired`) should be the arbiter, NOT `allowRender`. When the shell-gate says content is present, don't render (even if allowRender=true). When the shell-gate says shell, render (only if allowRender=true).

```ts
// REVERT to:
if (!input.result.jsRequired) return input.result;
```

**Impact:** Direct Ashby URLs return to Tier 1 (instant). Only JS-only pages (e2b wrapper, SPAs) hit Tier 3. ~10x faster for SSR pages.

**Trade-off:** The e2b wrapper URL (`e2b.dev/careers?ashby_jid=...`) has SOME visible content (company info) → shell-gate says "content present" → doesn't render → misses the Ashby job modal. This is a known limitation: the shell-gate can't detect "has SOME content but not the DESIRED content." The user must use the direct Ashby URL (`jobs.ashbyhq.com/e2b/{id}`) for the e2b case.

### Fix 2: E2B iframe extraction quality

**Problem:** When the render captures iframe content (the Ashby embed iframe), it appends the iframe HTML to the main page content:
```ts
// src/infrastructure/render/playwright-renderer.ts
let content = await page.content();
for (const frame of page.frames()) { ... content += "\n" + frameContent; }
```

The extractor then runs on this combined HTML. But the title/metadata from the iframe don't override the main page's title. Result: `title: "Careers — E2B"` instead of `"Platform Engineer @ E2B"`.

**Fix:** After combining main + iframe content, re-run structured-data extraction on the COMBINED HTML. If the iframe has its own JSON-LD JobPosting, use THAT for the title/structured fields (it's more specific than the main page's OG/meta). This is in the extraction pipeline (`src/infrastructure/extract/` or `src/application/use-cases/tier1-extract.ts`).

### Fix 3: Rendered-content extraction quality

**Problem:** For SPA-rendered pages (TodoMVC, Vue RealWorld, Angular RealWorld), the rendered DOM has the app content but the extractor produces weak/thin text. The Readability-style extraction doesn't handle React/Vue rendered DOMs well.

**Fix:** Improve the main-content extraction for rendered pages. Options:
- Add a `defuddle` dependency (MIT, the same one agent-smart-fetch uses) for better Readability-grade extraction from rendered DOMs.
- OR improve the hand-rolled extractor to handle common SPA patterns (app roots, virtual lists, dynamic content blocks).
- This is in `src/infrastructure/extract/html.ts` (the extractor).

### Fix 4: maxBytes — raise default or make advisory

**Problem:** The default `maxBytes: 250000` (250KB) is too small for some pages (the 2captcha Turnstile demo exceeds it). The response shows `errors: ["max_bytes advisory"]`.

**Fix:** Either:
- Raise the default to `500000` (500KB) in `src/application/use-cases/smart-fetch-input.ts` (`DEFAULT_SMART_FETCH_DEFAULTS.maxBytes`).
- OR make the byte cap advisory (truncate content instead of rejecting the whole response). When content exceeds maxBytes, slice it + add `[Content truncated at N bytes]` rather than returning an error.

### Fix 5: Remove dead fixtures from test-urls.md

**Problem:** `docs/test-urls.md` references a dead Cloudflare challenge fixture (2captcha.com/demo/cloudflare-challenge → 404).

**Fix:** Remove it from `docs/test-urls.md`. Update the status markers for all other URLs based on the latest test results.

## Follow-up items (not blocking, lower priority)

- **Cloudflare Access JWT code verification**: port personal-memory-gateway's `cloudflare-identity.ts` to smart-fetch so the OAuth `subject` comes from the verified CF Access JWT (currently `subject: "hosted-user"` for all). Code change + config env vars (`CF_ACCESS_ALLOWED_EMAIL`, `CF_ACCESS_AUDIENCE`, `CF_ACCESS_CERTS_URL`, `CF_ACCESS_ISSUER`).
- **Browser-as-a-reusable-module**: extract the Playwright integration into a standalone browser service (sidecar container with CDP endpoint). smart-fetch connects to it for Tier-3. The user can also connect via Chrome DevTools for debugging. Feature-by-feature evolution: render+extract → screenshot → click+navigate → automation.
- **Tier-2 adapters**: if the e2b wrapper case is important enough, build an Ashby adapter that detects `e2b.dev/careers?ashby_jid=...` → extracts the org alias from the embed script → hits the Ashby API directly (no render needed). Behind the `PlatformAdapter` port (already exists in the code).
- **Summary accuracy**: verify that the structured-data-in-transform fix works (JSON-LD fields prepended to the content sent to the OpenRouter model). The model should now report correct titles + salaries from the verified fields.

## Key files for the fixes

| Fix | File(s) |
|-----|---------|
| 1 (revert bypass) | `src/application/use-cases/render.ts` line 22 |
| 2 (iframe extraction) | `src/infrastructure/render/playwright-renderer.ts` (content capture) + `src/application/use-cases/tier1-extract.ts` (extraction) |
| 3 (rendered extraction) | `src/infrastructure/extract/html.ts` |
| 4 (maxBytes) | `src/application/use-cases/smart-fetch-input.ts` (`DEFAULT_SMART_FETCH_DEFAULTS`) |
| 5 (fixtures) | `docs/test-urls.md` |

## Test URLs (verified working / failing)

**Working (Tier 1 — instant JSON-LD, no render needed):**
- `https://jobs.ashbyhq.com/langfuse/1bc2e248-89e7-41d7-b32f-08e9320eb5d0`
- `https://jobs.ashbyhq.com/langfuse/f17768f8-525b-4caa-a8ee-5553a4ff4979`
- `https://jobs.ashbyhq.com/e2b/ab44a84f-4467-438a-a26c-2420237c54e2`
- `https://edictum.ai`

**Working with render (Tier 3 — needs allowRender=true):**
- `https://e2b.dev/careers?ashby_jid=ab44a84f-4467-438a-a26c-2420237c54e2` (iframe capture works, but title metadata wrong — Fix 2)
- `https://vue-vuex-realworld.netlify.app/`
- `https://angular.realworld.io/`
- `https://react-shopping-cart-67954.firebaseapp.com/`
- `https://todomvc.com/examples/react/dist/`
- `https://todomvc.com/examples/vue/dist/`

**SSRF (always blocked):**
- `http://127.0.0.1/`, `http://169.254.169.254/`, `http://[::ffff:127.0.0.1]/`, `file:///etc/passwd`

## Architecture quick reference

```
smart_fetch(url, {prompt?, output?, schema?, budget?, transform?, maxBytes?, timeoutMs?, allowRender?})
  0. guardedFetch(url)              ← rebinding-proof SSRF (node:https connect-to-IP)
  1. TIER-1  wreq-js fetch (TLS fingerprint, anti-bot) + raw-HTML extraction
               (JSON-LD / OG / meta / app-state) + shell-gate → done if content present
  2. TIER-3  Playwright render (if shell-gate says shell + allowRender=true)
             → 3s delay for widgets → iframe content capture → extract
  3. TRANSFORM (if configured)  OpenRouter/Ollama summarize|extract
  → compact response (content + provenance, no duplication)
```

- Tier-1 fetch = `wreq-js` (Rust-powered TLS/JA3 fingerprint impersonation → anti-bot bypass)
- Tier-3 render = Playwright Chromium (in the Docker image at `/ms-playwright/`, `chromiumSandbox: false`)
- Transform router = OpenRouter (dynamic /models discovery, free-first, feedback bandit, fallback chain)
- OAuth = gateway-owned (ES256 JWT, hashed codes/refresh, family revocation, CF Access on consent path)
- Storage = TiDB (mysql2, reusing personal-memory-infra's instance, `smartfetch` DB)
- Deployment = ECS/Fargate ARM64 + Cloudflare Tunnel + Cloudflare Access
