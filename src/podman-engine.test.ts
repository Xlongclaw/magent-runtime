import assert from "node:assert/strict";
import { test } from "node:test";
import type { ApplicationCommand } from "./client.js";
import { PodmanApplicationEngine, type PodmanCommandRunner } from "./podman-engine.js";

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

function exitCodeError(code: number): Error & { code: number } {
  return Object.assign(new Error(`Podman exited with ${code}`), { code });
}

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
      secretInputs.set(name, options.input ?? "");
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

test("MAP containers use an internal network, loopback-only ports, and relay actions with the app token", async () => {
  const calls: string[][] = [];
  const networks = new Set<string>();
  const secrets = new Set<string>();
  let fetchUrl = "";
  let fetchHeaders: Headers | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    fetchUrl = input instanceof Request ? input.url : input.toString();
    fetchHeaders = new Headers(init?.headers);
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
      assert.equal(options.input, "M".repeat(43));
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
  } finally {
    globalThis.fetch = originalFetch;
  }
});
