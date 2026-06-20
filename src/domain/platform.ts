export interface Platform {
  adapterId: string;
  label: string;
  detectedFrom: string;
}

export interface DetectResult {
  adapterId: string;
  label: string;
  detectedFrom: string;
  confidence: number;
}

export interface ResolveInput {
  url: string;
  /** Caller-injected ISO timestamp; no Date.now() in core. */
  now: string;
}

export interface ResolveResult {
  /** Clean resolved content (JSON or markdown), platform-specific. */
  content: string;
  contentType: string;
  finalUrl: string;
  redirects: Array<{ url: string; status: number }>;
  structured?: StructuredData;
  title?: string;
}

export interface StructuredData {
  canonicalUrl?: string;
  jsonLd?: unknown;
  og?: Record<string, string>;
  meta?: Record<string, string>;
  appState?: unknown;
  /**
   * Absolute, deduped, bounded http(s) image URLs derived from og:image*,
   * JSON-LD image/thumbnailUrl/ImageObject, and `<img src>`/`<source srcset>`.
   * Surfaced to the agent for optional multimodal vision fetch; never fetched
   * by this service. Private-IP / localhost hosts are stripped (no DNS — string
   * check only) so internal targets are not advertised externally.
   */
  images?: string[];
}
