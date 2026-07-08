import { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { GuardedFetchError, reject, throwIfAborted } from "./errors.ts";
import { headerValue } from "./url.ts";
import { prescanMetaCharset } from "./charset.ts";

export type ResponseHeaders = Record<string, string | string[] | number | undefined>;

export interface CappedBody {
  bytes: Uint8Array;
  byteLength: number;
  truncated: boolean;
  /** Why the body was truncated. `"cap"` = it exceeded `maxBytes` (a clean prefix of a
   *  larger body); `"body_read_error"` = the stream broke mid-read AFTER partial bytes
   *  arrived (premature close / Content-Length mismatch / decompression truncation) —
   *  transport-unreliable, but partial content > none (#149). Present iff `truncated`. */
  truncatedReason?: "cap" | "body_read_error";
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
  let truncatedReason: "cap" | "body_read_error" | undefined;

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
        truncatedReason = "cap";
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
    // Mid-read truncation with partial bytes already collected: the stream broke
    // (premature close / Content-Length mismatch / decompression truncation) AFTER some
    // content arrived. Partial content > none — keep what we have and mark it transport-
    // truncated, instead of discarding the bytes and hard-failing (#149). Only a
    // zero-byte total failure (the stream broke before any content) still rejects.
    if (total > 0) {
      truncated = true;
      truncatedReason = "body_read_error";
    } else {
      reject("body_read_error", "Response body could not be read safely");
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
  }

  const bytes = new Uint8Array(Buffer.concat(chunks, total));
  return { bytes, byteLength: total, truncated, ...(truncatedReason ? { truncatedReason } : {}) };
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

/** True for `application/json` and `+json` suffixes (e.g. application/vnd.api+json).
 *  Used to route API responses away from the HTML extractor (#94). */
export function isJsonContentType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const primary = contentType.split(";")[0].trim().toLowerCase();
  return primary === "application/json" || primary.endsWith("+json");
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
