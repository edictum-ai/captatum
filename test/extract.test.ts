import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { FetcherResult } from "../src/application/ports/fetcher.ts";
import { extractTier1FromFetchResult, preferredTitle } from "../src/application/use-cases/tier1-extract.ts";
import { extractHtml } from "../src/infrastructure/extract/index.ts";
import { extractVisibleText, findElements, stripHtmlComments, stripHtmlTags } from "../src/infrastructure/extract/html.ts";
import { MAIN_OVERRIDE_FACTOR, selectMainContentHtml } from "../src/infrastructure/extract/main-content.ts";
import { decodeHtmlEntities } from "../src/infrastructure/extract/entities.ts";
import { stripHiddenSubtrees } from "../src/infrastructure/extract/hidden.ts";
import { collectHiddenDisplayNoneClasses } from "../src/infrastructure/extract/hidden-classes.ts";
import { extractAppState } from "../src/infrastructure/extract/app-state.ts";
import { isJsonContentType } from "../src/infrastructure/http/body.ts";
import { classifyContentType } from "../src/application/classify.ts";

const FIXTURE_DIR = join(process.cwd(), "test", "fixtures", "extract");

test("findElements skips a literal <script> inside an earlier script body (PR #86 review)", () => {
  // A literal `<script>` inside the first JSON-LD block must not cross-pair with the
  // second block's close and swallow it — both JSON-LD nodes must be extracted.
  const html =
    `<script type="application/ld+json">{"one":"contains a <script> literal"}</script>` +
    `<script type="application/ld+json">{"two":"second block survives"}</script>`;
  const structured = JSON.stringify(extractHtml({ html, url: "https://example.test/" }).structured);
  assert.ok(structured.includes("second block survives"), "the second JSON-LD block is not swallowed");
});

test("findElements treats a form-feed after </script as a tag boundary (PR #86 review)", () => {
  // U+000C is HTML tag-name-terminating whitespace, so `</script\f>` closes the script.
  const el = findElements("<script>DATA</script\f>", "script")[0];
  assert.equal(el?.content, "DATA", "form-feed-terminated </script> is recognized as the close");
});

test("extracts title, canonical URL, and JSON-LD from json-ld.html", () => {
  const extraction = extractHtml({
    html: fixture("json-ld.html"),
    url: "https://example.test/articles/original",
  });

  assert.equal(extraction.title, "JSON-LD Fixture & Title");
  assert.equal(extraction.structured.canonicalUrl, "https://example.test/json-ld?ref=fixture");
  assert.deepEqual(extraction.structured.jsonLd, {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: "Deterministic extraction",
    author: { "@type": "Person", name: "Ada" },
  });
  assert.equal(extraction.shellGate.jsRequired, false);
  assert.equal(extraction.shellGate.reason, "structured-data-found");
  assert.deepEqual(extraction.errors, []);
});

test("extracts Open Graph, Twitter, generic meta, and canonical from og-meta.html", () => {
  const extraction = extractHtml({
    html: fixture("og-meta.html"),
    url: "https://example.test/start",
  });

  assert.equal(extraction.title, "Meta Fixture");
  assert.equal(extraction.structured.canonicalUrl, "https://example.test/meta-canonical?x=1&y=2");
  assert.deepEqual(extraction.structured.og, {
    "og:title": "OG Fixture Title",
    "og:type": "article",
    "og:url": "https://example.test/articles/fixture",
  });
  assert.deepEqual(extraction.structured.meta, {
    description: "A deterministic meta fixture.",
    "twitter:card": "summary_large_image",
    "twitter:title": "Twitter Fixture Title",
  });
  // OG/twitter meta alone (empty body, no JSON-LD/app-state) is a shell — render it.
  assert.equal(extraction.shellGate.reason, "empty-spa-shell");
});

test("ignores unsafe meta keys after normalization", () => {
  const extraction = extractHtml({
    html: [
      "<meta property=\"OG:TITLE\" content=\"Safe OG\">",
      "<meta name=\"description\" content=\"Safe meta\">",
      "<meta name=\"Constructor\" content=\"unsafe\">",
      "<meta name=\"PROTOTYPE\" content=\"unsafe\">",
      "<meta name=\"__PROTO__\" content=\"unsafe\">",
    ].join(""),
    url: "https://example.test/meta-unsafe",
  });

  assert.deepEqual(extraction.structured.og, { "og:title": "Safe OG" });
  assert.deepEqual(extraction.structured.meta, { description: "Safe meta" });
  assert.equal(extraction.shellGate.reason, "empty-spa-shell");
});

test("extracts __NEXT_DATA__ and __INITIAL_STATE__ from app-state.html", () => {
  const extraction = extractHtml({
    html: fixture("app-state.html"),
    url: "https://example.test/app-state",
  });

  assert.deepEqual(extraction.structured.appState, {
    __NEXT_DATA__: {
      props: { pageProps: { slug: "tier-1", count: 2 } },
      page: "/docs/[slug]",
    },
    __INITIAL_STATE__: {
      viewer: { name: "Reader", roles: ["agent", "tester"] },
      nested: { message: "brace } inside string" },
    },
  });
  assert.equal(extraction.shellGate.reason, "structured-data-found");
});

test("shell gate distinguishes content-page.html from spa-shell.html", () => {
  const content = extractHtml({
    html: fixture("content-page.html"),
    url: "https://example.test/content",
  });
  const shell = extractHtml({
    html: fixture("spa-shell.html"),
    url: "https://example.test/app",
  });

  assert.equal(content.shellGate.jsRequired, false);
  assert.equal(content.shellGate.reason, "content-present");
  assert.equal(content.text, [
    "Tier one extraction has real content",
    "This fixture has enough visible text for the shell gate to stop before render.",
  ].join(" "));

  assert.equal(shell.shellGate.jsRequired, true);
  assert.equal(shell.shellGate.reason, "empty-spa-shell");
  assert.equal(shell.shellGate.appRootFound, true);
  assert.equal(shell.shellGate.scriptCount, 2);
  assert.equal(shell.text, "");
});

test("shell gate escalates an OG-tagged SPA with an empty body (regression: vue-realworld, react-shopping-cart)", () => {
  // Real failure: an SPA ships og:title + an app-root div + a JS bundle but no
  // body text. OG is social-card metadata, not content — this must render.
  const extraction = extractHtml({
    html: [
      "<html><head>",
      "<title>Conduit</title>",
      "<meta property=\"og:title\" content=\"Conduit\">",
      "<meta property=\"og:type\" content=\"website\">",
      "</head><body>",
      "<div id=\"app\"></div>",
      "<script src=\"/bundle.js\"></script>",
      "</body></html>",
    ].join(""),
    url: "https://example.test/spa-with-og",
  });

  assert.equal(extraction.shellGate.jsRequired, true);
  assert.equal(extraction.shellGate.reason, "empty-spa-shell");
  assert.equal(extraction.shellGate.appRootFound, true);
  assert.ok(extraction.structured.og, "OG still extracted");
});

test("vscdn/Netflix: hidden display:none config blobs do not leak into visible text", () => {
  // Real failure (explore.jobs.netflix.net): themeOptions/branding config lives in
  // <code style="display:none"> elements. A browser never renders them, so neither
  // should captatum's visible-text extractor. The job description lives only in the
  // JobPosting JSON-LD; the raw <body> is JS-rendered.
  const extraction = extractHtml({
    html: fixture("vscdn-config.html"),
    url: "https://explore.jobs.netflix.net/careers/job/790315212924",
  });

  assert.equal(extraction.shellGate.reason, "structured-data-found");
  assert.equal(extraction.shellGate.jsRequired, false);
  // The hidden config blobs must NOT appear as visible text.
  assert.equal(extraction.text.length, 0);
  assert.doesNotMatch(extraction.text, /themeOptions|primary-color|NetflixSans|domain : netflix|applySuccessMessage/);
  // The JobPosting JSON-LD is still extracted and is the content-bearing node.
  const items = Array.isArray(extraction.structured.jsonLd)
    ? extraction.structured.jsonLd
    : [extraction.structured.jsonLd];
  const jobPosting = items.find(
    (node) => node !== null && typeof node === "object"
      && (node as Record<string, unknown>)["@type"] === "JobPosting",
  );
  assert.ok(jobPosting, "JobPosting JSON-LD extracted");
});

test("vscdn/Netflix: Tier-1 raw output is the JobPosting description, not the config blob", async () => {
  const result = await extractTier1FromFetchResult({
    requestedUrl: "https://explore.jobs.netflix.net/careers/job/790315212924",
    fetchResult: fetchResult(
      "https://explore.jobs.netflix.net/careers/job/790315212924",
      fixture("vscdn-config.html"),
    ),
    extractHtml,
    durationMs: 100,
    fetchMs: 90,
    output: "raw",
  });

  assert.equal(result.tier, 1);
  assert.equal(result.resolvedVia, "tier1-jsonld");
  assert.equal(result.jsRequired, false);
  // The result leads with the job description (the page's primary content), not the
  // hidden themeOptions/branding config that used to dominate output:raw.
  assert.ok(result.result.startsWith("Netflix is one of the world's leading entertainment services"));
  assert.doesNotMatch(result.result, /themeOptions|primary-color|domain : netflix|applySuccessMessage/);
});

test("Pinterest pin: SocialMediaPosting articleBody leads output:raw (not SPA chrome)", async () => {
  // Real failure (pinterest.com/pin/<id>): a pin's caption lives in the
  // SocialMediaPosting JSON-LD articleBody (author, follower stats, source text);
  // the node has no top-level description and the visible body is SPA chrome.
  // Before the fix, output:raw was only the page title — the caption was never
  // surfaced because SocialMediaPosting was not a content-bearing node.
  const result = await extractTier1FromFetchResult({
    requestedUrl: "https://www.pinterest.com/pin/1618549864698060/",
    fetchResult: fetchResult(
      "https://www.pinterest.com/pin/1618549864698060/",
      fixture("pinterest-pin.html"),
    ),
    extractHtml,
    durationMs: 100,
    fetchMs: 90,
    output: "raw",
  });

  assert.equal(result.tier, 1);
  assert.equal(result.resolvedVia, "tier1-jsonld");
  // The pin's source caption (articleBody) leads the result.
  assert.ok(
    result.result.startsWith("5,972 Followers, 719 Following"),
    "articleBody caption must lead output:raw",
  );
  assert.ok(result.result.includes("Sfera kids"), "pin source caption surfaced");
  // The nested interactionStatistic.description ("Saves") must NOT be picked as
  // the description fallback — only the node's own articleBody.
  assert.ok(!result.result.startsWith("Saves"));
  // The page <title> already contains the headline, so it is kept as-is.
  assert.equal(result.title, "Decoração Festa Infantil fundo do mar | Sereia tema de festa");
});

test("Pinterest pin: short/absent description falls back to articleBody, not the weak description", async () => {
  // A node that has BOTH a weak (<50 char) description and a real articleBody:
  // the articleBody must win so the caption, not a truncated one-liner, leads.
  const html = [
    "<!doctype html><html><head><title>Pinterest</title></head><body>",
    "<script type=\"application/ld+json\">",
    JSON.stringify({
      "@context": "http://schema.org/",
      "@type": "SocialMediaPosting",
      headline: "A pin",
      description: "too short",
      articleBody: "Sfera kids I Buffet infantil: Festas completas para a primeira infância com experiencias ludicas.",
    }),
    "</script></body></html>",
  ].join("\n");
  const result = await extractTier1FromFetchResult({
    requestedUrl: "https://www.pinterest.com/pin/123/",
    fetchResult: fetchResult("https://www.pinterest.com/pin/123/", html),
    extractHtml,
    durationMs: 100,
    fetchMs: 90,
    output: "raw",
  });
  assert.ok(result.result.startsWith("Sfera kids"), "articleBody leads over the weak description");
  assert.ok(!result.result.startsWith("too short"));
});

test("Article articleBody is NOT duplicated as a leading description (gate is SocialMediaPosting-only)", async () => {
  // Regression guard (codex P2): the articleBody fallback must stay gated to
  // SocialMediaPosting. An Article's articleBody equals its visible body, so
  // leading with it would duplicate the whole article and re-inflate the transform
  // input that transformContent works to keep small.
  const body = "This is the real article body that already appears as visible text.";
  const html = [
    "<!doctype html><html><head><title>Some News Article</title></head><body>",
    `<article><p>${body}</p></article>`,
    "<script type=\"application/ld+json\">",
    JSON.stringify({ "@context": "https://schema.org", "@type": "NewsArticle", headline: "Some News Article", articleBody: body }),
    "</script></body></html>",
  ].join("\n");
  const result = await extractTier1FromFetchResult({
    requestedUrl: "https://news.test/article",
    fetchResult: fetchResult("https://news.test/article", html),
    extractHtml,
    durationMs: 100,
    fetchMs: 90,
    output: "raw",
  });
  // The articleBody must NOT be prepended as a leading description (which would
  // make the body appear twice). It appears exactly once, from the visible body.
  const phrase = "real article body that already appears as visible text";
  assert.ok(result.result.includes(phrase), "visible body present");
  assert.equal(
    result.result.indexOf(phrase),
    result.result.lastIndexOf(phrase),
    "articleBody must not be duplicated as a leading description",
  );
});

test("Pinterest pin wrapped in a @graph node still surfaces its articleBody caption", async () => {
  // Some pages wrap content JSON-LD in a @graph node. leadDescription must descend
  // @graph (as preferredTitle already does) or a graph-wrapped pin's caption is
  // missed and output:raw falls back to SPA chrome/empty body.
  const html = [
    "<!doctype html><html><head><title>Pin</title></head><body>",
    "<script type=\"application/ld+json\">",
    JSON.stringify({
      "@context": "https://schema.org",
      "@graph": [{
        "@type": "SocialMediaPosting",
        headline: "A Graph-Wrapped Pin",
        articleBody: "Sfera kids I Buffet infantil: Festas completas para a primeira infancia com experiencias ludicas.",
      }],
    }),
    "</script></body></html>",
  ].join("\n");
  const result = await extractTier1FromFetchResult({
    requestedUrl: "https://www.pinterest.com/pin/9/",
    fetchResult: fetchResult("https://www.pinterest.com/pin/9/", html),
    extractHtml,
    durationMs: 100,
    fetchMs: 90,
    output: "raw",
  });
  assert.ok(result.result.startsWith("Sfera kids"), "graph-wrapped pin articleBody surfaced");
});

test("Pinterest pin: a SHORT articleBody caption (<=50 chars) still leads", async () => {
  // A pin's caption can be short ("Cute outfit!"). It IS the post's content, so it
  // must lead even though it is under the >50-char threshold the description path
  // uses — otherwise output:raw falls back to SPA chrome.
  const html = [
    "<!doctype html><html><head><title>Pin</title></head><body>",
    "<header><nav>Skip to content Explore</nav></header>",
    "<script type=\"application/ld+json\">",
    JSON.stringify({ "@context": "http://schema.org/", "@type": "SocialMediaPosting", headline: "Pin", articleBody: "Cute outfit! Love it." }),
    "</script></body></html>",
  ].join("\n");
  const result = await extractTier1FromFetchResult({
    requestedUrl: "https://www.pinterest.com/pin/8/",
    fetchResult: fetchResult("https://www.pinterest.com/pin/8/", html),
    extractHtml,
    durationMs: 100,
    fetchMs: 90,
    output: "raw",
  });
  assert.ok(result.result.startsWith("Cute outfit!"), "short SocialMediaPosting caption leads");
});

test("an embedded SocialMediaPosting on an article page does NOT dominate the article body", async () => {
  // Regression guard (codex P2): a normal article page that also embeds a social
  // post (a SocialMediaPosting JSON-LD node) must not lead with the post's
  // articleBody. The post is embedded/related, not the page subject; the article
  // body leads. Only a pin/thin page (no other content node) uses the post body.
  const articleBody = "This is the genuine article body with enough text to be primary content for the fetched page.";
  const html = [
    "<!doctype html><html><head><title>Real Article</title></head><body>",
    `<article><p>Real Article ${articleBody}</p></article>`,
    "<script type=\"application/ld+json\">",
    JSON.stringify({ "@context": "https://schema.org", "@type": "NewsArticle", headline: "Real Article", articleBody }),
    "</script>",
    "<script type=\"application/ld+json\">",
    JSON.stringify({ "@context": "https://schema.org", "@type": "SocialMediaPosting", articleBody: "This is an embedded social post, not the page body." }),
    "</script></body></html>",
  ].join("\n");
  const result = await extractTier1FromFetchResult({
    requestedUrl: "https://news.test/article-with-embed",
    fetchResult: fetchResult("https://news.test/article-with-embed", html),
    extractHtml,
    durationMs: 100,
    fetchMs: 90,
    output: "raw",
  });
  assert.ok(!result.result.startsWith("This is an embedded social post"), "embedded social post must not lead");
  assert.ok(result.result.includes("genuine article body"), "article body present");
});

test("a non-pin page with real body + an embedded social post does NOT let the post lead", async () => {
  // Regression guard (codex P2): a page with real visible body but no
  // Article/JobPosting JSON-LD that embeds a social post must not prepend the
  // post's articleBody. Only a pin page (pinterest/pin.it) or an empty SPA shell
  // treats a SocialMediaPosting as the subject; visible-text length alone is too
  // fragile to be the signal.
  const rich = "Welcome to our site. ".repeat(40); // ~880 chars of real body text
  const html = [
    "<!doctype html><html><head><title>Acme Home</title></head><body>",
    `<main><p>${rich}</p></main>`,
    "<script type=\"application/ld+json\">",
    JSON.stringify({ "@context": "https://schema.org", "@type": "SocialMediaPosting", articleBody: "Embedded social post caption that should not dominate the homepage." }),
    "</script></body></html>",
  ].join("\n");
  const result = await extractTier1FromFetchResult({
    requestedUrl: "https://acme.test/",
    fetchResult: fetchResult("https://acme.test/", html),
    extractHtml,
    durationMs: 100,
    fetchMs: 90,
    output: "raw",
  });
  assert.ok(!result.result.startsWith("Embedded social post"), "embedded post must not lead on a non-pin page");
  assert.ok(result.result.startsWith("Welcome to our site"), "real page body leads");
});

test("a Pinterest board/profile page (not a /pin/ URL) does NOT treat an embedded post as the subject", async () => {
  // Regression guard (codex P2): the host-only pin check let any pinterest.*
  // page fire the caption fallback. A board/profile/search page with real body
  // text + an embedded social post must not lead with the post — only an actual
  // pin detail page (pinterest.*/pin/<id>/ or pin.it) does.
  const rich = "Pin idea after pin idea. ".repeat(40);
  const html = [
    "<!doctype html><html><head><title>Party Ideas Board</title></head><body>",
    `<main><p>${rich}</p></main>`,
    "<script type=\"application/ld+json\">",
    JSON.stringify({ "@context": "https://schema.org", "@type": "SocialMediaPosting", articleBody: "An embedded pin caption that must not dominate this board page." }),
    "</script></body></html>",
  ].join("\n");
  const result = await extractTier1FromFetchResult({
    requestedUrl: "https://www.pinterest.com/thaynavitoriano/festa-fundo-do-mar/",
    fetchResult: fetchResult("https://www.pinterest.com/thaynavitoriano/festa-fundo-do-mar/", html),
    extractHtml,
    durationMs: 100,
    fetchMs: 90,
    output: "raw",
  });
  assert.ok(!result.result.startsWith("An embedded pin caption"), "board page must not lead with an embedded post");
  assert.ok(result.result.startsWith("Pin idea"), "board body leads");
});

test("an empty Pinterest board/profile shell does NOT surface an embedded social post", async () => {
  // Regression guard (codex P2): on a Pinterest host, only an actual /pin/ detail
  // page qualifies — not an empty board/profile shell whose only content is an
  // embedded SocialMediaPosting.
  const html = [
    "<!doctype html><html><head><title>My Board</title></head><body>",
    "<div id=\"app\"></div>",
    "<script type=\"application/ld+json\">",
    JSON.stringify({ "@context": "https://schema.org", "@type": "SocialMediaPosting", articleBody: "Embedded post caption that must not surface on a board shell." }),
    "</script></body></html>",
  ].join("\n");
  const result = await extractTier1FromFetchResult({
    requestedUrl: "https://www.pinterest.com/thaynavitoriano/my-board/",
    fetchResult: fetchResult("https://www.pinterest.com/thaynavitoriano/my-board/", html),
    extractHtml,
    durationMs: 100,
    fetchMs: 90,
    output: "raw",
  });
  assert.ok(!result.result.includes("Embedded post caption"), "board shell must not surface the embedded post");
});

test("a spoofed Pinterest host (pinterest.com.evil) does NOT trigger the pin fallback", async () => {
  // Regression guard (codex P3): the host match must be spoof-safe. A lookalike
  // domain whose hostname merely contains "pinterest." must not surface a
  // SocialMediaPosting articleBody as if it were a real pin page.
  const html = [
    "<!doctype html><html><head><title>Evil</title></head><body>",
    "<div id=\"app\"></div>",
    "<script type=\"application/ld+json\">",
    JSON.stringify({ "@context": "https://schema.org", "@type": "SocialMediaPosting", articleBody: "Spoofed caption that must not surface." }),
    "</script></body></html>",
  ].join("\n");
  const result = await extractTier1FromFetchResult({
    requestedUrl: "https://pinterest.com.evil/pin/foo/",
    fetchResult: fetchResult("https://pinterest.com.evil/pin/foo/", html),
    extractHtml,
    durationMs: 100,
    fetchMs: 90,
    output: "raw",
  });
  assert.ok(!result.result.includes("Spoofed caption"), "spoofed pinterest host must not trigger pin fallback");
});

test("a 3-letter lookalike host (pinterest.com.foo) does NOT trigger the pin fallback", async () => {
  // Regression guard (codex P2): the host regex must reject 3+ letter tails, so a
  // lookalike like pinterest.com.foo (which slid past the com.[a-z]{2,3} form) is
  // not treated as a genuine Pinterest host.
  const html = [
    "<!doctype html><html><head><title>Evil</title></head><body>",
    "<div id=\"app\"></div>",
    "<script type=\"application/ld+json\">",
    JSON.stringify({ "@context": "https://schema.org", "@type": "SocialMediaPosting", articleBody: "Lookalike host caption that must not surface." }),
    "</script></body></html>",
  ].join("\n");
  const result = await extractTier1FromFetchResult({
    requestedUrl: "https://www.pinterest.com.foo/pin/123/",
    fetchResult: fetchResult("https://www.pinterest.com.foo/pin/123/", html),
    extractHtml,
    durationMs: 100,
    fetchMs: 90,
    output: "raw",
  });
  assert.ok(!result.result.includes("Lookalike host"), "3-letter lookalike host must not trigger pin fallback");
});

test("a Pinterest country-domain pin (pinterest.co.uk) still surfaces its caption", async () => {
  // The host gate must accept genuine Pinterest country domains, not just .com,
  // or country-domain pins lose the caption fallback (isPinHost and isPinDetailPage
  // must agree). Spoof-safety is preserved by anchoring the match to the host end.
  const html = [
    "<!doctype html><html><head><title>Pin</title></head><body>",
    "<div id=\"app\"></div>",
    "<script type=\"application/ld+json\">",
    JSON.stringify({ "@context": "https://schema.org", "@type": "SocialMediaPosting", headline: "Pin", articleBody: "Sfera kids I Buffet infantil: caption on a country-domain pin page." }),
    "</script></body></html>",
  ].join("\n");
  const result = await extractTier1FromFetchResult({
    requestedUrl: "https://www.pinterest.co.uk/pin/123/",
    fetchResult: fetchResult("https://www.pinterest.co.uk/pin/123/", html),
    extractHtml,
    durationMs: 100,
    fetchMs: 90,
    output: "raw",
  });
  assert.ok(result.result.startsWith("Sfera kids"), "country-domain pin caption surfaces");
});

test("a pin in an array-valued JSON-LD script (multi-script page) still surfaces", async () => {
  // Regression guard (codex P2): extractJsonLd nests multi-script pages as
  // [[nodes...], node]; candidateNodes must flatten array-valued script values,
  // not treat the inner array as a single (non-content) record.
  const html = [
    "<!doctype html><html><head><title>Pin</title></head><body>",
    "<div id=\"app\"></div>",
    "<script type=\"application/ld+json\">",
    JSON.stringify([{ "@type": "SocialMediaPosting", headline: "Pin", articleBody: "Sfera kids caption nested inside an array-valued JSON-LD script." }]),
    "</script>",
    "<script type=\"application/ld+json\">",
    JSON.stringify({ "@type": "BreadcrumbList", itemListElement: [{ name: "Home" }] }),
    "</script></body></html>",
  ].join("\n");
  const result = await extractTier1FromFetchResult({
    requestedUrl: "https://www.pinterest.com/pin/555/",
    fetchResult: fetchResult("https://www.pinterest.com/pin/555/", html),
    extractHtml,
    durationMs: 100,
    fetchMs: 90,
    output: "raw",
  });
  assert.ok(result.result.startsWith("Sfera kids"), "array-nested SocialMediaPosting caption surfaces");
});

test("non-detail Pinterest routes (/pin/create/, board slug /alice/pin/) do NOT trigger the fallback", async () => {
  // Regression guard (codex P2): isPinDetailPage must require the actual pin route
  // /pin/<numeric-id>, not any "/pin/" substring. An empty shell is used so the only
  // thing that could surface is the embedded post — isolating the route check.
  const shell = (caption) => [
    "<!doctype html><html><head><title>Pinterest</title></head><body>",
    "<div id=\"app\"></div>",
    "<script type=\"application/ld+json\">",
    JSON.stringify({ "@context": "https://schema.org", "@type": "SocialMediaPosting", articleBody: caption }),
    "</script></body></html>",
  ].join("\n");
  for (const url of [
    "https://www.pinterest.com/alice/pin/",
    "https://www.pinterest.com/pin/create/",
    "https://www.pinterest.com/alice/pin/123/", // /pin/<digits> not at the path root
    "https://www.pinterest.com/pin/123abc/", // id segment has trailing junk
  ]) {
    const result = await extractTier1FromFetchResult({
      requestedUrl: url,
      fetchResult: fetchResult(url, shell("EMBED " + url)),
      extractHtml,
      durationMs: 100,
      fetchMs: 90,
      output: "raw",
    });
    assert.ok(!result.result.includes("EMBED"), `${url} must not trigger the pin fallback`);
  }
});

test("among multiple SocialMediaPosting nodes, the one matching the fetched pin leads", async () => {
  // Regression guard (codex P2): a pin page may carry several SocialMediaPosting
  // nodes (the current pin + a quoted/related one). Prefer the node whose
  // url/mainEntityOfPage references the fetched pin id; don't just take the first.
  const html = [
    "<!doctype html><html><head><title>Pin</title></head><body>",
    "<div id=\"app\"></div>",
    "<script type=\"application/ld+json\">",
    JSON.stringify({ "@context": "https://schema.org", "@type": "SocialMediaPosting", articleBody: "RELATED pin caption that must NOT lead.", mainEntityOfPage: { "@id": "https://www.pinterest.com/pin/999/" } }),
    "</script>",
    "<script type=\"application/ld+json\">",
    JSON.stringify({ "@context": "https://schema.org", "@type": "SocialMediaPosting", articleBody: "CURRENT pin caption that SHOULD lead.", mainEntityOfPage: { "@id": "https://www.pinterest.com/pin/123/" } }),
    "</script></body></html>",
  ].join("\n");
  const result = await extractTier1FromFetchResult({
    requestedUrl: "https://www.pinterest.com/pin/123/",
    fetchResult: fetchResult("https://www.pinterest.com/pin/123/", html),
    extractHtml,
    durationMs: 100,
    fetchMs: 90,
    output: "raw",
  });
  assert.ok(result.result.startsWith("CURRENT pin caption"), "the fetched pin's caption leads, not a related pin's");
  assert.ok(!result.result.startsWith("RELATED pin caption"), "a related/quoted pin must not lead");
});

test("prefix-colliding pin ids (123 vs 1234) select the exact match, not the prefix", async () => {
  // Regression guard (codex P2): matching the pin id by substring would let
  // /pin/123 match /pin/1234 (a prefix collision) and surface the wrong caption.
  // Require an exact id boundary.
  const html = [
    "<!doctype html><html><head><title>Pin</title></head><body>",
    "<div id=\"app\"></div>",
    "<script type=\"application/ld+json\">",
    JSON.stringify({ "@context": "https://schema.org", "@type": "SocialMediaPosting", articleBody: "PREFIX pin 1234 must NOT lead.", mainEntityOfPage: { "@id": "https://www.pinterest.com/pin/1234/" } }),
    "</script>",
    "<script type=\"application/ld+json\">",
    JSON.stringify({ "@context": "https://schema.org", "@type": "SocialMediaPosting", articleBody: "EXACT pin 123 SHOULD lead.", mainEntityOfPage: { "@id": "https://www.pinterest.com/pin/123/" } }),
    "</script></body></html>",
  ].join("\n");
  const result = await extractTier1FromFetchResult({
    requestedUrl: "https://www.pinterest.com/pin/123/",
    fetchResult: fetchResult("https://www.pinterest.com/pin/123/", html),
    extractHtml,
    durationMs: 100,
    fetchMs: 90,
    output: "raw",
  });
  assert.ok(result.result.startsWith("EXACT pin 123"), "exact pin-id match leads, not a prefix-colliding one");
});

test("a co-typed pin (@type SocialMediaPosting + Article) still surfaces its caption", async () => {
  // Regression guard (codex P2): a node typed as BOTH SocialMediaPosting and Article
  // is still the pin — its articleBody must surface, not be suppressed as a higher-
  // priority content node via the Article type.
  const html = [
    "<!doctype html><html><head><title>Pin</title></head><body>",
    "<div id=\"app\"></div>",
    "<script type=\"application/ld+json\">",
    JSON.stringify({ "@context": "https://schema.org", "@type": ["SocialMediaPosting", "Article"], headline: "Pin", articleBody: "Sfera kids co-typed pin caption that must surface.", mainEntityOfPage: { "@id": "https://www.pinterest.com/pin/777/" } }),
    "</script></body></html>",
  ].join("\n");
  const result = await extractTier1FromFetchResult({
    requestedUrl: "https://www.pinterest.com/pin/777/",
    fetchResult: fetchResult("https://www.pinterest.com/pin/777/", html),
    extractHtml,
    durationMs: 100,
    fetchMs: 90,
    output: "raw",
  });
  assert.ok(result.result.startsWith("Sfera kids co-typed"), "co-typed pin caption surfaces");
});

test("a related posting referenced as /pin/123abc/ does not shadow the exact /pin/123/", async () => {
  // Regression guard (codex P3): the pin-id boundary must be a real path boundary,
  // not just a non-digit — /pin/123abc/ must not match pin id 123.
  const html = [
    "<!doctype html><html><head><title>Pin</title></head><body>",
    "<div id=\"app\"></div>",
    "<script type=\"application/ld+json\">",
    JSON.stringify({ "@context": "https://schema.org", "@type": "SocialMediaPosting", articleBody: "TRAILING JUNK ref must NOT lead.", mainEntityOfPage: { "@id": "https://www.pinterest.com/pin/123abc/" } }),
    "</script>",
    "<script type=\"application/ld+json\">",
    JSON.stringify({ "@context": "https://schema.org", "@type": "SocialMediaPosting", articleBody: "EXACT pin SHOULD lead.", mainEntityOfPage: { "@id": "https://www.pinterest.com/pin/123/" } }),
    "</script></body></html>",
  ].join("\n");
  const result = await extractTier1FromFetchResult({
    requestedUrl: "https://www.pinterest.com/pin/123/",
    fetchResult: fetchResult("https://www.pinterest.com/pin/123/", html),
    extractHtml,
    durationMs: 100,
    fetchMs: 90,
    output: "raw",
  });
  assert.ok(result.result.startsWith("EXACT pin"), "exact pin leads, not a trailing-junk reference");
});

test("a posting referenced via a non-detail path (/alice/pin/123/) does not shadow the real pin", async () => {
  // Regression guard (codex P2): a reference URL that merely contains the pin id in
  // a non-detail path (or a query) must not be selected. Only a genuine Pinterest
  // pin-detail URL with the same id counts as the current pin.
  const html = [
    "<!doctype html><html><head><title>Pin</title></head><body>",
    "<div id=\"app\"></div>",
    "<script type=\"application/ld+json\">",
    JSON.stringify({ "@context": "https://schema.org", "@type": "SocialMediaPosting", articleBody: "BOARD PATH ref must NOT lead.", mainEntityOfPage: { "@id": "https://www.pinterest.com/alice/pin/123/" } }),
    "</script>",
    "<script type=\"application/ld+json\">",
    JSON.stringify({ "@context": "https://schema.org", "@type": "SocialMediaPosting", articleBody: "REAL pin SHOULD lead.", mainEntityOfPage: { "@id": "https://www.pinterest.com/pin/123/" } }),
    "</script></body></html>",
  ].join("\n");
  const result = await extractTier1FromFetchResult({
    requestedUrl: "https://www.pinterest.com/pin/123/",
    fetchResult: fetchResult("https://www.pinterest.com/pin/123/", html),
    extractHtml,
    durationMs: 100,
    fetchMs: 90,
    output: "raw",
  });
  assert.ok(result.result.startsWith("REAL pin"), "the real pin detail ref leads, not a non-detail path ref");
});

test("a pin identified via mainEntityOfPage.url (not @id) is still matched", async () => {
  // Regression guard (codex P2): mainEntityOfPage may be { url } instead of { @id }.
  const html = [
    "<!doctype html><html><head><title>Pin</title></head><body>",
    "<div id=\"app\"></div>",
    "<script type=\"application/ld+json\">",
    JSON.stringify({ "@context": "https://schema.org", "@type": "SocialMediaPosting", articleBody: "RELATED must NOT lead.", mainEntityOfPage: { "@id": "https://www.pinterest.com/pin/999/" } }),
    "</script>",
    "<script type=\"application/ld+json\">",
    JSON.stringify({ "@context": "https://schema.org", "@type": "SocialMediaPosting", articleBody: "URL FORM pin SHOULD lead.", mainEntityOfPage: { url: "https://www.pinterest.com/pin/123/" } }),
    "</script></body></html>",
  ].join("\n");
  const result = await extractTier1FromFetchResult({
    requestedUrl: "https://www.pinterest.com/pin/123/",
    fetchResult: fetchResult("https://www.pinterest.com/pin/123/", html),
    extractHtml,
    durationMs: 100,
    fetchMs: 90,
    output: "raw",
  });
  assert.ok(result.result.startsWith("URL FORM pin"), "mainEntityOfPage.url form is matched");
});

test("a pin that identifies itself via a top-level @id is matched", async () => {
  // Regression guard (codex P2): a posting may carry its canonical URL as a
  // top-level @id rather than url/mainEntityOfPage.
  const html = [
    "<!doctype html><html><head><title>Pin</title></head><body>",
    "<div id=\"app\"></div>",
    "<script type=\"application/ld+json\">",
    JSON.stringify({ "@context": "https://schema.org", "@type": "SocialMediaPosting", articleBody: "RELATED must NOT lead.", mainEntityOfPage: { "@id": "https://www.pinterest.com/pin/999/" } }),
    "</script>",
    "<script type=\"application/ld+json\">",
    JSON.stringify({ "@id": "https://www.pinterest.com/pin/123/", "@type": "SocialMediaPosting", articleBody: "TOPLEVEL ID pin SHOULD lead." }),
    "</script></body></html>",
  ].join("\n");
  const result = await extractTier1FromFetchResult({
    requestedUrl: "https://www.pinterest.com/pin/123/",
    fetchResult: fetchResult("https://www.pinterest.com/pin/123/", html),
    extractHtml,
    durationMs: 100,
    fetchMs: 90,
    output: "raw",
  });
  assert.ok(result.result.startsWith("TOPLEVEL ID pin"), "a pin identified by a top-level @id is matched");
});

test("a trailing-dot FQDN pin URL (www.pinterest.com.) is still recognized", async () => {
  // Regression guard (codex P3): the FQDN form "pinterest.com." is the same host;
  // the allowlist must match it after stripping the trailing dot.
  const html = [
    "<!doctype html><html><head><title>Pin</title></head><body>",
    "<div id=\"app\"></div>",
    "<script type=\"application/ld+json\">",
    JSON.stringify({ "@context": "https://schema.org", "@type": "SocialMediaPosting", headline: "Pin", articleBody: "Trailing-dot host pin caption.", mainEntityOfPage: { "@id": "https://www.pinterest.com./pin/123/" } }),
    "</script></body></html>",
  ].join("\n");
  const result = await extractTier1FromFetchResult({
    requestedUrl: "https://www.pinterest.com./pin/123/",
    fetchResult: fetchResult("https://www.pinterest.com./pin/123/", html),
    extractHtml,
    durationMs: 100,
    fetchMs: 90,
    output: "raw",
  });
  assert.ok(result.result.startsWith("Trailing-dot host"), "trailing-dot FQDN pin is recognized");
});

test("any real Pinterest country domain (e.g. pinterest.com.uy) is recognized", async () => {
  // Regression guard (codex P2): the host matcher must cover EVERY real Pinterest
  // country domain, not a hard-coded subset — a 2-letter-cc suffix strategy is used
  // deliberately (an attacker-registered pinterest.<cc> is attacker-controlled end
  // to end, so no cross-domain injection) so legitimate country pins never regress.
  const html = [
    "<!doctype html><html><head><title>Pin</title></head><body>",
    "<div id=\"app\"></div>",
    "<script type=\"application/ld+json\">",
    JSON.stringify({ "@context": "https://schema.org", "@type": "SocialMediaPosting", headline: "Pin", articleBody: " Uruguay pin caption on a .com.uy domain.", mainEntityOfPage: { "@id": "https://www.pinterest.com.uy/pin/4242/" } }),
    "</script></body></html>",
  ].join("\n");
  const result = await extractTier1FromFetchResult({
    requestedUrl: "https://www.pinterest.com.uy/pin/4242/",
    fetchResult: fetchResult("https://www.pinterest.com.uy/pin/4242/", html),
    extractHtml,
    durationMs: 100,
    fetchMs: 90,
    output: "raw",
  });
  assert.ok(result.result.startsWith("Uruguay pin caption"), "pinterest.com.uy pin caption surfaces");
});

test("a Pinterest AMP pin route (/amp/pin/<id>/) is a pin detail page", async () => {
  // Regression guard (codex P2): Pinterest also exposes pins under /amp/pin/<id>/.
  const html = [
    "<!doctype html><html><head><title>Pin</title></head><body>",
    "<div id=\"app\"></div>",
    "<script type=\"application/ld+json\">",
    JSON.stringify({ "@context": "https://schema.org", "@type": "SocialMediaPosting", headline: "Pin", articleBody: "AMP route pin caption that must surface.", mainEntityOfPage: { "@id": "https://www.pinterest.com/amp/pin/5555/" } }),
    "</script></body></html>",
  ].join("\n");
  const result = await extractTier1FromFetchResult({
    requestedUrl: "https://www.pinterest.com/amp/pin/5555/",
    fetchResult: fetchResult("https://www.pinterest.com/amp/pin/5555/", html),
    extractHtml,
    durationMs: 100,
    fetchMs: 90,
    output: "raw",
  });
  assert.ok(result.result.startsWith("AMP route pin caption"), "AMP pin route surfaces the caption");
});

test("a config-only SPA shell (hidden config, no JSON-LD) escalates to Tier-3", () => {
  // Same vscdn shape but WITHOUT the JobPosting JSON-LD: once the hidden config is
  // correctly ignored there is no extractable content, so it must render.
  const extraction = extractHtml({
    html: [
      "<html><head><title>Widget Board</title></head><body>",
      "<div id=\"root\"></div>",
      "<code style=\"display:none\">{&quot;themeOptions&quot;: {&quot;primary-color&quot;: &quot;#E50914&quot;}}</code>",
      "<script>window.__BRAND__ = { domain: \"widget.io\", branding: { applySuccessMessage: \"Thanks!\" } };</script>",
      "</body></html>",
    ].join(""),
    url: "https://boards.widget.io/job/123",
  });

  assert.equal(extraction.text.length, 0);
  assert.equal(extraction.shellGate.jsRequired, true);
  assert.equal(extraction.shellGate.reason, "empty-spa-shell");
});

test("stripHiddenSubtrees drops display:none / hidden subtrees (single pass, O(n))", () => {
  // display:none subtree (nested same-name) removed entirely, siblings kept.
  const a = stripHiddenSubtrees("<p>keep</p><code style=\"display: none\"><code>x</code>SECRET</code><p>also</p>");
  assert.doesNotMatch(a, /SECRET/);
  assert.match(a, /keep/);
  assert.match(a, /also/);
  // boolean `hidden` attribute.
  assert.doesNotMatch(stripHiddenSubtrees("<section hidden>NOPE</section>"), /NOPE/);
  // `!important` is stripped before the value compare.
  assert.doesNotMatch(stripHiddenSubtrees('<div style="display:none !important">SECRET</div><p>after</p>'), /SECRET/);
  // A void hidden element (no subtree) does not swallow following content.
  assert.match(stripHiddenSubtrees('<input hidden type="text"><p>after</p>'), /after/);
  // In HTML, non-void `<div/>` is NOT self-closing (the slash is ignored), so the
  // subtree is hidden. Only VOID_ELEMENTS self-close.
  assert.doesNotMatch(stripHiddenSubtrees('<div hidden/>SECRET</div><p>after</p>'), /SECRET/);
  assert.match(stripHiddenSubtrees('<div hidden/>SECRET</div><p>after</p>'), /after/);
  // visibility:hidden is intentionally NOT hidden — unlike display:none it is
  // cancellable by a `visibility:visible` descendant, so dropping its subtree would
  // lose genuinely visible content.
  assert.match(stripHiddenSubtrees('<div><span style="visibility:hidden">HID</span></div>'), /HID/);
  // A `</div>` inside a comment must NOT close the subtree (hidden content must not leak).
  assert.doesNotMatch(stripHiddenSubtrees('<div hidden><!-- </div> -->SECRET</div><p>after</p>'), /SECRET/);
  // A `<div` inside a quoted attribute must NOT be counted as an open tag.
  assert.doesNotMatch(stripHiddenSubtrees('<div hidden><span data-x="<div class=x">SECRET</span></div><p>after</p>'), /SECRET/);
  // A CSS custom property whose VALUE is "display:none" is NOT hidden (element is visible).
  assert.match(stripHiddenSubtrees('<div style="--brand: display:none; color:red">VISIBLE</div><p>after</p>'), /VISIBLE/);
  // Non-hidden content is untouched.
  assert.equal(stripHiddenSubtrees("<p>visible</p>"), "<p>visible</p>");
});

test("stripHiddenSubtrees keeps React streaming-SSR boundary content (only a matching $RC reveals it)", () => {
  // Real React 18+ streaming: the server ships a boundary's real content INSIDE a `hidden` div,
  // then a `$RC("B:N","S:N")` completion call removes `hidden` after hydration. This IS real page
  // content the browser reveals — NOT a hidden config blob. Regression (Anthropic/Next.js docs):
  // the article body lived in the hidden boundary, so stripping it left only cookie/consent text.
  // ONLY a `$RC` that TARGETS the boundary id reveals it — `$RS`/`$RX`/`$RT` do not (a `$RS`-only
  // page would otherwise expose a boundary the browser still hides — #118 codex P1).
  const rc = '<div hidden id="S:1"><article><h1>The Real Article</h1><p>body</p></article></div>'
    + '<script>$RC=function(a,b){var e=document.getElementById(b);if(e)e.removeAttribute("hidden")};$RC("B:1","S:1")</script>';
  const kept = stripHiddenSubtrees(rc);
  assert.match(kept, /The Real Article/, "a boundary targeted by a $RC call is KEPT (browser reveals it)");
  assert.match(kept, /<article/, "the article element is preserved");

  // $RX (error-boundary completion) does NOT reveal the boundary — the fallback is shown, not the
  // hidden real content; $RS (segment move) does not either. Both stay stripped (#118 codex P1).
  assert.doesNotMatch(stripHiddenSubtrees('<div hidden id="S:2"><p>OriginalHidden</p></div><script>$RX("S:2","E:2")</script>'), /OriginalHidden/);
  assert.doesNotMatch(stripHiddenSubtrees('<div hidden id="S:3"><p>PendingSegment</p></div><script>$RS("S:3","P:3")</script>'), /PendingSegment/);

  // A boundary is revealed only when a $RC call names ITS id. S:0 + S:1 both have calls → both kept.
  const multi = stripHiddenSubtrees('<div hidden id="S:0">A</div><div hidden id="S:1">B</div><script>$RC("B:0","S:0");$RC("B:1","S:1")</script>');
  assert.match(multi, /A/);
  assert.match(multi, /B/);
  // S:2 has NO matching $RC → it stays hidden even when siblings are revealed (a partial stream).
  const partial = stripHiddenSubtrees('<div hidden id="S:0">A</div><div hidden id="S:2">PENDING</div><script>$RC("B:0","S:0")</script>');
  assert.match(partial, /A/);
  assert.doesNotMatch(partial, /PENDING/, "a boundary with no matching $RC stays hidden (partial stream)");

  // DUAL SIGNAL: without any $RC call in the document, a `hidden id="S:N"` div is NOT un-hidden.
  assert.doesNotMatch(stripHiddenSubtrees('<div hidden id="S:1">SECRET</div><p>after</p>'), /SECRET/);

  // Inline `display:none` on a React boundary still wins (an author who explicitly hid it).
  assert.doesNotMatch(
    stripHiddenSubtrees('<div hidden id="S:1" style="display:none">STILL HIDDEN</div><script>$RC("B:1","S:1")</script>'),
    /STILL HIDDEN/,
  );

  // A display:none CLASS on a React boundary still hides it — the browser's CSS keeps the element
  // invisible even after $RC removes the `hidden` attribute, so the boundary exemption must not
  // skip the class check (#118 codex P2). hiddenClasses is collected from <style> upstream.
  assert.doesNotMatch(
    stripHiddenSubtrees('<div hidden id="S:1" class="hide">CLASS_HIDDEN</div><script>$RC("B:1","S:1")</script>', new Set(["hide"])),
    /CLASS_HIDDEN/,
  );

  // vscdn/Netflix config blob (`style="display:none"`, NOT a React boundary) stays hidden
  // even when a React $RC call is present elsewhere in the document.
  assert.doesNotMatch(
    stripHiddenSubtrees('<code style="display:none">THEME_OPTIONS_SECRET</code><script>$RC("B:0","S:0")</script>'),
    /THEME_OPTIONS_SECRET/,
  );

  // An id that is NOT a React boundary marker (not S:N) stays hidden even with a $RC call.
  assert.doesNotMatch(stripHiddenSubtrees('<div hidden id="sidebar">SECRET</div><script>$RC("B:0","S:0")</script>'), /SECRET/);
});

test("stripHiddenSubtrees stays linear on a flood of hidden elements (per-subtree toLowerCase DoS)", () => {
  // Regression: an earlier version called html.toLowerCase() once per hidden subtree,
  // making `<span hidden>x</span>` floods O(n²) (~3.3s at 672k chars; ~7s at 1.5M).
  // Two guards: an absolute time budget (robust to CI load — the O(n²) blow-up is
  // ~30x over it) AND a sub-quadratic ratio (CI-machine-independent, like the REDOS
  // tests). Either failing means super-linear.
  const unit = "<span hidden>x</span>";
  const timed = (n: number): number => {
    const t = performance.now();
    stripHiddenSubtrees(unit.repeat(n));
    return performance.now() - t;
  };
  timed(20_000); // JIT warmup
  const small = timed(20_000);
  const large = timed(80_000); // 4x input (linear ≈ 4x time; quadratic ≈ 16x)
  assert.ok(large < 2000, `stripHiddenSubtrees 80k units took ${large.toFixed(1)}ms — likely super-linear`);
  assert.ok(large / Math.max(small, 1) < 12, `80k/20k ratio ${(large / small).toFixed(1)} — likely super-linear`);
});

test("a generic WebSite JSON-LD description does not outrank real body text (output:raw)", async () => {
  // A page ships a WebSite node WITH a long description plus real article body text.
  // Only a content-bearing @type's description may lead output:raw; the WebSite
  // description must not crowd out the genuine article body.
  const description = "This is the website description that is long enough to exceed the fifty char threshold.";
  const html = [
    "<html><head><title>Site</title>",
    '<script type="application/ld+json">',
    `{"@context":"https://schema.org","@type":"WebSite","name":"Site","description":${JSON.stringify(description)}}`,
    "</script></head><body>",
    "<main><h1>Real Article Headline</h1>",
    "<p>This is the genuine article body text that agents should see first.</p>",
    "</main></body></html>",
  ].join("");
  const result = await extractTier1FromFetchResult({
    requestedUrl: "https://example.test/article",
    fetchResult: fetchResult("https://example.test/article", html),
    extractHtml,
    durationMs: 10,
    output: "raw",
  });
  assert.doesNotMatch(result.result, /website description/);
  assert.match(result.result, /genuine article body text/);
});

test("prototype-pollution.html drops unsafe app-state keys without mutating prototypes", () => {
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  const extraction = extractHtml({
    html: fixture("prototype-pollution.html"),
    url: "https://example.test/pollution",
  });

  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.deepEqual(extraction.structured.appState, {
    __NEXT_DATA__: {
      props: {
        pageProps: {
          safe: true,
          nested: { kept: "value" },
        },
      },
    },
  });
  assert.deepEqual(
    extraction.errors.map((error) => error.code),
    ["unsafe_json_key", "unsafe_json_key", "unsafe_json_key"],
  );
});

test("malformed.html returns partial structured data instead of throwing", () => {
  const extraction = extractHtml({
    html: fixture("malformed.html"),
    url: "https://example.test/malformed",
  });

  assert.equal(extraction.title, "Malformed Fixture");
  assert.deepEqual(extraction.structured.og, { "og:title": "Recovered OG" });
  assert.deepEqual(extraction.structured.jsonLd, {
    "@context": "https://schema.org",
    "@type": "Thing",
    name: "Recovered",
  });
  assert.equal(extraction.text, "Recovered body text despite missing closing tags");
  assert.equal(extraction.shellGate.reason, "structured-data-found");
});

test("Tier-1 use case returns Result-compatible structured data and shell evidence", async () => {
  const result = await extractTier1FromFetchResult({
    requestedUrl: "https://example.test/requested",
    fetchResult: fetchResult("https://example.test/app", fixture("spa-shell.html")),
    extractHtml,
    durationMs: 12,
    fetchMs: 8,
    output: "raw",
    fetchedAt: "2026-06-16T00:00:00.000Z",
  });

  assert.equal(result.schemaVersion, 1);
  assert.equal(result.url, "https://example.test/requested");
  assert.equal(result.finalUrl, "https://example.test/app");
  assert.equal(result.tier, 1);
  assert.equal(result.output, "raw");
  assert.equal(result.jsRequired, true);
  assert.equal(result.resolvedVia, "tier1-shell-gate");
  assert.deepEqual(result.attempts, [{
    step: 1,
    tier: 1,
    outcome: "escalate",
    status: 200,
    durationMs: 8,
    bytes: Buffer.byteLength(fixture("spa-shell.html")),
    reason: "empty-spa-shell",
  }]);
  assert.deepEqual(result.structured, {
    meta: { viewport: "width=device-width, initial-scale=1" },
  });
  assert.equal(result.result, "");
  assert.equal(JSON.stringify(result).includes("Set-Cookie"), false);
  assert.equal(JSON.stringify(result).includes("Authorization"), false);
});

test("preferredTitle uses a content-bearing JSON-LD title when <title> is generic", () => {
  // e2b-style iframe case: host page <title> is "Careers — E2B" but the
  // embedded JobPosting JSON-LD carries the real title.
  const iframe = preferredTitle("Careers — E2B", {
    jsonLd: { "@type": "JobPosting", title: "Platform Engineer" },
  });
  assert.equal(iframe, "Platform Engineer");

  // Ashby direct: <title> already contains the JSON-LD title and is richer,
  // so the <title> is kept.
  const ashby = preferredTitle("Platform Engineer @ E2B", {
    jsonLd: { "@type": "JobPosting", title: "Platform Engineer" },
  });
  assert.equal(ashby, "Platform Engineer @ E2B");

  // Homepage with an Organization node: Organization is not a content type, so
  // the page <title> is preserved over the generic org name.
  const home = preferredTitle("E2B — Sandboxes for AI agents", {
    jsonLd: { "@type": "Organization", name: "E2B" },
  });
  assert.equal(home, "E2B — Sandboxes for AI agents");

  // headline + @graph wrapper.
  const graph = preferredTitle("Site Name", {
    jsonLd: { "@graph": [{ "@type": "NewsArticle", headline: "Breaking Story" }] },
  });
  assert.equal(graph, "Breaking Story");

  // Full-IRI @type form (https://schema.org/JobPosting).
  const iri = preferredTitle("Generic", {
    jsonLd: { "@type": "https://schema.org/JobPosting", title: "Platform Engineer" },
  });
  assert.equal(iri, "Platform Engineer");

  // Single-object @graph wrapper (not an array).
  const singleGraph = preferredTitle("Site", {
    jsonLd: { "@graph": { "@type": "NewsArticle", headline: "Solo Graph Story" } },
  });
  assert.equal(singleGraph, "Solo Graph Story");

  // Multiple content-bearing nodes: first in document order wins (the page's
  // primary content). This is a deliberate heuristic, locked here intentionally.
  const multi = preferredTitle("Site", {
    jsonLd: [
      { "@type": "NewsArticle", headline: "First Story Wins" },
      { "@type": "JobPosting", title: "Some Job" },
    ],
  });
  assert.equal(multi, "First Story Wins");

  // A SocialMediaPosting is NOT a reliable page subject (often an embed), so it
  // must not override the page <title> the way a JobPosting/Article does. (A pin's
  // caption is still surfaced via leadDescription pass 2; the title comes from the
  // page <title>, which on real pin pages is descriptive.)
  const embed = preferredTitle("Real Article", {
    jsonLd: { "@type": "SocialMediaPosting", headline: "Embedded Post Headline" },
  });
  assert.equal(embed, "Real Article");

  // No structured data: <title> passes through.
  assert.equal(preferredTitle("Just a title", {}), "Just a title");
  assert.equal(preferredTitle(undefined, {}), undefined);
});

test("4xx/5xx response: body returned, jsRequired forced false (no false render-blocked) [GUARD, was GAP]", async () => {
  // A thin text/html 404 (nginx default / SSG error page) used to fail the shell-gate's
  // hasContent check -> empty-spa-shell -> jsRequired:true -> render-blocked with a false
  // gateReason. Now a 4xx/5xx forces jsRequired:false + resolvedVia "tier1-error" + an
  // http_error provenance warning; the body is still returned for the agent to read.
  const body = "<html><body>Not Found</body></html>";
  const result = await extractTier1FromFetchResult({
    requestedUrl: "https://example.test/missing",
    fetchResult: { ...fetchResult("https://example.test/missing", body), status: 404 },
    extractHtml,
    durationMs: 50,
    fetchMs: 40,
    output: "raw",
  });
  assert.equal(result.tier, 1, "an error response stays at Tier-1 (not render-blocked)");
  assert.equal(result.jsRequired, false, "a 4xx is not a JS shell — never escalate to render");
  assert.equal(result.resolvedVia, "tier1-error");
  assert.equal(result.code, 404);
  assert.ok(result.errors.some((e) => e.code === "http_error"), "http_error provenance warning recorded");
  assert.ok((result.result ?? "").length > 0, "the error body is still returned");
});

function fixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), "utf8");
}

function fetchResult(finalUrl: string, html: string, contentType: string = "text/html; charset=utf-8"): FetcherResult {
  return {
    status: 200,
    finalUrl,
    redirects: [],
    bodyStream: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(html));
        controller.close();
      },
    }),
    contentType,
    bytes: Buffer.byteLength(html),
  };
}

// REDOS-1/2/3: the extraction regexes were quadratic on pathological HTML
// (unterminated `<!--`, bare-`<` flood, unterminated `<script>`). The linear
// scanners are O(n); these guard against a quadratic regression and pin the
// spacing / close-tag-boundary behavior the old regexes had.
test("stripHtmlTags scales linearly on a bare-`<` flood (REDOS-2)", () => {
  assert.equal(stripHtmlTags("<".repeat(1000)), "<".repeat(1000)); // no '>' → literal
  // CI-independent regression guard: a 4x input must take ~4x (linear), not ~16x
  // (quadratic). Ratio avoids flaking on slow/loaded runners, unlike a fixed
  // wall-clock budget.
  const timed = (n: number): number => {
    const t = performance.now();
    stripHtmlTags("<".repeat(n));
    return performance.now() - t;
  };
  timed(200_000); // JIT warmup
  const ratio = timed(800_000) / Math.max(timed(200_000), 1);
  assert.ok(ratio < 8, `stripHtmlTags 800k/200k ratio ${ratio.toFixed(1)} — likely quadratic`);
});

test("stripHtmlTags replaces tags with spaces so words don't merge", () => {
  const out = stripHtmlTags("<a>x</a><b>y</b>");
  assert.doesNotMatch(out, /xy/, "adjacent tags must not merge their text");
  assert.match(out, /x/);
  assert.match(out, /y/);
});

test("stripHtmlComments is linear on unterminated `<!--` and replaces with a space", () => {
  assert.equal(stripHtmlComments("<!--".repeat(50_000)), " "); // no '-->' → stop
  assert.equal(stripHtmlComments("a<!-- c -->b"), "a b");
});

test("extractVisibleText completes on pathological floods without hanging (REDOS-1/2/3)", () => {
  const pathological = `<html><body>${"<script>".repeat(20_000)}${"<!--".repeat(20_000)}${"<".repeat(20_000)}</body></html>`;
  assert.equal(typeof extractVisibleText(pathological), "string");
});

test("extractVisibleText separates words across tags (no merge regression)", () => {
  const text = extractVisibleText("<html><body><h1>Heading</h1><p>Hello</p></body></html>");
  assert.match(text, /Heading Hello/, "a space where each tag was");
});

test("extractVisibleText rejoins inline-split prices without merging lists/periods", () => {
  // `<span>$</span><span>10</span><span>.90</span>` -> "$ 10 .90" (each tag became
  // a space) -> "$10.90".
  assert.equal(extractVisibleText("<p><span>$</span><span>10</span><span>.90</span></p>"), "$10.90");
  const mixed = extractVisibleText("<p>Total 10 .90; list 10, 20, 30. End. Next.</p>");
  assert.match(mixed, /Total 10\.90;/, "decimal fragment rejoined");
  assert.match(mixed, /10, 20, 30/, "comma list preserved");
  assert.match(mixed, /End\. Next\./, "sentence periods preserved");
  // A literal "$ 1" (no decimal — e.g. inside <pre>/<code> where the space is
  // meaningful) must NOT be collapsed to "$1".
  assert.equal(extractVisibleText("<pre>token: $ 1</pre>"), "token: $ 1");
});

test("extractVisibleText does not treat </scripture> as a </script> close", () => {
  const html = `<html><body><script>var s = "</scripture>";</script><p>Visible</p></body></html>`;
  const text = extractVisibleText(html);
  assert.match(text, /Visible/);
  assert.doesNotMatch(text, /scripture|var s/i, "script content removed via the real </script> close");
});

test("extractVisibleText still strips script/style/comments/tags on well-formed HTML", () => {
  const html = `<html><head><style>.x{color:red}</style></head><body><script>var x=1;</script><!-- note --><h1>Heading</h1><p>Hello &amp; world</p></body></html>`;
  const text = extractVisibleText(html);
  assert.match(text, /Heading/);
  assert.match(text, /Hello & world/);
  assert.doesNotMatch(text, /var x|note|color:red/, "script/style/comment content removed");
});

test("extractHtml scales linearly on a <title> bare-`<` flood (REDOS-2 in metadata.ts)", () => {
  const html = (n: number): string => `<html><head><title>${"<".repeat(n)}</title></head><body>x</body></html>`;
  // Two guards, per stripHiddenSubtrees: an absolute budget (robust to CI load — a real O(n²)
  // blow-up is ~30x over it) AND a sub-quadratic ratio (CI-machine-independent). The ratio alone
  // at <8 flaked on loaded CI runners (200k/50k hit 8.3); <12 still catches a true quadratic (16x).
  const timed = (n: number): number => {
    const t = performance.now();
    extractHtml({ html: html(n), url: "https://example.test/" });
    return performance.now() - t;
  };
  timed(50_000); // JIT warmup
  const small = timed(50_000);
  const large = timed(200_000); // 4x input (linear ≈ 4x time; quadratic ≈ 16x)
  assert.equal(typeof extractHtml({ html: html(100), url: "https://example.test/" }).title, "string");
  assert.ok(large < 2000, `extractHtml 200k title flood took ${large.toFixed(1)}ms — likely super-linear`);
  assert.ok(large / Math.max(small, 1) < 12, `extractHtml title 200k/50k ratio ${(large / small).toFixed(1)} — likely quadratic`);
});

// --- Tier-1 extraction-fidelity coverage (charset/CSS-hidden/CDATA/SVG/app-state) ---

test("collectHiddenDisplayNoneClasses finds single-class display:none rules only", () => {
  const css = `<style>
    .a { display: none }
    .b { display: block }
    .c, .d { display: none !important }
    .parent .child { display: none }
    #id-only { display: none }
  </style>`;
  const classes = collectHiddenDisplayNoneClasses(css);
  assert.ok(classes.has("a"), ".a hidden");
  assert.ok(classes.has("c"), ".c hidden (!important stripped, value still none)");
  assert.ok(classes.has("d"), ".d hidden");
  assert.ok(!classes.has("b"), ".b is display:block");
  assert.ok(!classes.has("parent"), "combinator selector skipped (no over-hiding)");
  assert.ok(!classes.has("child"), "descendant in combinator skipped");
  assert.ok(!classes.has("id-only"), "id selector not a class");
});

test("stripHiddenSubtrees drops a class-hidden subtree given the class set", () => {
  // Style block already stripped upstream (as in extractVisibleText); the div is
  // hidden only via its class matching the collected set.
  const html = `<div class="config-hidden">SECRET tenantId</div><p>visible keep</p>`;
  const classes = new Set(["config-hidden"]);
  const out = stripHiddenSubtrees(html, classes);
  assert.doesNotMatch(out, /SECRET|tenantId/);
  assert.match(out, /visible keep/);
});

test("extractVisibleText strips class-based display:none from a <style> block", () => {
  const html = `<html><head><style>.config-hidden{display:none}</style></head>` +
    `<body><h1>Senior Engineer</h1><div class="config-hidden">{"tenantId":"x"}</div></body></html>`;
  const text = extractVisibleText(html);
  assert.match(text, /Senior Engineer/);
  assert.doesNotMatch(text, /tenantId/);
});

test("extractVisibleText preserves SVG <text> chart data", () => {
  const html = `<body><h1>Q3 Report</h1>` +
    `<svg><title>chart</title><text>Q1: $1.2M</text><text>Q2: $1.8M</text></svg></body>`;
  const text = extractVisibleText(html);
  assert.match(text, /Q1: \$1\.2M/);
  assert.match(text, /Q2: \$1\.8M/);
});

test("extractJsonLd strips CDATA wrappers from legacy-CMS JSON-LD", () => {
  const html = `<script type="application/ld+json">//<![CDATA[\n` +
    `{"@type":"NewsArticle","headline":"Legacy","articleBody":"CDATA body recovered"}\n//]]></script>`;
  const ex = extractHtml({ html, url: "https://example.test/cdata" });
  assert.ok(ex.structured.jsonLd, "JSON-LD parsed despite CDATA wrapper");
  assert.match(JSON.stringify(ex.structured.jsonLd), /CDATA body recovered/);
});

test("extractAppState harvests __PRELOADED_STATE__ and any application/json script", () => {
  const html = `<script>window.__PRELOADED_STATE__={"reviews":[{"body":"deep"}]};</script>` +
    `<script type="application/json" id="__APP_DATA__">{"spec":"x"}</script>`;
  const errors: unknown[] = [];
  const state = extractAppState(html, errors as never) as Record<string, unknown>;
  assert.deepEqual(state, {
    __PRELOADED_STATE__: { reviews: [{ body: "deep" }] },
    __APP_DATA__: { spec: "x" },
  });
});

test("extractAppState never lets a hostile script id pollute prototypes", () => {
  const before = ({} as Record<string, unknown>).polluted;
  const html = `<script type="application/json" id="__proto__">{"polluted":"yes"}</script>`;
  const errors: unknown[] = [];
  const state = extractAppState(html, errors as never) as Record<string, unknown>;
  assert.equal(({} as Record<string, unknown>).polluted, before);
  assert.equal(state.__proto__ && (state.__proto__ as Record<string, unknown>).polluted, undefined);
});

test("extractVisibleText drops a hidden svg's <text> (no leak)", () => {
  const html = `<body><svg hidden><text>SECRET</text></svg><p>keep</p></body>`;
  const text = extractVisibleText(html);
  assert.doesNotMatch(text, /SECRET/);
  assert.match(text, /keep/);
});

test("a <style> inside a script string does not hide real content", () => {
  const html = `<html><head>` +
    `<script>const t='<style>.article{display:none}</style>'</script>` +
    `</head><body><div class="article">VISIBLE ARTICLE</div></body></html>`;
  const text = extractVisibleText(html);
  assert.match(text, /VISIBLE ARTICLE/);
});

test("collectHiddenDisplayNoneClasses ignores inert script-string styles but keeps real ones", () => {
  const html = `<script>const t='<style>.inert{display:none}</style>'</script>` +
    `<style>.real-hidden{display:none}</style>`;
  const classes = collectHiddenDisplayNoneClasses(html);
  assert.ok(!classes.has("inert"), "style inside a script string is inert");
  assert.ok(classes.has("real-hidden"), "real style block still collected");
});

test("collectHiddenDisplayNoneClasses does not crash on a flood of bogus </style… misses", () => {
  const html = `<style>.x{display:none}</style>` + "</stylex".repeat(20000) + `<div class=x>OK</div>`;
  const classes = collectHiddenDisplayNoneClasses(html);
  assert.ok(classes.has("x"));
});

test("an empty SPA with only a generic JSON config script still escalates to render", () => {
  const html = `<html><body><div id="app"></div>` +
    `<script type="application/json" id="config">{"theme":"dark"}</script></body></html>`;
  const ex = extractHtml({ html, url: "https://example.test/shell" });
  assert.equal(ex.shellGate.reason, "empty-spa-shell");
  assert.equal(ex.shellGate.jsRequired, true);
  assert.ok(ex.structured.appState, "config JSON still harvested for debug/structured access");
});

test("collectHiddenDisplayNoneClasses skips print-only style blocks", () => {
  const html = `<style media="print">.article{display:none}</style><style>.real{display:none}</style>`;
  const classes = collectHiddenDisplayNoneClasses(html);
  assert.ok(!classes.has("article"), "print-only style is inert on screen");
  assert.ok(classes.has("real"), "default-media style collected");
});

test("extractVisibleText keeps content hidden only by a print stylesheet", () => {
  const html = `<html><head><style media="print">.article{display:none}</style></head>` +
    `<body><div class="article">VISIBLE ARTICLE</div></body></html>`;
  assert.match(extractVisibleText(html), /VISIBLE ARTICLE/);
});

test("extractVisibleText skips SVG <text> hidden via presentation attributes", () => {
  const html = `<body><svg><text display="none">SECRET</text><text>VISIBLE</text></svg></body>`;
  const text = extractVisibleText(html);
  assert.doesNotMatch(text, /SECRET/);
  assert.match(text, /VISIBLE/);
});

test("extractVisibleText drops SVG <text> inside a hidden ancestor <g display=none>", () => {
  const html = `<body><svg><g display="none"><text>SECRET</text></g><text>VISIBLE</text></svg></body>`;
  const text = extractVisibleText(html);
  assert.doesNotMatch(text, /SECRET/);
  assert.match(text, /VISIBLE/);
});

test("extractAppState caps id-less JSON scripts and stays O(n)", () => {
  let html = `<script type="application/json" id="__APP_DATA__">{"keep":1}</script>`;
  for (let i = 0; i < 3000; i += 1) html += `<script type="application/json">{}</script>`;
  const errors: unknown[] = [];
  const state = extractAppState(html, errors as never) as Record<string, unknown>;
  assert.equal((state.__APP_DATA__ as { keep: number }).keep, 1, "named script still harvested");
  const synthetic = Object.keys(state).filter((k) => k.startsWith("__json_script_"));
  assert.ok(synthetic.length <= 256, `synthetic keys capped (got ${synthetic.length})`);
});

test("collectHiddenDisplayNoneClasses respects non-screen media queries", () => {
  const html =
    `<style media="not screen">.a{display:none}</style>` +
    `<style media="print and (color)">.b{display:none}</style>` +
    `<style media="(min-width: 0)">.c{display:none}</style>` +
    `<style>.d{display:none}</style>`;
  const classes = collectHiddenDisplayNoneClasses(html);
  assert.ok(!classes.has("a"), "'not screen' excludes screen");
  assert.ok(!classes.has("b"), "'print and (color)' is non-screen");
  assert.ok(classes.has("c"), "bare query defaults to all");
  assert.ok(classes.has("d"), "no media applies");
});

test("inline style display:block overrides a class display:none", () => {
  const html = `<html><head><style>.h{display:none}</style></head>` +
    `<body><div class="h" style="display:block">VISIBLE</div></body></html>`;
  assert.match(extractVisibleText(html), /VISIBLE/);
});

test("a self-closing SVG hidden node does not suppress sibling <text>", () => {
  const html = `<body><svg><path display="none"/><text>VISIBLE</text></svg></body>`;
  const text = extractVisibleText(html);
  assert.match(text, /VISIBLE/);
});

test("a later display:block override on the same class un-hides content", () => {
  const html = `<html><head><style>.h{display:none}.h{display:block}</style></head>` +
    `<body><div class="h">VISIBLE</div></body></html>`;
  assert.match(extractVisibleText(html), /VISIBLE/);
});

test("collectHiddenDisplayNoneClasses still works with a leading @font-face at-rule", () => {
  const html = `<style>@font-face{font-family:x}.config-hidden{display:none}</style>`;
  const classes = collectHiddenDisplayNoneClasses(html);
  assert.ok(classes.has("config-hidden"), "utility rule after an at-rule still collected");
});

test("a self-closing SVG <text/> does not duplicate a sibling label", () => {
  const html = `<body><svg><text/><text>Q1</text></svg></body>`;
  const text = extractVisibleText(html);
  const matches = text.match(/Q1/g) ?? [];
  assert.equal(matches.length, 1, `expected one Q1, got ${matches.length}`);
});

test("a later <style> block re-shows a class an earlier block hid", () => {
  const html = `<html><head><style>.h{display:none}</style><style>.h{display:block}</style></head>` +
    `<body><div class="h">VISIBLE</div></body></html>`;
  assert.match(extractVisibleText(html), /VISIBLE/);
});

test("SVG <text> inside <defs>/<symbol> (non-rendering) is not inlined", () => {
  const html = `<body><svg><defs><text>SECRET-DEFS</text></defs>` +
    `<symbol id="s"><text>SECRET-SYMBOL</text></symbol><text>VISIBLE</text></svg></body>`;
  const text = extractVisibleText(html);
  assert.doesNotMatch(text, /SECRET-DEFS|SECRET-SYMBOL/);
  assert.match(text, /VISIBLE/);
});

test("a self-closing root <svg hidden/> does not suppress following siblings", () => {
  const html = `<body><svg hidden/><p>VISIBLE</p></body>`;
  assert.match(extractVisibleText(html), /VISIBLE/);
});

test("decodeHtmlEntities decodes the common named entities (not just the XML 5)", () => {
  assert.equal(decodeHtmlEntities("&copy; &mdash; &eacute; &hellip; &laquo; &raquo; &euro; &ldquo; &rdquo;"), "© — é … « » € “ ”");
  assert.equal(decodeHtmlEntities("r&eacute;sum&eacute; caf&eacute; na&iuml;ve"), "résumé café naïve");
  // numeric refs still decode every code point; unknown names pass through.
  assert.equal(decodeHtmlEntities("&#65; &#x263a; &notreal;"), "A ☺ &notreal;");
});

test("decodeHtmlEntities honors case-sensitive named entities (&Eacute; ≠ &eacute;)", () => {
  assert.equal(decodeHtmlEntities("&eacute; &Eacute;"), "é É");
  assert.equal(decodeHtmlEntities("&dagger; &Dagger;"), "† ‡");
  // a fully-uppercased lowercase entity still decodes leniently (&AMP; → &).
  assert.equal(decodeHtmlEntities("&AMP;"), "&");
});

// #94: a JSON API response must be returned raw — NOT run through the HTML scanners, which
// fabricated image URLs (registry.npmjs.org/%22…svg%22) by misparsing JSON string values as
// <img>/<source> tags. It must also be labeled contentType "json" and resolvedVia "tier1-json".

test("extractTier1: JSON response is raw, no fabricated images, contentType json, resolvedVia tier1-json (#94)", async () => {
  const json = JSON.stringify({
    description: '![badge](https://img.shields.io/x.svg) <img src="https://example.test/a.png">',
    versions: { "0.6.0": { dist: { tarball: "https://registry.test/x.tgz" } } },
  });
  const result = await extractTier1FromFetchResult({
    requestedUrl: "https://registry.test/pkg",
    fetchResult: fetchResult("https://registry.test/pkg", json, "application/json; charset=utf-8"),
    extractHtml,
    durationMs: 10,
  });
  assert.equal(result.result, json, "raw JSON returned verbatim, no HTML stripping");
  assert.equal(result.resolvedVia, "tier1-json");
  assert.equal(result.jsRequired, false);
  assert.equal(result.structured, undefined, "no HTML structured data fabricated from JSON");
  assert.equal(result.contentType, "application/json; charset=utf-8");
  assert.equal(classifyContentType(result), "json");
});

test("extractTier1: a text/plain response resolves via tier1-text with the raw body (#94)", async () => {
  const body = "404: Not Found";
  const result = await extractTier1FromFetchResult({
    requestedUrl: "https://x.test/missing",
    fetchResult: fetchResult("https://x.test/missing", body, "text/plain; charset=utf-8"),
    extractHtml,
    durationMs: 10,
  });
  assert.equal(result.result, body);
  assert.equal(result.resolvedVia, "tier1-text");
  assert.equal(result.structured, undefined);
  assert.equal(result.jsRequired, false);
});

test("isJsonContentType: application/json + +json suffixes, not text/html/absent (#94)", () => {
  assert.equal(isJsonContentType("application/json"), true);
  assert.equal(isJsonContentType("application/json; charset=utf-8"), true);
  assert.equal(isJsonContentType("application/vnd.api+json"), true);
  assert.equal(isJsonContentType("text/plain"), false);
  assert.equal(isJsonContentType("text/html"), false);
  assert.equal(isJsonContentType(undefined), false);
});

// #93: GitHub repo / blog / docs pages wrap the real content in <article>; without main-content
// selection, extractVisibleText flattened the whole <body> and the lean payload was pure nav chrome.

test("selectMainContentHtml returns the first <article>'s inner HTML, else null (#93)", () => {
  const withArticle = '<html><body><header>NAV</header><main>'
    + '<article class="markdown-body entry-content" itemprop="text"><h1>Title</h1><p>body</p></article>'
    + '</main><footer>FOOT</footer></body></html>';
  const main = selectMainContentHtml(withArticle);
  assert.match(main ?? "", /<h1>Title<\/h1>/);
  assert.equal(selectMainContentHtml("<html><body><div>no article here</div></body></html>"), null);
});

test("extractHtml scopes visible text to <article>, dropping GitHub-style nav chrome (#93)", () => {
  const html = "<html><body>"
    + "<header>Skip to content Navigation Menu Toggle navigation Sign in Pricing Saved searches</header>"
    + '<main id="js-repo-pjax-container"><article class="markdown-body entry-content container-lg" itemprop="text">'
    + "<h1>mcp-oauth-server</h1><p>OAuth 2.1 server. npm install mcp-oauth-server@latest</p>"
    + "</article></main><footer>© footer chrome</footer></body></html>";
  const out = extractHtml({ html, url: "https://github.com/x/y", contentType: "text/html; charset=utf-8" });
  assert.match(out.text, /mcp-oauth-server/);
  assert.match(out.text, /npm install/);
  for (const chrome of ["Skip to content", "Navigation Menu", "Pricing", "Saved searches", "© footer chrome"]) {
    assert.equal(out.text.includes(chrome), false, `chrome leaked into text: "${chrome}"`);
  }
});

test("extractHtml falls back to <main> when there is no <article> (VitePress/GitBook/mdBook docs) (#93 extension)", () => {
  // Docs themes that SSR prose into <main> with the sidebar in a sibling <aside> (no <article>).
  // <main> is a subset of <body>, so selecting it drops the header/footer/aside chrome.
  const html = "<html><body>"
    + "<header>Top nav: Skip to content Main Navigation Search</header>"
    + '<main><div class="vp-doc"><h1>Getting Started</h1><p>Vite is a build tool for modern web projects.</p></div></main>'
    + "<aside>Sidebar: Guide Config Plugins Resources</aside>"
    + "<footer>Footer chrome</footer></body></html>";
  const out = extractHtml({ html, url: "https://docs.test/guide/", contentType: "text/html; charset=utf-8" });
  assert.match(out.text, /Getting Started/);
  assert.match(out.text, /Vite is a build tool/);
  for (const chrome of ["Top nav", "Skip to content", "Main Navigation", "Sidebar", "Guide Config Plugins", "Footer chrome"]) {
    assert.equal(out.text.includes(chrome), false, `chrome leaked from <main> selection: "${chrome}"`);
  }
});

// #108: selectMainContentHtml scores <article>/<main> by visible-text length instead of blindly
// returning the first <article>. <main> wins only when substantially richer (MAIN_OVERRIDE_FACTOR);
// chrome (aside/nav/footer) is stripped first. The old code returned the FIRST <article> — a 4-word
// card tile on hub pages (MS-Learn) — ignoring a far richer <main>.

test("selectMainContentHtml: <main> wins over card-grid <article> tiles when substantially richer (#108)", () => {
  assert.equal(MAIN_OVERRIDE_FACTOR, 1.5);
  const html = "<html><body><header>Microsoft Learn Global navigation</header>"
    + "<main>"
    + "<h1>Azure Storage documentation</h1>"
    + "<p>Find quickstarts, tutorials, and samples to learn about Azure Storage service options.</p>"
    + "<section>"
    + "<article><h3>Introduction to Azure Storage</h3><p>Overview of storage options.</p></article>"
    + "<article><h3>Storage account overview</h3><p>Learn about storage account types.</p></article>"
    + "<article><h3>Blob storage</h3><p>Object storage for unstructured data.</p></article>"
    + "</section>"
    + "</main><footer>Microsoft Learn footer Privacy cookies Terms</footer></body></html>";
  const out = extractHtml({ html, url: "https://learn.microsoft.com/en-us/azure/storage/", contentType: "text/html; charset=utf-8" });
  // The hub intro (only in <main>, not in any tile) is present → <main> was selected, not a tile.
  assert.match(out.text, /Azure Storage documentation/);
  assert.match(out.text, /Find quickstarts/);
  // Header/footer chrome (outside <main>) is absent.
  for (const chrome of ["Microsoft Learn Global navigation", "Microsoft Learn footer", "Privacy cookies"]) {
    assert.equal(out.text.includes(chrome), false, `chrome leaked: "${chrome}"`);
  }
});

test("selectMainContentHtml: <article> wins when <main> only adds footer/nav chrome (#108)", () => {
  assert.equal(MAIN_OVERRIDE_FACTOR, 1.5);
  // Mintlify/Anthropic shape: <main> wraps the real <article> plus a global footer; the footer is
  // chrome, so <main> is only ~1.0× the article → the <article>'s tighter scope must win.
  const articleBody = "<h1>Building effective agents</h1>"
    + "<p>Agents skip process. This is a long enough article body to exceed the empty-candidate guard.</p>";
  const html = "<html><body>"
    + `<main><article>${articleBody}</article>`
    + "<footer>Platform Docs Solutions AI agents Company Careers Privacy policy Terms of service</footer>"
    + "</main></body></html>";
  const out = extractHtml({ html, url: "https://docs.anthropic.com/", contentType: "text/html; charset=utf-8" });
  assert.match(out.text, /Building effective agents/);
  for (const chrome of ["Platform Docs", "Careers", "Privacy policy", "Terms of service"]) {
    assert.equal(out.text.includes(chrome), false, `footer chrome leaked: "${chrome}"`);
  }
});

test("selectMainContentHtml: strips <aside>/<nav>/<footer> chrome from <main> before comparing (#108)", () => {
  // A <main> wrapping a clean <article> plus a heavy <aside> related-link farm must keep the
  // <article>; without the chrome-strip, main would be ~3× the article and override at factor 1.5.
  const html = "<html><body><main>"
    + "<article><h1>Real Post</h1><p>This is the real post body with enough prose to be meaningful here.</p></article>"
    + "<aside><h3>Related Posts</h3><ul>"
    + "<li><a href=\"/a\">Related article one with a longish title</a></li>"
    + "<li><a href=\"/b\">Related article two with another longish title</a></li>"
    + "<li><a href=\"/c\">Related article three with yet another long title</a></li>"
    + "</ul></aside>"
    + "</main></body></html>";
  const out = extractHtml({ html, url: "https://blog.example.com/post", contentType: "text/html; charset=utf-8" });
  assert.match(out.text, /Real Post/);
  for (const chrome of ["Related Posts", "Related article one", "Related article two", "Related article three"]) {
    assert.equal(out.text.includes(chrome), false, `aside chrome leaked: "${chrome}"`);
  }
});

test("selectMainContentHtml: prefers the FIRST <article> when there is no <main> (#108 conservative tie-break)", () => {
  // No <main>: keep #93 first-article behavior. A later, longer sibling <article> (a related/
  // author block) must NOT displace the page's primary (first) article. (Chrome-stripping means
  // a related block in an <aside> is already gone; this pins the bare-sibling decision too.)
  const html = "<html><body>"
    + "<article><h1>The Primary Article</h1><p>This is the main post the reader came for.</p></article>"
    + "<article><h3>Author Bio</h3><p>A longer author biography block with many more words than the primary post body above, included as a sibling article.</p></article>"
    + "</body></html>";
  const main = selectMainContentHtml(html);
  assert.match(main ?? "", /The Primary Article/);
  assert.equal((main ?? "").includes("Author Bio"), false, "longer later sibling article displaced the primary article");
});

test("selectMainContentHtml: a substantially richer sibling <article> overrides a loading skeleton on React pages (#118)", () => {
  // React streaming-SSR ships a short loading-skeleton <article> FIRST and the real streamed
  // article as a later, far-richer sibling (docs.anthropic.com: skeleton ~175 chars vs real
  // ~2901 chars, ~16x). First-article-wins would lock in the skeleton and return only "Loading..."
  // text; SIBLING_ARTICLE_OVERRIDE_FACTOR (5x) lets the real article win. The override is GATED to
  // React (the $RC swap marker makes reactStreaming true) so a non-React page's #108 first-article
  // tie-break is never displaced by a longer sibling. The modestly-longer author-bio sibling in the
  // test below (~2.4x) also stays under the 5x threshold, so #108 holds two ways.
  const skeleton = "<p>" + "Loading... ".repeat(5) + "</p>"; // ~55 chars, a minimal Suspense fallback
  const realBody = "<h1>Real Streamed Content</h1>"
    + "<p>This is the actual article body that React streams inside a Suspense boundary and reveals "
    + "after hydration. It carries the page's real prose — many sentences of genuine content that the "
    + "browser unveils once the boundary completes, far more than the loading placeholder above. "
    + "Captatum recognizes the streaming idiom at Tier-1 so this content is extracted without a render. "
    + "The real streamed article is substantially richer than the skeleton placeholder, so the "
    + "sibling-override factor lets it win the article pick instead of locking in the loading text. "
    + "This mirrors docs.anthropic.com where the boundary article is roughly sixteen times richer.</p>";
  // A `$RC` call makes revealedIds non-empty (the page is React streaming-SSR) so the React-gated
  // sibling-override can fire.
  const swap = "<script>$RC=function(a){var e=document.getElementById(a);if(e)e.removeAttribute('hidden')};$RC('S:1')</script>";
  const html = "<html><body>" + swap + "<article>" + skeleton + "</article><article>" + realBody + "</article></body></html>";
  const main = selectMainContentHtml(html);
  assert.match(main ?? "", /Real Streamed Content/);
  assert.equal((main ?? "").includes("Loading..."), false, "the substantially richer real article must override the skeleton on a React page");
});

test("selectMainContentHtml: a richer sibling does NOT override the primary on a non-React page (#108 tie-break, codex P2)", () => {
  // The sibling override is gated to React streaming. On a plain (non-React) page, a much-longer
  // later sibling — a related article, author block, or index teaser outside aside/nav/footer —
  // must NOT displace the page's primary (first) article, even when >5x richer. (Without the
  // reactStreaming gate, this regresses #108's first-article tie-break for every non-React page.)
  const primary = "<article><h1>Primary Post</h1><p>The main post.</p></article>";
  const longSibling = "<article><h3>Related</h3><p>" + "A very long related-article teaser. ".repeat(20) + "</p></article>";
  const html = "<html><body>" + primary + longSibling + "</body></html>"; // no $RC marker -> not React
  const main = selectMainContentHtml(html);
  assert.match(main ?? "", /Primary Post/);
  assert.equal((main ?? "").includes("Related"), false, "a non-React page's longer sibling must not displace the primary article");
});

test("selectMainContentHtml: a substantial primary is NOT displaced by a richer sibling even on a React page (#118 codex P2)", () => {
  // The override requires the FIRST article be skeleton-short. A React page that merely has a
  // `$RC` boundary elsewhere (e.g. a header widget) but a SUBSTANTIAL primary first <article>
  // followed by a much-longer sibling must keep the primary — only a short skeleton is overridden.
  const primary = "<article><h1>Primary Post</h1><p>" + "This is the real primary article body with substantial prose. ".repeat(40) + "</p></article>";
  const longSibling = "<article><h3>Related</h3><p>" + "A much longer related block. ".repeat(300) + "</p></article>";
  // React streaming is active (a $RC call) but the boundary is unrelated to the articles.
  const html = "<html><body><script>$RC('B:9','S:9')</script>" + primary + longSibling + "</body></html>";
  const main = selectMainContentHtml(html);
  assert.match(main ?? "", /Primary Post/);
  assert.equal((main ?? "").includes("Related"), false, "a substantial primary is not displaced even on a React page");
});

test("extractHtml: a nested React boundary inside the scoped <article> is preserved (#118 codex P1)", () => {
  // The $RC swap script is OUTSIDE the article; the article contains a NESTED React boundary.
  // Scoping to the article loses the $RC marker (a script, stripped/outside scope), so the
  // streaming flag must be threaded from the FULL page — otherwise extractVisibleText recomputes
  // false from the fragment and strips the nested boundary, silently omitting its streamed body.
  const html = "<html><body>"
    + "<script>$RC=function(a){var e=document.getElementById(a);if(e)e.removeAttribute('hidden')};$RC('B:5','S:5')</script>"
    + "<article><p>Visible intro paragraph with enough words to satisfy the shell gate alone.</p>"
    + "<div hidden id=\"S:5\"><p>Nested streamed body that must NOT be silently omitted.</p></div>"
    + "</article></body></html>";
  const out = extractHtml({ html, url: "https://example.test/", contentType: "text/html" });
  assert.match(out.text, /Nested streamed body that must NOT be silently omitted/);
});

test("selectMainContentHtml: empty <main> shell scopes to empty so chrome doesn't mask a needed render (#108, codex P2)", () => {
  // Client-rendered SPA shell: an empty <main id=root> (the render target) with header/footer
  // chrome OUTSIDE it. Scoping to the empty <main> leaves textLength 0 so the shell-gate escalates
  // to render. Returning null (full-body fallback) would let the chrome satisfy the gate and skip
  // the render the page actually needs.
  const html = "<html><body>"
    + "<header>Global navigation menu with many words of chrome that would satisfy the gate</header>"
    + "<main id=\"root\"></main>"
    + "<footer>Footer chrome Privacy Terms About Company Careers more words</footer>"
    + "</body></html>";
  const main = selectMainContentHtml(html);
  assert.equal(main, "", "empty <main> shell scopes to empty (not null -> full-body chrome)");
  const out = extractHtml({ html, url: "https://app.example.com/", contentType: "text/html; charset=utf-8" });
  assert.equal(out.shellGate.jsRequired, true, "empty <main> shell must escalate to render, not pass as content-present");
});

test("selectMainContentHtml: CJK <article> is scored by character length, not treated as a skeleton (#108)", () => {
  // No whitespace tokenization in CJK → a word-count skeleton filter would see "1 word" and drop
  // the whole article. Character-length scoring is script-agnostic and keeps it.
  const html = "<html><body>"
    + "<article><h1>存储简介</h1>"
    + "<p>Azure 存储是 Microsoft 提供的云存储解决方案。"
    + "它提供高度可用的、安全的、持久的存储。</p></article>"
    + "</body></html>";
  const main = selectMainContentHtml(html);
  assert.ok(main, "CJK article must be selected (not null)");
  const out = extractHtml({ html, url: "https://learn.microsoft.com/zh-cn/", contentType: "text/html; charset=utf-8" });
  assert.match(out.text, /存储简介/);
  assert.match(out.text, /Azure 存储/);
});

test("selectMainContentHtml: skeleton page with no <article>/<main> stays null (shell-gate handles it) (#108)", () => {
  // Scoping never suppresses a needed render: a JS shell with no <article>/<main> takes the fast
  // path (null), the full body feeds evaluateShellGate, and the terse skeleton trips jsRequired.
  const html = "<html><body><div id=\"root\"><div class=\"skeleton\">Loading content...</div></div></body></html>";
  assert.equal(selectMainContentHtml(html), null);
  const out = extractHtml({ html, url: "https://app.example.com/", contentType: "text/html; charset=utf-8" });
  assert.equal(out.shellGate.jsRequired, true);
});
