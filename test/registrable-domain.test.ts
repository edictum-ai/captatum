import { test } from "node:test";
import assert from "node:assert/strict";
import { registrableDomain, isSameRegistrableDomain } from "../src/domain/registrable-domain.ts";

test("registrableDomain: Jira sibling subdomains share a registrable domain (#111 motivation)", () => {
  // api.atlassian.com (POST target) vs developer.atlassian.com (the page) — same registrable.
  assert.equal(registrableDomain("api.atlassian.com"), "atlassian.com");
  assert.equal(registrableDomain("developer.atlassian.com"), "atlassian.com");
  assert.equal(isSameRegistrableDomain("api.atlassian.com", "developer.atlassian.com"), true);
});

test("registrableDomain: multi-tenant suffixes are NOT collapsed (the SSRF-critical guard)", () => {
  // foo.github.io and bar.github.io are DIFFERENT tenants — a naive suffix match (or tldts,
  // which omits private domains) collapses both to `github.io`, the cross-tenant bypass.
  assert.equal(registrableDomain("foo.github.io"), "foo.github.io");
  assert.equal(registrableDomain("bar.github.io"), "bar.github.io");
  assert.equal(isSameRegistrableDomain("foo.github.io", "bar.github.io"), false, "different github.io tenants must NOT match");

  assert.equal(registrableDomain("foo.appspot.com"), "foo.appspot.com");
  assert.equal(isSameRegistrableDomain("foo.appspot.com", "bar.appspot.com"), false);

  assert.equal(registrableDomain("foo.herokuapp.com"), "foo.herokuapp.com");
  assert.equal(isSameRegistrableDomain("foo.herokuapp.com", "bar.herokuapp.com"), false);

  assert.equal(registrableDomain("foo.cloudfront.net"), "foo.cloudfront.net");
  assert.equal(isSameRegistrableDomain("d1.cloudfront.net", "d2.cloudfront.net"), false);
});

test("registrableDomain: co.uk / com.au are NOT the registrable domain", () => {
  assert.equal(registrableDomain("example.co.uk"), "example.co.uk");
  assert.equal(registrableDomain("sub.example.co.uk"), "example.co.uk");
  assert.equal(isSameRegistrableDomain("foo.co.uk", "bar.co.uk"), false, "different .co.uk regs must NOT match");
  assert.equal(isSameRegistrableDomain("a.example.co.uk", "b.example.co.uk"), true);
  assert.equal(registrableDomain("example.com.au"), "example.com.au");
});

test("registrableDomain: IP literals, single-label, empty → null (fail-closed)", () => {
  // psl mis-parses bare IPs (e.g. 10.0.0.1 -> "0.1"); isIP guards them to null.
  assert.equal(registrableDomain("10.0.0.1"), null);
  assert.equal(registrableDomain("192.168.1.1"), null);
  assert.equal(registrableDomain("[::1]"), null);
  assert.equal(registrableDomain("localhost"), null);
  assert.equal(registrableDomain(""), null);
  assert.equal(registrableDomain("singlelabel"), null);
});

test("isSameRegistrableDomain: null !== null (a page on an IP/localhost never matches a sibling)", () => {
  // The fail-closed contract: either operand null -> false, so an ambiguous/edge host
  // aborts the POST rather than forwarding page-authored bytes on a non-match.
  assert.equal(isSameRegistrableDomain("10.0.0.1", "10.0.0.2"), false);
  assert.equal(isSameRegistrableDomain("localhost", "localhost"), false);
  assert.equal(isSameRegistrableDomain("example.com", "10.0.0.1"), false);
  assert.equal(isSameRegistrableDomain("notafqdn", "alsonotadomain"), false);
});

test("registrableDomain: is case-insensitive and tolerates surrounding whitespace", () => {
  assert.equal(registrableDomain("API.Atlassian.COM"), "atlassian.com");
  assert.equal(registrableDomain("  developer.atlassian.com  "), "atlassian.com");
});

test("registrableDomain: plain domains + deep subdomains collapse to the registrable domain", () => {
  assert.equal(registrableDomain("example.com"), "example.com");
  assert.equal(registrableDomain("www.example.com"), "example.com");
  assert.equal(registrableDomain("a.b.c.example.com"), "example.com");
  assert.equal(isSameRegistrableDomain("www.example.com", "api.example.com"), true);
  assert.equal(isSameRegistrableDomain("example.com", "example.org"), false);
});
