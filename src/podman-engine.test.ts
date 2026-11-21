import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import type { ApplicationCommand } from "./client.js";
import {
  PodmanApplicationEngine,
  runPodmanCommand,
  type PodmanCommandRunner,
} from "./podman-engine.js";

function command(
  operation: ApplicationCommand["operation"],
  payload: ApplicationCommand["payload"],
): ApplicationCommand {
  return {
    id: (++commandId).toString(16).padStart(24, "0"),
    leaseToken: "L".repeat(43),
    operation,
    payload: {
      environment: {},
      credentialIds: [],
      credentials: [],
      previousEnvironment: {},
      previousCredentialIds: [],
      previousCredentials: [],
      previousSecretGeneration: "000000000000000000000000",
      ...payload,
    },
  };
}

let commandId = 0;

function appStudioArchive(files: Record<string, string>): Buffer {
  const entries = Object.entries(files).map(([path, value]) => {
    const body = Buffer.from(value);
    const header = Buffer.alloc(512);
    header.write(path, 0, 100, "utf8");
    header.write("0000644\0", 100, 8, "ascii");
    header.write("0000000\0", 108, 8, "ascii");
    header.write("0000000\0", 116, 8, "ascii");
    header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
    header.write("00000000000\0", 136, 12, "ascii");
    header.fill(0x20, 148, 156);
    header[156] = "0".charCodeAt(0);
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    const padding = body.length % 512 ? Buffer.alloc(512 - body.length % 512) : Buffer.alloc(0);
    return Buffer.concat([header, body, padding]);
  });
  return gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
}

function exitCodeError(code: number): Error & { code: number } {
  return Object.assign(new Error(`Podman exited with ${code}`), { code });
}

test("Podman command runner forces local mode and forwards secret stdin", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mაგენტ-podman-test-"));
  const executable = join(directory, "podman");
  await writeFile(
    executable,
    '#!/bin/sh\nprintf \'%s|%s|%s|%s\\n\' "${CONTAINER_HOST-unset}" "${CONTAINER_CONNECTION-unset}" "${DOCKER_HOST-unset}" "$*"\ncat\n',
    { mode: 0o700 },
  );
  const previousEnvironment = {
    CONTAINER_HOST: process.env.CONTAINER_HOST,
    CONTAINER_CONNECTION: process.env.CONTAINER_CONNECTION,
    DOCKER_HOST: process.env.DOCKER_HOST,
  };
  process.env.CONTAINER_HOST = "ssh://remote.example.test";
  process.env.CONTAINER_CONNECTION = "remote";
  process.env.DOCKER_HOST = "tcp://remote.example.test:2375";

  try {
    const result = await runPodmanCommand(
      executable,
      ["secret", "create", "test-secret", "-"],
      { timeout: 5_000, maxBuffer: 1_024, input: "secret-payload" },
    );
    assert.equal(
      result.stdout,
      "unset|unset|unset|--remote=false secret create test-secret -\nsecret-payload",
    );
    assert.equal(result.stderr, "");
  } finally {
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("App Studio image builds on the runtime and passes GHCR tokens only over stdin", async () => {
  const calls: Array<{ args: string[]; input?: string | Uint8Array }> = [];
  const archive = appStudioArchive({ Dockerfile: "FROM node:22-alpine\n", "package.json": "{}" });
  const runner: PodmanCommandRunner = async (_executable, args, options) => {
    calls.push({ args, ...(options.input !== undefined ? { input: options.input } : {}) });
    if (args[0] === "info") return { stdout: "true\n", stderr: "" };
    if (args[0] === "push") {
      const digestFile = args.find((argument) => argument.startsWith("--digestfile="))?.slice("--digestfile=".length);
      assert.ok(digestFile);
      await writeFile(digestFile, `sha256:${"a".repeat(64)}`);
    }
    return { stdout: "build output", stderr: "" };
  };
  const engine = new PodmanApplicationEngine("podman-test", runner);
  const result = await engine.buildAppStudioImage({
    projectId: "0123456789abcdef01234567",
    appId: "example.notes",
    version: "1.0.0",
    digest: "a".repeat(64),
    archive,
    localImage: `localhost/magent/example-notes:1.0.0-${"a".repeat(24)}`,
    registryImage: "ghcr.io/testowner/notes:1.0.0",
    registryCredential: JSON.stringify({ username: "testowner", token: "secret-token" }),
  });
  assert.equal(result.localImage, `localhost/magent/example-notes:1.0.0-${"a".repeat(24)}`);
  assert.equal(result.registryImage, "ghcr.io/testowner/notes:1.0.0");
  assert.equal(result.registryDigest, `sha256:${"a".repeat(64)}`);
  const build = calls.find(({ args }) => args[0] === "build");
  assert.ok(build);
  assert.equal(build.input instanceof Uint8Array, true);
  assert.deepEqual(build.args.filter((argument) => argument.startsWith("--tag=")), [
    `--tag=localhost/magent/example-notes:1.0.0-${"a".repeat(24)}`,
    "--tag=ghcr.io/testowner/notes:1.0.0",
  ]);
  const login = calls.find(({ args }) => args[0] === "login");
  assert.ok(login);
  assert.equal(login.args.includes("secret-token"), false);
  assert.equal(login.input, "secret-token");
  assert.ok(calls.some(({ args }) => args[0] === "push"));

  const localBuild = await engine.buildAppStudioImage({
    projectId: "0123456789abcdef01234567",
    appId: "example.notes",
    version: "1.0.0",
    digest: "a".repeat(64),
    archive,
    localImage: `localhost/magent/example-notes:1.0.0-${"a".repeat(24)}`,
  });
  assert.equal(localBuild.registryImage, null);
  assert.equal(localBuild.registryDigest, null);
  assert.equal(calls.filter(({ args }) => args[0] === "push").length, 1);
});

test("App Studio terminal runs a temporary source copy in a rootless, networkless container", async () => {
  const calls: Array<{ args: string[]; options: { timeout: number; maxBuffer: number } }> = [];
  const runner: PodmanCommandRunner = async (_executable, args, options) => {
    calls.push({ args, options });
    if (args[0] === "info") return { stdout: "true\n", stderr: "" };
    if (args[0] === "run") return { stdout: "tests passed\n__MAGENT_EXIT_CODE=0;OUTPUT_BYTES=12\n", stderr: "" };
    return { stdout: "", stderr: "" };
  };
  const engine = new PodmanApplicationEngine("podman-test", runner);
  const result = await engine.executeAppStudioCommand({
    projectId: "0123456789abcdef01234567",
    archive: appStudioArchive({
      Dockerfile: "FROM node:22-alpine\n",
      "package.json": "{}",
      "src/server.js": "console.log('test');",
    }),
    command: "node --test",
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.output, "tests passed");
  const run = calls.find(({ args }) => args[0] === "run");
  assert.ok(run);
  for (const requiredFlag of [
    "--network=none",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--pids-limit=64",
    "--memory=256m",
    "--cpus=1",
    "--tmpfs=/tmp:rw,noexec,nosuid,size=32m",
    "--tmpfs=/workspace:rw,noexec,nosuid,size=64m",
  ]) {
    assert.ok(run.args.includes(requiredFlag), `missing terminal isolation flag ${requiredFlag}`);
  }
  assert.equal(run.args.at(-1), "node --test");
  assert.equal(run.options.timeout, 60_000);
});

test("workflow code runs without network, host mounts, or elevated container privileges", async () => {
  const calls: Array<{ args: string[]; input?: string | Uint8Array; timeout: number }> = [];
  const runner: PodmanCommandRunner = async (_executable, args, options) => {
    calls.push({
      args,
      timeout: options.timeout,
      ...(options.input !== undefined ? { input: options.input } : {}),
    });
    if (args[0] === "info") return { stdout: "true\n", stderr: "" };
    if (args[0] === "run") {
      assert.equal(typeof options.input, "string");
      const payload = JSON.parse(String(options.input)) as { source: string };
      assert.equal(typeof payload.source, "string");
      const script = args.at(-1);
      assert.ok(script);
      return await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, ["-e", script]);
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
        child.on("error", reject);
        child.on("close", (code) => {
          if (code === 0) resolve({ stdout, stderr });
          else reject(new Error(stderr || `Sandbox runner exited with code ${code}.`));
        });
        child.stdin.end(options.input);
      });
    }
    return { stdout: "", stderr: "" };
  };
  const engine = new PodmanApplicationEngine("podman-test", runner);
  const result = await engine.executeWorkflowCode({
    executionId: "0123456789abcdef01234567",
    workflowId: "abcdefabcdefabcdefabcdef",
    nodeId: "code-1",
    source: "return { value: input.count + 1 };",
    context: { input: { count: 2 }, nodes: {} },
  });
  assert.deepEqual(result.output, { value: 3 });
  const run = calls.find(({ args }) => args[0] === "run");
  assert.ok(run);
  for (const requiredFlag of [
    "--timeout=15",
    "--network=none",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--pids-limit=32",
    "--memory=128m",
    "--cpus=1",
    "--userns=keep-id",
  ]) {
    assert.ok(run.args.includes(requiredFlag), `missing workflow sandbox flag ${requiredFlag}`);
  }
  assert.equal(run.args.some((argument) => argument.startsWith("--volume=")), false);
  assert.equal(run.timeout, 20_000);
  const hiddenRuntimeState = await engine.executeWorkflowCode({
    executionId: "0123456789abcdef01234567",
    workflowId: "abcdefabcdefabcdefabcdef",
    nodeId: "code-1",
    source: "return typeof process;",
    context: { input: {}, nodes: {} },
  });
  assert.equal(hiddenRuntimeState.output, "undefined");
});

test("Podman lifecycle uses rootless, isolated containers and preserves app storage", async () => {
  const calls: string[][] = [];
  const volumes = new Set<string>();
  const containers = new Set<string>();
  const generations = new Map<string, string>();
  const secrets = new Set<string>();
  const secretInputs = new Map<string, string>();
  let failNextRunFor: string | null = null;
  const runner: PodmanCommandRunner = async (_executable, args, options) => {
    calls.push(args);
    if (args[0] === "info") {
      return { stdout: "true\n", stderr: "" };
    }
    if (args[0] === "pull") {
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "volume" && args[1] === "exists") {
      if (!volumes.has(args[2] ?? "")) throw exitCodeError(1);
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "volume" && args[1] === "create") {
      volumes.add(args[2] ?? "");
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "volume" && args[1] === "rm") {
      volumes.delete(args[2] ?? "");
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "secret" && args[1] === "exists") {
      if (!secrets.has(args[2] ?? "")) throw exitCodeError(1);
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "secret" && args[1] === "create") {
      const name = args[2] ?? "";
      secrets.add(name);
      secretInputs.set(
        name,
        typeof options.input === "string" ? options.input : Buffer.from(options.input ?? []).toString("utf8"),
      );
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "secret" && args[1] === "rm") {
      secrets.delete(args[2] ?? "");
      secretInputs.delete(args[2] ?? "");
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "container" && args[1] === "exists") {
      if (!containers.has(args[2] ?? "")) throw exitCodeError(1);
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "run") {
      const image = args.at(-1) ?? "";
      if (failNextRunFor === image) {
        failNextRunFor = null;
        throw new Error("simulated image startup failure");
      }
      const name = args.find((argument) => argument.startsWith("--name="))?.slice(7);
      assert.ok(name);
      containers.add(name);
      generations.set(
        name,
        args.find((argument) => argument.startsWith("--label=magent.secret-generation="))
          ?.slice("--label=magent.secret-generation=".length) ?? "",
      );
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "inspect") {
      if (args[1]?.startsWith("--format={{index")) {
        return { stdout: `${generations.get(args.at(-1) ?? "")}|true\n`, stderr: "" };
      }
      return { stdout: "true\n", stderr: "" };
    }
    if (args[0] === "rm") {
      const name = args.at(-1) ?? "";
      containers.delete(name);
      generations.delete(name);
      return { stdout: "", stderr: "" };
    }
    return { stdout: "", stderr: "" };
  };

  const engine = new PodmanApplicationEngine("podman-test", runner);
  const appId = "demo-app";
  const volumeName = "magent-data-demo-app";
  const credentialId = "abcdefabcdefabcdefabcdef";
  const imageV1 = "registry.example.test/team/demo:v1";
  const imageV2 = "registry.example.test/team/demo:v2";

  const installCommand = command("app.install", {
    appId,
    image: imageV1,
    cpuCount: 1.5,
    memoryMb: 512,
    environment: { APP_MODE: "production" },
    credentialIds: [credentialId],
    credentials: [{ credentialId, value: "sensitive-value" }],
  });
  assert.deepEqual(await engine.execute(installCommand), { applicationId: appId, status: "active" });
  assert.ok(volumes.has(volumeName));
  assert.equal(
    secretInputs.get(`magent-${appId}-${installCommand.id}-${credentialId}`),
    "sensitive-value",
  );
  const launch = calls.find((args) => args[0] === "run");
  assert.ok(launch);
  for (const requiredFlag of [
    "--network=none",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--pids-limit=128",
    "--memory=512m",
    "--cpus=1.5",
    "--userns=keep-id",
    "--tmpfs=/tmp:rw,noexec,nosuid,size=64m",
    `--volume=${volumeName}:/data:U`,
    "--env=APP_MODE=production",
    `--secret=magent-${appId}-${installCommand.id}-${credentialId},target=/run/secrets/${credentialId}`,
  ]) {
    assert.ok(launch.includes(requiredFlag), `missing isolation flag ${requiredFlag}`);
  }
  assert.equal(launch.some((argument) => argument.includes(";")), false);
  assert.equal(launch.some((argument) => argument.includes("sensitive-value")), false);
  const launchCount = calls.filter((args) => args[0] === "run").length;
  assert.deepEqual(await engine.execute(installCommand), { applicationId: appId, status: "active" });
  assert.equal(calls.filter((args) => args[0] === "run").length, launchCount);

  assert.deepEqual(await engine.execute(command("app.stop", { appId })), {
    applicationId: appId,
    status: "stopped",
  });
  assert.deepEqual(await engine.execute(command("app.start", { appId })), {
    applicationId: appId,
    status: "active",
  });
  assert.deepEqual(await engine.execute(command("app.restart", { appId })), {
    applicationId: appId,
    status: "active",
  });

  const updateCommand = command("app.update", {
    appId,
    image: imageV2,
    previousImage: imageV1,
    cpuCount: 1,
    memoryMb: 512,
    environment: { APP_MODE: "production" },
    credentialIds: [credentialId],
    credentials: [{ credentialId, value: "sensitive-value" }],
    previousEnvironment: { APP_MODE: "production" },
    previousCredentialIds: [credentialId],
    previousCredentials: [{ credentialId, value: "sensitive-value" }],
    previousSecretGeneration: installCommand.id,
  });
  assert.deepEqual(await engine.execute(updateCommand), { applicationId: appId, status: "active" });
  assert.equal(secrets.has(`magent-${appId}-${installCommand.id}-${credentialId}`), false);
  const updateLaunchCount = calls.filter((args) => args[0] === "run").length;
  assert.deepEqual(await engine.execute(updateCommand), { applicationId: appId, status: "active" });
  assert.equal(calls.filter((args) => args[0] === "run").length, updateLaunchCount);
  failNextRunFor = imageV1;
  await assert.rejects(engine.execute(command("app.rollback", {
    appId,
    image: imageV1,
    previousImage: imageV2,
    cpuCount: 1,
    memoryMb: 512,
    environment: { APP_MODE: "production" },
    credentialIds: [credentialId],
    credentials: [{ credentialId, value: "sensitive-value" }],
    previousEnvironment: { APP_MODE: "production" },
    previousCredentialIds: [credentialId],
    previousCredentials: [{ credentialId, value: "sensitive-value" }],
    previousSecretGeneration: updateCommand.id,
  })), /previous image was restored/);
  assert.ok(containers.has("magent-app-demo-app"));
  assert.ok(volumes.has(volumeName));

  assert.deepEqual(await engine.execute(command("app.uninstall", {
    appId,
    credentialIds: [credentialId],
    previousSecretGeneration: updateCommand.id,
  })), {
    applicationId: appId,
    status: "removed",
  });
  assert.equal(containers.has("magent-app-demo-app"), false);
  assert.equal(volumes.has(volumeName), false);
  assert.equal(secrets.size, 0);
});

test("Podman refuses a rootful engine and invalid OCI references", async () => {
  const calls: string[][] = [];
  const engine = new PodmanApplicationEngine("podman-test", async (_executable, args) => {
    calls.push(args);
    return { stdout: "false\n", stderr: "" };
  });

  await assert.rejects(engine.execute(command("app.install", {
    appId: "demo-app",
    image: "registry.example.test/team/demo:v1",
    cpuCount: 1,
    memoryMb: 512,
  })), /require rootless Podman/);
  assert.deepEqual(calls, [["info", "--format={{.Host.Security.Rootless}}"]]);

  const rootlessEngine = new PodmanApplicationEngine("podman-test", async () => ({
    stdout: "true\n",
    stderr: "",
  }));
  await assert.rejects(rootlessEngine.execute(command("app.install", {
    appId: "demo-app;touch-pwned",
    image: "registry.example.test/team/demo:v1",
    cpuCount: 1,
    memoryMb: 512,
  })), /invalid format/);
});

test("Podman inspection reports only managed application status and resource usage", async () => {
  const engine = new PodmanApplicationEngine("podman-test", async (_executable, args) => {
    if (args[0] === "info") {
      return { stdout: "true\n", stderr: "" };
    }
    if (args[0] === "ps") {
      return {
        stdout: JSON.stringify([
          {
            Names: ["magent-app-demo-app"],
            State: "running",
            Labels: { "magent.app-id": "demo-app", "magent.managed": "true" },
          },
          {
            Names: ["unmanaged-container"],
            State: "running",
            Labels: { "magent.managed": "false" },
          },
        ]),
        stderr: "",
      };
    }
    if (args[0] === "stats") {
      return {
        stdout: JSON.stringify([{
          Name: "magent-app-demo-app",
          CPU: "12.5%",
          MemUsage: "128MiB / 512MiB",
        }]),
        stderr: "",
      };
    }
    throw new Error(`Unexpected Podman command: ${args.join(" ")}`);
  });

  assert.deepEqual(await engine.inspect(), [{
    applicationId: "demo-app",
    status: "running",
    cpuUsagePercent: 12.5,
    memoryUsageBytes: 128 * 1024 * 1024,
    memoryLimitBytes: 512 * 1024 * 1024,
  }]);
});

test("Podman returns bounded logs only from the named managed application container", async () => {
  const calls: string[][] = [];
  const engine = new PodmanApplicationEngine("podman-test", async (_executable, args) => {
    calls.push(args);
    if (args[0] === "info") return { stdout: "true\n", stderr: "" };
    if (args[0] === "container" && args[1] === "exists") {
      assert.equal(args[2], "magent-app-demo-app");
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "logs") {
      return { stdout: "x".repeat(70_000), stderr: "stderr-line\n" };
    }
    throw new Error(`Unexpected Podman command: ${args.join(" ")}`);
  });

  const result = await engine.logs("demo-app", 12);
  assert.equal(result.applicationId, "demo-app");
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.content) <= 65_536);
  assert.ok(result.content.endsWith("stderr-line\n"));
  assert.deepEqual(calls.at(-1), ["logs", "--tail=12", "magent-app-demo-app"]);
  await assert.rejects(engine.logs("demo-app", 501), /line limit is invalid/);
});

test("MAP containers use internal networks unless outbound access is explicitly granted", async () => {
  const calls: string[][] = [];
  const networks = new Set<string>();
  const secrets = new Set<string>();
  let fetchUrl = "";
  let fetchHeaders: Headers | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    fetchUrl = input instanceof Request ? input.url : input.toString();
    fetchHeaders = new Headers(init?.headers);
    if (fetchUrl === "http://127.0.0.1:49153/index.html") {
      return new Response("<main>frontend</main>", {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    }
    return Response.json({
      requestId: "7f5f80b3-26a6-4273-aa98-903708b8c5c6",
      output: { id: "created" },
    });
  };
  const runner: PodmanCommandRunner = async (_executable, args, options) => {
    calls.push(args);
    if (args[0] === "info") return { stdout: "true\n", stderr: "" };
    if (args[0] === "pull") return { stdout: "", stderr: "" };
    if (args[0] === "network" && args[1] === "exists") {
      if (!networks.has(args[2] ?? "")) throw exitCodeError(1);
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "network" && args[1] === "create") {
      networks.add(args.at(-1) ?? "");
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "secret" && args[1] === "exists") {
      if (!secrets.has(args[2] ?? "")) throw exitCodeError(1);
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "secret" && args[1] === "create") {
      secrets.add(args[2] ?? "");
      assert.match(String(options.input), /^[MN]{43}$/);
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "run") return { stdout: "", stderr: "" };
    if (args[0] === "inspect") return { stdout: "true\n", stderr: "" };
    if (args[0] === "container" && args[1] === "exists") {
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "port") return { stdout: "127.0.0.1:49153\n", stderr: "" };
    return { stdout: "", stderr: "" };
  };

  try {
    const engine = new PodmanApplicationEngine("podman-test", runner);
    const manifest = {
      manifestVersion: "1.0.0" as const,
      id: "com.example.tasks",
      name: "Tasks",
      version: "1.0.0",
      description: "Manage tasks",
      publisher: { id: "example", name: "Example" },
      runtime: { type: "container" as const, entrypoint: "server", port: 4000 },
      capabilities: [],
      actions: [],
      events: [],
      subscriptions: [],
      configuration: [],
      requestedPermissions: [],
    };
    const appId = manifest.id;
    await engine.execute(command("app.install", {
      appId,
      image: "registry.example.test/team/tasks:v1",
      cpuCount: 1,
      memoryMb: 512,
      manifest,
      mapToken: "M".repeat(43),
    }));
    const run = calls.find((args) => args[0] === "run");
    assert.ok(run);
    assert.ok(run.includes("--entrypoint=server"));
    assert.ok(run.includes("--network=magent-net-com.example.tasks"));
    assert.ok(run.includes("--publish=127.0.0.1::4000/tcp"));
    assert.ok(run.some((arg) => arg.includes("target=/run/secrets/magent-map-token")));
    assert.ok(run.includes("--env=MAGENT_MAP_URL=http://host.containers.internal:4317"));
    assert.equal(networks.has("magent-net-com.example.tasks"), true);
    const internalNetwork = calls.find((args) =>
      args[0] === "network" && args[1] === "create" && args.at(-1) === "magent-net-com.example.tasks",
    );
    assert.ok(internalNetwork?.includes("--internal"));

    const outboundManifest = {
      ...manifest,
      id: "com.example.mail",
      requestedPermissions: ["network.outbound"],
    };
    await engine.execute(command("app.install", {
      appId: outboundManifest.id,
      image: "registry.example.test/team/mail:v1",
      cpuCount: 1,
      memoryMb: 512,
      manifest: outboundManifest,
      grantedPermissions: ["network.outbound"],
      mapToken: "N".repeat(43),
    }));
    const outboundRun = calls.filter((args) => args[0] === "run").at(-1);
    assert.ok(outboundRun?.includes("--network=magent-net-com.example.mail-outbound"));
    const outboundNetwork = calls.find((args) =>
      args[0] === "network" && args[1] === "create" && args.at(-1) === "magent-net-com.example.mail-outbound",
    );
    assert.ok(outboundNetwork);
    assert.equal(outboundNetwork.includes("--internal"), false);

    const action = await engine.invokeMapAction(appId, 4000, "M".repeat(43), {
      requestId: "7f5f80b3-26a6-4273-aa98-903708b8c5c6",
      traceId: "90261d9c-9a7b-4e8f-a476-d526a333876b",
      workspaceId: "0123456789abcdef01234567",
      caller: { type: "APP", id: "com.example.source" },
      target: { appId, action: "createTask" },
      input: { title: "Test" },
    });
    assert.equal(fetchUrl, "http://127.0.0.1:49153/_magent/actions/createTask");
    assert.equal(fetchHeaders?.get("authorization"), `Bearer ${"M".repeat(43)}`);
    assert.deepEqual(action, {
      requestId: "7f5f80b3-26a6-4273-aa98-903708b8c5c6",
      success: true,
      output: { id: "created" },
    });

    const frontend = await engine.proxyApplicationRequest({
      appId,
      port: 4000,
      path: "/index.html",
      method: "GET",
    });
    assert.equal(fetchUrl, "http://127.0.0.1:49153/index.html");
    assert.equal(fetchHeaders?.get("authorization"), null);
    assert.deepEqual(frontend, {
      applicationId: appId,
      statusCode: 200,
      contentType: "text/html; charset=utf-8",
      cacheControl: "no-store",
      body: Buffer.from("<main>frontend</main>").toString("base64"),
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
