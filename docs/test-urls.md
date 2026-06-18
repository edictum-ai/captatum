# smart-fetch Test URL Suite

Run these against the deployed instance (`https://smart-fetch.arnoldcartagena.com/mcp`)
to verify behavior. Update status after each fix.

## Category 1: Static SSR pages (Tier-1, no render)

| URL | Expected | Status |
|-----|----------|--------|
| `https://edictum.ai` | Tier-1, real content, jsRequired=false | ✅ working |
| `https://qratum.dev` | Tier-1, real content | ✅ working |

## Category 2: SSR + JSON-LD extraction (Tier-1, structured data)

| URL | Expected | Status |
|-----|----------|--------|
| `https://jobs.ashbyhq.com/langfuse/1bc2e248-89e7-41d7-b32f-08e9320eb5d0` | Tier-1, JobPosting JSON-LD: title=Senior Cloud Infrastructure Engineer, salary=€90-160k | ✅ working |
| `https://jobs.ashbyhq.com/langfuse/f17768f8-525b-4caa-a8ee-5553a4ff4979` | Tier-1, JobPosting: Senior Product Engineer (Integrations) | ✅ working |
| `https://jobs.ashbyhq.com/e2b/ab44a84f-4467-438a-a26c-2420237c54e2` | Tier-1, JobPosting: Platform Engineer, CZK 150-300k/month | ✅ working |

## Category 3: JS-rendered pages (Tier-3, needs allowRender=true)

| URL | Expected | Status |
|-----|----------|--------|
| `https://e2b.dev/careers?ashby_jid=ab44a84f-4467-438a-a26c-2420237c54e2` | Tier-3 render → Ashby modal → Platform Engineer job | ⏳ verifying (chromiumSandbox fix deployed) |
| A pure React SPA (no SSR, no JSON-LD) | Tier-3 render → extracted content | ❌ needs a test URL |

## Category 4: Anti-bot (wreq-js TLS fingerprint)

| URL | Expected | Status |
|-----|----------|--------|
| A Cloudflare-protected page | 200 + content (wreq-js fingerprint bypasses challenge) | ❌ needs a test URL |

## Category 5: Transform — summary accuracy

| URL | Input | Expected | Status |
|-----|-------|----------|--------|
| Ashby Langfuse job | `output: summary, prompt: "Extract title, salary, location"` | Summary matches structured data: Senior Cloud Infrastructure Engineer, €90-160k, EU/remote | ⏳ verifying (structured data now in transform prompt) |
| Any page | `output: summary` (default) | Concise, accurate summary using verified JSON-LD fields | ⏳ verifying |

## Category 6: Transform — structured extraction

| URL | Input | Expected | Status |
|-----|-------|----------|--------|
| Ashby job | `output: extract, schema: { type: "object", properties: { title: {type:"string"}, salary: {type:"string"}, location: {type:"string"} } }` | JSON with title/salary/location from JSON-LD | ⏳ verifying (schema validation relaxed) |

## Category 7: Security (SSRF)

| URL | Expected | Status |
|-----|----------|--------|
| `http://127.0.0.1/` | FETCH_REJECTED | ✅ working |
| `http://169.254.169.254/latest/meta-data/` | FETCH_REJECTED | ✅ working |
| `http://[::ffff:127.0.0.1]/` | FETCH_REJECTED | ✅ working |
| `file:///etc/passwd` | Rejected at input validation | ✅ working |

## Known issues

1. **e2b.dev embedded Ashby**: the Webflow page loads the Ashby widget client-side.
   Render was crashing (chromiumSandbox=true on Fargate). Fix deployed (f50f3df).
   Needs verification: does the rendered modal contain the job?

2. **Summary accuracy**: the model was ignoring structured data (title/salary) and
   hallucinating. Fix deployed (f50f3df): JSON-LD fields now prepended to transform
   content with "prefer these verified fields." Needs verification.

3. **Extract schema**: validation was too strict (one missing field → raw fallback).
   Fix deployed (da9c6bb): validation is advisory. Needs verification.

4. **Tier provenance**: tier="error" appeared on successful fetches when render
   crashed. Root cause: chromiumSandbox crash. Fix deployed (f50f3df). Needs
   verification that tier is now correct (1 for SSR, 3 for render).

## Test commands

```bash
# Via ChatGPT/Claude.ai connector
# Just call smart_fetch with each URL + the expected options

# Via curl (for direct endpoint testing)
curl -s -X POST https://smart-fetch.arnoldcartagena.com/mcp \
  -H "content-type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"jsonrpc":"2.0","method":"tools/call","id":1,"params":{"name":"smart_fetch","arguments":{"url":"<test-url>","output":"raw"}}}' \
  | python3 -m json.tool
```
