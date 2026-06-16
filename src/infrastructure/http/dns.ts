import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { ipVersion, isPrivate } from "../../domain/policy.ts";
import { reject, withAbort } from "./errors.ts";
import { isLocalHostname } from "./url.ts";

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface DnsResolver {
  lookup(hostname: string, signal: AbortSignal): Promise<ResolvedAddress[]>;
}

export class NodeDnsResolver implements DnsResolver {
  async lookup(hostname: string, signal: AbortSignal): Promise<ResolvedAddress[]> {
    const literalFamily = toIpFamily(hostname);
    if (literalFamily) {
      return [{ address: hostname, family: literalFamily }];
    }
    return await withAbort(
      lookup(hostname, { all: true, verbatim: true }).then((results) =>
        results.map(({ address, family }) => ({ address, family: family as 4 | 6 })),
      ),
      signal,
    );
  }
}

export async function resolvePublicAddress(
  hostname: string,
  resolver: DnsResolver,
  signal: AbortSignal,
): Promise<ResolvedAddress> {
  const literalFamily = toIpFamily(hostname);
  if (literalFamily) {
    if (isPrivate(hostname)) {
      reject("private_address", "Host resolves to a private or reserved address");
    }
    return { address: hostname, family: literalFamily };
  }

  if (isLocalHostname(hostname)) {
    reject("private_address", "Host resolves to a private or reserved address");
  }

  let addresses: ResolvedAddress[];
  try {
    addresses = await resolver.lookup(hostname, signal);
  } catch (error) {
    if (error instanceof Error && error.name === "GuardedFetchError") throw error;
    reject("dns_error", "DNS resolution failed");
  }

  if (addresses.length === 0) {
    reject("dns_empty", "DNS resolution returned no addresses");
  }
  for (const resolved of addresses) {
    assertClassifiedResolvedAddress(resolved);
    if (isPrivate(resolved.address)) {
      reject("private_address", "Host resolves to a private or reserved address");
    }
  }
  return addresses[0];
}

function toIpFamily(hostname: string): 4 | 6 | null {
  const family = isIP(hostname);
  if (family !== 4 && family !== 6) return null;
  if (ipVersion(hostname) !== family) {
    reject("invalid_url", "IP literal could not be classified");
  }
  return family;
}

function assertClassifiedResolvedAddress(resolved: ResolvedAddress): void {
  if (ipVersion(resolved.address) !== resolved.family) {
    reject("dns_error", "DNS resolution returned an unclassifiable address");
  }
}
