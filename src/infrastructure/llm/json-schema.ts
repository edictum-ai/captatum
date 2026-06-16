export interface SchemaValidationResult {
  valid: boolean;
  message?: string;
}

export function parseJsonResult(text: string): unknown {
  const trimmed = stripJsonFence(text.trim());
  return JSON.parse(trimmed) as unknown;
}

export function validateJsonSchema(value: unknown, schema: unknown): SchemaValidationResult {
  if (schema === undefined) return { valid: true };
  if (!isRecord(schema)) return { valid: false, message: "schema must be an object" };
  return validateAt(value, schema, "$", new Set());
}

function validateAt(
  value: unknown,
  schema: Record<string, unknown>,
  path: string,
  seen: Set<Record<string, unknown>>,
): SchemaValidationResult {
  if (seen.has(schema)) return { valid: true };
  seen.add(schema);

  const enumResult = validateEnum(value, schema, path);
  if (!enumResult.valid) return enumResult;

  const typeResult = validateType(value, schema, path);
  if (!typeResult.valid) return typeResult;

  if (schema.type === "object" || isRecord(value)) {
    const objectResult = validateObject(value, schema, path, seen);
    if (!objectResult.valid) return objectResult;
  }

  if (schema.type === "array" || Array.isArray(value)) {
    const arrayResult = validateArray(value, schema, path, seen);
    if (!arrayResult.valid) return arrayResult;
  }

  return { valid: true };
}

function validateEnum(value: unknown, schema: Record<string, unknown>, path: string): SchemaValidationResult {
  if ("const" in schema && !deepEqual(value, schema.const)) {
    return { valid: false, message: `${path} must equal schema const` };
  }
  if (!Array.isArray(schema.enum)) return { valid: true };
  return schema.enum.some((candidate) => deepEqual(value, candidate))
    ? { valid: true }
    : { valid: false, message: `${path} must be one of schema enum values` };
}

function validateType(value: unknown, schema: Record<string, unknown>, path: string): SchemaValidationResult {
  const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
  const types = allowed.filter((type): type is string => typeof type === "string");
  if (types.length === 0) return { valid: true };
  return types.some((type) => matchesType(value, type))
    ? { valid: true }
    : { valid: false, message: `${path} must be ${types.join(" or ")}` };
}

function validateObject(
  value: unknown,
  schema: Record<string, unknown>,
  path: string,
  seen: Set<Record<string, unknown>>,
): SchemaValidationResult {
  if (!isRecord(value)) return { valid: false, message: `${path} must be object` };
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const key of required) {
    if (typeof key === "string" && !(key in value)) {
      return { valid: false, message: `${path}.${key} is required` };
    }
  }

  const properties = isRecord(schema.properties) ? schema.properties : {};
  for (const [key, propertySchema] of Object.entries(properties)) {
    if (!(key in value) || !isRecord(propertySchema)) continue;
    const result = validateAt(value[key], propertySchema, `${path}.${key}`, seen);
    if (!result.valid) return result;
  }

  if (schema.additionalProperties === false) {
    const allowed = new Set(Object.keys(properties));
    const extra = Object.keys(value).find((key) => !allowed.has(key));
    if (extra) return { valid: false, message: `${path}.${extra} is not allowed` };
  }
  return { valid: true };
}

function validateArray(
  value: unknown,
  schema: Record<string, unknown>,
  path: string,
  seen: Set<Record<string, unknown>>,
): SchemaValidationResult {
  if (!Array.isArray(value)) return { valid: false, message: `${path} must be array` };
  if (!isRecord(schema.items)) return { valid: true };
  for (let index = 0; index < value.length; index += 1) {
    const result = validateAt(value[index], schema.items, `${path}[${index}]`, seen);
    if (!result.valid) return result;
  }
  return { valid: true };
}

function matchesType(value: unknown, type: string): boolean {
  if (type === "array") return Array.isArray(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "object") return isRecord(value);
  if (type === "null") return value === null;
  return typeof value === type;
}

function stripJsonFence(text: string): string {
  const match = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1] ?? text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
