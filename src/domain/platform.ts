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
  jsonLd?: unknown;
  og?: Record<string, string>;
  meta?: Record<string, string>;
  appState?: unknown;
}
