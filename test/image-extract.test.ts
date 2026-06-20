import assert from "node:assert/strict";
import { test } from "node:test";
import { extractImages } from "../src/infrastructure/extract/images.ts";

const BASE = "https://example.test/article/one";

test("collects og:image, og:image:url, and og:image:secure_url", () => {
  const images = extractImages("", BASE, {
    "og:image": "https://cdn.test/a.jpg",
    "og:image:url": "https://cdn.test/a.jpg", // duplicate of og:image
    "og:image:secure_url": "https://cdn.test/b.jpg",
  }, undefined);
  assert.deepEqual(images, ["https://cdn.test/a.jpg", "https://cdn.test/b.jpg"]);
});

test("resolves relative <img> and <source srcset> URLs against the base URL", () => {
  const html = [
    `<img src="/abs.jpg">`,
    `<img data-src="rel.jpg">`,       // relative to /article/one → /article/rel.jpg
    `<source srcset="https://cdn.test/c.jpg 2x, https://cdn.test/d.jpg 3x">`,
  ].join("");
  const images = extractImages(html, BASE, undefined, undefined);
  assert.deepEqual(images, [
    "https://example.test/abs.jpg",
    "https://example.test/article/rel.jpg",
    "https://cdn.test/c.jpg", // only the first srcset candidate is taken
  ]);
});

test("extracts image URLs from JSON-LD (string, ImageObject, thumbnailUrl, @graph)", () => {
  const jsonLd = [
    { "@type": "Article", image: "https://cdn.test/article.jpg", thumbnailUrl: "https://cdn.test/thumb.jpg" },
    { "@type": "ImageObject", url: "https://cdn.test/object.jpg", contentUrl: "https://cdn.test/content.jpg" },
    { "@graph": [{ "@type": "Product", image: { "@type": "ImageObject", url: "https://cdn.test/graph.jpg" } }] },
  ];
  const images = extractImages("", BASE, undefined, jsonLd);
  assert.deepEqual(images, [
    "https://cdn.test/article.jpg",
    "https://cdn.test/thumb.jpg",
    "https://cdn.test/object.jpg",
    "https://cdn.test/content.jpg",
    "https://cdn.test/graph.jpg",
  ]);
});

test("skips non-http(s), data URIs, and private / localhost hosts", () => {
  const html = [
    `<img src="data:image/png;base64,AAAA">`,
    `<img src="javascript:alert(1)">`,
    `<img src="mailto:x@y.test">`,
    `<img src="https://10.0.0.5/secret.jpg">`,
    `<img src="https://localhost/admin.jpg">`,
    `<img src="https://intranet.local/panel.jpg">`,
    `<img src="https://cdn.test/ok.jpg">`,
  ].join("");
  const images = extractImages(html, BASE, undefined, undefined);
  assert.deepEqual(images, ["https://cdn.test/ok.jpg"]);
});

test("dedupes across sources and caps at the bound", () => {
  const og = { "og:image": "https://cdn.test/first.jpg" };
  const html = Array.from({ length: 30 }, (_, i) => `<img src="https://cdn.test/img${i}.jpg">`).join("");
  const images = extractImages(html, BASE, og, undefined);
  assert.ok(images && images.length <= 12, `expected <=12, got ${images?.length}`);
  assert.equal(images?.[0], "https://cdn.test/first.jpg"); // og:image gathered first
  assert.equal(new Set(images).size, images?.length); // no duplicates
});

test("returns undefined when no usable image is found", () => {
  assert.equal(extractImages("", BASE, undefined, undefined), undefined);
  assert.equal(extractImages(`<img src="data:image/png;base64,AAAA">`, BASE, undefined, undefined), undefined);
});

test("protocol-relative URLs resolve against the base to https", () => {
  const images = extractImages(`<img src="//cdn.test/rel.jpg">`, BASE, undefined, undefined);
  assert.deepEqual(images, ["https://cdn.test/rel.jpg"]);
});

test("strips IPv6 loopback/mapped, trailing-dot localhost, and cloud-metadata hosts", () => {
  const html = [
    `<img src="https://[::1]/x.jpg">`,
    `<img src="https://[::ffff:127.0.0.1]/x.jpg">`,
    `<img src="https://localhost./admin.jpg">`,
    `<img src="https://metadata.google.internal/computeMetadata/v1/">`,
    `<img src="https://cdn.test/kept.jpg">`,
  ].join("");
  assert.deepEqual(extractImages(html, BASE, undefined, undefined), ["https://cdn.test/kept.jpg"]);
});

test("collects data-src only (lazy-load), ignores empty srcset and bare <img>", () => {
  const html = [
    `<img data-src="lazy.jpg">`,       // lazy-loaded, no src
    `<img>`,                            // nothing
    `<source srcset="">`,               // empty srcset
    `<source>`,                         // no srcset
  ].join("");
  assert.deepEqual(extractImages(html, BASE, undefined, undefined), ["https://example.test/article/lazy.jpg"]);
});

test("rejects absurdly long URLs (payload-bloat guard)", () => {
  const huge = "https://cdn.test/" + "a".repeat(3000);
  assert.deepEqual(extractImages(`<img src="${huge}">`, BASE, undefined, undefined), undefined);
});
