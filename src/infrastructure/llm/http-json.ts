import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

export async function postJson<T>(url: string, headers: Record<string, string>, body: unknown, timeoutMs: number): Promise<T> {
  const payload = JSON.stringify(body);
  return await new Promise<T>((resolve, reject) => {
    const parsed = new URL(url);
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
      res.on("data", (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
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
