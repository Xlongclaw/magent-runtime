import { arch, cpus, freemem, platform, totalmem } from "node:os";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { statfs } from "node:fs/promises";
import {
  RuntimeAgentApiError,
  RuntimeAgentClient,
  type AppStudioBuildPayload,
  type AppStudioCommandPayload,
  type ApplicationCommand,
  type ApplicationLogsCommand,
  type LeasedCommand,
  type MapActionCommand,
  type MapEventCommand,
  type RuntimeInspection,
} from "./client.js";
import { PodmanApplicationEngine } from "./podman-engine.js";
import {
  cloudEventSchema,
  mapActionRequestSchema,
  mapManifestSchema,
} from "@magent/map-protocol";
import {
  appStudioBuildPayloadSchema,
  appStudioCommandPayloadSchema,
  workflowCodePayloadSchema,
} from "@magent/runtime-protocol";

const LEGACY_SECRET_GENERATION = "000000000000000000000000";

export interface RuntimeAgentOptions {
  client: RuntimeAgentClient;
  version: string;
  applicationEngine?: Pick<PodmanApplicationEngine, "execute"> &
    Partial<Pick<PodmanApplicationEngine, "buildAppStudioImage" | "executeAppStudioCommand" | "executeWorkflowCode">> &
    Partial<Pick<PodmanApplicationEngine, "inspect" | "logs" | "invokeMapAction" | "deliverMapEvent">>;
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  mapProxyPort?: number;
  onError?: (error: Error) => void;
}

export class RuntimeAgent {
  private lastHeartbeatAt = 0;
  private readonly pollIntervalMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly mapProxyPort: number;
  private mapProxyServer: Server | null = null;
  private readonly applicationEngine: Pick<PodmanApplicationEngine, "execute"> &
    Partial<Pick<PodmanApplicationEngine, "buildAppStudioImage" | "executeAppStudioCommand" | "executeWorkflowCode">> &
    Partial<Pick<PodmanApplicationEngine, "inspect" | "logs" | "invokeMapAction" | "deliverMapEvent">>;

  constructor(private readonly options: RuntimeAgentOptions) {
    this.pollIntervalMs = options.pollIntervalMs ?? 5_000;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 30_000;
    this.mapProxyPort = options.mapProxyPort ?? Number(process.env.MAGENT_MAP_PROXY_PORT ?? 4317);
    if (!Number.isInteger(this.mapProxyPort) || this.mapProxyPort < 1 || this.mapProxyPort > 65_535) {
      throw new Error("MAP relay port must be a valid TCP port.");
    }
    this.applicationEngine = options.applicationEngine ??
      new PodmanApplicationEngine("podman", undefined, this.mapProxyPort);
  }

  async runOnce(now = Date.now()): Promise<boolean> {
    if (now - this.lastHeartbeatAt >= this.heartbeatIntervalMs) {
      await this.options.client.heartbeat();
      this.lastHeartbeatAt = now;
    }

    const command = await this.options.client.claimCommand();
    if (!command) {
      return false;
    }

    let result;
    const heartbeatTimer = command.operation === "appstudio.build" ||
      command.operation === "appstudio.command" ||
      command.operation === "workflow.code"
      ? setInterval(() => {
          void this.options.client.heartbeat().catch((error: unknown) => {
            this.options.onError?.(
              error instanceof Error ? error : new Error("Runtime heartbeat failed during App Studio work."),
            );
          });
        }, this.heartbeatIntervalMs)
      : null;
    try {
      if (command.operation === "runtime.inspect") {
        result = await collectRuntimeInspection(
          this.options.version,
          this.applicationEngine.inspect?.() ?? Promise.resolve([]),
        );
      } else if (command.operation === "app.logs") {
        const logsCommand = parseApplicationLogsCommand(command);
        if (!this.applicationEngine.logs) {
          throw new Error("Runtime log collection is not available.");
        }
        result = await this.applicationEngine.logs(
          logsCommand.payload.appId,
          logsCommand.payload.tail,
        );
      } else if (command.operation === "app.invoke") {
        const mapCommand = parseMapActionCommand(command);
        const token = await this.options.client.getMapToken(mapCommand.payload.appId);
        if (!token || !this.applicationEngine.invokeMapAction) {
          throw new Error("MAP action forwarding is not available.");
        }
        result = await this.applicationEngine.invokeMapAction(
          mapCommand.payload.appId,
          mapCommand.payload.port,
          token,
          mapCommand.payload.request,
        );
      } else if (command.operation === "app.event") {
        const mapCommand = parseMapEventCommand(command);
        const token = await this.options.client.getMapToken(mapCommand.payload.appId);
        if (!token || !this.applicationEngine.deliverMapEvent) {
          throw new Error("MAP event delivery is not available.");
        }
        result = await this.applicationEngine.deliverMapEvent(
          mapCommand.payload.appId,
          mapCommand.payload.port,
          token,
          mapCommand.payload.event,
        );
      } else if (command.operation === "appstudio.build") {
        const build = parseAppStudioBuildPayload(command.payload);
        if (!this.applicationEngine.buildAppStudioImage) {
          throw new Error("App Studio image builds are not available in this runtime agent.");
        }
        const registryCredential = build.registryCredentialId
          ? await this.options.client.getRuntimeCredential(build.registryCredentialId)
          : undefined;
        result = await this.applicationEngine.buildAppStudioImage({
          projectId: build.projectId,
          appId: build.appId,
          version: build.version,
          digest: build.digest,
          localImage: build.localImage,
          archive: decodeAppStudioArchive(build.archive),
          ...(build.registryImage ? { registryImage: build.registryImage } : {}),
          ...(registryCredential ? { registryCredential } : {}),
        });
      } else if (command.operation === "appstudio.command") {
        const terminal = parseAppStudioCommandPayload(command.payload);
        if (!this.applicationEngine.executeAppStudioCommand) {
          throw new Error("The isolated App Studio terminal is not available in this runtime agent.");
        }
        result = await this.applicationEngine.executeAppStudioCommand({
          ...terminal,
          archive: decodeAppStudioArchive(terminal.archive),
        });
      } else if (command.operation === "workflow.code") {
        const code = workflowCodePayloadSchema.safeParse(command.payload);
        if (!code.success || !this.applicationEngine.executeWorkflowCode) {
          throw new Error("Workflow code sandbox is not available in this runtime agent.");
        }
        result = await this.applicationEngine.executeWorkflowCode(code.data);
      } else {
        const applicationCommand = parseApplicationCommand(command);
        const mapToken = await this.options.client.getMapToken(
          applicationCommand.payload.appId,
        );
        if (mapToken) applicationCommand.payload.mapToken = mapToken;
        applicationCommand.payload.credentials = await getCredentials(
          this.options.client,
          applicationCommand.payload.appId,
          applicationCommand.payload.credentialIds ?? [],
        );
        if (
          applicationCommand.operation === "app.update" ||
          applicationCommand.operation === "app.rollback" ||
          applicationCommand.operation === "app.configure"
        ) {
          applicationCommand.payload.previousCredentials = (
            applicationCommand.payload.previousCredentialIds ?? []
          ).map((credentialId) => ({ credentialId, value: "" }));
        }
        result = await this.applicationEngine.execute(applicationCommand);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Runtime command failed.";
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      await this.options.client.acknowledgeFailure(command, message);
      return true;
    }
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    await this.options.client.acknowledgeSuccess(command, result);
    return true;
  }

  async start(signal: AbortSignal): Promise<void> {
    await this.startMapProxy();
    try {
      while (!signal.aborted) {
        try {
          await this.runOnce();
        } catch (error) {
          if (error instanceof RuntimeAgentApiError && [401, 403].includes(error.statusCode)) {
            throw error;
          }
          this.options.onError?.(
            error instanceof Error ? error : new Error("Runtime Agent request failed."),
          );
        }
        await delay(this.pollIntervalMs, signal);
      }
    } finally {
      await this.stopMapProxy();
    }
  }

  private async startMapProxy(): Promise<void> {
    if (this.mapProxyServer) throw new Error("MAP relay is already running.");
    const server = createServer((request, response) => {
      void this.handleMapProxyRequest(request, response);
    });
    this.mapProxyServer = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.mapProxyPort, "0.0.0.0", () => {
        server.off("error", reject);
        resolve();
      });
    }).catch((error: unknown) => {
      this.mapProxyServer = null;
      throw error;
    });
  }

  private async stopMapProxy(): Promise<void> {
    const server = this.mapProxyServer;
    this.mapProxyServer = null;
    if (!server) return;
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }

  private async handleMapProxyRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      if (!isPrivateAddress(request.socket.remoteAddress ?? "")) {
        sendMapProxyResponse(response, 403, { error: "MAP relay is restricted to local containers." });
        return;
      }
      if (request.method !== "POST") {
        sendMapProxyResponse(response, 405, { error: "Method not allowed." });
        return;
      }
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.search || url.hash ||
          url.pathname !== "/map/actions/invoke" && url.pathname !== "/map/events") {
        sendMapProxyResponse(response, 404, { error: "MAP relay endpoint not found." });
        return;
      }
      const token = request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
      if (!token) {
        sendMapProxyResponse(response, 401, { error: "MAP application authentication required." });
        return;
      }
      const body = await readRequestBody(request);
      const upstream = await this.options.client.proxyMapRequest(url.pathname, token, body);
      const upstreamBody = await upstream.text();
      if (upstreamBody.length > 1024 * 1024) {
        sendMapProxyResponse(response, 502, { error: "MAP platform response exceeds the allowed size." });
        return;
      }
      response.writeHead(upstream.status, {
        "content-type": upstream.headers.get("content-type") ?? "application/json",
        "cache-control": "no-store",
        "content-length": Buffer.byteLength(upstreamBody),
      });
      response.end(upstreamBody);
    } catch (error) {
      this.options.onError?.(
        error instanceof Error ? error : new Error("MAP relay request failed."),
      );
      if (!response.headersSent) {
        sendMapProxyResponse(response, 502, { error: "MAP relay request failed." });
      } else {
        response.destroy();
      }
    }
  }
}

function parseApplicationLogsCommand(command: {
  id: string;
  leaseToken: string;
  operation: string;
  payload?: Record<string, unknown>;
}): ApplicationLogsCommand {
  if (
    !/^[a-f\d]{24}$/i.test(command.id) ||
    command.operation !== "app.logs" ||
    !command.payload ||
    typeof command.payload.appId !== "string" ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(command.payload.appId) ||
    typeof command.payload.tail !== "number" ||
    !Number.isInteger(command.payload.tail) ||
    command.payload.tail < 1 ||
    command.payload.tail > 500
  ) {
    throw new Error("Application log command is invalid.");
  }
  return {
    id: command.id,
    leaseToken: command.leaseToken,
    operation: "app.logs",
    payload: {
      appId: command.payload.appId,
      tail: command.payload.tail,
    },
  };
}

function parseAppStudioBuildPayload(value: Record<string, unknown> | undefined): AppStudioBuildPayload {
  const parsed = appStudioBuildPayloadSchema.safeParse(value);
  if (!parsed.success) throw new Error("App Studio image build payload is invalid.");
  return parsed.data;
}

function parseAppStudioCommandPayload(value: Record<string, unknown> | undefined): AppStudioCommandPayload {
  const parsed = appStudioCommandPayloadSchema.safeParse(value);
  if (!parsed.success) throw new Error("App Studio terminal payload is invalid.");
  return parsed.data;
}

function decodeAppStudioArchive(encoded: string): Buffer {
  if (
    encoded.length > 1_000_000 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
  ) {
    throw new Error("App Studio source package encoding is invalid.");
  }
  const archive = Buffer.from(encoded, "base64");
  if (archive.length === 0 || archive.length > 750_000 || archive.toString("base64") !== encoded) {
    throw new Error("App Studio source package exceeds its allowed size or has invalid encoding.");
  }
  return archive;
}

function parseMapActionCommand(command: LeasedCommand): MapActionCommand {
  const payload = command.payload;
  if (
    command.operation !== "app.invoke" ||
    !payload ||
    typeof payload.appId !== "string" ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(payload.appId) ||
    typeof payload.port !== "number" ||
    !Number.isInteger(payload.port) ||
    payload.port < 1 ||
    payload.port > 65_535
  ) {
    throw new Error("MAP action command is invalid.");
  }
  const request = mapActionRequestSchema.safeParse(payload.request);
  if (!request.success || request.data.target.appId !== payload.appId) {
    throw new Error("MAP action request is invalid.");
  }
  return {
    id: command.id,
    leaseToken: command.leaseToken,
    operation: "app.invoke",
    payload: { appId: payload.appId, port: payload.port, request: request.data },
  };
}

function parseMapEventCommand(command: LeasedCommand): MapEventCommand {
  const payload = command.payload;
  if (
    command.operation !== "app.event" ||
    !payload ||
    typeof payload.appId !== "string" ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(payload.appId) ||
    typeof payload.port !== "number" ||
    !Number.isInteger(payload.port) ||
    payload.port < 1 ||
    payload.port > 65_535
  ) {
    throw new Error("MAP event command is invalid.");
  }
  const event = cloudEventSchema.safeParse(payload.event);
  if (!event.success) throw new Error("MAP event payload is invalid.");
  return {
    id: command.id,
    leaseToken: command.leaseToken,
    operation: "app.event",
    payload: { appId: payload.appId, port: payload.port, event: event.data },
  };
}

function parseApplicationCommand(command: {
  id: string;
  leaseToken: string;
  operation: string;
  payload?: Record<string, unknown>;
}): ApplicationCommand {
  const { operation, payload } = command;
  if (
    !/^[a-f\d]{24}$/i.test(command.id) ||
    operation !== "app.install" &&
    operation !== "app.start" &&
    operation !== "app.stop" &&
    operation !== "app.restart" &&
    operation !== "app.update" &&
    operation !== "app.uninstall" &&
    operation !== "app.rollback" &&
    operation !== "app.configure"
  ) {
    throw new Error("Unsupported application lifecycle operation.");
  }
  if (!payload || typeof payload.appId !== "string" ||
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(payload.appId)) {
    throw new Error("Application command payload is invalid.");
  }

  const parsedPayload: ApplicationCommand["payload"] = { appId: payload.appId };
  if (payload.manifest !== undefined) {
    const manifest = mapManifestSchema.safeParse(payload.manifest);
    if (!manifest.success || manifest.data.id !== payload.appId) {
      throw new Error("MAP application manifest is invalid.");
    }
    parsedPayload.manifest = manifest.data;
  }
  if (
    operation === "app.install" ||
    operation === "app.update" ||
    operation === "app.rollback" ||
    operation === "app.configure"
  ) {
    parsedPayload.environment = parseEnvironment(payload.environment === undefined ? {} : payload.environment);
    parsedPayload.credentialIds = parseCredentialIds(
      payload.credentialIds === undefined ? [] : payload.credentialIds,
    );
  }
  if (
    operation === "app.update" ||
    operation === "app.rollback" ||
    operation === "app.configure"
  ) {
    if (
      typeof payload.image !== "string" ||
      typeof payload.cpuCount !== "number" ||
      typeof payload.memoryMb !== "number"
    ) {
      throw new Error("Application command resource configuration is invalid.");
    }
    parsedPayload.image = payload.image;
    parsedPayload.cpuCount = payload.cpuCount;
    parsedPayload.memoryMb = payload.memoryMb;
    parsedPayload.previousEnvironment = parseEnvironment(
      payload.previousEnvironment === undefined ? {} : payload.previousEnvironment,
    );
    parsedPayload.previousCredentialIds = parseCredentialIds(
      payload.previousCredentialIds === undefined ? [] : payload.previousCredentialIds,
    );
    if (
      typeof payload.previousImage !== "string" ||
      (payload.previousSecretGeneration !== undefined &&
        (typeof payload.previousSecretGeneration !== "string" ||
          !/^[a-f\d]{24}$/i.test(payload.previousSecretGeneration)))
    ) {
      throw new Error("Application rollback configuration is invalid.");
    }
    parsedPayload.previousImage = payload.previousImage;
    parsedPayload.previousSecretGeneration = payload.previousSecretGeneration ?? LEGACY_SECRET_GENERATION;
  }
  if (operation === "app.install") {
    if (
      typeof payload.image !== "string" ||
      typeof payload.cpuCount !== "number" ||
      typeof payload.memoryMb !== "number"
    ) {
      throw new Error("Application command resource configuration is invalid.");
    }
    parsedPayload.image = payload.image;
    parsedPayload.cpuCount = payload.cpuCount;
    parsedPayload.memoryMb = payload.memoryMb;
  }
  if (operation === "app.uninstall") {
    parsedPayload.credentialIds = parseCredentialIds(
      payload.credentialIds === undefined ? [] : payload.credentialIds,
    );
    if (
      payload.previousSecretGeneration !== undefined &&
      (typeof payload.previousSecretGeneration !== "string" ||
        !/^[a-f\d]{24}$/i.test(payload.previousSecretGeneration))
    ) {
      throw new Error("Application credential generation is invalid.");
    }
    parsedPayload.previousSecretGeneration =
      payload.previousSecretGeneration ?? LEGACY_SECRET_GENERATION;
  }
  return {
    id: command.id,
    leaseToken: command.leaseToken,
    operation,
    payload: parsedPayload,
  };
}

async function getCredentials(
  client: RuntimeAgentClient,
  appId: string,
  credentialIds: string[],
): Promise<Array<{ credentialId: string; value: string }>> {
  return Promise.all(credentialIds.map(async (credentialId) => ({
    credentialId,
    value: await client.getApplicationCredential(appId, credentialId),
  })));
}

function parseEnvironment(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Application configuration is invalid.");
  }
  const entries = Object.entries(value);
  if (
    entries.length > 64 ||
    entries.some(([key, item]) =>
      !/^[A-Z_][A-Z0-9_]{0,63}$/.test(key) ||
      key.startsWith("MAGENT_") ||
      typeof item !== "string" ||
      item.length > 2_048 ||
      item.includes("\0"),
    ) ||
    entries.reduce((size, [key, item]) => size + key.length + String(item).length, 0) > 16_384
  ) {
    throw new Error("Application configuration is invalid.");
  }
  const environment: Record<string, string> = {};
  for (const [key, item] of entries) {
    if (typeof item !== "string") {
      throw new Error("Application configuration is invalid.");
    }
    environment[key] = item;
  }
  return environment;
}

function parseCredentialIds(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 50 ||
    value.some((credentialId) => typeof credentialId !== "string" || !/^[a-f\d]{24}$/i.test(credentialId)) ||
    new Set(value).size !== value.length
  ) {
    throw new Error("Application credential grants are invalid.");
  }
  return value;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === "string");
}

let previousCpuSample: { total: number; idle: number } | null = null;

export async function collectRuntimeInspection(
  version: string,
  applications: Promise<RuntimeInspection["applications"]>,
): Promise<RuntimeInspection> {
  const memoryUsage = process.memoryUsage();
  const cpuSample = cpus().reduce(
    (total, cpu) => ({
      total: total.total + Object.values(cpu.times).reduce((sum, value) => sum + value, 0),
      idle: total.idle + cpu.times.idle,
    }),
    { total: 0, idle: 0 },
  );
  const cpuUsagePercent = previousCpuSample && cpuSample.total > previousCpuSample.total
    ? Math.max(0, Math.min(100, (
        1 - (cpuSample.idle - previousCpuSample.idle) /
          (cpuSample.total - previousCpuSample.total)
      ) * 100))
    : null;
  previousCpuSample = cpuSample;
  const disk = await statfs("/");
  return {
    agentVersion: version,
    platform: platform(),
    architecture: arch(),
    nodeVersion: process.version,
    uptimeSeconds: Math.floor(process.uptime()),
    resources: {
      cpuUsagePercent,
      memoryTotalBytes: totalmem(),
      memoryAvailableBytes: freemem(),
      diskTotalBytes: Number(disk.blocks * disk.bsize),
      diskAvailableBytes: Number(disk.bavail * disk.bsize),
    },
    applications: await applications,
    memory: {
      rssBytes: memoryUsage.rss,
      heapUsedBytes: memoryUsage.heapUsed,
      heapTotalBytes: memoryUsage.heapTotal,
      externalBytes: memoryUsage.external,
    },
  };
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > 1024 * 1024) throw new Error("MAP relay request exceeds the allowed size.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendMapProxyResponse(response: ServerResponse, status: number, body: unknown): void {
  const serialized = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(serialized),
    "cache-control": "no-store",
  });
  response.end(serialized);
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^::ffff:/, "");
  if (normalized === "::1" || normalized.startsWith("fc") ||
      normalized.startsWith("fd") || normalized.startsWith("fe80:")) {
    return true;
  }
  const octets = normalized.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }
  return octets[0] === 10 ||
    octets[0] === 127 ||
    octets[0] === 192 && octets[1] === 168 ||
    octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31 ||
    octets[0] === 169 && octets[1] === 254;
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });

    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
  });
}
