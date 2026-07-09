import { z } from "zod";
import type { Output } from "../../domain/tier.ts";
import type { TransformOverride } from "../ports/transformer.ts";
import { findUnsupportedSchemaKeyword, MAX_SCHEMA_BYTES, MAX_SCHEMA_DEPTH, MAX_SCHEMA_NODES, schemaByteSize, unsupportedKeywordMessage } from "../../infrastructure/llm/schema-keywords.ts";

const CRLF = /[\r\n]|%0d|%0a/i;
const DEFAULT_PROMPT = "Provide a concise summary of the page.";

const positiveInteger = z.number().int().positive();
/** Shared transform-override shape (exported so captatum_bulk mirrors it exactly). */
export const transformOverrideSchema = z.object({
  model: z.string().min(1).optional(),
  provider: z.string().min(1).optional(),
}).catchall(z.unknown());

const captatumInputSchema = z.object({
  url: z.string().min(1),
  prompt: z.string().optional(),
  output: z.enum(["summary", "raw", "extract"]).optional(),
  schema: z.unknown().optional(),
  budget: positiveInteger.optional(),
  transform: transformOverrideSchema.optional(),
  maxBytes: positiveInteger.optional(),
  timeoutMs: positiveInteger.optional(),
  allowRender: z.boolean().optional(),
  debug: z.boolean().optional(),
}).strict();

export interface CaptatumDefaults {
  maxBytes: number;
  maxBytesHardCap: number;
  timeoutMs: number;
  timeoutMsHardCap: number;
  renderTimeoutMs: number;
  renderTimeoutMsHardCap: number;
  maxHops: number;
  allowRender: boolean;
  prompt: string;
  /** Output used when the caller omits `output`. "raw" by default so a fetcher with
   *  no transform provider returns full raw content, not a silent truncated excerpt;
   *  the use case raises this to "summary" when a provider is configured. */
  defaultOutput: Output;
}

export const DEFAULT_CAPTATUM_DEFAULTS: CaptatumDefaults = {
  maxBytes: 5 * 1024 * 1024,
  maxBytesHardCap: 5 * 1024 * 1024,
  timeoutMs: 15_000,
  timeoutMsHardCap: 60_000,
  renderTimeoutMs: 20_000,
  renderTimeoutMsHardCap: 60_000,
  maxHops: 5,
  allowRender: true,
  prompt: DEFAULT_PROMPT,
  defaultOutput: "raw",
};

export interface CaptatumInput {
  url: string;
  prompt?: string;
  output?: Output;
  schema?: unknown;
  budget?: number;
  transform?: TransformOverride;
  maxBytes?: number;
  timeoutMs?: number;
  allowRender?: boolean;
  debug?: boolean;
}

export interface NormalizedCaptatumInput {
  url: string;
  prompt: string;
  requestedOutput: Output;
  schema?: unknown;
  budget?: number;
  transform?: TransformOverride;
  maxBytes: number;
  timeoutMs: number;
  renderTimeoutMs: number;
  maxHops: number;
  allowRender: boolean;
  /** Presentation-only flag: unlock heavy diagnostic fields in the MCP payload. */
  debug: boolean;
}

export interface ContractErrorBody {
  error: { code: string; message: string };
}

export class CaptatumInputError extends Error {
  readonly body: ContractErrorBody;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CaptatumInputError";
    this.body = { error: { code, message } };
  }
}

export function normalizeCaptatumInput(
  value: unknown,
  defaults: CaptatumDefaults = DEFAULT_CAPTATUM_DEFAULTS,
): NormalizedCaptatumInput {
  const parsed = parseInput(value);
  const url = normalizeContractUrl(parsed.url);
  const requestedOutput = parsed.output ?? defaults.defaultOutput;
  assertExtractSchemaSupported(requestedOutput, parsed.schema); // #153: fail-closed at the input boundary
  return {
    url,
    prompt: parsed.prompt ?? defaults.prompt,
    requestedOutput,
    schema: parsed.schema,
    budget: parsed.budget,
    transform: parsed.transform as TransformOverride | undefined,
    maxBytes: Math.min(parsed.maxBytes ?? defaults.maxBytes, defaults.maxBytesHardCap),
    timeoutMs: Math.min(parsed.timeoutMs ?? defaults.timeoutMs, defaults.timeoutMsHardCap),
    renderTimeoutMs: Math.min(parsed.timeoutMs ?? defaults.renderTimeoutMs, defaults.renderTimeoutMsHardCap),
    maxHops: defaults.maxHops,
    allowRender: parsed.allowRender ?? defaults.allowRender,
    debug: parsed.debug ?? false,
  };
}

function parseInput(value: unknown): CaptatumInput {
  const result = captatumInputSchema.safeParse(value);
  if (result.success) return result.data;
  const first = result.error.issues[0];
  if (first?.path[0] === "url") {
    throw new CaptatumInputError("invalid_url", "URL is required");
  }
  throw new CaptatumInputError("invalid_input", "captatum input is invalid");
}

/**
 * Fail-closed input-boundary check for `output: "extract"` (#153): the caller `schema` is
 * untrusted, so reject it — before any fetch/LLM — when it is malformed (not object/boolean),
 * too large/complex to scan, or uses a JSON Schema keyword captatum cannot verify. The
 * decision is an ALLOWLIST (SUPPORTED_KEYS), never a blocklist. Exported so captatum_bulk's
 * normalizer applies the same trust-boundary decision (sibling sweep). */
export function assertExtractSchemaSupported(requestedOutput: Output, schema: unknown): void {
  if (requestedOutput !== "extract" || schema === undefined) return;
  // Payload cap FIRST: the node/depth caps below bound STRUCTURE, not a multi-MB terminal value
  // (description/enum/examples) that would be JSON.stringify'd into the transform prompt. The
  // boundary rejects it before any fetch/LLM (#153).
  if (schemaByteSize(schema, MAX_SCHEMA_BYTES) > MAX_SCHEMA_BYTES) {
    throw new CaptatumInputError("invalid_schema", `extract schema is too large — captatum serializes it into the transform prompt; simplify it to under ${MAX_SCHEMA_BYTES} bytes.`);
  }
  const scan = findUnsupportedSchemaKeyword(schema);
  if (scan.ok) return;
  const message = scan.kind === "unsupported"
    ? unsupportedKeywordMessage(scan.key, scan.path)
    : scan.kind === "unsupported_value"
      ? `JSON Schema keyword "${scan.key}" at ${scan.path} uses an unsupported value form (tuple/array-valued items) — captatum cannot validate it; use a single item schema.`
      : scan.kind === "malformed"
        ? `extract schema must be a JSON Schema object or boolean (received ${typeName(schema)} at ${scan.path}).`
        : `extract schema is too large or complex to validate — simplify it (over ${MAX_SCHEMA_NODES} nodes or ${MAX_SCHEMA_DEPTH} nesting levels at ${scan.path}).`;
  throw new CaptatumInputError("invalid_schema", message);
}

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** Exported for captatum_bulk's per-entry URL validation (same scheme upgrade,
 *  userinfo/CRLF strip, http→https). Throws CaptatumInputError on a bad URL. */
export function normalizeContractUrl(input: string): string {
  if (CRLF.test(input)) {
    throw new CaptatumInputError("crlf_url", "URL contains a forbidden CRLF sequence");
  }

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new CaptatumInputError("invalid_url", "URL is invalid");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new CaptatumInputError("unsupported_scheme", "Only http and https URLs are allowed");
  }
  if (parsed.username || parsed.password) {
    throw new CaptatumInputError("userinfo_url", "URLs with userinfo are not allowed");
  }
  if (!parsed.hostname) {
    throw new CaptatumInputError("invalid_url", "URL must include a hostname");
  }

  parsed.username = "";
  parsed.password = "";
  parsed.hash = "";
  if (parsed.protocol === "http:") parsed.protocol = "https:";
  return parsed.href;
}
