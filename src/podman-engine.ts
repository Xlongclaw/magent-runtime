import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";
import type {
  AppStudioBuildResult,
  AppStudioCommandResult,
  WorkflowCodePayload,
  WorkflowCodeResult,
  ApplicationCommand,
  ApplicationCredential,
  ApplicationLogsResult,
  ApplicationProxyPayload,
  ApplicationProxyResult,
  ApplicationLifecycleResult,
  RuntimeInspection,
} from "./client.js";
import type {
  CloudEvent,
  MapActionRequest,
  MapActionResult,
  MapManifest,
} from "@magent/map-protocol";
import {
  applicationProxyPayloadSchema,
  applicationProxyResultSchema,
  workflowCodePayloadSchema,
  workflowCodeResultSchema,
} from "@magent/runtime-protocol";

const appIdPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const imagePattern = /^(?:(?:[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[0-9]{1,5})?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*)(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}|@sha256:[a-f0-9]{64})$/;
const MAX_LOG_BYTES = 65_536;
const APP_STUDIO_TERMINAL_IMAGE = "docker.io/library/node:22-alpine";
const APP_STUDIO_LOCAL_IMAGE_PREFIX = "localhost/magent/";
const OUTBOUND_NETWORK_PERMISSION = "network.outbound";
const WORKFLOW_CODE_RUNNER = `const fs=require("node:fs");const vm=require("node:vm");const payload=JSON.parse(fs.readFileSync(0,"utf8"));const timer=setTimeout(()=>{process.stderr.write("Workflow code exceeded its execution deadline.\\n");process.exit(124)},10000);const sandbox=vm.createContext({contextJson:JSON.stringify(payload.context),source:payload.source},{codeGeneration:{strings:false,wasm:false}});(async()=>{const result=await vm.runInContext("(async()=>{const {input,nodes}=JSON.parse(contextJson);\\n"+payload.source+"\\n})()",sandbox,{timeout:5000});const output=JSON.stringify(result);if(typeof output!=="string")throw new Error("Workflow code must return a JSON value.");if(Buffer.byteLength(output)>262144)throw new Error("Workflow code output exceeded 256 KiB.");process.stdout.write(JSON.stringify({executionId:payload.executionId,nodeId:payload.nodeId,output:JSON.parse(output)}));clearTimeout(timer)})().catch(error=>{process.stderr.write(String(error&&error.message||"Workflow code failed.").slice(0,1000));process.exitCode=1;clearTimeout(timer)})`;

export interface PodmanCommandRunner {
  (executable: string, args: string[], options: {
    timeout: number;
    maxBuffer: number;
    input?: string | Uint8Array;
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
          command.payload.grantedPermissions,
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
          command.payload.grantedPermissions,
          command.payload.previousGrantedPermissions,
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

  async buildAppStudioImage(input: {
    projectId: string;
    appId: string;
    version: string;
    digest: string;
    archive: Buffer;
    localImage: string;
    registryImage?: string;
    registryCredential?: string;
  }): Promise<AppStudioBuildResult> {
    this.validateAppId(input.appId);
    const expectedLocalImage = `${APP_STUDIO_LOCAL_IMAGE_PREFIX}${input.appId.replaceAll(".", "-")}:${input.version}-${input.digest.slice(0, 24)}`;
    if (!/^[a-f\d]{24}$/i.test(input.projectId) ||
        !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(input.version) ||
        !/^[a-f\d]{64}$/i.test(input.digest) ||
        input.localImage !== expectedLocalImage) {
      throw new Error("App Studio image build metadata is invalid.");
    }
    this.validateImageReference(input.localImage);
    if (input.registryImage) {
      if (!input.registryCredential) {
        throw new Error("A runtime-granted GHCR credential is required to push this image.");
      }
      this.validateGhcrImage(input.registryImage);
    } else if (input.registryCredential) {
      throw new Error("A GHCR credential cannot be used without a registry image.");
    }
    if (input.archive.length === 0 || input.archive.length > 750_000) {
      throw new Error("App Studio package exceeds the runtime build limit.");
    }
    const registryCredentials = input.registryImage
      ? parseGhcrCredentials(input.registryCredential!)
      : null;
    await this.ensureRootlessPodman();

    const tags = [`--tag=${input.localImage}`];
    if (input.registryImage) tags.push(`--tag=${input.registryImage}`);
    const { stdout, stderr } = await this.run(this.executable, [
      "build",
      "--pull=missing",
      "--memory=512m",
      "--cpu-period=100000",
      "--cpu-quota=200000",
      ...tags,
      "--file=Dockerfile",
      "-",
    ], {
      timeout: 600_000,
      maxBuffer: 2 * 1024 * 1024,
      input: input.archive,
    });
    const logs = truncateUtf8([stdout.trim(), stderr.trim()].filter(Boolean).join("\n"), MAX_LOG_BYTES);
    let registryDigest: string | null = null;
    if (input.registryImage && registryCredentials) {
      const authDirectory = await mkdtemp(join(tmpdir(), "mაგენტ-ghcr-auth-"));
      const authFile = join(authDirectory, "auth.json");
      const digestFile = join(authDirectory, "digest");
      try {
        await this.commandWithInput([
          "login",
          "--authfile",
          authFile,
          "--username",
          registryCredentials.username,
          "--password-stdin",
          "ghcr.io",
        ], registryCredentials.token);
        await this.command([
          "push",
          "--authfile",
          authFile,
          `--digestfile=${digestFile}`,
          input.registryImage,
        ], 1024 * 1024, 600_000);
        registryDigest = (await readFile(digestFile, "utf8")).trim();
        if (!/^sha256:[a-f\d]{64}$/i.test(registryDigest)) {
          throw new Error("GHCR did not return a valid OCI image digest.");
        }
      } finally {
        await rm(authDirectory, { recursive: true, force: true });
      }
    }
    return {
      projectId: input.projectId,
      appId: input.appId,
      version: input.version,
      digest: input.digest,
      localImage: input.localImage,
      registryImage: input.registryImage ?? null,
      registryDigest,
      logs,
    };
  }

  async executeAppStudioCommand(input: {
    projectId: string;
    archive: Buffer;
    command: string;
  }): Promise<AppStudioCommandResult> {
    if (!/^[a-f\d]{24}$/i.test(input.projectId) ||
        !input.command.trim() || input.command.length > 1_000 ||
        input.command.includes("\0") ||
        input.archive.length === 0 || input.archive.length > 750_000) {
      throw new Error("App Studio terminal request is invalid.");
    }
    await this.ensureRootlessPodman();
    await this.ensureTerminalImage();
    const directory = await extractAppStudioArchive(input.archive);
    try {
      const { stdout, stderr } = await this.run(this.executable, [
        "run",
        "--rm",
        "--network=none",
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--pids-limit=64",
        "--memory=256m",
        "--cpus=1",
        "--userns=keep-id",
        "--tmpfs=/tmp:rw,noexec,nosuid,size=32m",
        "--tmpfs=/workspace:rw,noexec,nosuid,size=64m",
        `--volume=${directory}:/source:ro`,
        APP_STUDIO_TERMINAL_IMAGE,
        "sh",
        "-lc",
        'cp -R /source/. /workspace && cd /workspace || exit 125; sh -lc "$1" > /tmp/magent-output 2>&1; status=$?; bytes=$(wc -c < /tmp/magent-output); head -c 65536 /tmp/magent-output; printf "\\n__MAGENT_EXIT_CODE=%s;OUTPUT_BYTES=%s\\n" "$status" "$bytes"',
        "mაგენტ-app-studio-terminal",
        input.command,
      ], {
        timeout: 60_000,
        maxBuffer: 128 * 1024,
      });
      const exitMarker = /\n__MAGENT_EXIT_CODE=(\d{1,3});OUTPUT_BYTES=(\d+)\s*$/.exec(stdout);
      if (!exitMarker?.[1]) {
        throw new Error("Isolated terminal did not return a valid command status.");
      }
      const fullOutput = [stdout.slice(0, exitMarker.index).trimEnd(), stderr.trim()]
        .filter(Boolean)
        .join("\n");
      return {
        projectId: input.projectId,
        output: truncateUtf8(fullOutput, MAX_LOG_BYTES),
        exitCode: Number(exitMarker[1]),
        truncated: Number(exitMarker[2]) > MAX_LOG_BYTES ||
          Buffer.byteLength(fullOutput) > MAX_LOG_BYTES,
      };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async executeWorkflowCode(input: WorkflowCodePayload): Promise<WorkflowCodeResult> {
    const parsed = workflowCodePayloadSchema.safeParse(input);
    if (!parsed.success) throw new Error("Workflow code command is invalid.");
    await this.ensureRootlessPodman();
    await this.ensureTerminalImage();
    const { stdout } = await this.run(this.executable, [
      "run",
      "--rm",
      "--timeout=15",
      "--network=none",
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--pids-limit=32",
      "--memory=128m",
      "--cpus=1",
      "--userns=keep-id",
      "--tmpfs=/tmp:rw,noexec,nosuid,size=16m",
      "--env=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      "--env=HOME=/tmp",
      "--workdir=/tmp",
      APP_STUDIO_TERMINAL_IMAGE,
      "node",
      "-e",
      WORKFLOW_CODE_RUNNER,
    ], {
      timeout: 20_000,
      maxBuffer: 512 * 1024,
      input: JSON.stringify(parsed.data),
    });
    let result: unknown;
    try {
      result = JSON.parse(stdout) as unknown;
    } catch {
      throw new Error("Workflow code sandbox returned invalid JSON.");
    }
    const validated = workflowCodeResultSchema.safeParse(result);
    if (
      !validated.success ||
      validated.data.executionId !== parsed.data.executionId ||
      validated.data.nodeId !== parsed.data.nodeId
    ) {
      throw new Error("Workflow code sandbox returned an invalid result.");
    }
    return validated.data;
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

    async proxyApplicationRequest(payload: ApplicationProxyPayload): Promise<ApplicationProxyResult> {
      const parsed = applicationProxyPayloadSchema.safeParse(payload);
      if (!parsed.success) throw new Error("Application frontend proxy request is invalid.");
      const request = parsed.data;
      this.validateAppId(request.appId);
      const target = new URL(request.path, `http://127.0.0.1:${await this.publishedPort(request.appId, request.port)}`);
      if (target.hostname !== "127.0.0.1" || target.username || target.password) {
        throw new Error("Application frontend proxy target is invalid.");
      }

      let body: Buffer | undefined;
      if (request.body !== undefined) {
        if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(request.body)) {
          throw new Error("Application frontend proxy body encoding is invalid.");
        }
        body = Buffer.from(request.body, "base64");
        if (body.length > 750 * 1024 || body.toString("base64") !== request.body) {
          throw new Error("Application frontend proxy request exceeds the allowed size.");
        }
      }

      const response = await fetch(target, {
        method: request.method,
        ...(body && request.method !== "GET" && request.method !== "HEAD" ? { body: Uint8Array.from(body) } : {}),
        headers: request.contentType ? { "content-type": request.contentType } : {},
        redirect: "manual",
        signal: AbortSignal.timeout(20_000),
      });
      const responseBody = await readResponseBuffer(response, 2 * 1024 * 1024);
      const result = {
        applicationId: request.appId,
        statusCode: response.status,
        ...(response.headers.get("content-type")
          ? { contentType: response.headers.get("content-type")!.slice(0, 256) }
          : {}),
        ...(response.headers.get("location")
          ? { location: response.headers.get("location")!.slice(0, 4_096) }
          : {}),
        ...(response.headers.get("cache-control")
          ? { cacheControl: response.headers.get("cache-control")!.slice(0, 256) }
          : {}),
        body: responseBody.toString("base64"),
      };
      const validated = applicationProxyResultSchema.safeParse(result);
      if (!validated.success) throw new Error("Application frontend proxy response is invalid.");
      return validated.data;
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
    grantedPermissions: string[] = [],
    mapToken?: string,
  ): Promise<void> {
    await this.ensureVolume(appId);
    if (await this.exists(["container", "exists", this.containerName(appId)])) {
      if (await this.containerUsesGeneration(appId, generation)) {
        return;
      }
      await this.command(["rm", "--force", this.containerName(appId)]);
    }
    await this.ensureImage(image);
    await this.createSecrets(appId, generation, credentials);
    try {
      await this.runContainer(
        appId, generation, image, cpuCount, memoryMb, environment, credentials, manifest,
        grantedPermissions, mapToken,
      );
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
    grantedPermissions: string[] = [],
    previousGrantedPermissions: string[] = [],
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
    await this.ensureImage(image);
    await this.createSecrets(appId, generation, credentials);
    try {
      await this.command(["stop", "--time", "10", this.containerName(appId)]);
      await this.command(["rm", this.containerName(appId)]);
    } catch (error) {
      await this.removeSecrets(appId, generation, credentials.map(({ credentialId }) => credentialId));
      throw error;
    }
    try {
      await this.runContainer(
        appId, generation, image, cpuCount, memoryMb, environment, credentials, manifest,
        grantedPermissions, mapToken,
      );
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
          previousGrantedPermissions,
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
    for (const allowOutbound of [false, true]) {
      const network = this.networkName(appId, allowOutbound);
      if (await this.exists(["network", "exists", network])) {
        await this.command(["network", "rm", network]);
      }
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
    grantedPermissions: string[] = [],
    mapToken?: string,
  ): Promise<void> {
    if (manifest && (!mapToken || !/^[A-Za-z0-9_-]{43}$/.test(mapToken))) {
      throw new Error("MAP application token is unavailable.");
    }
    if (manifest) {
      const outboundRequested = manifest.requestedPermissions.includes(OUTBOUND_NETWORK_PERMISSION);
      const outboundGranted = grantedPermissions.includes(OUTBOUND_NETWORK_PERMISSION);
      if (outboundGranted && !outboundRequested) {
        throw new Error("Outbound network access was granted but not requested by the MAP manifest.");
      }
      await this.ensureNetwork(appId, outboundGranted);
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
      manifest
        ? `--network=${this.networkName(appId, grantedPermissions.includes(OUTBOUND_NETWORK_PERMISSION))}`
        : "--network=none",
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

  private async ensureNetwork(appId: string, allowOutbound: boolean): Promise<void> {
    const name = this.networkName(appId, allowOutbound);
    if (!(await this.exists(["network", "exists", name]))) {
      await this.command([
        "network",
        "create",
        ...(allowOutbound ? [] : ["--internal"]),
        name,
      ]);
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

  private async ensureImage(image: string): Promise<void> {
    if (image.startsWith(APP_STUDIO_LOCAL_IMAGE_PREFIX)) {
      if (await this.exists(["image", "exists", image])) return;
      throw new Error("The runtime-local App Studio image is missing. Build it on this runtime before installing.");
    }
    await this.pull(image);
  }

  private async ensureTerminalImage(): Promise<void> {
    if (!(await this.exists(["image", "exists", APP_STUDIO_TERMINAL_IMAGE]))) {
      await this.pull(APP_STUDIO_TERMINAL_IMAGE);
    }
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

  private command(
    args: string[],
    maxBuffer = 128 * 1024,
    timeout = 120_000,
  ): Promise<{ stdout: string; stderr: string }> {
    return this.run(this.executable, args, {
      timeout,
      maxBuffer,
    });
  }

  private async commandWithInput(
    args: string[],
    input: string | Uint8Array,
  ): Promise<{ stdout: string; stderr: string }> {
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

  private validateImageReference(image: string): void {
    if (!imagePattern.test(image)) {
      throw new Error("App Studio image reference has an invalid format.");
    }
  }

  private validateGhcrImage(image: string): void {
    if (!/^ghcr\.io\/[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9][a-z0-9._-]{0,127}:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(image)) {
      throw new Error("App Studio can only push tagged images to a GHCR owner/repository.");
    }
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

  private networkName(appId: string, allowOutbound: boolean): string {
    return `magent-net-${this.appNameComponent(appId)}${allowOutbound ? "-outbound" : ""}`;
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

async function readResponseBuffer(response: Response, maxBytes: number): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maxBytes) {
      await reader.cancel();
      throw new Error("Application frontend response exceeds the allowed size.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function parseGhcrCredentials(value: string): { username: string; token: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error("The runtime GHCR credential must contain JSON with username and token fields.");
  }
  if (
    typeof parsed !== "object" || parsed === null || Array.isArray(parsed) ||
    !("username" in parsed) || typeof parsed.username !== "string" ||
    !/^[A-Za-z0-9-]{1,39}$/.test(parsed.username) ||
    !("token" in parsed) || typeof parsed.token !== "string" ||
    parsed.token.length < 1 || parsed.token.length > 4_096 ||
    /[\r\n\0]/.test(parsed.token)
  ) {
    throw new Error("The runtime GHCR credential must contain a valid username and token.");
  }
  return { username: parsed.username, token: parsed.token };
}

function truncateUtf8(value: string, limit: number): string {
  const bytes = Buffer.from(value);
  if (bytes.length <= limit) return value;
  return bytes.subarray(bytes.length - limit).toString("utf8");
}

async function extractAppStudioArchive(archive: Buffer): Promise<string> {
  let tar: Buffer;
  try {
    tar = gunzipSync(archive, { maxOutputLength: 2 * 1024 * 1024 });
  } catch {
    throw new Error("App Studio source package is not a valid bounded gzip archive.");
  }
  const directory = await mkdtemp(join(tmpdir(), "mაგენტ-app-studio-"));
  const seen = new Set<string>();
  const root = resolve(directory);
  let offset = 0;
  try {
    while (offset + 512 <= tar.length) {
      const header = tar.subarray(offset, offset + 512);
      if (header.every((byte) => byte === 0)) break;
      const checksum = Number.parseInt(
        header.subarray(148, 156).toString("ascii").replace(/\0.*$/, "").trim(),
        8,
      );
      const checksumHeader = Buffer.from(header);
      checksumHeader.fill(0x20, 148, 156);
      if (!Number.isInteger(checksum) || checksumHeader.reduce((sum, byte) => sum + byte, 0) !== checksum) {
        throw new Error("App Studio source package has an invalid tar header.");
      }
      const path = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
      const sizeText = header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim();
      const size = Number.parseInt(sizeText, 8);
      const type = header[156];
      if (!path || path.startsWith("/") || path.includes("\\") ||
          path.split("/").some((part) => !part || part === "." || part === "..") ||
          (type !== 0 && type !== 48) || !Number.isInteger(size) || size < 0 ||
          size > 512_000 ||
          offset + 512 + Math.ceil(size / 512) * 512 > tar.length ||
          seen.has(path)) {
        throw new Error("App Studio source package contains an unsupported archive entry.");
      }
      seen.add(path);
      const target = resolve(root, path);
      const relativePath = relative(root, target);
      if (!relativePath || relativePath.startsWith(`..${sep}`) || relativePath === "..") {
        throw new Error("App Studio source package contains an unsafe path.");
      }
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, tar.subarray(offset + 512, offset + 512 + size), {
        flag: "wx",
        mode: 0o600,
      });
      offset += 512 + Math.ceil(size / 512) * 512;
    }
    if (!seen.has("Dockerfile") || !seen.has("package.json")) {
      throw new Error("App Studio source package is missing required project files.");
    }
    return directory;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
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

export async function runPodmanCommand(
  executable: string,
  args: string[],
  options: { timeout: number; maxBuffer: number; input?: string | Uint8Array },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const [file, execArgs] =
      options.input !== undefined
        ? ["/bin/sh", ["-c", 'cat | "$@"', "_", executable, "--remote=false", ...args]]
        : [executable, ["--remote=false", ...args]];
    const child = execFileCallback(
      file,
      execArgs,
      {
        timeout: options.timeout,
        maxBuffer: options.maxBuffer,
        env: localPodmanEnvironment(),
      },
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

function localPodmanEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.CONTAINER_HOST;
  delete env.CONTAINER_CONNECTION;
  delete env.DOCKER_HOST;
  return env;
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
