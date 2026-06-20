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
 * Decode a body stream to text, honoring the HTTP `Content-Type` charset.
 * Previously hard-coded UTF-8 via `Response.text()`, which corrupted pages
 * served as iso-8859-15 / windows-1252 / etc. (e.g. elmundo.es → "apag�n").
 * Falls back to UTF-8 when the charset is absent or unsupported.
 */
export async function decodeBody(
  stream: ReadableStream<Uint8Array>,
  contentType?: string,
): Promise<string> {
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  const charset = parseCharset(contentType);
  if (charset && charset.toLowerCase() !== "utf-8" && charset.toLowerCase() !== "utf8") {
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


function decodedStream(body: Readable, encodingHeader: string): Readable {
  const encoding = encodingHeader.toLowerCase().split(",")[0]?.trim() ?? "";
  if (!encoding || encoding === "identity") return body;
  if (encoding === "gzip" || encoding === "x-gzip") return body.pipe(createGunzip());
  if (encoding === "deflate") return body.pipe(createInflate());
  if (encoding === "br") return body.pipe(createBrotliDecompress());

  body.destroy();
  reject("unsupported_encoding", "Response uses an unsupported content encoding");
}
