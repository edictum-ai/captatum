import assert from "node:assert/strict";
import { test } from "node:test";
import { AD_TRACKER_HOSTS, isAdTrackerHost } from "../src/domain/adblock.ts";

test("isAdTrackerHost matches an apex and any subdomain of a listed apex", () => {
  for (const h of [
    "doubleclick.net",
    "ad.doubleclick.net",
    "stats.g.doubleclick.net",
    "google-analytics.com",
    "www.google-analytics.com",
    "tpc.googlesyndication.com",
    "sb.scorecardresearch.com",
    "connect.facebook.net",
  ]) {
    assert.equal(isAdTrackerHost(h), true, `${h} should be blocked`);
  }
});

test("isAdTrackerHost does NOT match apex-of-portal / shared-CDN / first-party hosts", () => {
  // These were deliberately excluded by the adversarial vet pass: blocking the apex
  // would break the legitimate platform/site, or the host serves first-party content.
  for (const h of [
    "facebook.com",
    "www.facebook.com",
    "linkedin.com",
    "t.co",
    "redditstatic.com",
    "pinterest.com",
    "analytics.pinterest.com",
    "quora.com",
    "yandex.ru",
    "yahoo.com",
    "tiktok.com",
    // shared CDNs / SaaS serving first-party content
    "cloudfront.net",
    "d123.cloudfront.net",
    "akamaized.net",
    "fastly.net",
    "googleapis.com",
    "gstatic.com",
    // unrelated / first-party
    "estadao.com.br",
    "example.com",
    "localhost",
    "",
  ]) {
    assert.equal(isAdTrackerHost(h), false, `${h} must NOT be blocked`);
  }
});

test("the new blocklist is a strict superset of the old ANALYTICS_HOSTS (no regression)", () => {
  const oldAnalytics = [
    "doubleclick.net",
    "google-analytics.com",
    "googletagmanager.com",
    "mixpanel.com",
    "segment.io",
  ];
  for (const h of oldAnalytics) {
    assert.ok(AD_TRACKER_HOSTS.has(h), `regression: ${h} dropped from blocklist`);
  }
});

test("AD_TRACKER_HOSTS contains no known portal/CDN apex (vet guard)", () => {
  const forbidden = [
    "facebook.com", "linkedin.com", "t.co", "redditstatic.com", "pinterest.com",
    "quora.com", "yandex.ru", "cloudfront.net", "akamai.net", "fastly.net",
    "googleapis.com", "gstatic.com", "cloudflare.com", "jsdelivr.net",
  ];
  for (const h of forbidden) {
    assert.ok(!AD_TRACKER_HOSTS.has(h), `vet regression: ${h} must not be in blocklist`);
  }
});
