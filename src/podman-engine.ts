import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import type {
  ApplicationCommand,
  ApplicationCredential,
  ApplicationLogsResult,
  ApplicationLifecycleResult,
  RuntimeInspection,
} from "./client.js";
import type {
  CloudEvent,
  MapActionRequest,
  MapActionResult,
  MapManifest,
} from "@magent/map-protocol";

const appIdPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const imagePattern = /^(?:(?:[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[0-9]{1,5})?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*)(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}|@sha256:[a-f0-9]{64})$/;
const MAX_LOG_BYTES = 65_536;

export interface PodmanCommandRunner {
  (executable: string, args: string[], options: {
    timeout: number;
    maxBuffer: number;
    input?: string;
  }): Promise<{
    stdout: string;
    stderr: string;
  }>;
}

export class PodmanApplicationEngine {
  private rootlessCheck: Promise<void> | null = null;
  private readonly mapProxyPort: number;

  constructor(
    private readonly executable = "podman",
    private readonly run: PodmanCommandRunner = runPodmanCommand,
    mapProxyPort = Number(process.env.MAGENT_MAP_PROXY_PORT ?? 4317),
  ) {
    if (!Number.isInteger(mapProxyPort) || mapProxyPort < 1 || mapProxyPort > 65_535) {
      throw new Error("MAP relay port must be a valid TCP port.");
    }
    this.mapProxyPort = mapProxyPort;
  }

  async execute(command: ApplicationCommand): Promise<ApplicationLifecycleResult> {
    const appId = command.payload.appId;
    this.validateAppId(appId);
    await this.ensureRootlessPodman();

    switch (command.operation) {
      case "app.install":
        await this.install(
          appId,
          command.id,
          this.requiredImage(command.payload.image),
          this.requiredCpuCount(command.payload.cpuCount),
          this.requiredMemoryMb(command.payload.memoryMb),
          this.requiredEnvironment(command.payload.environment),
          this.requiredCredentials(command.payload.credentialIds, command.payload.credentials),
          command.payload.manifest,
          command.payload.mapToken,
        );
        return { applicationId: appId, status: "active" };
      case "app.start":
        await this.requireContainer(appId);
        await this.command(["start", this.containerName(appId)]);
        return { applicationId: appId, status: "active" };
      case "app.stop":
        await this.requireContainer(appId);
        await this.command(["stop", "--time", "10", this.containerName(appId)]);
        return { applicationId: appId, status: "stopped" };
      case "app.restart":
        await this.requireContainer(appId);
        await this.command(["restart", "--time", "10", this.containerName(appId)]);
        return { applicationId: appId, status: "active" };
      case "app.update":
      case "app.rollback":
      case "app.configure":
        await this.replaceImage(
          appId,
          command.id,
          this.requiredImage(command.payload.image),
          this.requiredImage(command.payload.previousImage),
          this.requiredCpuCount(command.payload.cpuCount),
          this.requiredMemoryMb(command.payload.memoryMb),
          this.requiredEnvironment(command.payload.environment),
          this.requiredCredentials(command.payload.credentialIds, command.payload.credentials),
          this.requiredEnvironment(command.payload.previousEnvironment),
          this.requiredCredentialReferences(
            command.payload.previousCredentialIds,
            command.payload.previousCredentials,
          ),
          this.requiredGeneration(command.payload.previousSecretGeneration),
          command.payload.manifest,
          command.payload.mapToken,
        );
        return { applicationId: appId, status: "active" };
      case "app.uninstall":
        await this.uninstall(
          appId,
          this.requiredGeneration(command.payload.previousSecretGeneration),
          this.requiredCredentialIds(command.payload.credentialIds),
        );
        return { applicationId: appId, status: "removed" };
      default:
        throw new Error("Unsupported application lifecycle operation.");
    }
  }

    async invokeMapAction(
      appId: string,
      port: number,
      token: string,
      request: MapActionRequest,
    ): Promise<MapActionResult> {
      this.validateMapTarget(appId, port, token);
      if (request.target.appId !== appId) {
        throw new Error("MAP action target does not match the application.");
      }
      const response = await fetch(
        `http://127.0.0.1:${await this.publishedPort(appId, port)}/_magent/actions/${encodeURIComponent(request.target.action)}`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(30_000),
        },
      );
      const body = await readResponseJson(response);
      if (!response.ok) {
        return {
          requestId: request.requestId,
          success: false,
          error: {
            code: "APP_ACTION_FAILED",
            message: mapErrorMessage(body, response.status),
            retryable: response.status >= 500,
          },
        };
      }
      if (
        typeof body !== "object" ||
        body === null ||
        Array.isArray(body) ||
        !("requestId" in body) ||
        body.requestId !== request.requestId ||
        !("output" in body)
      ) {
        throw new Error("MAP action returned an invalid response.");
      }
      return {
        requestId: request.requestId,
        success: true,
        output: body.output,
      };
    }

    async deliverMapEvent(
      appId: string,
      port: number,
      token: string,
      event: CloudEvent,
    ): Promise<{ eventId: string }> {
      this.validateMapTarget(appId, port, token);
      const response = await fetch(
        `http://127.0.0.1:${await this.publishedPort(appId, port)}/_magent/events/${encodeURIComponent(event.id)}`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(event),
          signal: AbortSignal.timeout(30_000),
        },
      );
      const body = await readResponseJson(response);
      if (!response.ok || typeof body !== "object" || body === null ||
          !("eventId" in body) || body.eventId !== event.id) {
        throw new Error(mapErrorMessage(body, response.status));
      }
      return { eventId: event.id };
    }

  async inspect(): Promise<RuntimeInspection["applications"]> {
    await this.ensureRootlessPodman();
    const [containersResult, statsResult] = await Promise.all([
      this.command(["ps", "--all", "--filter", "label=magent.managed=true", "--format=json"]),
      this.command(["stats", "--no-stream", "--format=json"]),
    ]);
    const containers = parsePodmanJsonArray(containersResult.stdout, "container list");
    const stats = parsePodmanJsonArray(statsResult.stdout, "container statistics");
    const statsByName = new Map(
      stats.map((entry) => [podmanName(entry), entry]),
    );
    return containers.flatMap((container) => {
      const labels = podmanLabels(container);
      const appId = labels["magent.app-id"];
      if (!appId || !appIdPattern.test(appId)) {
        return [];
      }
      const state = podmanString(container, "State", "state").toLowerCase();
      const statsEntry = statsByName.get(podmanName(container));
      const memory = statsEntry ? parseMemoryUsage(podmanString(statsEntry, "MemUsage", "memUsage")) : null;
      const cpuUsagePercent = statsEntry
        ? parsePercent(podmanString(statsEntry, "CPU", "CPUPerc", "cpu"))
        : null;
      return [{
        applicationId: appId,
        status: state === "running" ? "running" as const : "stopped" as const,
        cpuUsagePercent,
        memoryUsageBytes: memory?.usageBytes ?? null,
        memoryLimitBytes: memory?.limitBytes ?? null,
      }];
    });
  }

  async logs(appId: string, tail: number): Promise<ApplicationLogsResult> {
    this.validateAppId(appId);
    if (!Number.isInteger(tail) || tail < 1 || tail > 500) {
      throw new Error("Application log line limit is invalid.");
    }
    await this.ensureRootlessPodman();
    await this.requireContainer(appId);
    const { stdout, stderr } = await this.command(
      ["logs", `--tail=${tail}`, this.containerName(appId)],
      1024 * 1024,
    );
    const output = [stdout, stderr].filter(Boolean).join(stdout && stderr ? "\n" : "");
    const bytes = Buffer.from(output);
    const truncated = bytes.byteLength > MAX_LOG_BYTES;
    const content = truncated
      ? bytes.subarray(bytes.byteLength - MAX_LOG_BYTES).toString("utf8")
      : output;
    return { applicationId: appId, content, truncated };
  }

  private async install(
    appId: string,
    generation: string,
    image: string,
    cpuCount: number,
    memoryMb: number,
    environment: Record<string, string>,
    credentials: ApplicationCredential[],
    manifest?: MapManifest,
    mapToken?: string,
  ): Promise<void> {
    await this.ensureVolume(appId);
    if (await this.exists(["container", "exists", this.containerName(appId)])) {
      if (await this.containerUsesGeneration(appId, generation)) {
        return;
      }
      await this.command(["rm", "--force", this.containerName(appId)]);
    }
    await this.pull(image);
    await this.createSecrets(appId, generation, credentials);
    try {
      await this.runContainer(appId, generation, image, cpuCount, memoryMb, environment, credentials, manifest, mapToken);
    } catch (error) {
      try {
        await this.removeSecrets(appId, generation, credentials.map(({ credentialId }) => credentialId));
      } catch (cleanupError) {
        throw new Error(
          `Application install failed (${errorMessage(error)}); removing staged credentials also failed (${errorMessage(cleanupError)}).`,
        );
      }
      throw error;
    }
  }

  private async replaceImage(
    appId: string,
    generation: string,
    image: string,
    previousImage: string,
    cpuCount: number,
    memoryMb: number,
    environment: Record<string, string>,
    credentials: ApplicationCredential[],
    previousEnvironment: Record<string, string>,
    previousCredentials: ApplicationCredential[],
    previousGeneration: string,
    manifest?: MapManifest,
    mapToken?: string,
  ): Promise<void> {
    await this.requireContainer(appId);
    if (await this.containerUsesGeneration(appId, generation)) {
      await this.removeSecrets(
        appId,
        previousGeneration,
        previousCredentials.map(({ credentialId }) => credentialId),
      );
      return;
    }
    await this.pull(image);
    await this.createSecrets(appId, generation, credentials);
    try {
      await this.command(["stop", "--time", "10", this.containerName(appId)]);
      await this.command(["rm", this.containerName(appId)]);
    } catch (error) {
      await this.removeSecrets(appId, generation, credentials.map(({ credentialId }) => credentialId));
      throw error;
    }
    try {
      await this.runContainer(appId, generation, image, cpuCount, memoryMb, environment, credentials, manifest, mapToken);
    } catch (error) {
      let cleanupError: unknown;
      try {
        await this.removeSecrets(appId, generation, credentials.map(({ credentialId }) => credentialId));
      } catch (failedCleanup) {
        cleanupError = failedCleanup;
      }
      try {
        await this.runContainer(
          appId,
          previousGeneration,
          previousImage,
          cpuCount,
          memoryMb,
          previousEnvironment,
          previousCredentials,
          manifest,
          mapToken,
        );
      } catch (rollbackError) {
        throw new Error(
          `Could not launch the requested image (${errorMessage(error)}); restoring the previous image also failed (${errorMessage(rollbackError)})${cleanupError ? `; removing staged credentials also failed (${errorMessage(cleanupError)})` : ""}.`,
        );
      }
      if (cleanupError) {
        throw new Error(
          `Could not launch the requested image; the previous image was restored, but removing staged credentials failed (${errorMessage(cleanupError)}).`,
        );
      }
      throw new Error(
        `Could not launch the requested image; the previous image was restored (${errorMessage(error)}).`,
      );
    }
    if (previousGeneration !== generation) {
      await this.removeSecrets(
        appId,
        previousGeneration,
        previousCredentials.map(({ credentialId }) => credentialId),
      );
    }
  }

  private async uninstall(
    appId: string,
    generation: string,
    credentialIds: string[],
  ): Promise<void> {
    if (await this.exists(["container", "exists", this.containerName(appId)])) {
      await this.command(["rm", "--force", this.containerName(appId)]);
    }
    await this.removeSecrets(appId, generation, credentialIds);
    if (await this.exists(["volume", "exists", this.volumeName(appId)])) {
      await this.command(["volume", "rm", this.volumeName(appId)]);
    }
    if (await this.exists(["network", "exists", this.networkName(appId)])) {
      await this.command(["network", "rm", this.networkName(appId)]);
    }
  }

  private async createSecrets(
    appId: string,
    generation: string,
    credentials: ApplicationCredential[],
  ): Promise<void> {
    try {
      for (const { credentialId, value } of credentials) {
        const name = this.secretName(appId, generation, credentialId);
        if (await this.exists(["secret", "exists", name])) {
          await this.command(["secret", "rm", name]);
        }
        await this.commandWithInput(["secret", "create", name, "-"], value);
      }
    } catch (error) {
      try {
        await this.removeSecrets(
          appId,
          generation,
          credentials.map(({ credentialId }) => credentialId),
        );
      } catch (cleanupError) {
        throw new Error(
          `Could not create an application credential secret (${errorMessage(error)}); secret cleanup failed (${errorMessage(cleanupError)}).`,
        );
      }
      throw error;
    }
  }

  private async removeSecrets(appId: string, generation: string, credentialIds: string[]): Promise<void> {
    for (const credentialId of credentialIds) {
      const name = this.secretName(appId, generation, credentialId);
      if (await this.exists(["secret", "exists", name])) {
        await this.command(["secret", "rm", name]);
      }
      const mapSecret = this.mapSecretName(appId, generation);
      if (await this.exists(["secret", "exists", mapSecret])) {
        await this.command(["secret", "rm", mapSecret]);
      }
    }
  }

  private async ensureVolume(appId: string): Promise<void> {
    const volumeName = this.volumeName(appId);
    if (!(await this.exists(["volume", "exists", volumeName]))) {
      await this.command(["volume", "create", volumeName]);
    }
  }

  private async runContainer(
    appId: string,
    generation: string,
    image: string,
    cpuCount: number,
    memoryMb: number,
    environment: Record<string, string>,
    credentials: ApplicationCredential[],
    manifest?: MapManifest,
    mapToken?: string,
  ): Promise<void> {
    if (manifest && (!mapToken || !/^[A-Za-z0-9_-]{43}$/.test(mapToken))) {
      throw new Error("MAP application token is unavailable.");
    }
    if (manifest) {
      await this.ensureNetwork(appId);
      const name = this.mapSecretName(appId, generation);
      if (await this.exists(["secret", "exists", name])) {
        await this.command(["secret", "rm", name]);
      }
      await this.commandWithInput(["secret", "create", name, "-"], mapToken!);
    }
    const args = [
      "run",
      "--detach",
      "--pull=never",
      `--name=${this.containerName(appId)}`,
      "--label=magent.managed=true",
      `--label=magent.app-id=${appId}`,
      `--label=magent.secret-generation=${generation}`,
      ...(manifest ? [`--entrypoint=${manifest.runtime.entrypoint}`] : []),
      manifest ? `--network=${this.networkName(appId)}` : "--network=none",
      ...(manifest ? [`--publish=127.0.0.1::${manifest.runtime.port}/tcp`] : []),
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--pids-limit=128",
      `--memory=${memoryMb}m`,
      `--cpus=${cpuCount}`,
      "--userns=keep-id",
      "--tmpfs=/tmp:rw,noexec,nosuid,size=64m",
      `--volume=${this.volumeName(appId)}:/data:U`,
      ...Object.entries(environment).map(([key, value]) => `--env=${key}=${value}`),
      ...(manifest
        ? [`--env=MAGENT_MAP_URL=http://host.containers.internal:${this.mapProxyPort}`]
        : []),
      ...credentials.map(({ credentialId }) =>
        `--secret=${this.secretName(appId, generation, credentialId)},target=/run/secrets/${credentialId}`,
      ),
      ...(manifest
        ? [`--secret=${this.mapSecretName(appId, generation)},target=/run/secrets/magent-map-token`]
        : []),
      image,
    ];
    await this.command(args);
    try {
      const { stdout } = await this.command([
        "inspect",
        `--format={{.State.Running}}`,
        this.containerName(appId),
      ]);
      if (stdout.trim() === "true") {
        return;
      }
    } catch (error) {
      try {
        await this.command(["rm", "--force", this.containerName(appId)]);
      } catch (cleanupError) {
        throw new Error(
          `Container did not start (${errorMessage(error)}); cleanup failed (${errorMessage(cleanupError)}).`,
        );
      }
      throw error;
    }

    await this.command(["rm", "--force", this.containerName(appId)]);
    throw new Error("Application container exited before it became active.");
  }

  private async ensureNetwork(appId: string): Promise<void> {
    const name = this.networkName(appId);
    if (!(await this.exists(["network", "exists", name]))) {
      await this.command(["network", "create", "--internal", name]);
    }
  }

  private async publishedPort(appId: string, containerPort: number): Promise<number> {
    await this.ensureRootlessPodman();
    await this.requireContainer(appId);
    const { stdout } = await this.command([
      "port",
      this.containerName(appId),
      `${containerPort}/tcp`,
    ]);
    const match = /^127\.0\.0\.1:(\d+)$/.exec(stdout.trim());
    if (!match?.[1]) {
      throw new Error("MAP application is not published on a loopback-only port.");
    }
    const hostPort = Number(match[1]);
    if (!Number.isInteger(hostPort) || hostPort < 1 || hostPort > 65_535) {
      throw new Error("MAP application published port is invalid.");
    }
    return hostPort;
  }

  private validateMapTarget(appId: string, port: number, token: string): void {
    this.validateAppId(appId);
    if (!Number.isInteger(port) || port < 1 || port > 65_535 ||
        !/^[A-Za-z0-9_-]{43}$/.test(token)) {
      throw new Error("MAP application target is invalid.");
    }
  }

  private async pull(image: string): Promise<void> {
    await this.command(["pull", image]);
  }

  private async requireContainer(appId: string): Promise<void> {
    if (!(await this.exists(["container", "exists", this.containerName(appId)]))) {
      throw new Error(`Managed container for ${appId} does not exist.`);
    }
  }

  private async containerUsesGeneration(appId: string, generation: string): Promise<boolean> {
    const { stdout } = await this.command([
      "inspect",
      `--format={{index .Config.Labels "magent.secret-generation"}}|{{.State.Running}}`,
      this.containerName(appId),
    ]);
    return stdout.trim() === `${generation}|true`;
  }

  private async exists(args: string[]): Promise<boolean> {
    try {
      await this.command(args);
      return true;
    } catch (error) {
      if (isExitCode(error, 1)) {
        return false;
      }
      throw error;
    }
  }

  private async ensureRootlessPodman(): Promise<void> {
    this.rootlessCheck ??= this.command(["info", "--format={{.Host.Security.Rootless}}"])
      .then(({ stdout }) => {
        if (stdout.trim() !== "true") {
          throw new Error("Magent applications require rootless Podman.");
        }
      })
      .catch((error: unknown) => {
        this.rootlessCheck = null;
        throw error;
      });
    await this.rootlessCheck;
  }

  private command(args: string[], maxBuffer = 128 * 1024): Promise<{ stdout: string; stderr: string }> {
    return this.run(this.executable, args, {
      timeout: 120_000,
      maxBuffer,
    });
  }

  private async commandWithInput(args: string[], input: string): Promise<{ stdout: string; stderr: string }> {
    return this.run(this.executable, args, {
      timeout: 120_000,
      maxBuffer: 128 * 1024,
      input,
    });
  }

  private validateAppId(appId: string): void {
    if (!appIdPattern.test(appId)) {
      throw new Error("Application ID has an invalid format.");
    }
  }

  private requiredImage(image: string | undefined): string {
    if (!image || !imagePattern.test(image)) {
      throw new Error("Application image reference has an invalid format.");
    }
    return image;
  }

  private requiredCpuCount(cpuCount: number | undefined): number {
    if (cpuCount === undefined || !Number.isFinite(cpuCount) || cpuCount < 0.1 || cpuCount > 128) {
      throw new Error("Application CPU limit is invalid.");
    }
    return cpuCount;
  }

  private requiredMemoryMb(memoryMb: number | undefined): number {
    if (!Number.isInteger(memoryMb) || memoryMb === undefined || memoryMb < 64 || memoryMb > 1_048_576) {
      throw new Error("Application memory limit is invalid.");
    }
    return memoryMb;
  }

  private requiredEnvironment(environment: Record<string, string> | undefined): Record<string, string> {
    if (!environment || Object.entries(environment).some(([key, value]) =>
      !/^[A-Z_][A-Z0-9_]{0,63}$/.test(key) ||
      key.startsWith("MAGENT_") ||
      typeof value !== "string" ||
      value.length > 2_048 ||
      value.includes("\0"),
    )) {
      throw new Error("Application configuration is invalid.");
    }
    if (
      Object.keys(environment).length > 64 ||
      Object.entries(environment).reduce((size, [key, value]) => size + key.length + value.length, 0) > 16_384
    ) {
      throw new Error("Application configuration exceeds its allowed size.");
    }
    return environment;
  }

  private requiredCredentialIds(credentialIds: string[] | undefined): string[] {
    if (
      !credentialIds ||
      credentialIds.length > 50 ||
      credentialIds.some((credentialId) => !/^[a-f\d]{24}$/i.test(credentialId)) ||
      new Set(credentialIds).size !== credentialIds.length
    ) {
      throw new Error("Application credential grants are invalid.");
    }
    return credentialIds;
  }

  private requiredCredentials(
    credentialIds: string[] | undefined,
    credentials: ApplicationCredential[] | undefined,
  ): ApplicationCredential[] {
    const expectedIds = this.requiredCredentialIds(credentialIds);
    if (
      !credentials ||
      credentials.length !== expectedIds.length ||
      new Set(credentials.map(({ credentialId }) => credentialId)).size !== credentials.length ||
      credentials.some(({ credentialId, value }) =>
        !expectedIds.includes(credentialId) || typeof value !== "string" || value.length === 0,
      )
    ) {
      throw new Error("Application credentials do not match the authorized grants.");
    }
    return credentials;
  }

  private requiredCredentialReferences(
    credentialIds: string[] | undefined,
    credentials: ApplicationCredential[] | undefined,
  ): ApplicationCredential[] {
    const expectedIds = this.requiredCredentialIds(credentialIds);
    if (
      !credentials ||
      credentials.length !== expectedIds.length ||
      new Set(credentials.map(({ credentialId }) => credentialId)).size !== credentials.length ||
      credentials.some(({ credentialId }) => !expectedIds.includes(credentialId))
    ) {
      throw new Error("Previous application credential references are invalid.");
    }
    return credentials;
  }

  private requiredGeneration(generation: string | undefined): string {
    if (!generation || !/^[a-f\d]{24}$/i.test(generation)) {
      throw new Error("Application credential generation is invalid.");
    }
    return generation;
  }

  private containerName(appId: string): string {
    return `magent-app-${this.appNameComponent(appId)}`;
  }

  private volumeName(appId: string): string {
    return `magent-data-${this.appNameComponent(appId)}`;
  }

  private secretName(appId: string, generation: string, credentialId: string): string {
    return `magent-${this.appNameComponent(appId)}-${generation}-${credentialId}`;
  }

  private mapSecretName(appId: string, generation: string): string {
    return `magent-${this.appNameComponent(appId)}-${generation}-map-token`;
  }

  private networkName(appId: string): string {
    return `magent-net-${this.appNameComponent(appId)}`;
  }

  private appNameComponent(appId: string): string {
    return appId.length <= 63
      ? appId
      : `id-${createHash("sha256").update(appId).digest("hex").slice(0, 32)}`;
  }
}

async function readResponseJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("MAP application returned an empty response.");
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 1024 * 1024) {
      await reader.cancel();
      throw new Error("MAP application response exceeds the allowed size.");
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new Error("MAP application returned invalid JSON.");
  }
}

function mapErrorMessage(value: unknown, statusCode: number): string {
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "error" in value &&
    typeof value.error === "string"
  ) {
    return value.error.slice(0, 500);
  }
  return `MAP application request failed (${statusCode}).`;
}

function parsePodmanJsonArray(value: string, label: string): Array<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value || "[]");
  } catch {
    throw new Error(`Podman returned invalid JSON for ${label}.`);
  }
  if (!Array.isArray(parsed) || parsed.some((entry) =>
    typeof entry !== "object" || entry === null || Array.isArray(entry),
  )) {
    throw new Error(`Podman returned an invalid ${label}.`);
  }
  return parsed as Array<Record<string, unknown>>;
}

function podmanString(entry: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    if (typeof entry[key] === "string") {
      return entry[key];
    }
  }
  return "";
}

function podmanName(entry: Record<string, unknown>): string {
  const name = entry.Name ?? entry.name ?? entry.Names ?? entry.names;
  return Array.isArray(name) && typeof name[0] === "string"
    ? name[0]
    : typeof name === "string"
      ? name
      : "";
}

function podmanLabels(entry: Record<string, unknown>): Record<string, string> {
  const labels = entry.Labels ?? entry.labels;
  if (typeof labels === "object" && labels !== null && !Array.isArray(labels)) {
    return Object.fromEntries(
      Object.entries(labels).filter((item): item is [string, string] => typeof item[1] === "string"),
    );
  }
  if (typeof labels === "string") {
    return Object.fromEntries(labels.split(",").flatMap((label) => {
      const separator = label.indexOf("=");
      return separator < 0 ? [] : [[label.slice(0, separator), label.slice(separator + 1)]];
    }));
  }
  return {};
}

function parsePercent(value: string): number | null {
  const match = /^([\d.]+)%?$/.exec(value.trim());
  if (!match?.[1]) {
    return null;
  }
  const percent = Number(match[1]);
  return Number.isFinite(percent) ? percent : null;
}

function parseMemoryUsage(value: string): { usageBytes: number; limitBytes: number } | null {
  const match = /^\s*([^/]+?)\s*\/\s*(.+?)\s*$/.exec(value);
  if (!match?.[1] || !match[2]) {
    return null;
  }
  const usageBytes = parseByteSize(match[1]);
  const limitBytes = parseByteSize(match[2]);
  return usageBytes === null || limitBytes === null ? null : { usageBytes, limitBytes };
}

function parseByteSize(value: string): number | null {
  const match = /^\s*([\d.]+)\s*(B|KiB|MiB|GiB|TiB|kB|MB|GB|TB)?\s*$/i.exec(value);
  if (!match?.[1]) {
    return null;
  }
  const size = Number(match[1]);
  const unit = (match[2] ?? "B").toLowerCase();
  const power = unit === "b" ? 0
    : unit === "kib" || unit === "kb" ? 1
      : unit === "mib" || unit === "mb" ? 2
        : unit === "gib" || unit === "gb" ? 3
          : unit === "tib" || unit === "tb" ? 4
            : null;
  return Number.isFinite(size) && power !== null
    ? Math.round(size * (unit.endsWith("ib") ? 1024 : 1000) ** power)
    : null;
}

async function runPodmanCommand(
  executable: string,
  args: string[],
  options: { timeout: number; maxBuffer: number; input?: string },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFileCallback(
      executable,
      args,
      { timeout: options.timeout, maxBuffer: options.maxBuffer },
      (error: Error | null, stdout: string, stderr: string) => {
        if (error) {
          const output = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
          if (output) {
            error.message = `${error.message}\nPodman output:\n${output.slice(-4_096)}`;
          }
          reject(error);
        } else {
          resolve({ stdout, stderr });
        }
      },
    );
    if (options.input !== undefined) {
      if (!child.stdin) {
        reject(new Error("Could not provide input to the Podman command."));
        return;
      }
      child.stdin.on("error", reject);
      child.stdin.end(options.input);
    }
  });
}

function isExitCode(error: unknown, code: number): boolean {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown container engine error";
}
