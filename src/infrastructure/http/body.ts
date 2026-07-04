import { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { GuardedFetchError, reject, throwIfAborted } from "./errors.ts";
import { headerValue } from "./url.ts";

export type ResponseHeaders = Record<string, string | string[] | number | undefined>;

export interface CappedBody {
  bytes: Uint8Array;
  byteLength: number;
  truncated: boolean;
}

/**
 * Read up to `maxBytes` from a response body (decompressing if needed).
 * Advisory: when the body exceeds the cap, returns the first `maxBytes` and
 * marks `truncated=true` rather than rejecting — partial content > no content.
 * The caller surfaces a max_bytes provenance note.
 */
export async function readCappedBody(
  body: Readable,
  headers: ResponseHeaders,
  maxBytes: number,
  signal: AbortSignal,
): Promise<CappedBody> {
  throwIfAborted(signal);

  const stream = decodedStream(body, headerValue(headers, "content-encoding"));
  const onAbort = () => {
    const error = new GuardedFetchError("timeout", "Fetch timed out");
    body.destroy(error);
    if (stream !== body) stream.destroy(error);
  };
  signal.addEventListener("abort", onAbort, { once: true });

  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;

  try {
    for await (const chunk of stream) {
      throwIfAborted(signal);
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (total + buffer.byteLength > maxBytes) {
        const remaining = maxBytes - total;
        if (remaining > 0) {
          chunks.push(buffer.subarray(0, remaining));
          total += remaining;
        }
        truncated = true;
        body.destroy();
        if (stream !== body) stream.destroy();
        break;
      }
      total += buffer.byteLength;
      chunks.push(buffer);
    }
  } catch (error) {
    if (error instanceof Error && error.name === "GuardedFetchError") throw error;
    if (signal.aborted) reject("timeout", "Fetch timed out");
    reject("body_read_error", "Response body could not be read safely");
  } finally {
    signal.removeEventListener("abort", onAbort);
  }

  const bytes = new Uint8Array(Buffer.concat(chunks, total));
  return { bytes, byteLength: total, truncated };
}

export function streamFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (bytes.byteLength > 0) {
        controller.enqueue(bytes);
      }
      controller.close();
    },
  });
}

/**
 * Decode a body stream to text, honoring the HTTP `Content-Type` charset; when
 * the header omits one, prescan the HTML head for a `<meta charset>` / `<meta
 * http-equiv=Content-Type>` declaration (WHATWG prescan) so a page served as
 * plain text/html with `<meta charset="windows-1252">` is not mojibake'd
 * (Café → CafÃ©). Previously hard-coded UTF-8 via `Response.text()`, which
 * corrupted pages served as iso-8859-15 / windows-1252 / etc. Falls back to
 * UTF-8 when no charset is declared or the label is unsupported.
 */
export async function decodeBody(
  stream: ReadableStream<Uint8Array>,
  contentType?: string,
): Promise<string> {
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  // Only HTML bodies declare their charset via `<meta charset>`; prescanning a
  // declared non-HTML body (e.g. application/json from an ATS roster) would let an
  // HTML snippet inside the first 1024 bytes re-decode the whole response.
  const charset = parseCharset(contentType) ?? (isHtmlContentType(contentType) ? prescanMetaCharset(bytes) : undefined);
  if (charset && !isUtf8(charset)) {
    try {
      return new TextDecoder(charset, { fatal: false }).decode(bytes);
    } catch {
      // Unknown charset label — fall through to UTF-8.
    }
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function parseCharset(contentType?: string): string | undefined {
  if (!contentType) return undefined;
  const match = /charset\s*=\s*["']?([^\s;"']+)/i.exec(contentType);
  return match?.[1];
}

function isUtf8(charset: string): boolean {
  const lower = charset.toLowerCase();
  return lower === "utf-8" || lower === "utf8";
}

/** True when a body could legitimately carry a `<meta charset>` declaration —
 *  HTML/XHTML, or an unknown/absent type (a meta charset in the bytes strongly
 *  implies HTML). Declared non-HTML types (application/json, text/plain, …) are
 *  not prescanned. */
export function isHtmlContentType(contentType: string | undefined): boolean {
  if (!contentType) return true;
  return /html|xhtml/i.test(contentType);
}

/** WHATWG-ish charset prescan: inspect the first 1024 bytes (as an ASCII view
 *  where each byte < 128 maps to its char and bytes ≥ 128 become '_') for a
 *  `<meta charset=…>` (HTML5) or `<meta http-equiv=Content-Type
 *  content="…charset=…">` (HTML4) declaration. Bytes past the first 1024 are
 *  ignored — per spec a charset declared after 1024 bytes is not trusted. Returns
 *  undefined when no meta charset is found. Manual byte mapping (not TextDecoder)
 *  so it works regardless of ICU/label availability. Attribute parsing is
 *  quote-aware so a `data-charset` attribute or a `charset=` substring inside an
 *  unrelated attribute value can't mis-decode the page. */
function prescanMetaCharset(bytes: Uint8Array): string | undefined {
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
    const close = lower.indexOf(">", at);
    if (close === -1) return undefined;
    const cs = metaCharsetFromTag(lower.slice(at, close));
    if (cs) return cs;
    cursor = close + 1;
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


function decodedStream(body: Readable, encodingHeader: string): Readable {
  const encoding = encodingHeader.toLowerCase().split(",")[0]?.trim() ?? "";
  if (!encoding || encoding === "identity") return body;
  if (encoding === "gzip" || encoding === "x-gzip") return body.pipe(createGunzip());
  if (encoding === "deflate") return body.pipe(createInflate());
  if (encoding === "br") return body.pipe(createBrotliDecompress());

  body.destroy();
  reject("unsupported_encoding", "Response uses an unsupported content encoding");
}
