import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isLoopbackHost } from "../../domain/policy.ts";

/** Cap on a buffered LLM provider response — a summary/extract JSON is KB at
 *  most; 10 MiB is a generous abuse ceiling that prevents unbounded buffering
 *  from a misbehaving/hostile provider endpoint. */
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

/** Whether a URL points at loopback (localhost / 127.0.0.0/8 / ::1). Tells a
 *  genuinely-local provider (zero-egress Ollama) from a remote one, and permits plain
 *  http:// only to loopback. Delegates to isLoopbackHost, which requires an IP LITERAL:
 *  a DNS name like "127.attacker.example" is NOT loopback (PR #86 review — otherwise it
 *  could smuggle a cleartext-http bearer token or mark a remote model "local"). */
export function isLoopbackUrl(value: string): boolean {
  if (!value) return false;
  try {
    return isLoopbackHost(new URL(value).hostname);
  } catch {
    return false;
  }
}

export async function postJson<T>(url: string, headers: Record<string, string>, body: unknown, timeoutMs: number): Promise<T> {
  const payload = JSON.stringify(body);
  return await new Promise<T>((resolve, reject) => {
    const parsed = new URL(url);
    // #5: refuse to send an authorization header over cleartext http:// to a
    // non-loopback host — a misconfigured OPENROUTER_BASE_URL would egress the key in
    // plaintext. OpenRouterProvider also guards its baseUrl at construction; this is
    // defense-in-depth at the transport. (Ollama's no-auth loopback path is unaffected.)
    if (parsed.protocol === "http:" && !isLoopbackUrl(url) && hasAuthHeader(headers)) {
      reject(new Error(`refusing to send authorization header over cleartext http:// to ${parsed.host}`));
      return;
    }
    const request = parsed.protocol === "http:" ? httpRequest : httpsRequest;
    const req = request(parsed, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(payload)),
        ...headers,
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      let total = 0;
      res.on("data", (chunk: Buffer | string) => {
        total += chunk.length;
        if (total > MAX_RESPONSE_BYTES) {
          req.destroy(new Error("LLM provider response exceeded the 10 MiB byte cap"));
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) {
          reject(new Error(`LLM provider returned HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
          return;
        }
        try {
          resolve(JSON.parse(text) as T);
        } catch (error) {
          reject(error);
        }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error("LLM provider request timed out")));
    req.on("error", reject);
    req.end(payload);
  });
}

function hasAuthHeader(headers: Record<string, string>): boolean {
  return Object.keys(headers).some((key) => /^authorization$/i.test(key));
}
