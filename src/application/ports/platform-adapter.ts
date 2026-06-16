import type { DetectResult, ResolveInput, ResolveResult } from "../../domain/platform.ts";
import type { FetcherPort } from "./fetcher.ts";

/**
 * A general-purpose platform adapter that can detect a URL and resolve it via
 * the platform's public API (clean JSON), short-circuiting extraction/render.
 *
 * Register concrete adapters in src/application/adapters.ts. Adding a platform
 * = one folder under src/infrastructure/<platform>/ + one registry line + one
 * fixture. Not part of the public contract.
 *
 * See docs/contracts.md "Ports → PlatformAdapter".
 */
export interface PlatformAdapter {
  readonly id: string;
  detect(ctx: { url: string; contentType?: string; html?: string }): DetectResult | null;
  resolve(input: ResolveInput, fetcher: FetcherPort): Promise<ResolveResult>;
}

/**
 * Registry of platform adapters keyed by adapter id. Mirrors the
 * SandboxProviderRegistry pattern from ~/sandbox.
 */
export class PlatformAdapterRegistry {
  private readonly adapters = new Map<string, PlatformAdapter>();

  constructor(adapters: PlatformAdapter[]) {
    for (const adapter of adapters) {
      this.adapters.set(adapter.id, adapter);
    }
  }

  get(id: string): PlatformAdapter | null {
    return this.adapters.get(id) ?? null;
  }

  has(id: string): boolean {
    return this.adapters.has(id);
  }

  names(): string[] {
    return [...this.adapters.keys()].sort();
  }

  /**
   * First adapter whose detect() returns non-null for the given context wins.
   * Returns null when no adapter claims the URL (→ generic path).
   */
  detect(ctx: { url: string; contentType?: string; html?: string }): DetectResult | null {
    for (const id of this.names()) {
      const adapter = this.adapters.get(id);
      if (!adapter) continue;
      const detected = adapter.detect(ctx);
      if (detected) return detected;
    }
    return null;
  }
}
