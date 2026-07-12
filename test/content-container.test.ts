// Non-frozen unit tests for the #165 no-landmark main-content container selector.
// Impl-detail guards (the allowlist, the tag set, class-tokenization, depth-aware span, the
// two-axis floor boundary, allowlist precision) — the CONTRACT is pinned effects-only in the
// frozen test/acceptance/165/. Per [[captatum-frozen-suite-contract-only]], impl-detail guards
// live here so a later floor/allowlist tweak does not churn the frozen hash.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  selectContentContainer,
  CONTENT_CONTAINER_MIN_CHARS,
  CONTENT_CONTAINER_MIN_FRACTION,
} from "../src/infrastructure/extract/content-container.ts";

const NO_IDS = new Set<string>();
const prose = (n: number): string => `Real article prose. `.repeat(n);

test("#165 recognizes a <div id=\"content\"> container and returns its inner html", () => {
  const body = `<div id="chrome">nav</div><div id="content"><p>${prose(30)}</p></div>`;
  const out = selectContentContainer(body, NO_IDS);
  assert.ok(out !== null, "container selected");
  assert.match(out!, /Real article prose/, "returns the inner content");
  assert.doesNotMatch(out!, /nav/, "chrome outside the container is excluded");
});

test("#165 recognizes a <section id=\"layout-content\"> (pins the div+section scan)", () => {
  const body = `<div class="topnav">nav</div><section id="layout-content"><p>${prose(30)}</p></section>`;
  const out = selectContentContainer(body, NO_IDS);
  assert.ok(out !== null, "section container selected");
  assert.match(out!, /Real article prose/);
});

test("#165 class-tokenization: a multi-class container matches on any token", () => {
  // class="entry-content wp-content" — a whole-string compare would miss it.
  const body = `<div class="chrome">nav</div><div class="entry-content wp-content"><p>${prose(30)}</p></div>`;
  assert.ok(selectContentContainer(body, NO_IDS) !== null, "multi-class entry-content recognized");
});

test("#165 allowlist precision: SPA app roots + chrome ids are NOT recognized", () => {
  for (const id of ["root", "app", "__next", "footer", "nav", "sidebar", "header", "wrapper", "container"]) {
    const body = `<div id="${id}"><p>${prose(30)}</p></div>`;
    assert.ok(selectContentContainer(body, NO_IDS) === null, `id="${id}" must NOT be selected`);
  }
});

test("#165 depth-aware span: a nested same-tag container is not truncated", () => {
  // #content wraps a nested <div>…</div>; a non-depth-aware pairing would cut at the inner </div>.
  const body = `<div id="content"><div class="inner">FIRST</div><p>${prose(30)}</p><div>LAST</div></div>`;
  const out = selectContentContainer(body, NO_IDS);
  assert.ok(out !== null);
  assert.match(out!, /FIRST/);
  assert.match(out!, /LAST/, "the matching close is the OUTER </div>, so the tail survives");
});

test("#165 floor (fraction): a minority container is rejected -> null (no content loss)", () => {
  // Container holds well under MIN_FRACTION of the body; the real content is a sibling.
  const container = `<div id="content"><p>${prose(4)}</p></div>`; // ~80 chars
  const sibling = `<div class="real"><p>${prose(40)}</p></div>`; // ~800 chars (majority)
  assert.ok(selectContentContainer(container + sibling, NO_IDS) === null, "minority container rejected");
});

test("#165 floor (absolute): a sub-MIN_CHARS container is rejected even if it is the whole body", () => {
  const tiny = `<div id="content"><p>short</p></div>`; // < CONTENT_CONTAINER_MIN_CHARS
  assert.ok(CONTENT_CONTAINER_MIN_CHARS > 80, "MIN_CHARS exceeds hasContent's 80 (cross-file invariant)");
  assert.ok(selectContentContainer(tiny, NO_IDS) === null, "sub-200-char container rejected");
});

test("#165 no recognized container -> null (whole-body fallback stands)", () => {
  const body = `<div class="post"><p>${prose(30)}</p></div>`; // no allowlisted id/class
  assert.ok(selectContentContainer(body, NO_IDS) === null);
});

test("#165 CONTENT_CONTAINER_MIN_FRACTION is 0.7 (clears both repros 0.96/0.91, rejects splits)", () => {
  assert.equal(CONTENT_CONTAINER_MIN_FRACTION, 0.7);
});

test("#165 id is case-insensitive; class tokens are case-insensitive", () => {
  const body = `<div id="CONTENT"><p>${prose(30)}</p></div>`;
  assert.ok(selectContentContainer(body, NO_IDS) !== null, "uppercase id matched");
  const body2 = `<div class="Entry-Content"><p>${prose(30)}</p></div>`;
  assert.ok(selectContentContainer(body2, NO_IDS) !== null, "mixed-case class token matched");
});
