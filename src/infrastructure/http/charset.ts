// WHATWG-ish HTML `<meta charset>` prescan — extracted from body.ts to respect the
// 250-line limit. Used by decodeBody to honor a `<meta charset=…>` / `<meta
// http-equiv=Content-Type>` declaration when the HTTP Content-Type header omits one,
// so a page served as plain text/html with `<meta charset="windows-1252">` is not
// mojibake'd (Café → CafÃ©). Internal to the HTTP body layer.

/** WHATWG-ish charset prescan: inspect the first 1024 bytes (as an ASCII view
 *  where each byte < 128 maps to its char and bytes ≥ 128 become '_') for a
 *  `<meta charset=…>` (HTML5) or `<meta http-equiv=Content-Type
 *  content="…charset=…">` (HTML4) declaration. Bytes past the first 1024 are
 *  ignored — per spec a charset declared after 1024 bytes is not trusted. Returns
 *  undefined when no meta charset is found. Manual byte mapping (not TextDecoder)
 *  so it works regardless of ICU/label availability. Attribute parsing is
 *  quote-aware so a `data-charset` attribute or a `charset=` substring inside an
 *  unrelated attribute value can't mis-decode the page. */
export function prescanMetaCharset(bytes: Uint8Array): string | undefined {
  const end = Math.min(bytes.length, 1024);
  let head = "";
  for (let i = 0; i < end; i += 1) {
    const b = bytes[i];
    head += b < 128 ? String.fromCharCode(b) : "_";
  }
  const lower = stripHtmlCommentsAscii(head.toLowerCase());
  let cursor = 0;
  while (cursor < lower.length) {
    const at = lower.indexOf("<meta", cursor);
    if (at === -1) return undefined;
    // Require a tag-name boundary after "meta" so `<metadata …>` (or `<metalink>`)
    // is not mistaken for a charset-declaring `<meta>`.
    const after = lower[at + 5];
    if (after !== undefined && after !== ">" && after !== "/" && !/\s/.test(after)) {
      cursor = at + 5;
      continue;
    }
    // Quote-aware meta tag end that records whether it terminated on an UNQUOTED `>`. The
    // last char being `>` is NOT enough: `<meta charset="utf-8" data="x>` ends inside the open
    // data= quote (the `>` is in-quote, not a real terminator) — trusting it would decode from
    // malformed markup. Only a genuine unquoted `>` terminates; else the meta is malformed. (#166 P2)
    let mq: string | null = null;
    let close = lower.length;
    let terminated = false;
    for (let j = at; j < lower.length; j += 1) {
      const ch = lower[j];
      if (mq) { if (ch === mq) mq = null; continue; }
      if (ch === "\"" || ch === "'") mq = ch;
      else if (ch === ">") { close = j + 1; terminated = true; break; }
    }
    if (!terminated) return undefined;
    const cs = metaCharsetFromTag(lower.slice(at, close));
    if (cs) return cs;
    cursor = close;
  }
  return undefined;
}

/** Remove `<!-- … -->` spans (replace with a space) so a commented-out
 *  `<meta charset>` — inert, the browser ignores it — can't prescan. Linear. */
function stripHtmlCommentsAscii(s: string): string {
  let out = "";
  let cursor = 0;
  while (cursor < s.length) {
    const start = s.indexOf("<!--", cursor);
    if (start === -1) { out += s.slice(cursor); break; }
    const end = s.indexOf("-->", start + 4);
    if (end === -1) { out += s.slice(cursor, start); break; }
    out += `${s.slice(cursor, start)} `;
    cursor = end + 3;
  }
  return out;
}

/** The charset declared by a single `<meta …>` tag, or undefined. Honors the HTML5
 *  `charset` attribute and the HTML4 http-equiv=Content-Type form (charset inside
 *  `content`); ignores `charset=` appearing anywhere else. */
function metaCharsetFromTag(tag: string): string | undefined {
  const attrs = parseTagAttrs(tag);
  if (attrs.charset) return attrs.charset;
  if ((attrs["http-equiv"] ?? "").trim() === "content-type" && attrs.content) {
    const match = /charset\s*=\s*([a-z0-9][a-z0-9_:.+\-]*)/i.exec(attrs.content);
    if (match) return match[1];
  }
  return undefined;
}

/** Minimal quote-aware attribute parser for a single start tag (the part between
 *  the name and `>`). Keys lowercased; first occurrence wins. */
function parseTagAttrs(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  let i = 5; // skip "<meta"
  const len = tag.length;
  while (i < len) {
    while (i < len && /\s/.test(tag[i])) i += 1;
    if (i >= len || tag[i] === "/" || tag[i] === ">") break;
    const nameStart = i;
    while (i < len && /[^\s=/>]/.test(tag[i])) i += 1;
    const name = tag.slice(nameStart, i).toLowerCase();
    while (i < len && /\s/.test(tag[i])) i += 1;
    let value = "";
    if (tag[i] === "=") {
      i += 1;
      while (i < len && /\s/.test(tag[i])) i += 1;
      const quote = tag[i];
      if (quote === "\"" || quote === "'") {
        i += 1;
        const vStart = i;
        while (i < len && tag[i] !== quote) i += 1;
        value = tag.slice(vStart, i);
        if (tag[i] === quote) i += 1;
      } else {
        const vStart = i;
        while (i < len && /[^\s>]/.test(tag[i])) i += 1;
        value = tag.slice(vStart, i);
      }
    }
    if (name && attrs[name] === undefined) attrs[name] = value;
  }
  return attrs;
}
