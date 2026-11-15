import { z } from "zod";

const identifier = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
const permissionIdentifier = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*$/).max(64);
export const mapApplicationIdSchema = z.string().min(1).max(128).regex(
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/,
);

const jsonSchemaDefinition: z.ZodType<JsonSchema> = z.lazy(() => z.object({
  type: z.enum(["object", "array", "string", "number", "integer", "boolean", "null"]).optional(),
  properties: z.record(z.string().max(128), jsonSchemaDefinition).optional(),
  required: z.array(z.string().max(128)).max(128).optional(),
  additionalProperties: z.union([z.boolean(), jsonSchemaDefinition]).optional(),
  items: jsonSchemaDefinition.optional(),
  enum: z.array(z.unknown()).max(100).optional(),
  minimum: z.number().finite().optional(),
  maximum: z.number().finite().optional(),
  minLength: z.number().int().min(0).optional(),
  maxLength: z.number().int().min(0).optional(),
  minItems: z.number().int().min(0).optional(),
  maxItems: z.number().int().min(0).optional(),
  pattern: z.string().max(256).optional(),
  format: z.enum(["date-time", "email", "uri"]).optional(),
}).strict());

export interface JsonSchema {
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  pattern?: string;
  format?: "date-time" | "email" | "uri";
}

export const mapActionSchema = z.object({
  name: identifier,
  description: z.string().trim().min(1).max(500),
  inputSchema: jsonSchemaDefinition,
  outputSchema: jsonSchemaDefinition,
  requiredPermissions: z.array(permissionIdentifier).max(100).default([]),
}).strict();

export const mapEventDefinitionSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/).max(128),
  description: z.string().trim().min(1).max(500),
  schema: jsonSchemaDefinition,
}).strict();

const mapConfigurationSchema = z.object({
  key: z.string().regex(/^[A-Z_][A-Z0-9_]{0,63}$/),
  type: z.enum(["string", "number", "boolean", "secret"]),
  required: z.boolean().default(false),
  description: z.string().max(500).optional(),
}).strict();

export const mapManifestSchema = z.object({
  manifestVersion: z.literal("1.0.0"),
  id: mapApplicationIdSchema,
  name: z.string().trim().min(1).max(120),
  version: z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/).max(64),
  description: z.string().trim().min(1).max(2_000),
  publisher: z.object({
    id: z.string().trim().min(1).max(128),
    name: z.string().trim().min(1).max(120),
  }).strict(),
  runtime: z.object({
    type: z.literal("container"),
    entrypoint: z.string().trim().min(1).max(256),
    port: z.number().int().min(1).max(65_535),
  }).strict(),
  capabilities: z.array(identifier).max(100),
  actions: z.array(mapActionSchema).max(100),
  events: z.array(mapEventDefinitionSchema).max(100),
  subscriptions: z.array(mapEventDefinitionSchema).max(100).default([]),
  configuration: z.array(mapConfigurationSchema).max(100).default([]),
  requestedPermissions: z.array(permissionIdentifier).max(100).default([]),
}).strict().superRefine((manifest, context) => {
  const actionNames = new Set<string>();
  for (const [index, action] of manifest.actions.entries()) {
    if (actionNames.has(action.name)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["actions", index, "name"], message: "Action names must be unique." });
    }
    actionNames.add(action.name);
    for (const permission of action.requiredPermissions) {
      if (!manifest.requestedPermissions.includes(permission)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["actions", index, "requiredPermissions"],
          message: `Action permission "${permission}" must be included in requestedPermissions.`,
        });
      }
    }
  }
  for (const key of ["events", "subscriptions"] as const) {
    const names = new Set<string>();
    for (const [index, event] of manifest[key].entries()) {
      if (names.has(event.name)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: [key, index, "name"], message: "Event names must be unique." });
      }
      names.add(event.name);
    }
  }
  const configKeys = new Set<string>();
  for (const [index, item] of manifest.configuration.entries()) {
    if (configKeys.has(item.key)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["configuration", index, "key"], message: "Configuration keys must be unique." });
    }
    configKeys.add(item.key);
  }
});

export const mapCallerSchema = z.object({
  type: z.enum(["CONTROLLER", "AGENT", "WORKFLOW", "APP", "USER"]),
  id: z.string().min(1).max(128),
}).strict();

export const mapActionRequestSchema = z.object({
  requestId: z.string().uuid(),
  traceId: z.string().uuid(),
  idempotencyKey: z.string().min(1).max(128).optional(),
  workspaceId: z.string().regex(/^[a-f\d]{24}$/i),
  caller: mapCallerSchema,
  target: z.object({
    appId: mapApplicationIdSchema,
    action: identifier,
  }).strict(),
  input: z.unknown(),
  deadline: z.string().datetime().optional(),
}).strict();

export const mapActionResultSchema = z.object({
  requestId: z.string().uuid(),
  success: z.boolean(),
  output: z.unknown().optional(),
  error: z.object({
    code: z.string().min(1).max(64),
    message: z.string().min(1).max(500),
    retryable: z.boolean(),
  }).strict().optional(),
}).strict().refine((result) =>
  result.success ? result.error === undefined : result.error !== undefined,
);

export const cloudEventSchema = z.object({
  specversion: z.literal("1.0"),
  id: z.string().uuid(),
  source: z.string().min(1).max(128),
  type: z.string().regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/).max(128),
  subject: z.string().min(1).max(128),
  time: z.string().datetime(),
  datacontenttype: z.literal("application/json"),
  dataschema: z.string().min(1).max(256),
  traceid: z.string().uuid(),
  data: z.unknown(),
}).strict();

export type MapManifest = z.infer<typeof mapManifestSchema>;
export type MapAction = z.infer<typeof mapActionSchema>;
export type MapEventDefinition = z.infer<typeof mapEventDefinitionSchema>;
export type MapActionRequest = z.infer<typeof mapActionRequestSchema>;
export type MapActionResult = z.infer<typeof mapActionResultSchema>;
export type CloudEvent = z.infer<typeof cloudEventSchema>;

export function validateJsonSchema(schema: JsonSchema, value: unknown, path = "$"): string[] {
  const errors: string[] = [];
  if (schema.enum && !schema.enum.some((candidate) => deepEqual(candidate, value))) {
    errors.push(`${path} must match one of the declared values.`);
    return errors;
  }
  if (schema.type) {
    const valid = schema.type === "null" ? value === null
      : schema.type === "array" ? Array.isArray(value)
        : schema.type === "object" ? isRecord(value)
          : schema.type === "integer" ? typeof value === "number" && Number.isInteger(value)
            : typeof value === schema.type;
    if (!valid) {
      errors.push(`${path} must be ${schema.type}.`);
      return errors;
    }
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path} is too short.`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path} is too long.`);
    if (schema.pattern) {
      try {
        if (!new RegExp(schema.pattern).test(value)) errors.push(`${path} has an invalid format.`);
      } catch {
        errors.push(`${path} uses an invalid manifest pattern.`);
      }
    }
    if (schema.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) errors.push(`${path} must be an email address.`);
    if (schema.format === "uri") {
      try { new URL(value); } catch { errors.push(`${path} must be a URI.`); }
    }
    if (schema.format === "date-time" && Number.isNaN(Date.parse(value))) errors.push(`${path} must be a date-time.`);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) errors.push(`${path} must be finite.`);
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path} is below its minimum.`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path} exceeds its maximum.`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path} has too few items.`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path} has too many items.`);
    if (schema.items) value.forEach((item, index) => errors.push(...validateJsonSchema(schema.items!, item, `${path}[${index}]`)));
  }
  if (isRecord(value) && schema.type === "object") {
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${path}.${key} is required.`);
    }
    for (const [key, item] of Object.entries(value)) {
      const propertySchema = schema.properties?.[key];
      if (propertySchema) {
        errors.push(...validateJsonSchema(propertySchema, item, `${path}.${key}`));
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}.${key} is not allowed.`);
      } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        errors.push(...validateJsonSchema(schema.additionalProperties, item, `${path}.${key}`));
      }
    }
  }
  return errors;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepEqual(first: unknown, second: unknown): boolean {
  return JSON.stringify(first) === JSON.stringify(second);
}
