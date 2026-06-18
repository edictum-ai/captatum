# smart-fetch Test URL Suite

Run these against the pipeline to verify behavior. Update status after each fix.

## Verification harnesses (local, real network)

```bash
export PLAYWRIGHT_BROWSERS_PATH="$HOME/Library/Caches/ms-playwright"

# Single-URL diagnostic — dumps tier/title/structured/bytes/errors:
node --no-warnings src/dev/render-probe.ts "<url>" [--render] [--full]

# Full live suite — asserts every tier + the fixes against ground truth:
node --no-warnings src/dev/url-suite.ts
```

`url-suite.ts` is the "test everything" gate: Tier-1 SSR, Tier-3 true-shell render,
Fix 1 (allowRender=true keeps SSR at Tier-1), Fix 4 (render truncation advisory),
and SSRF rejection. It exits non-zero on any assertion failure.

## Category 1: Static SSR pages (Tier-1, no render)

| URL | Expected | Status |
|-----|----------|--------|
| `https://edictum.ai` | Tier-1, real content, jsRequired=false | ✅ working (Tier-1, ~0.2s) |
| `https://qratum.dev` | Tier-1, real content | ✅ working |

## Category 2: SSR + JSON-LD extraction (Tier-1, structured data)

| URL | Expected | Status |
|-----|----------|--------|
| `https://jobs.ashbyhq.com/langfuse/1bc2e248-89e7-41d7-b32f-08e9320eb5d0` | Tier-1, JobPosting JSON-LD | ✅ working |
| `https://jobs.ashbyhq.com/langfuse/f17768f8-525b-4caa-a8ee-5553a4ff4979` | Tier-1, JobPosting | ✅ working |
| `https://jobs.ashbyhq.com/e2b/ab44a84f-4467-438a-a26c-2420237c54e2` | Tier-1, JobPosting: Platform Engineer | ✅ working (title "Platform Engineer @ E2B") |

## Category 3: JS-rendered pages (Tier-3, needs allowRender=true)

| URL | Expected | Status |
|-----|----------|--------|
| `https://e2b.dev/careers?ashby_jid=ab44a84f-4467-438a-a26c-2420237c54e2` | **Now Tier-1** (see Fix 1 trade-off below) | ⚠️ Tier-1 marketing page — use the direct Ashby URL for the job |
| `https://angular.realworld.io/` | Tier-3 render (true empty SPA shell) | ✅ working (Tier-3, title "Conduit") |
| `https://vue-vuex-realworld.netlify.app/` | Tier-3 render → clean article feed | ✅ working (1089 chars, high signal) |
| `https://todomvc.com/examples/react/dist/` | Tier-3 render | ✅ working (thin by design — app loads empty) |

## Category 4: Anti-bot (wreq-js TLS fingerprint)

| URL | Expected | Status |
|-----|----------|--------|
| A Cloudflare-protected page | 200 + content | ❌ needs a test URL (note: HTTPS currently uses the Node requester — see contracts.md "P1 limitation"; wreq fingerprint is HTTP-only for now) |

## Category 5: Transform — summary accuracy

Requires `OPENROUTER_API_KEY` or `OLLAMA_BASE_URL`. Without a provider, summary
degrades to `output: raw` with `transform.provider: "none"`.

| URL | Input | Expected | Status |
|-----|-------|----------|--------|
| Ashby Langfuse job | `output: summary, prompt: "Extract title, salary, location"` | Summary matches JSON-LD fields | ⏳ verify with a configured provider |
| Any page | `output: summary` (default) | Concise summary using verified JSON-LD | ⏳ verify with a configured provider |

## Category 6: Transform — structured extraction

| URL | Input | Expected | Status |
|-----|-------|----------|--------|
| Ashby job | `output: extract, schema: { type: "object", properties: { title, salary, location } }` | JSON from JSON-LD; advisory on mismatch | ✅ schema validation is advisory (non-silent) |

## Category 7: Security (SSRF)

| URL | Expected | Status |
|-----|----------|--------|
| `http://127.0.0.1/` | FETCH_REJECTED | ✅ working |
| `http://169.254.169.254/latest/meta-data/` | FETCH_REJECTED | ✅ working |
| `http://[::ffff:127.0.0.1]/` | FETCH_REJECTED | ✅ working |
| `file:///etc/passwd` | Rejected at input validation | ✅ working |

## Fix outcomes (this session)

1. **allowRender bypass reverted** — SSR pages return to Tier-1 even when a client
   sends `allowRender=true` on every call. Ashby direct URLs: ~0.2s Tier-1 (was
   multi-second Tier-3). **Trade-off:** the `e2b.dev/careers?ashby_jid=…` wrapper
   is now Tier-1 (its static Webflow HTML has content → shell-gate stops). The
   embedded Ashby job is not fetched from the wrapper; use the direct Ashby URL.

2. **Title from JSON-LD** — a content-bearing JSON-LD node (JobPosting/Article/…)
   supplies the title when the page `<title>` is generic; keeps `<title>` when it
   already contains the JSON-LD title (richer).

3. **Rendered extraction quality** — **not a code bug.** Empirical probes show the
   hand-rolled extractor yields clean main content for content-rich SPAs (Vue
   RealWorld = clean article feed). "Thin" cases (empty TodoMVC, "no articles"
   Angular) are pages with genuinely thin content at render time. `defuddle`
   evaluated and **not added** (no justification; would expand untrusted-HTML surface).

4. **Render byte cap is advisory** — rendered HTML exceeding the cap is UTF-8-safely
   truncated with a non-fatal `max_bytes` note instead of rejecting the render.
   Default cap is 5 MB. The Tier-1 fetch-path cap stays a hard reject (bandwidth guard).

5. **Dead fixtures** — no dead fixture was present in this file (the 2captcha URL
   lived only in the handoff brief). Statuses refreshed to verified reality above.

## Test commands

```bash
# Via curl (direct endpoint, needs a bearer token on the hosted flavor)
curl -s -X POST https://smart-fetch.arnoldcartagena.com/mcp \
  -H "content-type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"jsonrpc":"2.0","method":"tools/call","id":1,"params":{"name":"smart_fetch","arguments":{"url":"<test-url>","output":"raw"}}}' \
  | python3 -m json.tool
```
