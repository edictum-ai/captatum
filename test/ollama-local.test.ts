import assert from "node:assert/strict";
import { test } from "node:test";
import { config } from "../src/config.ts";
import { OllamaProvider } from "../src/infrastructure/llm/ollama.ts";

// #4: the "sensitive content stays local" gate trusts candidate.local. It must be
// derived from the base URL actually being loopback — a remote HTTPS OLLAMA_BASE_URL
// is local:false so flagged content is bypassed (raw fallback) rather than egressed.

function localFlag(baseUrl: string): boolean {
  return new OllamaProvider({ baseUrl }).candidates()[0]?.local ?? false;
}

test("Ollama candidate is local for loopback base URLs", () => {
  assert.equal(localFlag("http://localhost:11434"), true);
  assert.equal(localFlag("http://127.0.0.1:11434"), true);
  assert.equal(localFlag("http://[::1]:11434"), true);
  assert.equal(localFlag("https://localhost:11434"), true, "TLS-over-loopback is still local");
});

test("Ollama candidate is NOT local for a remote base URL", () => {
  assert.equal(localFlag("https://remote.example"), false);
  assert.equal(localFlag("https://10.0.0.5:11434"), false, "LAN is not loopback");
  assert.equal(localFlag("http://0.0.0.0:11434"), false, "0.0.0.0 binds all interfaces, not loopback");
  assert.equal(localFlag("https://192.168.1.10:11434"), false);
  // PR #86 review: a DNS name is not an IP literal, so a 127.-prefixed / localhost-prefixed
  // hostname must NOT be treated as loopback (else a remote model is marked local).
  assert.equal(localFlag("https://127.attacker.example:11434"), false, "127.<name> is a DNS name, not loopback");
  assert.equal(localFlag("https://localhost.attacker.example"), false, "localhost.<name> is a DNS name, not loopback");
});

test("Ollama candidate is absent when baseUrl is empty", () => {
  assert.equal(new OllamaProvider({ baseUrl: "" }).candidates().length, 0);
});

test("config accepts IPv6/127.x loopback OLLAMA_BASE_URL over plain http, rejects remote (#4)", () => {
  // URL.hostname keeps IPv6 brackets; the config gate must strip them (matching
  // isLoopbackUrl) or [::1] / 127.0.0.2 are wrongly rejected at boot.
  const saved = process.env.OLLAMA_BASE_URL;
  try {
    for (const url of ["http://[::1]:11434", "http://127.0.0.2:11434", "http://localhost:11434"]) {
      process.env.OLLAMA_BASE_URL = url;
      assert.equal(config.transform.ollamaBaseUrl(), url, `${url} should be accepted as loopback`);
    }
    process.env.OLLAMA_BASE_URL = "http://remote.example:11434";
    assert.throws(() => config.transform.ollamaBaseUrl(), /OLLAMA_BASE_URL must be https/);
    // PR #86 review: a 127.-prefixed DNS name over plain http must be rejected, not accepted as loopback.
    process.env.OLLAMA_BASE_URL = "http://127.attacker.example:11434";
    assert.throws(() => config.transform.ollamaBaseUrl(), /OLLAMA_BASE_URL must be https/, "127.<name> is not loopback");
  } finally {
    if (saved === undefined) delete process.env.OLLAMA_BASE_URL;
    else process.env.OLLAMA_BASE_URL = saved;
  }
});
