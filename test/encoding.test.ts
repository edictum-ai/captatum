import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeBody } from "../src/infrastructure/http/body.ts";

function streamOf(bytes: number[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(bytes)); c.close(); } });
}

test("decodeBody honors a declared non-UTF-8 charset (elmundo iso-8859-15 regression)", async () => {
  // "apagón" with ó encoded as 0xF3 (iso-8859-15), not the UTF-8 C3 B3.
  const text = await decodeBody(streamOf([0x61, 0x70, 0x61, 0x67, 0xf3, 0x6e]), "text/html; charset=iso-8859-15");
  assert.equal(text, "apagón");
});

test("decodeBody defaults to UTF-8 when no charset is declared", async () => {
  const text = await decodeBody(streamOf([0xc3, 0xb3]), "text/html");
  assert.equal(text, "ó");
});

test("decodeBody falls back to UTF-8 on an unsupported charset label", async () => {
  const text = await decodeBody(streamOf([0xc3, 0xb3]), "text/html; charset=not-a-real-encoding");
  assert.equal(text, "ó");
});

test("decodeBody prescans <meta charset> when the header omits one (windows-1252)", async () => {
  // "Café" with é as byte 0xE9 (windows-1252), header has no charset, meta declares it.
  const raw = `<html><head><meta charset="windows-1252"><title>Café</title></head></html>`;
  const bytes = Array.from(Buffer.from(raw, "latin1"));
  const text = await decodeBody(streamOf(bytes), "text/html");
  assert.equal(text, raw); // é stays é, not the UTF-8 mojibake "Ã©"
});

test("decodeBody prescans an http-equiv Content-Type charset", async () => {
  const raw = `<meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1">Café`;
  const bytes = Array.from(Buffer.from(raw, "latin1"));
  const text = await decodeBody(streamOf(bytes), "text/html");
  assert.match(text, /Café/);
});

test("decodeBody: an HTTP charset beats a lying <meta charset>", async () => {
  // Body is genuine UTF-8 (é = C3 A9) but carries a lying <meta charset=windows-1252>;
  // the header's utf-8 must win so it decodes as é, not the latin1 "Ã©".
  const meta = Buffer.from(`<meta charset="windows-1252">`, "ascii");
  const body = Buffer.concat([meta, Buffer.from([0xc3, 0xa9])]);
  const text = await decodeBody(streamOf(Array.from(body)), "text/html; charset=utf-8");
  assert.ok(text.endsWith("é"), `expected é, got ${JSON.stringify(text.slice(-4))}`);
});

test("decodeBody prescans a shift_jis meta charset for CJK", async () => {
  // "漢字" in Shift_JIS = 8A BF 8E 9A, behind a shift_jis meta (no header charset).
  const prefix = Buffer.from(`<meta charset="shift_jis">`, "ascii");
  const bytes = Array.from(Buffer.concat([prefix, Buffer.from([0x8a, 0xbf, 0x8e, 0x9a])]));
  const text = await decodeBody(streamOf(bytes), "text/html");
  assert.ok(text.endsWith("漢字"), `expected 漢字, got ${JSON.stringify(text.slice(-4))}`);
});

test("decodeBody does NOT prescan a declared application/json body for <meta charset>", async () => {
  // JSON body whose first bytes carry an HTML snippet must stay UTF-8 (not be
  // re-decoded as windows-1252 by the meta prescan).
  const raw = `<meta charset="windows-1252">{"v":"Café"}`;
  const bytes = Array.from(Buffer.from(raw, "utf-8")); // é = C3 A9 in UTF-8
  const text = await decodeBody(streamOf(bytes), "application/json");
  assert.match(text, /Café/);
  assert.doesNotMatch(text, /CafÃ©/);
});

test("decodeBody ignores a non-declaration charset substring (data-charset / content)", async () => {
  // Genuine UTF-8 body; a `data-charset` attr and a `charset=` inside an unrelated
  // attribute value must NOT re-decode the page as windows-1252.
  const raw = `<meta data-charset="windows-1252"><meta name="description" content="see charset=windows-1252 here">Café`;
  const bytes = Array.from(Buffer.from(raw, "utf-8"));
  const text = await decodeBody(streamOf(bytes), "text/html");
  assert.match(text, /Café/);
  assert.doesNotMatch(text, /CafÃ©/);
});

test("decodeBody does not treat <metadata> as a <meta> charset declaration", async () => {
  // `<metadata charset=…>` must not be mistaken for `<meta charset=…>`; UTF-8 body.
  const raw = `<metadata charset="windows-1252">Café`;
  const bytes = Array.from(Buffer.from(raw, "utf-8"));
  const text = await decodeBody(streamOf(bytes), "text/html");
  assert.match(text, /Café/);
  assert.doesNotMatch(text, /CafÃ©/);
});

test("decodeBody ignores a commented-out <meta charset>", async () => {
  // A commented-out charset declaration is inert; UTF-8 body stays UTF-8.
  const raw = `<!-- <meta charset="windows-1252"> -->Café`;
  const bytes = Array.from(Buffer.from(raw, "utf-8"));
  const text = await decodeBody(streamOf(bytes), "text/html");
  assert.match(text, /Café/);
  assert.doesNotMatch(text, /CafÃ©/);
});
