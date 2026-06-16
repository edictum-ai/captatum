import { deepEqual, finiteNumber, hasDuplicate, invalid, isMultipleOf, isRecord, matchesType, nonNegativeInteger, objectMap, ok, schemaList, stringArray, stripJsonFence, toRegExp, type SchemaValidationResult } from "./json-schema-utils.ts";

export type { SchemaValidationResult } from "./json-schema-utils.ts";

const JSON_TYPES = new Set(["array", "boolean", "integer", "null", "number", "object", "string"]);
const SUPPORTED_KEYS = new Set([
  "$comment", "$defs", "$id", "$schema", "additionalProperties", "allOf", "anyOf", "const",
  "default", "deprecated", "description", "enum", "examples", "exclusiveMaximum",
  "exclusiveMinimum", "items", "maxItems", "maxLength", "maxProperties", "maximum",
  "minItems", "minLength", "minProperties", "minimum", "multipleOf", "not", "oneOf",
  "pattern", "properties", "readOnly", "required", "title", "type", "uniqueItems",
  "writeOnly", "definitions",
]);

export function parseJsonResult(text: string): unknown {
  const trimmed = stripJsonFence(text.trim());
  return JSON.parse(trimmed) as unknown;
}

export function validateJsonSchema(value: unknown, schema: unknown): SchemaValidationResult {
  if (schema === undefined || schema === true) return ok();
  if (schema === false) return invalid("$ is not allowed by false schema");
  if (!isRecord(schema)) return invalid("schema must be an object or boolean");
  return validateAt(value, schema, "$", new Set());
}

function validateAt(value: unknown, schema: unknown, path: string, stack: Set<Record<string, unknown>>): SchemaValidationResult {
  if (schema === true) return ok();
  if (schema === false) return invalid(`${path} is not allowed by false schema`);
  if (!isRecord(schema)) return invalid(`${path} schema must be an object or boolean`);
  if (stack.has(schema)) return ok();
  stack.add(schema);
  try {
    for (const result of [
      validateSupported(schema, path),
      validateComposites(value, schema, path, stack),
      validateEnum(value, schema, path),
      validateType(value, schema, path),
      validateString(value, schema, path),
      validateNumber(value, schema, path),
      validateObject(value, schema, path, stack),
      validateArray(value, schema, path, stack),
    ]) {
      if (!result.valid) return result;
    }
    return ok();
  } finally {
    stack.delete(schema);
  }
}

function validateSupported(schema: Record<string, unknown>, path: string): SchemaValidationResult {
  const unsupported = Object.keys(schema).find((key) => !SUPPORTED_KEYS.has(key));
  return unsupported ? invalid(`${path} schema keyword "${unsupported}" is not supported`) : ok();
}

function validateComposites(value: unknown, schema: Record<string, unknown>, path: string, stack: Set<Record<string, unknown>>): SchemaValidationResult {
  const allOf = schemaList(schema.allOf, "allOf", path);
  if (!allOf.valid) return allOf;
  for (const subschema of allOf.value) {
    const result = validateAt(value, subschema, path, stack);
    if (!result.valid) return result;
  }

  const anyOf = schemaList(schema.anyOf, "anyOf", path);
  if (!anyOf.valid) return anyOf;
  if (anyOf.value.length > 0 && !anyOf.value.some((choice) => validateAt(value, choice, path, stack).valid)) {
    return invalid(`${path} must match at least one anyOf schema`);
  }

  const oneOf = schemaList(schema.oneOf, "oneOf", path);
  if (!oneOf.valid) return oneOf;
  const matches = oneOf.value.filter((choice) => validateAt(value, choice, path, stack).valid).length;
  if (oneOf.value.length > 0 && matches !== 1) return invalid(`${path} must match exactly one oneOf schema`);

  if ("not" in schema && validateAt(value, schema.not, path, stack).valid) {
    return invalid(`${path} must not match not schema`);
  }
  return ok();
}

function validateEnum(value: unknown, schema: Record<string, unknown>, path: string): SchemaValidationResult {
  if ("const" in schema && !deepEqual(value, schema.const)) return invalid(`${path} must equal schema const`);
  if (!("enum" in schema)) return ok();
  if (!Array.isArray(schema.enum)) return invalid(`${path} schema enum must be an array`);
  return schema.enum.some((candidate) => deepEqual(value, candidate))
    ? ok()
    : invalid(`${path} must be one of schema enum values`);
}

function validateType(value: unknown, schema: Record<string, unknown>, path: string): SchemaValidationResult {
  if (!("type" in schema)) return ok();
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (!types.every((type) => typeof type === "string" && JSON_TYPES.has(type))) {
    return invalid(`${path} schema type must be a JSON Schema type`);
  }
  return types.some((type) => matchesType(value, String(type)))
    ? ok()
    : invalid(`${path} must be ${types.join(" or ")}`);
}

function validateString(value: unknown, schema: Record<string, unknown>, path: string): SchemaValidationResult {
  for (const key of ["minLength", "maxLength"] as const) {
    const result = nonNegativeInteger(schema, key, path);
    if (!result.valid) return result;
  }
  if ("pattern" in schema && typeof schema.pattern !== "string") {
    return invalid(`${path} schema pattern must be a string`);
  }
  if (typeof value !== "string") return ok();
  const length = [...value].length;
  if (typeof schema.minLength === "number" && length < schema.minLength) {
    return invalid(`${path} length must be at least ${schema.minLength}`);
  }
  if (typeof schema.maxLength === "number" && length > schema.maxLength) {
    return invalid(`${path} length must be at most ${schema.maxLength}`);
  }
  if (typeof schema.pattern === "string") {
    const pattern = toRegExp(schema.pattern, path);
    if (!pattern.valid) return pattern;
    if (!pattern.value.test(value)) return invalid(`${path} must match pattern ${schema.pattern}`);
  }
  return ok();
}

function validateNumber(value: unknown, schema: Record<string, unknown>, path: string): SchemaValidationResult {
  for (const key of ["minimum", "maximum", "multipleOf"] as const) {
    if (key in schema && !finiteNumber(schema[key])) return invalid(`${path} schema ${key} must be a finite number`);
  }
  for (const key of ["exclusiveMinimum", "exclusiveMaximum"] as const) {
    if (key in schema && typeof schema[key] !== "number" && typeof schema[key] !== "boolean") {
      return invalid(`${path} schema ${key} must be a number or boolean`);
    }
  }
  if (typeof value !== "number" || !Number.isFinite(value)) return ok();
  if (typeof schema.minimum === "number" && value < schema.minimum) return invalid(`${path} must be >= ${schema.minimum}`);
  if (typeof schema.maximum === "number" && value > schema.maximum) return invalid(`${path} must be <= ${schema.maximum}`);
  if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) {
    return invalid(`${path} must be > ${schema.exclusiveMinimum}`);
  }
  if (schema.exclusiveMinimum === true && typeof schema.minimum === "number" && value <= schema.minimum) {
    return invalid(`${path} must be > ${schema.minimum}`);
  }
  if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) {
    return invalid(`${path} must be < ${schema.exclusiveMaximum}`);
  }
  if (schema.exclusiveMaximum === true && typeof schema.maximum === "number" && value >= schema.maximum) {
    return invalid(`${path} must be < ${schema.maximum}`);
  }
  if (typeof schema.multipleOf === "number" && schema.multipleOf <= 0) {
    return invalid(`${path} schema multipleOf must be greater than 0`);
  }
  if (typeof schema.multipleOf === "number" && !isMultipleOf(value, schema.multipleOf)) {
    return invalid(`${path} must be a multiple of ${schema.multipleOf}`);
  }
  return ok();
}

function validateObject(value: unknown, schema: Record<string, unknown>, path: string, stack: Set<Record<string, unknown>>): SchemaValidationResult {
  if (schema.type !== "object" && !isRecord(value)) return ok();
  if (!isRecord(value)) return invalid(`${path} must be object`);
  for (const key of ["minProperties", "maxProperties"] as const) {
    const result = nonNegativeInteger(schema, key, path);
    if (!result.valid) return result;
  }
  const count = Object.keys(value).length;
  if (typeof schema.minProperties === "number" && count < schema.minProperties) {
    return invalid(`${path} must have at least ${schema.minProperties} properties`);
  }
  if (typeof schema.maxProperties === "number" && count > schema.maxProperties) {
    return invalid(`${path} must have at most ${schema.maxProperties} properties`);
  }

  if (schema.required !== undefined && !stringArray(schema.required)) {
    return invalid(`${path} schema required must be an array of strings`);
  }
  for (const key of schema.required ?? []) {
    if (!(key in value)) return invalid(`${path}.${key} is required`);
  }

  const properties = objectMap(schema.properties, "properties", path);
  if (!properties.valid) return properties;
  for (const [key, propertySchema] of Object.entries(properties.value)) {
    if (key in value) {
      const result = validateAt(value[key], propertySchema, `${path}.${key}`, stack);
      if (!result.valid) return result;
    }
  }
  return validateAdditionalProperties(value, schema, properties.value, path, stack);
}

function validateAdditionalProperties(
  value: Record<string, unknown>,
  schema: Record<string, unknown>,
  properties: Record<string, unknown>,
  path: string,
  stack: Set<Record<string, unknown>>,
): SchemaValidationResult {
  const additional = schema.additionalProperties;
  if (additional !== undefined && typeof additional !== "boolean" && !isRecord(additional)) {
    return invalid(`${path} schema additionalProperties must be a boolean or schema`);
  }
  for (const key of Object.keys(value).filter((candidate) => !(candidate in properties))) {
    if (additional === false) return invalid(`${path}.${key} is not allowed`);
    if (additional !== undefined && additional !== true) {
      const result = validateAt(value[key], additional, `${path}.${key}`, stack);
      if (!result.valid) return result;
    }
  }
  return ok();
}

function validateArray(value: unknown, schema: Record<string, unknown>, path: string, stack: Set<Record<string, unknown>>): SchemaValidationResult {
  if (schema.type !== "array" && !Array.isArray(value)) return ok();
  if (!Array.isArray(value)) return invalid(`${path} must be array`);
  for (const key of ["minItems", "maxItems"] as const) {
    const result = nonNegativeInteger(schema, key, path);
    if (!result.valid) return result;
  }
  if (typeof schema.minItems === "number" && value.length < schema.minItems) {
    return invalid(`${path} must have at least ${schema.minItems} items`);
  }
  if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
    return invalid(`${path} must have at most ${schema.maxItems} items`);
  }
  if (schema.uniqueItems !== undefined && typeof schema.uniqueItems !== "boolean") {
    return invalid(`${path} schema uniqueItems must be a boolean`);
  }
  if (schema.uniqueItems === true && hasDuplicate(value)) return invalid(`${path} items must be unique`);
  if (!("items" in schema)) return ok();
  if (Array.isArray(schema.items)) return invalid(`${path} schema items tuple arrays are not supported`);
  for (let index = 0; index < value.length; index += 1) {
    const result = validateAt(value[index], schema.items, `${path}[${index}]`, stack);
    if (!result.valid) return result;
  }
  return ok();
}
