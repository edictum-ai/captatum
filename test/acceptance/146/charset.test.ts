// FROZEN acceptance suite for #146 (C-sibling) — quote-aware meta-charset tag-end.
// Authored independently of the implementation; asserts the DESIRED behavior. The
// (C-sibling) fix target WILL FAIL against the current quote-blind prescan
// (`lower.indexOf(">", at)` at charset.ts:35): a `>` inside a meta attribute chops the
// tag before `charset=` → charset undetected → page decoded wrong (mojibake). The
// sentinel cases guard the FIXED code against a naive `tagEnd >= length` boundary bug.
//
// Spec: docs/specs/146-noisy-extraction.md (C-sibling).
//
// `prescanMetaCharset` takes a Uint8Array (raw body bytes; only the first 1024 are
// inspected). `toBytes` encodes ASCII text to bytes (non-ASCII bytes would map to '_').

import assert from "node:assert/strict";
import { test } from "node:test";
import { prescanMetaCharset } from "../../../src/infrastructure/http/charset.ts";

const toBytes = (s: string): Uint8Array => new TextEncoder().encode(s);

test("#146 (C-sibling) a quoted `>` in a meta attr does not block charset detection", () => {
  // Current: indexOf(">") chops at the `>` inside data="a>b" → charset= never reached.
  assert.equal(prescanMetaCharset(toBytes('<meta data="a>b" charset="utf-8">')), "utf-8");
  assert.equal(prescanMetaCharset(toBytes("<meta data='a>b' charset='utf-8'>")), "utf-8");
});

test("#146 (C-sibling) http-equiv Content-Type with a quoted `>` still yields the charset", () => {
  // Same class, HTML4 form: charset lives inside content=". A quoted `>` earlier in the
  // tag must not chop it before content= is reached.
  const html = `<meta data="a>b" http-equiv="Content-Type" content="text/html; charset=windows-1252">`;
  assert.equal(prescanMetaCharset(toBytes(html)), "windows-1252");
});

test("#146 (C-sibling) a plain <meta charset> without a quoted `>` is unaffected", () => {
  // Regression: no quoted `>` → current already parses this. Must stay detected.
  assert.equal(prescanMetaCharset(toBytes('<meta charset="utf-8">')), "utf-8");
  assert.equal(prescanMetaCharset(toBytes("<meta charset='shift_jis'>")), "shift_jis");
});

test("#146 (C-sibling) sentinel: a <meta charset> ending exactly at EOF is not mis-classified unterminated", () => {
  // The whole input is the meta tag (its `>` is the last byte). findTagEnd returns
  // html.length here (the `>` is the final char); a naive `tagEnd >= length` guard would
  // wrongly treat this as unterminated → charset undetected → mojibake. The char-check
  // form (last char IS `>`) must keep it classified as terminated.
  assert.equal(prescanMetaCharset(toBytes('<meta charset="utf-8">')), "utf-8");
});

test("#146 (C-sibling) sentinel: a <meta charset> ending exactly at the 1024-byte window edge", () => {
  // The prescan inspects only the first 1024 bytes. Place the meta so its `>` is the
  // LAST byte of the window (byte 1023). A naive boundary guard would treat the tag as
  // unterminated (tagEnd == 1024 == window length); the char-check must still detect it.
  const meta = '<meta charset="utf-8">';
  const pad = "x".repeat(1024 - meta.length); // `<` at byte 1002, `>` at byte 1023
  const bytes = toBytes(pad + meta);
  assert.equal(bytes.length, 1024, "fixture sanity: the meta `>` is the final window byte");
  assert.equal(prescanMetaCharset(bytes), "utf-8");
});

test("#146 (C-sibling) a genuinely unterminated meta (no `>`) yields no charset", () => {
  // Contrast to the sentinel: a meta with NO `>` at all really is unterminated → undefined.
  assert.equal(prescanMetaCharset(toBytes('<meta charset="utf-8"')), undefined);
});
