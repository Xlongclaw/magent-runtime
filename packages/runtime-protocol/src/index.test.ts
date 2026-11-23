import assert from "node:assert/strict";
import test from "node:test";
import {
  agentCommandOperationSchema,
  applicationProxyPayloadSchema,
  applicationProxyResultSchema,
  applicationLogsResultSchema,
  runtimeInspectionResultSchema,
} from "./index.js";

test("runtime protocol validates the shared command operation set", () => {
  assert.equal(agentCommandOperationSchema.safeParse("runtime.inspect").success, true);
  assert.equal(agentCommandOperationSchema.safeParse("app.configure").success, true);
  assert.equal(agentCommandOperationSchema.safeParse("app.logs").success, true);
  assert.equal(agentCommandOperationSchema.safeParse("app.proxy").success, true);
  assert.equal(agentCommandOperationSchema.safeParse("host.exec").success, false);
  assert.equal(applicationLogsResultSchema.safeParse({
    applicationId: "demo-app",
    content: "ready\n",
    truncated: false,
  }).success, true);
  assert.equal(applicationLogsResultSchema.safeParse({
    applicationId: "demo-app",
    content: "x".repeat(65_537),
    truncated: false,
  }).success, false);
  const proxyRequest = {
    appId: "demo-app",
    port: 3000,
    path: "/index.html",
    method: "GET",
  };
  assert.equal(applicationProxyPayloadSchema.safeParse(proxyRequest).success, true);
  assert.equal(applicationProxyPayloadSchema.safeParse({
    ...proxyRequest,
    cookie: "im_session=opaque",
  }).success, true);
  assert.equal(applicationProxyPayloadSchema.safeParse({
    ...proxyRequest,
    path: "//external.example",
  }).success, false);
  assert.equal(applicationProxyPayloadSchema.safeParse({
    ...proxyRequest,
    path: "/%2e%2e/secret",
  }).success, false);
  assert.equal(applicationProxyResultSchema.safeParse({
    applicationId: "demo-app",
    statusCode: 200,
    contentType: "text/html",
    setCookies: ["im_session=opaque; Path=/; HttpOnly; SameSite=Lax"],
    body: Buffer.from("<main>ok</main>").toString("base64"),
  }).success, true);
});

test("runtime protocol validates inspection resource and application telemetry", () => {
  const inspection = {
    agentVersion: "1.0.0",
    platform: "linux",
    architecture: "x64",
    nodeVersion: "v22.0.0",
    uptimeSeconds: 30,
    resources: {
      cpuUsagePercent: null,
      memoryTotalBytes: 8192,
      memoryAvailableBytes: 4096,
      diskTotalBytes: 16384,
      diskAvailableBytes: 8192,
    },
    applications: [{
      applicationId: "demo-app",
      status: "running",
      cpuUsagePercent: 12.5,
      memoryUsageBytes: 128,
      memoryLimitBytes: 512,
    }],
    memory: {
      rssBytes: 1024,
      heapUsedBytes: 512,
      heapTotalBytes: 768,
      externalBytes: 64,
    },
  };
  assert.equal(runtimeInspectionResultSchema.safeParse(inspection).success, true);
  assert.equal(runtimeInspectionResultSchema.safeParse({
    ...inspection,
    resources: { ...inspection.resources, cpuUsagePercent: 101 },
  }).success, false);
});
