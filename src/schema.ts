import { ValidationError, type ValidationIssue } from "./errors.ts";

export const FIELD_TYPES = ["string", "number", "boolean", "datetime", "json"] as const;

export type FieldType = typeof FIELD_TYPES[number];

export interface FieldDefinition {
  type: FieldType;
  required: boolean;
  default?: unknown;
}

export type Fields = Record<string, FieldDefinition>;

export interface ResourceDefinition {
  name: string;
  fields: Fields;
}

/** A resource name doubles as the URL path segment, so keep it URL-safe and unambiguous. */
export const RESOURCE_NAME_PATTERN = /^[a-z][a-z0-9_-]*$/;

/** Paths the router claims for itself; they can never be resource names. */
export const RESERVED_RESOURCE_NAMES = new Set(["__admin", "_health"]);

/** Every record carries these, so a schema may not redefine them. */
export const RESERVED_FIELD_NAMES = new Set(["id", "createdAt", "updatedAt"]);

const FIELD_DEFINITION_KEYS = new Set(["type", "required", "default"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates the body of `POST|PUT /__admin/resources` and returns a normalized definition.
 * `expectedName` is supplied by `PUT`, where the name comes from the path instead of the body.
 */
export function parseResourceDefinition(input: unknown, expectedName?: string): ResourceDefinition {
  if (!isPlainObject(input)) {
    throw new ValidationError("Request body must be a JSON object");
  }

  const issues: ValidationIssue[] = [];
  const name = expectedName ?? input.name;

  if (typeof name !== "string") {
    issues.push({ field: "name", message: "name is required and must be a string" });
  } else if (!RESOURCE_NAME_PATTERN.test(name)) {
    issues.push({
      field: "name",
      message: `name must match ${RESOURCE_NAME_PATTERN.source}`,
    });
  } else if (RESERVED_RESOURCE_NAMES.has(name)) {
    issues.push({ field: "name", message: `"${name}" is reserved` });
  }

  if (expectedName !== undefined && typeof input.name === "string" && input.name !== expectedName) {
    issues.push({
      field: "name",
      message: `name in the body ("${input.name}") does not match the path ("${expectedName}")`,
    });
  }

  let fields: Fields = {};
  try {
    fields = parseFields(input.fields);
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    issues.push(...(error.details ?? [{ field: "fields", message: error.message }]));
  }

  if (issues.length > 0) {
    throw new ValidationError("Invalid resource definition", issues);
  }

  return { name: name as string, fields };
}

/** Validates the `fields` map of a resource definition and normalizes it. */
export function parseFields(input: unknown): Fields {
  if (!isPlainObject(input)) {
    throw new ValidationError("Invalid resource definition", [
      { field: "fields", message: "fields is required and must be an object" },
    ]);
  }

  const entries = Object.entries(input);
  if (entries.length === 0) {
    throw new ValidationError("Invalid resource definition", [
      { field: "fields", message: "fields must declare at least one field" },
    ]);
  }

  const issues: ValidationIssue[] = [];
  const fields: Fields = {};

  for (const [fieldName, rawDefinition] of entries) {
    const path = `fields.${fieldName}`;

    if (RESERVED_FIELD_NAMES.has(fieldName)) {
      issues.push({ field: path, message: `"${fieldName}" is a reserved field name` });
      continue;
    }
    if (!isPlainObject(rawDefinition)) {
      issues.push({ field: path, message: "field definition must be an object" });
      continue;
    }

    for (const key of Object.keys(rawDefinition)) {
      if (!FIELD_DEFINITION_KEYS.has(key)) {
        issues.push({ field: `${path}.${key}`, message: `unknown key "${key}"` });
      }
    }

    const type = rawDefinition.type;
    if (typeof type !== "string" || !FIELD_TYPES.includes(type as FieldType)) {
      issues.push({
        field: `${path}.type`,
        message: `type must be one of: ${FIELD_TYPES.join(", ")}`,
      });
      continue;
    }

    const required = rawDefinition.required ?? false;
    if (typeof required !== "boolean") {
      issues.push({ field: `${path}.required`, message: "required must be a boolean" });
      continue;
    }

    const definition: FieldDefinition = { type: type as FieldType, required };

    if ("default" in rawDefinition) {
      if (required) {
        issues.push({
          field: `${path}.default`,
          message: "a required field cannot also have a default",
        });
        continue;
      }
      const coerced = coerceValue(definition.type, rawDefinition.default);
      if (coerced.ok) {
        definition.default = coerced.value;
      } else {
        issues.push({ field: `${path}.default`, message: coerced.message });
        continue;
      }
    }

    fields[fieldName] = definition;
  }

  if (issues.length > 0) {
    throw new ValidationError("Invalid resource definition", issues);
  }

  return fields;
}

type CoerceResult =
  | { ok: true; value: unknown }
  | { ok: false; message: string };

/** Checks a single value against a field type and normalizes it for storage. */
function coerceValue(type: FieldType, value: unknown): CoerceResult {
  switch (type) {
    case "string":
      return typeof value === "string"
        ? { ok: true, value }
        : { ok: false, message: "must be a string" };

    case "number":
      return typeof value === "number" && Number.isFinite(value)
        ? { ok: true, value }
        : { ok: false, message: "must be a finite number" };

    case "boolean":
      return typeof value === "boolean"
        ? { ok: true, value }
        : { ok: false, message: "must be a boolean" };

    case "datetime": {
      if (typeof value !== "string") {
        return { ok: false, message: "must be an ISO 8601 date-time string" };
      }
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime())
        ? { ok: false, message: "must be an ISO 8601 date-time string" }
        : { ok: true, value: parsed.toISOString() };
    }

    case "json":
      // Anything that survived JSON.parse is acceptable, including arrays and nested objects.
      return { ok: true, value };
  }
}

export interface ValidateRecordOptions {
  /** `PATCH` sends only the fields being changed, so absent fields must not trip `required`. */
  partial?: boolean;
}

/**
 * Validates a record body against a resource schema and returns the data to store.
 * Rejects unknown fields, applies defaults on non-partial writes, and normalizes datetimes.
 */
export function validateRecord(
  fields: Fields,
  input: unknown,
  options: ValidateRecordOptions = {},
): Record<string, unknown> {
  if (!isPlainObject(input)) {
    throw new ValidationError("Request body must be a JSON object");
  }

  const partial = options.partial ?? false;
  const issues: ValidationIssue[] = [];
  const data: Record<string, unknown> = {};

  for (const key of Object.keys(input)) {
    if (!(key in fields)) {
      issues.push({
        field: key,
        message: RESERVED_FIELD_NAMES.has(key)
          ? `"${key}" is managed by the server and cannot be set`
          : `unknown field "${key}"`,
      });
    }
  }

  for (const [fieldName, definition] of Object.entries(fields)) {
    if (!(fieldName in input)) {
      if (partial) continue;
      if (definition.required) {
        issues.push({ field: fieldName, message: "is required" });
      } else if ("default" in definition) {
        data[fieldName] = definition.default;
      }
      continue;
    }

    const value = input[fieldName];

    if (value === null) {
      if (definition.required) {
        issues.push({ field: fieldName, message: "is required and cannot be null" });
      } else {
        data[fieldName] = null;
      }
      continue;
    }

    const coerced = coerceValue(definition.type, value);
    if (coerced.ok) {
      data[fieldName] = coerced.value;
    } else {
      issues.push({ field: fieldName, message: coerced.message });
    }
  }

  if (issues.length > 0) {
    throw new ValidationError("Invalid record", issues);
  }

  return data;
}
