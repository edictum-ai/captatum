import { PlatformAdapterRegistry } from "./ports/platform-adapter.ts";

/**
 * Build the platform-adapter registry. Concrete adapters (e.g. Ashby, GitHub,
 * generic) are added in the vertical slice — one folder under
 * src/infrastructure/<platform>/ + one line here + one fixture each.
 *
 * Mirrors ~/sandbox's createProviderRegistry pattern.
 */
export function createAdapterRegistry(): PlatformAdapterRegistry {
  return new PlatformAdapterRegistry([]);
}
