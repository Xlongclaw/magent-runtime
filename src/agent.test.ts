import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:net";
import { test } from "node:test";
import { RuntimeAgent } from "./agent.js";
import { RuntimeAgentClient, normalizeApiBaseUrl } from "./client.js";

test("Runtime Agent heartbeats, polls an authorized inspection command, and acknowledges it", async () => {
  const requests: Array<{ url: string; method: string; authorization: string | null; body?: unknown }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
    requests.push({
      url,
      method: init?.method ?? "GET",
      authorization: new Headers(init?.headers).get("authorization"),
      ...(body !== undefined ? { body } : {}),
    });

    if (url.endsWith("/runtimes/agent/heartbeat")) {
      return new Response(null, { status: 204 });
    }
    if (url.endsWith("/runtimes/agent/commands/claim")) {
      return Response.json({
        command: {
          id: "0123456789abcdef01234567",
          operation: "runtime.inspect",
          leaseToken: "L".repeat(43),
        },
      });
    }
    if (url.endsWith("/acknowledge")) {
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 404 });
  };

  const client = new RuntimeAgentClient(
    "https://magent.example.test/",
    "T".repeat(43),
    fetchImpl,
  );
  const agent = new RuntimeAgent({
    client,
    version: "test-agent",
    applicationEngine: {
      execute: async () => ({ applicationId: "unused", status: "active" }),
      inspect: async () => [],
    },
  });

  assert.equal(await agent.runOnce(60_000), true);
  assert.equal(requests.length, 3);
  assert.ok(requests.every((request) => request.authorization === `Bearer ${"T".repeat(43)}`));
  assert.equal(requests[0]?.url, "https://magent.example.test/runtimes/agent/heartbeat");
  assert.equal(requests[1]?.url, "https://magent.example.test/runtimes/agent/commands/claim");
  assert.equal(requests[2]?.url, "https://magent.example.test/runtimes/agent/commands/0123456789abcdef01234567/acknowledge");
  const acknowledgement = requests[2]?.body as {
    leaseToken: string;
    status: string;
    result: {
      agentVersion: string;
      memory: { rssBytes: number };
      resources: { diskTotalBytes: number };
      applications: unknown[];
    };
  };
  assert.equal(acknowledgement.status, "succeeded");
  assert.equal(acknowledgement.leaseToken, "L".repeat(43));
  assert.equal(acknowledgement.result.agentVersion, "test-agent");
  assert.ok(acknowledgement.result.memory.rssBytes > 0);
  assert.ok(acknowledgement.result.resources.diskTotalBytes > 0);
  assert.deepEqual(acknowledgement.result.applications, []);
});

test("Runtime Agent delegates app lifecycle commands to its container engine and acknowledges outcome", async () => {
  const requests: Array<{ url: string; body?: Record<string, unknown> }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    const body = typeof init?.body === "string"
      ? JSON.parse(init.body) as Record<string, unknown>
      : undefined;
    requests.push({ url, ...(body ? { body } : {}) });
    if (url.endsWith("/runtimes/agent/heartbeat")) {
      return new Response(null, { status: 204 });
    }
    if (url.endsWith("/runtimes/agent/commands/claim")) {
      return Response.json({
        command: {
          id: "0123456789abcdef01234567",
          operation: "app.install",
          leaseToken: "L".repeat(43),
          payload: {
            appId: "com.example.test-app",
            image: "registry.example.test/team/app:v1",
            cpuCount: 1,
            memoryMb: 512,
            environment: { MODE: "test" },
            credentialIds: ["abcdefabcdefabcdefabcdef"],
          },
        },
      });
    }
    if (url.endsWith("/credentials/agent/applications/com.example.test-app/abcdefabcdefabcdefabcdef")) {
      return Response.json({ name: "test-secret", value: "do-not-log-this" });
    }
    if (url.endsWith("/credentials/agent/applications/com.example.test-app/map-token")) {
      return Response.json({ enabled: false });
    }
    return new Response(null, { status: 204 });
  };
  const executed: unknown[] = [];
  const client = new RuntimeAgentClient(
    "https://magent.example.test",
    "T".repeat(43),
    fetchImpl,
  );
  const agent = new RuntimeAgent({
    client,
    version: "test-agent",
    applicationEngine: {
      execute: async (command) => {
        executed.push(command);
        return { applicationId: command.payload.appId, status: "active" };
      },
    },
  });

  assert.equal(await agent.runOnce(60_000), true);
  assert.equal(executed.length, 1);
  assert.deepEqual(executed[0], {
    id: "0123456789abcdef01234567",
    leaseToken: "L".repeat(43),
    operation: "app.install",
    payload: {
      appId: "com.example.test-app",
      image: "registry.example.test/team/app:v1",
      cpuCount: 1,
      memoryMb: 512,
      environment: { MODE: "test" },
      credentialIds: ["abcdefabcdefabcdefabcdef"],
      credentials: [{
        credentialId: "abcdefabcdefabcdefabcdef",
        value: "do-not-log-this",
      }],
    },
  });
  assert.equal(requests[4]?.body?.status, "succeeded");
  assert.deepEqual(requests[4]?.body?.result, {
    applicationId: "com.example.test-app",
    status: "active",
  });
  assert.equal(requests[2]?.url.endsWith("/credentials/agent/applications/com.example.test-app/map-token"), true);
  assert.equal(requests[3]?.url.endsWith("/credentials/agent/applications/com.example.test-app/abcdefabcdefabcdefabcdef"), true);
  assert.equal(JSON.stringify(requests).includes("do-not-log-this"), false);
});

test("Runtime Agent collects application logs and acknowledges bounded output", async () => {
  const requests: Array<{ url: string; body?: Record<string, unknown> }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    const body = typeof init?.body === "string"
      ? JSON.parse(init.body) as Record<string, unknown>
      : undefined;
    requests.push({ url, ...(body ? { body } : {}) });
    if (url.endsWith("/runtimes/agent/heartbeat")) return new Response(null, { status: 204 });
    if (url.endsWith("/runtimes/agent/commands/claim")) {
      return Response.json({
        command: {
          id: "0123456789abcdef01234567",
          operation: "app.logs",
          leaseToken: "L".repeat(43),
          payload: { appId: "test-app", tail: 25 },
        },
      });
    }
    return new Response(null, { status: 204 });
  };
  const client = new RuntimeAgentClient("https://magent.example.test", "T".repeat(43), fetchImpl);
  const agent = new RuntimeAgent({
    client,
    version: "test-agent",
    applicationEngine: {
      execute: async () => ({ applicationId: "unused", status: "active" }),
      logs: async (appId, tail) => {
        assert.equal(appId, "test-app");
        assert.equal(tail, 25);
        return { applicationId: appId, content: "ready\n", truncated: false };
      },
    },
  });

  assert.equal(await agent.runOnce(60_000), true);
  assert.equal(requests[2]?.body?.status, "succeeded");
  assert.deepEqual(requests[2]?.body?.result, {
    applicationId: "test-app",
    content: "ready\n",
    truncated: false,
  });
});

test("Runtime Agent relays MAP requests through the outbound API connection", async () => {
  const portProbe = createServer();
  portProbe.listen(0, "127.0.0.1");
  await once(portProbe, "listening");
  const address = portProbe.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate relay test port.");
  const mapProxyPort = address.port;
  await new Promise<void>((resolve, reject) =>
    portProbe.close((error) => error ? reject(error) : resolve()),
  );

  let upstreamAuthorization: string | null = null;
  let upstreamUrl = "";
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url.endsWith("/runtimes/agent/heartbeat")) return new Response(null, { status: 204 });
    if (url.endsWith("/runtimes/agent/commands/claim")) return new Response(null, { status: 204 });
    upstreamUrl = url;
    upstreamAuthorization = new Headers(init?.headers).get("authorization");
    return Response.json({ id: "event-1", deliveries: 1 });
  };
  const controller = new AbortController();
  const agent = new RuntimeAgent({
    client: new RuntimeAgentClient(
      "https://magent.example.test",
      "R".repeat(43),
      fetchImpl,
    ),
    version: "test-agent",
    mapProxyPort,
    pollIntervalMs: 20,
  });
  const running = agent.start(controller.signal);
  try {
    let response: Response | undefined;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        response = await fetch(`http://127.0.0.1:${mapProxyPort}/map/events`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${"A".repeat(43)}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ name: "task.created", data: { id: "task-1" } }),
        });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    assert.ok(response);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { id: "event-1", deliveries: 1 });
    assert.equal(upstreamUrl, "https://magent.example.test/map/events");
    assert.equal(upstreamAuthorization, `Bearer ${"A".repeat(43)}`);
  } finally {
    controller.abort();
    await running;
  }
});

test("Runtime Agent URL requires HTTPS outside loopback development", () => {
  assert.equal(normalizeApiBaseUrl("http://127.0.0.1:3000/"), "http://127.0.0.1:3000");
  assert.equal(normalizeApiBaseUrl("https://magent.example.test/"), "https://magent.example.test");
  assert.throws(() => normalizeApiBaseUrl("http://magent.example.test"));
  assert.throws(() => normalizeApiBaseUrl("https://user:pass@magent.example.test"));
});
