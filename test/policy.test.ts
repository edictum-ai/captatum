import assert from "node:assert/strict";
import { test } from "node:test";
import { isPrivate } from "../src/domain/policy.ts";

// PR 7 / SSRF-5: isPrivate must cover the full IANA special-use registry, not
// just RFC 1918 + loopback/link-local. Each of these was previously classified
// public (a private/reserved IP that egress would have reached). Also a Tier-3
// SSRF backstop for PR 1.

test("isPrivate blocks the previously-missed IPv4 special-use ranges", () => {
  const misses = [
    // 192.0.0.0/24 (IETF reserved) is blocked except the globally-reachable
    // anycast .9/.10 (tested public below).
    "192.0.0.1",
    "192.0.2.1", // TEST-NET-1 (documentation)
    "198.18.0.1", // benchmarking (RFC 2544)
    "198.51.100.1", // TEST-NET-2 (documentation)
    "203.0.113.1", // TEST-NET-3 (documentation)
    "240.0.0.1", // reserved for future use
    "255.255.255.255", // limited broadcast (covered by 240.0.0.0/4)
  ];
  for (const ip of misses) {
    assert.equal(isPrivate(ip), true, `${ip} should be private/reserved`);
  }
});

test("isPrivate blocks the previously-missed IPv6 special-use ranges", () => {
  const misses = [
    "::", // unspecified
    "64:ff9b:1::1", // NAT64 local-use prefix
    "100::1", // discard (RFC 6666)
    "2001::1", // Teredo
    "2001:2::1", // benchmarking (RFC 5180)
    "2001:db8::1", // documentation (RFC 3849)
    "2002:7f00:1::", // 6to4 wrapping 127.0.0.1
    "2002:a9fe:a9fe::", // 6to4 wrapping 169.254.169.254 (cloud metadata)
    "3fff::1", // documentation (RFC 9637)
    "fec0::1", // site-local (deprecated)
  ];
  for (const ip of misses) {
    assert.equal(isPrivate(ip), true, `${ip} should be private/reserved`);
  }
});

test("isPrivate still allows genuinely public IPs (no over-blocking regression)", () => {
  const pub = ["8.8.8.8", "1.1.1.1", "172.217.16.142", "192.0.0.9", "192.0.0.10", "2606:4700:4700::1111", "2a00:1450:4001:830::200e"];
  for (const ip of pub) {
    assert.equal(isPrivate(ip), false, `${ip} should be public`);
  }
});

test("isPrivate still blocks the original RFC 1918 / loopback / link-local ranges", () => {
  for (const ip of ["10.0.0.5", "172.16.4.4", "192.168.1.1", "127.0.0.1", "169.254.169.254", "::1", "fe80::1", "fd00::1"]) {
    assert.equal(isPrivate(ip), true, `${ip} should remain private`);
  }
});
