import { z } from "zod";
import { mapApplicationIdSchema } from "@magent/map-protocol";
import type {
  CloudEvent,
  MapActionRequest,
  MapActionResult,
  MapManifest,
} from "@magent/map-protocol";

export const applicationIdSchema = mapApplicationIdSchema;

export const runtimeCommandOperations = {
  inspect: "runtime.inspect",
  logs: "app.logs",
  invoke: "app.invoke",
  event: "app.event",
  install: "app.install",
  start: "app.start",
  stop: "app.stop",
  restart: "app.restart",
  update: "app.update",
  uninstall: "app.uninstall",
  rollback: "app.rollback",
  configure: "app.configure",
  proxy: "app.proxy",
  appStudioBuild: "appstudio.build",
  appStudioCommand: "appstudio.command",
  workflowCode: "workflow.code",
} as const;

export const agentCommandOperationSchema = z.nativeEnum(runtimeCommandOperations);
const appStudioProjectIdSchema = z.string().regex(/^[a-f\d]{24}$/i);
const appStudioVersionSchema = z.string().regex(
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/,
).max(64);
const appStudioImageSchema = z.string().min(1).max(512).regex(
  /^ghcr\.io\/[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9][a-z0-9._-]{0,127}:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/,
);

export const appStudioBuildPayloadSchema = z.object({
  projectId: appStudioProjectIdSchema,
  appId: applicationIdSchema,
  version: appStudioVersionSchema,
  digest: z.string().regex(/^[a-f\d]{64}$/i),
  archive: z.string().min(1).max(1_000_000),
  localImage: z.string().min(1).max(512),
  registryImage: appStudioImageSchema.optional(),
  registryCredentialId: z.string().regex(/^[a-f\d]{24}$/i).optional(),
}).strict().superRefine((payload, context) => {
  if (Boolean(payload.registryImage) !== Boolean(payload.registryCredentialId)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "GHCR image and runtime credential must be provided together.",
    });
  }
});

export const appStudioCommandPayloadSchema = z.object({
  projectId: appStudioProjectIdSchema,
  appId: applicationIdSchema,
  archive: z.string().min(1).max(1_000_000),
  command: z.string().trim().min(1).max(1_000).refine((value) => !value.includes("\0")),
}).strict();

export const appStudioBuildResultSchema = z.object({
  projectId: appStudioProjectIdSchema,
  appId: applicationIdSchema,
  version: appStudioVersionSchema,
  digest: z.string().regex(/^[a-f\d]{64}$/i),
  localImage: z.string().min(1).max(512),
  registryImage: appStudioImageSchema.nullable(),
  registryDigest: z.string().regex(/^sha256:[a-f\d]{64}$/i).nullable(),
  logs: z.string().max(65_536),
}).strict();

export const appStudioCommandResultSchema = z.object({
  projectId: appStudioProjectIdSchema,
  output: z.string().max(65_536),
  exitCode: z.number().int().min(0).max(255),
  truncated: z.boolean(),
}).strict();

const boundedJsonSchema = (limit: number) => z.unknown().refine((value) => {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" && new TextEncoder().encode(serialized).byteLength <= limit;
  } catch {
    return false;
  }
});

export const workflowCodePayloadSchema = z.object({
  executionId: z.string().regex(/^[a-f\d]{24}$/i),
  workflowId: z.string().regex(/^[a-f\d]{24}$/i),
  nodeId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
  source: z.string().min(1).max(20_000),
  context: boundedJsonSchema(65_536),
}).strict();

export const workflowCodeResultSchema = z.object({
  executionId: z.string().regex(/^[a-f\d]{24}$/i),
  nodeId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
  output: boundedJsonSchema(262_144),
}).strict();

export const runtimeInspectionResultSchema = z.object({
  agentVersion: z.string().min(1).max(64),
  platform: z.string().min(1).max(64),
  architecture: z.string().min(1).max(64),
  nodeVersion: z.string().min(1).max(64),
  uptimeSeconds: z.number().int().nonnegative(),
  resources: z.object({
    cpuUsagePercent: z.number().min(0).max(100).nullable(),
    memoryTotalBytes: z.number().int().positive(),
    memoryAvailableBytes: z.number().int().nonnegative(),
    diskTotalBytes: z.number().int().positive(),
    diskAvailableBytes: z.number().int().nonnegative(),
  }).strict(),
  applications: z.array(z.object({
    applicationId:     mapApplicationIdSchema,
    status: z.enum(["running", "stopped"]),
    cpuUsagePercent: z.number().nonnegative().nullable(),
    memoryUsageBytes: z.number().int().nonnegative().nullable(),
    memoryLimitBytes: z.number().int().nonnegative().nullable(),
  }).strict()).max(500),
  memory: z.object({
    rssBytes: z.number().int().nonnegative(),
    heapUsedBytes: z.number().int().nonnegative(),
    heapTotalBytes: z.number().int().nonnegative(),
    externalBytes: z.number().int().nonnegative(),
  }).strict(),
}).strict();

export const applicationLifecycleResultSchema = z.object({
  applicationId: applicationIdSchema,
  status: z.enum(["active", "stopped", "removed"]),
}).strict();

export const applicationLogsResultSchema = z.object({
  applicationId: applicationIdSchema,
  content: z.string().max(65_536),
  truncated: z.boolean(),
}).strict();
export const applicationProxyPayloadSchema = z.object({
  appId: applicationIdSchema,
  port: z.number().int().min(1).max(65_535),
  path: z.string().min(1).max(4_096).startsWith("/")
    .refine((value) => {
      const pathname = value.split("?", 1)[0] ?? "";
      let decodedPathname: string;
      try {
        decodedPathname = decodeURIComponent(pathname);
      } catch {
        return false;
      }
      return !value.startsWith("//") && !/[\0\\\r\n]/.test(decodedPathname) &&
        !decodedPathname.split("/").some((segment) => segment === "." || segment === "..");
    }),
  method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]),
  contentType: z.string().max(256).optional(),
  body: z.string().max(1_000_000).optional(),
}).strict();
export const applicationProxyResultSchema = z.object({
  applicationId: applicationIdSchema,
  statusCode: z.number().int().min(100).max(599),
  contentType: z.string().max(256).optional(),
  location: z.string().max(4_096).optional(),
  cacheControl: z.string().max(256).optional(),
  body: z.string().max(3_000_000),
}).strict();

export type RuntimeInspection = z.infer<typeof runtimeInspectionResultSchema>;
export type AgentCommandOperation = z.infer<typeof agentCommandOperationSchema>;
export type ApplicationLifecycleResult = z.infer<typeof applicationLifecycleResultSchema>;
export type ApplicationLogsResult = z.infer<typeof applicationLogsResultSchema>;
export type ApplicationProxyPayload = z.infer<typeof applicationProxyPayloadSchema>;
export type ApplicationProxyResult = z.infer<typeof applicationProxyResultSchema>;

export interface LeasedCommand {
  id: string;
  leaseToken: string;
  operation: AgentCommandOperation;
  payload?: Record<string, unknown>;
}

export type AppStudioBuildPayload = z.infer<typeof appStudioBuildPayloadSchema>;
export type AppStudioCommandPayload = z.infer<typeof appStudioCommandPayloadSchema>;
export type AppStudioBuildResult = z.infer<typeof appStudioBuildResultSchema>;
export type AppStudioCommandResult = z.infer<typeof appStudioCommandResultSchema>;
export type WorkflowCodePayload = z.infer<typeof workflowCodePayloadSchema>;
export type WorkflowCodeResult = z.infer<typeof workflowCodeResultSchema>;

export interface ApplicationCredential {
  credentialId: string;
  value: string;
}

export interface ApplicationCommand extends LeasedCommand {
  operation: Exclude<AgentCommandOperation, "runtime.inspect" | "app.logs" | "app.proxy">;
  payload: {
    appId: string;
    image?: string;
    previousImage?: string;
    cpuCount?: number;
    memoryMb?: number;
    environment?: Record<string, string>;
    credentialIds?: string[];
    credentials?: ApplicationCredential[];
    grantedPermissions?: string[];
    previousEnvironment?: Record<string, string>;
    previousCredentialIds?: string[];
    previousCredentials?: ApplicationCredential[];
    previousGrantedPermissions?: string[];
    previousSecretGeneration?: string;
    manifest?: MapManifest;
    mapToken?: string;
  };
}

export interface ApplicationLogsCommand extends LeasedCommand {
  operation: "app.logs";
  payload: {
    appId: string;
    tail: number;
  };
}

export interface ApplicationProxyCommand extends LeasedCommand {
  operation: "app.proxy";
  payload: ApplicationProxyPayload;
}

export interface MapActionCommand extends LeasedCommand {
  operation: "app.invoke";
  payload: {
    appId: string;
    port: number;
    request: MapActionRequest;
  };
}

export interface MapEventCommand extends LeasedCommand {
  operation: "app.event";
  payload: {
    appId: string;
    port: number;
    event: CloudEvent;
  };
}

export type MapCommandResult = MapActionResult | { eventId: string };
