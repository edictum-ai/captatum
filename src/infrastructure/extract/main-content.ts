import { collectHiddenDisplayNoneClasses } from "./hidden-classes.ts";
import { stripHiddenSubtrees } from "./hidden.ts";
import { findElements, stripElement, stripHtmlComments } from "./html.ts";

/**
 * Selects the page's main-content HTML so `extractVisibleText` doesn't flatten site chrome
 * (nav / header / footer) ahead of the real body. Targets the first `<article>` — the semantic
 * "self-contained content" element, which on repo/readme pages (GitHub's `<article
 * class="markdown-body entry-content">`) and most blog/docs pages holds the actual content.
 *
 * `<article>` is chosen over `<div id="readme">` / `<div class="markdown-body">` deliberately:
 * divs nest, so a first-close match (findElements / findCloseTag) would cut at the innermost
 * child's `</div>` — the balanced depth-counting extractor that case needs is the hard #54
 * Half B problem. Articles rarely nest, so first-close is correct here. Returns null when there
 * is no (visible, non-inert) `<article>`, so the caller falls back to the full body (today's
 * behavior) — no regression for pages that use `<main>`/`<div>` only.
 *
 * The page is pre-cleaned EXACTLY as `extractVisibleText` does before searching: hidden classes
 * are collected from the full page (so `<head><style>.x{display:none}</style>` rules apply), then
 * script/style/noscript/template + comments + hidden subtrees are stripped. This guarantees:
 *  (a) a literal `<article>` inside a `<script>`/`<template>`/comment isn't picked over the real
 *      article (#97 review);
 *  (b) an `<article>` inside a hidden boundary (React streaming's `<div hidden id="S:1">) isn't
 *      selected;
 *  (c) class-hidden nodes inside the article are already gone (so scoping to the article doesn't
 *      lose the head `<style>` context that `extractVisibleText` would have used) (#97 review). (#93)
 */
export function selectMainContentHtml(html: string): string | null {
  const hiddenClasses = collectHiddenDisplayNoneClasses(html);
  const withoutCode = ["script", "style", "noscript", "template"]
    .reduce((value, tag) => stripElement(value, tag), html);
  const clean = stripHtmlComments(stripHiddenSubtrees(withoutCode, hiddenClasses));
  const article = findElements(clean, "article")[0];
  return article ? article.content : null;
}
