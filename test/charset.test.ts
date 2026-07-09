import assert from "node:assert/strict";
import { test } from "node:test";
import { prescanMetaCharset } from "../src/infrastructure/http/charset.ts";

const enc = (s: string) => new TextEncoder().encode(s);

test("prescanMetaCharset: a meta whose unquoted '>' is at EOF is terminated (#166 codex P2)", () => {
  assert.equal(prescanMetaCharset(enc(`<meta charset="utf-8">`)), "utf-8");
  assert.equal(prescanMetaCharset(enc(`<html><head><meta charset="windows-1252">`)), "windows-1252");
});

test("prescanMetaCharset: a '>' inside an open (unterminated) quote is NOT a terminator — malformed → undefined (#166 codex P2)", () => {
  // The final '>' sits inside the unterminated data= quote; there is no UNQUOTED terminator,
  // so the meta is malformed and no charset is trusted (don't decode from broken markup).
  assert.equal(prescanMetaCharset(enc(`<meta charset="utf-8" data="x>`)), undefined);
  // Same shape but padded so the in-quote '>' lands at the 1024-byte window edge — still no
  // unquoted terminator within the prescan window.
  assert.equal(prescanMetaCharset(enc(`<meta charset="utf-8" data="` + "x".repeat(995) + ">")), undefined);
});
