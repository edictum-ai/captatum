import { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { GuardedFetchError, reject, throwIfAborted } from "./errors.ts";
import { headerValue } from "./url.ts";

export type ResponseHeaders = Record<string, string | string[] | number | undefined>;

export interface CappedBody {
  bytes: Uint8Array;
  byteLength: number;
}

export async function readCappedBody(
  body: Readable,
  headers: ResponseHeaders,
  maxBytes: number,
  signal: AbortSignal,
): Promise<CappedBody> {
  const declaredLength = Number(headerValue(headers, "content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    body.destroy();
    reject("max_bytes", "Response exceeds the configured byte cap");
  }
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

  try {
    for await (const chunk of stream) {
      throwIfAborted(signal);
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.byteLength;
      if (total > maxBytes) {
        body.destroy();
        stream.destroy();
        reject("max_bytes", "Response exceeds the configured byte cap");
      }
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
  return { bytes, byteLength: total };
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

function decodedStream(body: Readable, encodingHeader: string): Readable {
  const encoding = encodingHeader.toLowerCase().split(",")[0]?.trim() ?? "";
  if (!encoding || encoding === "identity") return body;
  if (encoding === "gzip" || encoding === "x-gzip") return body.pipe(createGunzip());
  if (encoding === "deflate") return body.pipe(createInflate());
  if (encoding === "br") return body.pipe(createBrotliDecompress());

  body.destroy();
  reject("unsupported_encoding", "Response uses an unsupported content encoding");
}
