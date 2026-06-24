import { z } from "zod";
import type { Output } from "../../domain/tier.ts";
import type { TransformOverride } from "../ports/transformer.ts";

const CRLF = /[\r\n]|%0d|%0a/i;
const DEFAULT_PROMPT = "Provide a concise summary of the page.";

const positiveInteger = z.number().int().positive();
const transformOverrideSchema = z.object({
  model: z.string().min(1).optional(),
  provider: z.string().min(1).optional(),
}).catchall(z.unknown());

const smartFetchInputSchema = z.object({
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

export interface SmartFetchDefaults {
  maxBytes: number;
  maxBytesHardCap: number;
  timeoutMs: number;
  timeoutMsHardCap: number;
  renderTimeoutMs: number;
  renderTimeoutMsHardCap: number;
  maxHops: number;
  allowRender: boolean;
  prompt: string;
}

export const DEFAULT_SMART_FETCH_DEFAULTS: SmartFetchDefaults = {
  maxBytes: 5 * 1024 * 1024,
  maxBytesHardCap: 5 * 1024 * 1024,
  timeoutMs: 15_000,
  timeoutMsHardCap: 60_000,
  renderTimeoutMs: 20_000,
  renderTimeoutMsHardCap: 60_000,
  maxHops: 5,
  allowRender: false,
  prompt: DEFAULT_PROMPT,
};

export interface SmartFetchInput {
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

export interface NormalizedSmartFetchInput {
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

export class SmartFetchInputError extends Error {
  readonly body: ContractErrorBody;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SmartFetchInputError";
    this.body = { error: { code, message } };
  }
}

export function normalizeSmartFetchInput(
  value: unknown,
  defaults: SmartFetchDefaults = DEFAULT_SMART_FETCH_DEFAULTS,
): NormalizedSmartFetchInput {
  const parsed = parseInput(value);
  const url = normalizeContractUrl(parsed.url);
  return {
    url,
    prompt: parsed.prompt ?? defaults.prompt,
    requestedOutput: parsed.output ?? "summary",
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

function parseInput(value: unknown): SmartFetchInput {
  const result = smartFetchInputSchema.safeParse(value);
  if (result.success) return result.data;
  const first = result.error.issues[0];
  if (first?.path[0] === "url") {
    throw new SmartFetchInputError("invalid_url", "URL is required");
  }
  throw new SmartFetchInputError("invalid_input", "smart_fetch input is invalid");
}

function normalizeContractUrl(input: string): string {
  if (CRLF.test(input)) {
    throw new SmartFetchInputError("crlf_url", "URL contains a forbidden CRLF sequence");
  }

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new SmartFetchInputError("invalid_url", "URL is invalid");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new SmartFetchInputError("unsupported_scheme", "Only http and https URLs are allowed");
  }
  if (parsed.username || parsed.password) {
    throw new SmartFetchInputError("userinfo_url", "URLs with userinfo are not allowed");
  }
  if (!parsed.hostname) {
    throw new SmartFetchInputError("invalid_url", "URL must include a hostname");
  }

  parsed.username = "";
  parsed.password = "";
  parsed.hash = "";
  if (parsed.protocol === "http:") parsed.protocol = "https:";
  return parsed.href;
}
