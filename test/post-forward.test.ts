import { test } from "node:test";
import assert from "node:assert/strict";
import { planPostForward } from "../src/infrastructure/render/post-forward.ts";
import { registrableDomain } from "../src/domain/registrable-domain.ts";

const enc = (s: string) => new TextEncoder().encode(s);

test("planPostForward: forwards a first-party POST fetch with a body + Content-Type", () => {
  const plan = planPostForward({
    method: "POST", resourceType: "fetch", url: "https://api.atlassian.com/x",
    body: enc('{"q":"a"}'), contentType: "application/json",
    mainRegistrableDomain: registrableDomain("developer.atlassian.com"), maxBytes: 1024,
  });
  assert.equal(plan.kind, "forward");
  if (plan.kind === "forward") {
    assert.equal(plan.postInit.method, "POST");
    assert.equal(plan.postInit.requestContentType, "application/json");
    assert.equal(plan.postInit.body.byteLength, 9);
  }
});

test("planPostForward: Jira motivation — api.atlassian.com POST forwards on a developer.atlassian.com page", () => {
  // Same registrable domain, different subdomains — the reason the gate is PSL-aware, not strict host.
  for (const rt of ["fetch", "xhr"]) {
    const plan = planPostForward({
      method: "POST", resourceType: rt, url: "https://api.atlassian.com/flags/api/v2/configurations",
      body: enc("{}"), contentType: "application/json",
      mainRegistrableDomain: registrableDomain("developer.atlassian.com"), maxBytes: 1048576,
    });
    assert.equal(plan.kind, "forward", `${rt} should forward`);
  }
});

test("planPostForward: multi-tenant SSRF — attacker.github.io POST on a victim.github.io page aborts", () => {
  // The highest-impact gate-bypass regression: a naive suffix match collapses both to `github.io`
  // and forwards the attacker's body cross-tenant. PSL-awareness keeps them distinct.
  const plan = planPostForward({
    method: "POST", resourceType: "fetch", url: "https://attacker.github.io/exfil",
    body: enc("steal"), contentType: "application/json",
    mainRegistrableDomain: registrableDomain("victim.github.io"), maxBytes: 1048576,
  });
  assert.equal(plan.kind, "abort");
  assert.equal((plan as { reason: string }).reason, "unsupported_browser_method");
  // Same for appspot.com / herokuapp.com tenants.
  const a = planPostForward({ method: "POST", resourceType: "fetch", url: "https://bad.appspot.com/x", body: enc("x"), mainRegistrableDomain: registrableDomain("good.appspot.com"), maxBytes: 1024 });
  assert.equal((a as { reason: string }).reason, "unsupported_browser_method");
});

test("planPostForward: co.uk / com.au — different registrable domains do NOT match", () => {
  const plan = planPostForward({
    method: "POST", resourceType: "fetch", url: "https://bar.co.uk/api",
    body: enc("x"), mainRegistrableDomain: registrableDomain("foo.co.uk"), maxBytes: 1024,
  });
  assert.equal((plan as { reason: string }).reason, "unsupported_browser_method");
});

test("planPostForward: non-POST methods (PUT/PATCH/DELETE) abort", () => {
  // captatum is a READ fetcher — no mutation methods forward.
  for (const method of ["PUT", "PATCH", "DELETE"]) {
    const plan = planPostForward({
      method, resourceType: "fetch", url: "https://api.example.com/x",
      body: enc("x"), mainRegistrableDomain: registrableDomain("example.com"), maxBytes: 1024,
    });
    assert.equal((plan as { reason: string }).reason, "unsupported_browser_method", `${method} must abort`);
  }
});

test("planPostForward: document / stylesheet POST aborts (only fetch/xhr are data fetches)", () => {
  for (const rt of ["document", "stylesheet", "image"]) {
    const plan = planPostForward({
      method: "POST", resourceType: rt, url: "https://example.com/x",
      body: enc("x"), mainRegistrableDomain: registrableDomain("example.com"), maxBytes: 1024,
    });
    assert.equal((plan as { reason: string }).reason, "unsupported_browser_method", `${rt} POST must abort`);
  }
});

test("planPostForward: third-party host aborts (page on example.com, POST to evil.com)", () => {
  const plan = planPostForward({
    method: "POST", resourceType: "fetch", url: "https://evil.com/exfil",
    body: enc("x"), mainRegistrableDomain: registrableDomain("example.com"), maxBytes: 1024,
  });
  assert.equal((plan as { reason: string }).reason, "unsupported_browser_method");
});

test("planPostForward: null body → unreadable_post_body", () => {
  const plan = planPostForward({
    method: "POST", resourceType: "fetch", url: "https://api.example.com/x",
    body: null, mainRegistrableDomain: registrableDomain("example.com"), maxBytes: 1024,
  });
  assert.equal((plan as { reason: string }).reason, "unreadable_post_body");
});

test("planPostForward: oversized declared Content-Length → request_body_too_large (no buffering)", () => {
  // Advisory pre-check rejects a page that declares an oversized body before materializing.
  const plan = planPostForward({
    method: "POST", resourceType: "fetch", url: "https://api.example.com/x",
    body: enc("small"), contentLength: "999999999",
    mainRegistrableDomain: registrableDomain("example.com"), maxBytes: 1024,
  });
  assert.equal((plan as { reason: string }).reason, "request_body_too_large");
});

test("planPostForward: oversized actual body → request_body_too_large (NEVER truncates)", () => {
  // A half JSON body would 400; a clean abort lets the page degrade.
  const plan = planPostForward({
    method: "POST", resourceType: "fetch", url: "https://api.example.com/x",
    body: enc("x".repeat(2000)), mainRegistrableDomain: registrableDomain("example.com"), maxBytes: 1024,
  });
  assert.equal((plan as { reason: string }).reason, "request_body_too_large");
});

test("planPostForward: CRLF / NUL / over-long Content-Type → invalid_post_header", () => {
  for (const ct of ["application/json\r\nX-Inject: 1", "application/json\n", "application/json\0", "x".repeat(257)]) {
    const plan = planPostForward({
      method: "POST", resourceType: "fetch", url: "https://api.example.com/x",
      body: enc("{}"), contentType: ct, mainRegistrableDomain: registrableDomain("example.com"), maxBytes: 1024,
    });
    assert.equal((plan as { reason: string }).reason, "invalid_post_header", `must reject: ${JSON.stringify(ct).slice(0, 30)}`);
  }
});

test("planPostForward: legitimate Content-Type with charset + absent Content-Type both forward", () => {
  const withCharset = planPostForward({
    method: "POST", resourceType: "fetch", url: "https://api.example.com/x",
    body: enc("{}"), contentType: "application/json; charset=utf-8",
    mainRegistrableDomain: registrableDomain("example.com"), maxBytes: 1024,
  });
  assert.equal(withCharset.kind, "forward");
  if (withCharset.kind === "forward") assert.equal(withCharset.postInit.requestContentType, "application/json; charset=utf-8");

  const noCt = planPostForward({
    method: "POST", resourceType: "fetch", url: "https://api.example.com/x",
    body: enc("{}"), mainRegistrableDomain: registrableDomain("example.com"), maxBytes: 1024,
  });
  assert.equal(noCt.kind, "forward");
  if (noCt.kind === "forward") assert.equal(noCt.postInit.requestContentType, undefined, "absent Content-Type not synthesized");
});

test("planPostForward: a page on an IP literal / localhost never forwards (null !== null fail-closed)", () => {
  // mainRegistrableDomain null (IP/localhost) -> isSameRegistrableDomain is false -> abort.
  const plan = planPostForward({
    method: "POST", resourceType: "fetch", url: "https://10.0.0.2/api",
    body: enc("x"), mainRegistrableDomain: registrableDomain("10.0.0.1"), maxBytes: 1024,
  });
  assert.equal((plan as { reason: string }).reason, "unsupported_browser_method");
});
