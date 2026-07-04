/**
 * IPv4 private/reserved CIDR ranges blocked from egress.
 * See docs/contracts.md "Security controls" and docs/threat-model.md.
 */
export const PRIVATE_IPV4_CIDRS: readonly string[] = [
  "0.0.0.0/8", // "this network"
  "10.0.0.0/8", // private
  "100.64.0.0/10", // CGNAT
  "127.0.0.0/8", // loopback
  "169.254.0.0/16", // link-local incl. cloud metadata (169.254.169.254)
  "172.16.0.0/12", // private
  // 192.0.0.0/24 (IETF Protocol Assignments) is reserved except the globally-
  // reachable anycast 192.0.0.9/.10 (kept allowed) — block the rest.
  "192.0.0.0/29",
  "192.0.0.8/32",
  "192.0.0.11/32",
  "192.0.0.12/30",
  "192.0.0.16/28",
  "192.0.0.32/27",
  "192.0.0.64/26",
  "192.0.0.128/25",
  "192.0.2.0/24", // TEST-NET-1 (documentation)
  "192.168.0.0/16", // private
  "198.18.0.0/15", // benchmarking (RFC 2544)
  "198.51.100.0/24", // TEST-NET-2 (documentation)
  "203.0.113.0/24", // TEST-NET-3 (documentation)
  "224.0.0.0/4", // multicast
  "240.0.0.0/4", // reserved for future use (incl. 255.255.255.255 broadcast)
];

/**
 * IPv6 private/reserved CIDR ranges blocked from egress.
 */
export const PRIVATE_IPV6_CIDRS: readonly string[] = [
  "::1/128", // loopback
  "::/128", // unspecified
  "::/96", // IPv4-compatible (deprecated but blocked)
  "::ffff:0:0/96", // IPv4-mapped
  "64:ff9b::/96", // NAT64 well-known prefix
  "64:ff9b:1::/48", // NAT64 local-use prefix (not globally reachable)
  "100::/64", // discard (RFC 6666)
  "2001::/32", // Teredo
  "2001:2::/48", // benchmarking (RFC 5180)
  "2001:db8::/32", // documentation (RFC 3849)
  "2002::/16", // 6to4
  "3fff::/20", // documentation (RFC 9637)
  "fec0::/10", // site-local (deprecated)
  "fe80::/10", // link-local
  "fc00::/7", // unique-local
  "ff00::/8", // multicast
];

/**
 * Whether the given IP string falls within a private/reserved range.
 */
export function isPrivate(ip: string): boolean {
  const cleaned = stripBracketsAndZone(ip);
  const version = ipVersion(cleaned);
  if (version === 4) {
    const value = parseIpv4(cleaned);
    return value === null ? false : PRIVATE_IPV4_CIDRS.some((cidr) => ipv4InCidr(value, cidr));
  }
  if (version === 6) {
    const value = parseIpv6(cleaned);
    return value === null ? false : PRIVATE_IPV6_CIDRS.some((cidr) => ipv6InCidr(value, cidr));
  }
  return false;
}

/** Whether a host is a loopback endpoint: the name "localhost", an IPv4 literal in
 *  127.0.0.0/8, or the IPv6 literal ::1. A DNS NAME such as "127.attacker.example" is
 *  NOT loopback — only IP literals count — so it cannot smuggle a cleartext-http bearer
 *  credential or mark a remote provider "local" for sensitive-content routing (PR #86). */
export function isLoopbackHost(host: string): boolean {
  const cleaned = stripBracketsAndZone(host);
  if (cleaned === "localhost") return true;
  const v4 = parseIpv4(cleaned);
  if (v4 !== null) return v4 >>> 24 === 127;
  const v6 = parseIpv6(cleaned);
  return v6 !== null && v6 === 1n;
}

export function ipVersion(ip: string): 0 | 4 | 6 {
  if (parseIpv4(stripBracketsAndZone(ip)) !== null) return 4;
  if (parseIpv6(stripBracketsAndZone(ip)) !== null) return 6;
  return 0;
}

function stripBracketsAndZone(value: string): string {
  let ip = value.trim().toLowerCase();
  if (ip.startsWith("[") && ip.endsWith("]")) {
    ip = ip.slice(1, -1);
  }
  const zoneIndex = ip.indexOf("%");
  return zoneIndex === -1 ? ip : ip.slice(0, zoneIndex);
}

function parseIpv4(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet < 0 || octet > 255) return null;
    value = (value << 8) + octet;
  }
  return value >>> 0;
}

function ipv4InCidr(value: number, cidr: string): boolean {
  const [baseText, prefixText] = cidr.split("/");
  const base = parseIpv4(baseText);
  const prefix = Number(prefixText);
  if (base === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    return false;
  }
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (base & mask);
}

function parseIpv6(ip: string): bigint | null {
  const normalized = normalizeDottedIpv6Tail(ip);
  if (normalized === null) return null;
  const halves = normalized.split("::");
  if (halves.length > 2) return null;

  const left = parseIpv6Side(halves[0]);
  const right = halves.length === 2 ? parseIpv6Side(halves[1]) : [];
  if (left === null || right === null) return null;

  const missing = 8 - left.length - right.length;
  if (halves.length === 1 && missing !== 0) return null;
  if (halves.length === 2 && missing < 0) return null;

  const groups = [...left, ...Array<number>(missing).fill(0), ...right];
  if (groups.length !== 8) return null;

  return groups.reduce((acc, group) => (acc << 16n) + BigInt(group), 0n);
}

function normalizeDottedIpv6Tail(ip: string): string | null {
  if (!ip.includes(".")) return ip;
  const lastColon = ip.lastIndexOf(":");
  if (lastColon === -1) return null;
  const ipv4 = parseIpv4(ip.slice(lastColon + 1));
  if (ipv4 === null) return null;
  const high = (ipv4 >>> 16).toString(16);
  const low = (ipv4 & 0xffff).toString(16);
  return `${ip.slice(0, lastColon)}:${high}:${low}`;
}

function parseIpv6Side(side: string): number[] | null {
  if (side === "") return [];
  const groups = side.split(":");
  const parsed: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
    parsed.push(Number.parseInt(group, 16));
  }
  return parsed;
}

function ipv6InCidr(value: bigint, cidr: string): boolean {
  const [baseText, prefixText] = cidr.split("/");
  const base = parseIpv6(baseText);
  const prefix = Number(prefixText);
  if (base === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 128) {
    return false;
  }
  const mask = prefix === 0 ? 0n : ((1n << BigInt(prefix)) - 1n) << BigInt(128 - prefix);
  return (value & mask) === (base & mask);
}
