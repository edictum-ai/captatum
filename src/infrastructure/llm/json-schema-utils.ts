export interface SchemaValidationResult {
  valid: boolean;
  message?: string;
}

export function schemaList(
  value: unknown,
  key: string,
  path: string,
): SchemaValidationResult & { value: unknown[] } {
  if (value === undefined) return { valid: true, value: [] };
  return Array.isArray(value)
    ? { valid: true, value }
    : { valid: false, message: `${path} schema ${key} must be an array`, value: [] };
}

export function objectMap(
  value: unknown,
  key: string,
  path: string,
): SchemaValidationResult & { value: Record<string, unknown> } {
  if (value === undefined) return { valid: true, value: {} };
  return isRecord(value)
    ? { valid: true, value }
    : { valid: false, message: `${path} schema ${key} must be an object`, value: {} };
}

export function nonNegativeInteger(
  schema: Record<string, unknown>,
  key: string,
  path: string,
): SchemaValidationResult {
  if (!(key in schema)) return ok();
  return Number.isInteger(schema[key]) && Number(schema[key]) >= 0
    ? ok()
    : invalid(`${path} schema ${key} must be a non-negative integer`);
}

export function toRegExp(pattern: string, path: string): SchemaValidationResult & { value: RegExp } {
  try {
    return { valid: true, value: new RegExp(pattern) };
  } catch {
    return { valid: false, message: `${path} schema pattern is invalid`, value: /$./ };
  }
}

export function matchesType(value: unknown, type: string): boolean {
  if (type === "array") return Array.isArray(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "object") return isRecord(value);
  if (type === "null") return value === null;
  return typeof value === type;
}

export function stripJsonFence(text: string): string {
  const match = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1] ?? text;
}

export function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function ok(): SchemaValidationResult {
  return { valid: true };
}

export function invalid(message: string): SchemaValidationResult {
  return { valid: false, message };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function hasDuplicate(values: unknown[]): boolean {
  return values.some((value, index) => values.findIndex((other) => deepEqual(value, other)) !== index);
}

export function isMultipleOf(value: number, divisor: number): boolean {
  const quotient = value / divisor;
  return Math.abs(quotient - Math.round(quotient)) < Number.EPSILON * 100;
}
