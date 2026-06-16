/**
 * IPv4 private/reserved CIDR ranges blocked from egress.
 * See docs/contracts.md "Security controls" and docs/threat-model.md.
 */
export const PRIVATE_IPV4_CIDRS: readonly string[] = [
  "10.0.0.0/8", // private
  "172.16.0.0/12", // private
  "192.168.0.0/16", // private
  "127.0.0.0/8", // loopback
  "169.254.0.0/16", // link-local incl. cloud metadata (169.254.169.254)
  "0.0.0.0/8", // "this network"
  "100.64.0.0/10", // CGNAT
  "224.0.0.0/4", // multicast
];

/**
 * IPv6 private/reserved CIDR ranges blocked from egress.
 */
export const PRIVATE_IPV6_CIDRS: readonly string[] = [
  "::1/128", // loopback
  "fe80::/10", // link-local
  "fc00::/7", // unique-local
  "ff00::/8", // multicast
  "::ffff:0:0/96", // IPv4-mapped
  "64:ff9b::/96", // NAT64 well-known prefix
  "::/96", // IPv4-compatible (deprecated but blocked)
];

/**
 * Whether the given IP string falls within a private/reserved range.
 *
 * TODO: implement CIDR check (v4 10/8,172.16/12,192.168/16,127/8,169.254/16,0.0.0.0/8,100.64/10,224/4; v6 ::1,fe80/10,fc00/7,ff00/8,::ffff:0:0/96,64:ff9b::,IPv4-compatible).
 * For now returns false — must NOT be wired to live egress until implemented.
 */
export function isPrivate(_ip: string): boolean {
  return false;
}
