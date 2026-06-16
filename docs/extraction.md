# Tier-1 extraction behavior

Tier-1 extraction is deterministic and runs on the guarded fetch body before any
optional render or transform step. Fetched HTML is untrusted data: extracted text
and embedded JSON may become result data, but never instructions.

## Extracted fields

- `<title>` becomes `Result.title`.
- `<link rel="canonical">` becomes `Result.structured.canonicalUrl`.
- `<script type="application/ld+json">` becomes `Result.structured.jsonLd`.
- Open Graph `<meta property="og:*">` becomes `Result.structured.og`.
- Twitter and generic `<meta name="...">` become `Result.structured.meta`.
- `__NEXT_DATA__` and `__INITIAL_STATE__` become `Result.structured.appState`.

Embedded JSON is parsed with a safe reviver. `__proto__`, `constructor`, and
`prototype` keys are ignored and reported as `unsafe_json_key`; invalid embedded
JSON reports a stable extraction error such as `invalid_json_ld` or
`invalid_app_state` without returning parser internals.

## Shell gate

The shell gate returns explicit evidence for later orchestration:

- `structured-data-found` — usable JSON-LD, app state, OG, or meaningful meta was
  found; `jsRequired` is false.
- `content-present` — visible body text is sufficient; `jsRequired` is false.
- `empty-spa-shell` — no usable structure or visible content was found;
  `jsRequired` is true so a later tier can decide whether to render.

Low-value metadata such as only `viewport` is preserved in `Result.structured`,
but it does not by itself satisfy the shell gate.

## Local fixtures

The deterministic fixture set lives in `test/fixtures/extract/`:

- `json-ld.html`
- `og-meta.html`
- `app-state.html`
- `spa-shell.html`
- `content-page.html`
- `prototype-pollution.html`
- `malformed.html`
