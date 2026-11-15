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
} as const;

export const agentCommandOperationSchema = z.nativeEnum(runtimeCommandOperations);

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

export type RuntimeInspection = z.infer<typeof runtimeInspectionResultSchema>;
export type AgentCommandOperation = z.infer<typeof agentCommandOperationSchema>;
export type ApplicationLifecycleResult = z.infer<typeof applicationLifecycleResultSchema>;
export type ApplicationLogsResult = z.infer<typeof applicationLogsResultSchema>;

export interface LeasedCommand {
  id: string;
  leaseToken: string;
  operation: AgentCommandOperation;
  payload?: Record<string, unknown>;
}

export interface ApplicationCredential {
  credentialId: string;
  value: string;
}

export interface ApplicationCommand extends LeasedCommand {
  operation: Exclude<AgentCommandOperation, "runtime.inspect" | "app.logs">;
  payload: {
    appId: string;
    image?: string;
    previousImage?: string;
    cpuCount?: number;
    memoryMb?: number;
    environment?: Record<string, string>;
    credentialIds?: string[];
    credentials?: ApplicationCredential[];
    previousEnvironment?: Record<string, string>;
    previousCredentialIds?: string[];
    previousCredentials?: ApplicationCredential[];
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
