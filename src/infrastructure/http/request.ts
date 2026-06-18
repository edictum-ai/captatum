import http, { type IncomingHttpHeaders } from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { GuardedFetchError, isAbortError, reject } from "./errors.ts";

export interface HttpRequestInput {
  url: URL;
  address: string;
  family: 4 | 6;
  hostHeader: string;
  signal: AbortSignal;
  timeoutMs: number;
}

export interface HttpResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Readable;
}

export interface HttpRequester {
  request(input: HttpRequestInput): Promise<HttpResponse>;
}

export class NodeHttpRequester implements HttpRequester {
  async request(input: HttpRequestInput): Promise<HttpResponse> {
    return await new Promise<HttpResponse>((resolve, rejectPromise) => {
      const transport = input.url.protocol === "https:" ? https : http;
      const request = transport.request({
        protocol: input.url.protocol,
        hostname: input.address,
        port: input.url.port || defaultPort(input.url.protocol),
        method: "GET",
        path: `${input.url.pathname}${input.url.search}`,
        family: input.family,
        signal: input.signal,
        servername: servernameFor(input.url),
        headers: {
          Host: input.hostHeader,
          "Accept-Encoding": "gzip, br, deflate",
          "User-Agent": "captatum/0.1",
        },
      }, (response) => {
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: response,
        });
      });

      request.setTimeout(input.timeoutMs, () => {
        request.destroy(new GuardedFetchError("timeout", "Fetch timed out"));
      });
      request.on("error", (error) => {
        if (error instanceof GuardedFetchError) {
          rejectPromise(error);
        } else if (input.signal.aborted || isAbortError(error)) {
          rejectPromise(new GuardedFetchError("timeout", "Fetch timed out"));
        } else {
          rejectPromise(new GuardedFetchError("network_error", "Network request failed"));
        }
      });
      request.end();
    });
  }
}

function defaultPort(protocol: string): number {
  return protocol === "https:" ? 443 : 80;
}

function servernameFor(url: URL): string | undefined {
  const hostname = stripBrackets(url.hostname);
  if (url.protocol !== "https:" || isIP(hostname)) return undefined;
  if (hostname.length === 0) reject("invalid_url", "URL must include a hostname");
  return hostname;
}

function stripBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}
