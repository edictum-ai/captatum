import type { ProvenanceError } from "../../domain/result.ts";

/** Only these root-level config keys may be recovered from an extract schema. This deliberately
 * excludes URL, output, prompt, schema, and bulk-only cost fields: schema data must never select
 * a fetch target, output mode, or caller budget policy. */
export const EXTRACT_SCHEMA_KNOB_KEYS = ["budget", "timeoutMs", "allowRender", "debug", "maxBytes", "transform"] as const;

type ExtractSchemaKnobKey = (typeof EXTRACT_SCHEMA_KNOB_KEYS)[number];

export interface ExtractSchemaKnobInput {
  output?: unknown;
  schema?: unknown;
  budget?: number;
  timeoutMs?: number;
  allowRender?: boolean;
  debug?: boolean;
  maxBytes?: number;
  transform?: unknown;
}

export interface SchemaKnobRecovery {
  schema: unknown;
  recovered: Partial<Pick<ExtractSchemaKnobInput, ExtractSchemaKnobKey>>;
  warnings: ProvenanceError[];
}

/**
 * Recover known Captatum configuration that a non-conforming client merged into an extract schema.
 * Only root keys of a shallow clone are considered, leaving property names such as
 * `schema.properties.budget` untouched. Invalid values remain in the schema so the existing
 * fail-closed schema-keyword boundary rejects them without applying untrusted configuration.
 */
export function recoverExtractSchemaKnobs(
  input: ExtractSchemaKnobInput,
  isValid: (key: ExtractSchemaKnobKey, value: unknown) => boolean,
): SchemaKnobRecovery {
  if (input.output !== "extract" || !isRecord(input.schema)) {
    return { schema: input.schema, recovered: {}, warnings: [] };
  }

  const schema = { ...input.schema };
  const recovered: SchemaKnobRecovery["recovered"] = {};
  const warnings: ProvenanceError[] = [];
  for (const key of EXTRACT_SCHEMA_KNOB_KEYS) {
    if (!Object.hasOwn(schema, key) || !isValid(key, schema[key])) continue;
    const applied = input[key] === undefined;
    if (applied) recovered[key] = schema[key] as never;
    delete schema[key];
    warnings.push({
      code: "schema_knob_extracted",
      message: applied
        ? `"${key}" was recovered from "schema" and applied as a Captatum tool argument.`
        : `"${key}" in "schema" was ignored because the top-level Captatum tool argument takes precedence.`,
    });
  }
  return { schema, recovered, warnings };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
