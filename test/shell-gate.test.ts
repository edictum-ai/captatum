import assert from "node:assert/strict";
import { test } from "node:test";
import type { StructuredData } from "../src/domain/platform.ts";
import { extractHtml, hasUsableStructuredData } from "../src/infrastructure/extract/index.ts";

// #81: an empty / trivial JSON-LD block ([], {}, null, or a context-only node) must NOT
// satisfy the shell-gate. Otherwise a client-rendered SPA that ships one stops at Tier-1
// and returns EMPTY content instead of rendering. These drive the real extractHtml path
// (HTML in → gate decision out), not a hand-mocked structured object.

test("shell-gate: empty JSON-LD does not stop an empty SPA shell from rendering (#81)", () => {
  const shell = '<html><body><div id="root"></div><script type="application/ld+json">[]</script></body></html>';
  const gate = extractHtml({ html: shell, url: "https://spa.test/" }).shellGate;
  assert.equal(gate.jsRequired, true, "empty ld+json array must not satisfy the gate");
  assert.equal(gate.reason, "empty-spa-shell");
});

test("shell-gate: context-only JSON-LD does not stop an empty SPA shell (#81)", () => {
  const shell = '<div id="root"></div><script type="application/ld+json">{"@context":"https://schema.org"}</script>';
  assert.equal(extractHtml({ html: shell, url: "https://spa.test/" }).shellGate.jsRequired, true);
});

test("shell-gate: real typed JSON-LD still resolves at Tier-1, no render (#81 regression guard)", () => {
  const html = '<html><body><div id="root"></div><script type="application/ld+json">'
    + '{"@context":"https://schema.org","@type":"JobPosting","title":"Engineer"}</script></body></html>';
  const gate = extractHtml({ html, url: "https://spa.test/" }).shellGate;
  assert.equal(gate.jsRequired, false);
  assert.equal(gate.reason, "structured-data-found");
});

test("shell-gate: real body text + empty JSON-LD resolves via content-present, no render (#81)", () => {
  const html = "<html><body><article>" + "Real visible article content here. ".repeat(5)
    + '</article><script type="application/ld+json">[]</script></body></html>';
  const gate = extractHtml({ html, url: "https://x.test/" }).shellGate;
  assert.equal(gate.jsRequired, false);
  assert.equal(gate.reason, "content-present");
});

// #144: a no-landmark SPA whose static HTML carries ONLY nav/aside chrome (no <main>/<article>,
// no real body) must escalate to render, not ship the nav menu as "content". The Jira REST v3
// repro: 13,630 chars of chrome crossed hasContent's threshold → "content-present" → no render.
test("shell-gate: a no-landmark SPA whose static HTML is only nav/aside chrome escalates to render (#144)", () => {
  const html = '<html><head><title>Developer Documentation</title></head><body>'
    + '<nav><a>Documentation</a><a>Resources</a><a>News and Updates</a><a>Get Support</a><a>Sign in</a></nav>'
    + '<aside><h2>REST API v3</h2><a>About</a><a>Version</a><a>Authentication</a><a>Endpoints</a></aside>'
    + '<div id="root"></div></body></html>';
  const gate = extractHtml({ html, url: "https://jira.test/rest/v3/intro" }).shellGate;
  assert.equal(gate.jsRequired, true, "chrome-only no-landmark SPA must escalate to render");
  assert.equal(gate.reason, "empty-spa-shell");
});

test("shell-gate: a no-landmark page with REAL body content (outside chrome) still resolves, no render (#144)", () => {
  // stripChrome removes aside/nav/footer but keeps the real body text — a legit no-landmark page
  // with substantial content must NOT be falsely escalated (regression guard for the #144 fix).
  const html = '<html><body>'
    + '<nav><a>Home</a><a>About</a></nav>'
    + '<div><p>' + "This is the real article body content, substantial and complete. ".repeat(3) + '</p></div>'
    + '<footer><a>Privacy</a></footer>'
    + '</body></html>';
  const gate = extractHtml({ html, url: "https://x.test/post" }).shellGate;
  assert.equal(gate.jsRequired, false, "real no-landmark body content must not be escalated");
});

test("shell-gate: a literal <nav> inside a <script> does not delete the real body (#160 codex)", () => {
  // stripChrome must run AFTER scripts are stripped — else the script's "<nav>" string pairs with a
  // later </nav> and deletes the intervening real body → a false shell-gate escalation.
  const html = '<html><body>'
    + '<script>const tpl = "<nav>menu</nav>";</script>'
    + '<div><p>' + "The real article body, substantial and complete. ".repeat(3) + '</p></div>'
    + '<nav><a>Home</a></nav>'
    + '</body></html>';
  const gate = extractHtml({ html, url: "https://x.test/p" }).shellGate;
  assert.equal(gate.jsRequired, false, "a script's <nav> string must not delete the real body");
});

test("shell-gate: a fake <nav> in a comment or <style> does not delete the real body (#160 codex)", () => {
  // The raw-chrome fallback pre-cleans comments + style BEFORE stripping chrome, so a fake opener
  // inside <!-- <nav> --> or <style>...</style> can't pair with a later real </nav> (#160 codex r2).
  const commented = '<html><body>'
    + '<!-- <nav>commented out</nav> -->'
    + '<div><p>' + "The real article body, substantial and complete. ".repeat(3) + '</p></div>'
    + '<nav><a>Home</a></nav>'
    + '</body></html>';
  assert.equal(extractHtml({ html: commented, url: "https://x.test/c" }).shellGate.jsRequired, false, "a comment's <nav> must not delete the body");
  const styled = '<html><head><style>.x::after { content: "<nav>fake</nav>" }</style></head><body>'
    + '<div><p>' + "The real article body, substantial and complete. ".repeat(3) + '</p></div>'
    + '<nav><a>Home</a></nav>'
    + '</body></html>';
  assert.equal(extractHtml({ html: styled, url: "https://x.test/s" }).shellGate.jsRequired, false, "a <style>'s <nav> must not delete the body");
});

test("shell-gate: a chrome <h2>/<p> outside the text scope doesn't satisfy hasContent (#160 codex r3)", () => {
  // A no-landmark SPA whose stripped body is a short placeholder (20-79 chars) but whose removed
  // chrome carries an <h2>: hasContent's tag-check must run on the STRIPPED scope, not the full
  // page, else the chrome tag satisfies it and the shell skips render (returns only the placeholder).
  const html = '<html><body>'
    + '<nav><h2>REST API v3</h2><a>About</a></nav>'
    + '<div id="root">Loading documentation shell</div>'
    + '</body></html>';
  const gate = extractHtml({ html, url: "https://jira.test/rest" }).shellGate;
  assert.equal(gate.jsRequired, true, "a chrome h2 outside the scope must not satisfy hasContent");
});

test("shell-gate: a short legitimate <article> (no inner tags) resolves, not falsely escalated (#160 codex r4)", () => {
  // A selected landmark IS content even if short + tagless — the scope is the article's INNER html
  // (no <article> wrapper), so hasContent must not require the tag-check for it.
  const html = '<html><body><article>Short but legitimate article body.</article></body></html>';
  const gate = extractHtml({ html, url: "https://x.test/a" }).shellGate;
  assert.equal(gate.jsRequired, false, "a short selected <article> must not be falsely escalated");
});

test("shell-gate: a literal <nav> in a <title> doesn't delete the real body (#160 codex r5/r6)", () => {
  // A malformed-but-tolerated <title>HTML <nav> element guide</title> (RCDATA) — stripChromeFromRaw
  // extracts <body> (excluding head/title) before chrome so the title's <nav> can't mis-pair with a
  // later </nav>. Covers BOTH an explicit </head> AND an omitted </head> (valid HTML — the body
  // extraction pairs on <body>, not </head>) (#160 codex r5/r6).
  const realBody = '<div><p>' + "The real article body, substantial and complete. ".repeat(3) + '</p></div><nav><a>Home</a></nav>';
  const closedHead = '<html><head><title>HTML <nav> element guide</title></head><body>' + realBody + '</body></html>';
  assert.equal(extractHtml({ html: closedHead, url: "https://x.test/t1" }).shellGate.jsRequired, false, "a title's <nav> (closed head) must not delete the body");
  const omittedHeadClose = '<html><head><title>HTML <nav> element guide</title><body>' + realBody + '</body></html>';
  assert.equal(extractHtml({ html: omittedHeadClose, url: "https://x.test/t2" }).shellGate.jsRequired, false, "a title's <nav> (omitted </head>) must not delete the body");
  // r7: a title with BOTH a fake <body> AND <nav> — inert blocks are stripped BEFORE body extraction
  // so the fake <body> isn't selected + the fake <nav> can't mis-pair.
  const fakeBodyInTitle = '<html><head><title>HTML <body> and <nav> element guide</title></head><body>' + realBody + '</body></html>';
  assert.equal(extractHtml({ html: fakeBodyInTitle, url: "https://x.test/t3" }).shellGate.jsRequired, false, "a title's fake <body>/<nav> must not be selected/mis-paired");
});

test("shell-gate: an UNTERMINATED <nav> (no close) doesn't satisfy hasContent (#160 codex r8)", () => {
  // A malformed-but-tolerated <nav> with no </nav> extends to </body> (browser auto-close); its
  // content is chrome. stripChrome now strips it to end (stripUnterminated), so a JS-only shell
  // with unterminated nav chrome escalates instead of shipping the nav as content.
  const html = '<html><body>'
    + '<nav><h2>REST API v3</h2><a>About</a><a>Authentication</a>'
    + '<div id="root"></div>'  // the article is JS-only; root is the empty app mount (inside the nav per the browser)
    + '</body></html>';
  const gate = extractHtml({ html, url: "https://jira.test/rest" }).shellGate;
  assert.equal(gate.jsRequired, true, "an unterminated <nav> must not satisfy hasContent");
});

test("shell-gate: real content BEFORE an unterminated <nav> is preserved, not dropped (#160 codex r9)", () => {
  // stripUnterminated must keep the text before the malformed chrome tag — <div><p>real body</p></div><nav>...
  // (unterminated) resolves (the real body survives), not falsely escalate to render.
  const html = '<html><body>'
    + '<div><p>' + "The real article body, substantial and complete. ".repeat(3) + '</p></div>'
    + '<nav><a>Home</a><a>About</a>'  // unterminated — no </nav>
    + '</body></html>';
  assert.equal(extractHtml({ html, url: "https://x.test/u" }).shellGate.jsRequired, false, "content before an unterminated <nav> must survive");
});

test("shell-gate: NESTED chrome (<nav>…<nav>…</nav>…</nav>) doesn't leave leftover chrome (#160 codex r10)", () => {
  // A non-nesting-aware strip pairs the outer <nav> open with the inner </nav> close, leaving the
  // outer nav's trailing chrome (>= 80 chars) in the scope → hasContent → no render. The nesting-
  // aware stripChromeElement pairs the outer open with its MATCHING close (depth-aware) → no leftover.
  const html = '<html><body>'
    + '<nav>menu<nav>sub</nav>' + "chrome text ".repeat(10) + '</nav>'  // nested nav; trailing chrome crosses the threshold
    + '<div id="root"></div>'
    + '</body></html>';
  const gate = extractHtml({ html, url: "https://x.test/n" }).shellGate;
  assert.equal(gate.jsRequired, true, "nested <nav> must not leave leftover chrome that satisfies hasContent");
});

test("shell-gate: a comment with <title> doesn't mis-pair + drop the real body (#160 codex r11)", () => {
  // stripHtmlComments must run BEFORE stripElement("title") — else the comment's <title> pairs with
  // the real </title>, removing the comment terminator → stripHtmlComments drops the rest → empty.
  const html = '<html><head><!-- <title> --><title>Real Title</title></head><body>'
    + '<div><p>' + "The real article body, substantial and complete. ".repeat(3) + '</p></div>'
    + '<nav><a>Home</a></nav>'
    + '</body></html>';
  assert.equal(extractHtml({ html, url: "https://x.test/c" }).shellGate.jsRequired, false, "a comment's <title> must not mis-pair + drop the body");
});

test("shell-gate: a script with legacy <!-- doesn't truncate the real body (#160 codex r12)", () => {
  // Scripts must be stripped BEFORE comments — a legacy `<!--` inside a <script> (no -->) would
  // make stripHtmlComments truncate at the marker, dropping the real body.
  const html = '<html><head><script><!--\nvar x = 1;\n</script></head><body>'
    + '<div><p>' + "The real article body, substantial and complete. ".repeat(3) + '</p></div>'
    + '<nav><a>Home</a></nav>'
    + '</body></html>';
  assert.equal(extractHtml({ html, url: "https://x.test/s" }).shellGate.jsRequired, false, "a script's <!-- must not truncate the body");
});

test("shell-gate: a comment with <script> doesn't mis-pair + drop the real body (#160 codex r13)", () => {
  // The context-aware stripInert scanner processes comments + scripts in document order — a
  // <script> inside a comment is never seen (the comment is stripped first). The 3-phase order
  // (scripts before comments) would mis-pair the comment's <script> with the real </script>.
  const html = '<html><head><!-- <script> --></head><body>'
    + '<script>var x = 1;</script>'
    + '<div><p>' + "The real article body, substantial and complete. ".repeat(3) + '</p></div>'
    + '<nav><a>Home</a></nav>'
    + '</body></html>';
  assert.equal(extractHtml({ html, url: "https://x.test/cs" }).shellGate.jsRequired, false, "a comment's <script> must not mis-pair + drop the body");
});

// #109 (dual of #81): a SCAFFOLDING JSON-LD node — WebPage/WebSite/… page metadata with an EMPTY
// description — must NOT satisfy the shell-gate. JetBrains/Writerside ship these as routing metadata
// on client-rendered shells; treating them as content let the shell stop at Tier-1 and return no
// content. A scaffolding node counts only when it carries a non-empty content property.

test("shell-gate: scaffolding WebPage JSON-LD with an empty description does not stop an empty shell (#109)", () => {
  const shell = '<html><body><div id="root"></div>'
    + '<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebPage","name":"IntelliJ Platform SDK","description":"","url":"https://x.test/p"}</script>'
    + '</body></html>';
  const gate = extractHtml({ html: shell, url: "https://x.test/p" }).shellGate;
  assert.equal(gate.jsRequired, true, "scaffolding WebPage (empty description) must not satisfy the gate");
  assert.equal(gate.reason, "empty-spa-shell");
});

test("shell-gate: WebPage JSON-LD WITH a real description still resolves at Tier-1 (#109 regression guard)", () => {
  const html = '<html><body><div id="root"></div>'
    + '<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebPage","description":"A real page summary an agent can use without rendering."}</script>'
    + '</body></html>';
  const gate = extractHtml({ html, url: "https://x.test/p" }).shellGate;
  assert.equal(gate.jsRequired, false);
  assert.equal(gate.reason, "structured-data-found");
});

test("hasUsableStructuredData: scaffolding-only nodes need a non-empty content property (#109)", () => {
  const notUsable: unknown[] = [
    { "@type": "WebPage", name: "X", description: "" },
    { "@type": "https://schema.org/WebPage", name: "X", description: "" }, // full-IRI form (codex P2)
    { "@type": "https://schema.org/WebPage/", name: "X", description: "" }, // trailing-slash IRI (codex P2 #2)
    { "@type": "WebSite", name: "X Help", url: "https://x.test/" },
    { "@type": "BreadcrumbList", itemListElement: [{ "@type": "ListItem", name: "Home" }] },
    { "@type": ["WebPage"], name: "x" },
    { "@type": "WebPage", mainEntityOfPage: "https://x.test/a" }, // URL reference, not inline content
  ];
  for (const jsonLd of notUsable) {
    assert.equal(hasUsableStructuredData({ jsonLd } as StructuredData), false, `scaffolding not usable: ${JSON.stringify(jsonLd)}`);
  }
  const usable: unknown[] = [
    { "@type": "WebPage", description: "Real summary." },
    { "@type": "https://schema.org/WebPage", description: "Real summary." }, // full-IRI WITH content
    { "@type": ["WebPage", "Article"], headline: "x" },
    { "@type": "JobPosting", title: "Eng" },
    { "@type": "WebPage", mainEntity: { "@type": "Article", articleBody: "real content" } }, // nested (codex P2 #3)
    { "@type": "WebPage", about: { "@type": "JobPosting", title: "Eng" } }, // nested via 'about'
  ];
  for (const jsonLd of usable) {
    assert.equal(hasUsableStructuredData({ jsonLd } as StructuredData), true, `usable: ${JSON.stringify(jsonLd)}`);
  }
});

test("hasUsableStructuredData: a deep scaffolding-only chain does not overflow / does not satisfy (#109 cycle guard)", () => {
  // 10 nested WebPage→mainEntity→WebPage… with no real content at the bottom: must not crash
  // (depth-capped) and must not be content-bearing.
  let node: Record<string, unknown> = { "@type": "Article", description: "" }; // bottom (Article, but empty)
  for (let i = 0; i < 10; i++) node = { "@type": "WebPage", mainEntity: node };
  assert.equal(hasUsableStructuredData({ jsonLd: node } as StructuredData), false, "deep scaffolding chain is not content-bearing");
});

test("shell-gate: scaffolding WebPage as a full IRI with empty description does not satisfy (#109, codex P2)", () => {
  // @type may be a full IRI (https://schema.org/WebPage); shortSchemaType normalizes it so the
  // scaffolding check still applies. Without normalization the IRI misses the set and falls through.
  const shell = '<html><body><div id="root"></div>'
    + '<script type="application/ld+json">{"@context":"https://schema.org","@type":"https://schema.org/WebPage","name":"X","description":""}</script>'
    + '</body></html>';
  const gate = extractHtml({ html: shell, url: "https://x.test/p" }).shellGate;
  assert.equal(gate.jsRequired, true, "full-IRI WebPage (empty description) must not satisfy the gate");
  assert.equal(gate.reason, "empty-spa-shell");
});

test("shell-gate: scaffolding WebPage as a trailing-slash IRI with empty description does not satisfy (#109, codex P2)", () => {
  // A trailing slash (https://schema.org/WebPage/) made shortSchemaType return "" — missing the
  // scaffolding set. Trailing slashes are now stripped before the last-segment logic.
  const shell = '<html><body><div id="root"></div>'
    + '<script type="application/ld+json">{"@context":"https://schema.org","@type":"https://schema.org/WebPage/","name":"X","description":""}</script>'
    + '</body></html>';
  const gate = extractHtml({ html: shell, url: "https://x.test/p" }).shellGate;
  assert.equal(gate.jsRequired, true, "trailing-slash IRI WebPage (empty description) must not satisfy the gate");
  assert.equal(gate.reason, "empty-spa-shell");
});

test("hasUsableStructuredData: content-bearing JSON-LD predicate edge cases (#81)", () => {
  const notUsable: unknown[] = [null, [], {}, { "@context": "https://schema.org" }, [{ "@context": "x" }], { "@graph": [] }];
  for (const jsonLd of notUsable) {
    assert.equal(hasUsableStructuredData({ jsonLd } as StructuredData), false, `not usable: ${JSON.stringify(jsonLd)}`);
  }
  const usable: unknown[] = [
    { "@type": "Article", headline: "x" },
    [{ "@type": "Product" }],
    { "@context": "x", "@graph": [{ "@type": "Article", headline: "y" }] },
  ];
  for (const jsonLd of usable) {
    assert.equal(hasUsableStructuredData({ jsonLd } as StructuredData), true, `usable: ${JSON.stringify(jsonLd)}`);
  }
});

// #92: a non-HTML body is the COMPLETE response however short — it must NEVER be judged an
// empty SPA shell needing JS. Without the content-type guard, a 14-byte text/plain
// "404: Not Found" tripped hasContent's <20-byte rule and escalated to jsRequired, cascading
// to contentType="spa" + gateReason="js-required" + tier="render-blocked" — a receipt that lies.

test("shell-gate: a short text/plain body is content, not an empty SPA shell (#92)", () => {
  const gate = extractHtml({ html: "404: Not Found", url: "https://x.test/missing", contentType: "text/plain; charset=utf-8" }).shellGate;
  assert.equal(gate.jsRequired, false, "a text/plain body, however short, is not a render shell");
  assert.equal(gate.reason, "content-present");
});

test("shell-gate: a short application/json body is content, not an empty SPA shell (#92)", () => {
  const gate = extractHtml({ html: '{"ok":false}', url: "https://x.test/api", contentType: "application/json" }).shellGate;
  assert.equal(gate.jsRequired, false);
  assert.equal(gate.reason, "content-present");
});

test("shell-gate: ABSENT content-type still escalates a genuinely empty HTML shell (no #92 regression)", () => {
  const gate = extractHtml({ html: '<div id="root"></div>', url: "https://spa.test/" }).shellGate;
  assert.equal(gate.jsRequired, true, "an empty shell with no declared type still needs render");
  assert.equal(gate.reason, "empty-spa-shell");
});

// #92 review (codex P2): once a non-HTML body is treated as complete content, extractHtml must
// return the RAW decoded body — not the HTML-stripped text, which mangles angle-bracket data.

test("extractHtml preserves a non-HTML body verbatim, including angle-bracket data (#92 review)", () => {
  const out = extractHtml({ html: '{"x":"<b>hi</b>"}', url: "https://x.test/api", contentType: "application/json" });
  assert.equal(out.text, '{"x":"<b>hi</b>"}', "JSON angle-bracket data must not be HTML-stripped");
  assert.equal(out.shellGate.jsRequired, false);
});

test("extractHtml preserves newlines in text/markdown bodies (#92 review, covers #94 markdown half)", () => {
  const md = "# Title\n\nfirst paragraph\n\nsecond paragraph";
  const out = extractHtml({ html: md, url: "https://x.test/readme.md", contentType: "text/markdown" });
  assert.equal(out.text, md, "markdown newlines must be preserved, not collapsed");
});

test("extractHtml preserves edge whitespace verbatim in non-HTML bodies (#92 review)", () => {
  // Leading indentation and trailing newlines are meaningful in code/markdown — the raw body must
  // be returned unchanged, not trimmed.
  const body = "    indented first line\nbody\n  \n";
  const out = extractHtml({ html: body, url: "https://x.test/snippet.txt", contentType: "text/plain" });
  assert.equal(out.text, body, "non-HTML edge whitespace must be preserved verbatim");
  assert.equal(out.shellGate.jsRequired, false);
});
