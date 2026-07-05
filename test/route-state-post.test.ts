import { test } from "node:test";
import assert from "node:assert/strict";
import type { FetcherPort, FetcherResult, RejectResult } from "../src/application/ports/fetcher.ts";
import type { RenderAction } from "../src/application/ports/renderer.ts";
import type { PlaywrightRequest, PlaywrightRoute } from "../src/infrastructure/render/playwright-types.ts";
import { RenderRouteState } from "../src/infrastructure/render/route-state.ts";
import type { BrowserUrlGuard } from "../src/infrastructure/render/browser-url-guard.ts";

const enc = (s: string) => new TextEncoder().encode(s);

/** A fetcher that returns a fixed 200 JSON body for any request (the POST gate is in route-state). */
function okFetcher(payload: string): FetcherPort {
  return {
    async fetchGuarded(url: string): Promise<FetcherResult | RejectResult> {
      const bytes = enc(payload);
      return {
        status: 200, finalUrl: url, redirects: [],
        bodyStream: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }),
        contentType: "application/json", bytes: bytes.byteLength,
      };
    },
  };
}

interface StubRequestSpec {
  method: string;
  resourceType: string;
  url: string;
  body?: Buffer;
  contentType?: string;
}
function stubRoute(spec: StubRequestSpec): PlaywrightRoute & { fulfilled: boolean; aborted: boolean; fulfillBody?: Uint8Array } {
  const req: PlaywrightRequest = {
    url: () => spec.url,
    method: () => spec.method,
    resourceType: () => spec.resourceType,
    ...(spec.body !== undefined ? { postDataBuffer: () => spec.body } : {}),
    ...(spec.contentType !== undefined ? { headers: () => ({ "content-type": spec.contentType }) } : {}),
  };
  // fulfill/abort mutate THIS object's fields (not a closure copy) so the test reads the outcome.
  const route = {
    fulfilled: false,
    aborted: false,
    fulfillBody: undefined as Uint8Array | undefined,
    request: () => req,
    fulfill: async (opts: { body: Uint8Array }) => { route.fulfilled = true; route.fulfillBody = opts.body; },
    abort: async () => { route.aborted = true; },
    continue: async () => { route.aborted = true; },
  };
  return route as unknown as PlaywrightRoute & { fulfilled: boolean; aborted: boolean; fulfillBody?: Uint8Array };
}

const noopGuard: BrowserUrlGuard = { async check() { return undefined; } };
const RENDER_INPUT = (fetcher: FetcherPort) => ({
  url: "https://example.test/page", // mainRegistrableDomain = "example.test" (computed once)
  maxBytes: 1024 * 1024, timeoutMs: 5000, maxHops: 5, fetcher,
});

test("RenderRouteState forwards a first-party POST fetch + logs request-forwarded-post (#111)", async () => {
  const actions: RenderAction[] = [];
  const state = new RenderRouteState(RENDER_INPUT(okFetcher('{"ok":1}')), actions, noopGuard);
  const route = stubRoute({
    method: "POST", resourceType: "fetch", url: "https://api.example.test/data",
    body: Buffer.from('{"q":"a"}'), contentType: "application/json",
  });
  await state.handle(route);
  assert.equal((route as { fulfilled: boolean }).fulfilled, true, "POST was fulfilled (forwarded through FetcherPort)");
  assert.equal((route as { aborted: boolean }).aborted, false);
  const fwd = actions.find((a) => a.type === "request-forwarded-post");
  assert.ok(fwd, "a request-forwarded-post action was logged");
  assert.equal(fwd?.outcome, "ok");
  assert.equal(fwd?.method, "POST");
  assert.equal(fwd?.bodyBytes, 9, 'bodyBytes = the forwarded body length ("{\\"q\\":\\"a\\"}" = 9)');
});

test("RenderRouteState aborts a third-party POST (different registrable domain) (#111)", async () => {
  const actions: RenderAction[] = [];
  const state = new RenderRouteState(RENDER_INPUT(okFetcher("x")), actions, noopGuard);
  const route = stubRoute({
    method: "POST", resourceType: "fetch", url: "https://evil.example.org/exfil",
    body: Buffer.from("steal"), contentType: "application/json",
  });
  await state.handle(route);
  assert.equal((route as { aborted: boolean }).aborted, true, "third-party POST aborted");
  assert.equal((route as { fulfilled: boolean }).fulfilled, false);
  const block = actions.find((a) => a.type === "request-blocked");
  assert.ok(block, "a request-blocked action was logged");
  assert.equal(block?.reason, "unsupported_browser_method");
});

test("RenderRouteState aborts a non-POST method (PUT) even to the same registrable domain (#111)", async () => {
  const actions: RenderAction[] = [];
  const state = new RenderRouteState(RENDER_INPUT(okFetcher("x")), actions, noopGuard);
  const route = stubRoute({ method: "PUT", resourceType: "fetch", url: "https://api.example.test/x", body: Buffer.from("y") });
  await state.handle(route);
  assert.equal((route as { aborted: boolean }).aborted, true, "PUT aborted (POST-only allowlist)");
  assert.equal((route as { fulfilled: boolean }).fulfilled, false);
});

test("RenderRouteState aborts a document POST (only fetch/xhr are data fetches) (#111)", async () => {
  const actions: RenderAction[] = [];
  const state = new RenderRouteState(RENDER_INPUT(okFetcher("x")), actions, noopGuard);
  const route = stubRoute({ method: "POST", resourceType: "document", url: "https://api.example.test/x", body: Buffer.from("y") });
  await state.handle(route);
  assert.equal((route as { aborted: boolean }).aborted, true, "document POST aborted");
});

test("RenderRouteState: a first-party CORS preflight (OPTIONS) gets a permissive synthesized response (#111 codex P1)", async () => {
  // Jira: developer.atlassian.com page → OPTIONS preflight to api.atlassian.com (cross-origin,
  // same registrable domain). Without a permissive preflight the browser never issues the POST.
  const state = new RenderRouteState(RENDER_INPUT(okFetcher("x")), [], noopGuard);
  const route = stubRoute({ method: "OPTIONS", resourceType: "fetch", url: "https://api.example.test/data" });
  // Record the fulfill status + headers (stubRoute records only fulfilled/aborted).
  let status = 0; let headers: Record<string, string> | undefined;
  (route as { fulfill: unknown }).fulfill = async (opts: { status: number; headers?: Record<string, string>; body: Uint8Array }) => {
    (route as { fulfilled: boolean }).fulfilled = true; status = opts.status; headers = opts.headers;
  };
  await state.handle(route);
  assert.equal((route as { fulfilled: boolean }).fulfilled, true, "preflight fulfilled (not aborted)");
  assert.equal(status, 204);
  assert.equal(headers?.["access-control-allow-origin"], "*", "permissive ACAO");
  assert.match(headers?.["access-control-allow-methods"] ?? "", /POST/, "POST allowed");
});

test("RenderRouteState: a third-party CORS preflight aborts (not first-party) (#111)", async () => {
  const state = new RenderRouteState(RENDER_INPUT(okFetcher("x")), [], noopGuard);
  const route = stubRoute({ method: "OPTIONS", resourceType: "fetch", url: "https://evil.example.org/data" });
  await state.handle(route);
  assert.equal((route as { aborted: boolean }).aborted, true, "third-party preflight aborted");
});
