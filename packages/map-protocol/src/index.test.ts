import assert from "node:assert/strict";
import test from "node:test";
import { mapManifestSchema, validateJsonSchema } from "./index.js";

const manifest = {
  manifestVersion: "1.0.0",
  id: "com.example.tasks",
  name: "Tasks",
  version: "1.2.3",
  description: "Manage tasks",
  publisher: { id: "example", name: "Example" },
  runtime: { type: "container", entrypoint: "server", port: 4000 },
  capabilities: ["tasks"],
  actions: [{
    name: "createTask",
    description: "Create a task",
    inputSchema: {
      type: "object",
      properties: { title: { type: "string", minLength: 1 } },
      required: ["title"],
      additionalProperties: false,
    },
    outputSchema: { type: "object" },
    requiredPermissions: [],
  }],
  events: [],
  subscriptions: [],
  configuration: [],
  requestedPermissions: [],
};

test("MAP manifest validates identity, runtime, actions, and permission declarations", () => {
  assert.equal(mapManifestSchema.safeParse(manifest).success, true);
  assert.equal(mapManifestSchema.safeParse({ ...manifest, id: "bad id" }).success, false);
  assert.equal(mapManifestSchema.safeParse({
    ...manifest,
    actions: [{ ...manifest.actions[0], requiredPermissions: ["storage.write"] }],
  }).success, false);
});

test("MAP JSON schema validation bounds object inputs and rejects undeclared fields", () => {
  const schema = manifest.actions[0]!.inputSchema;
  assert.deepEqual(validateJsonSchema(schema, { title: "Complete Phase 3" }), []);
  assert.notDeepEqual(validateJsonSchema(schema, { title: "", unexpected: true }), []);
  assert.notDeepEqual(validateJsonSchema(schema, {}), []);
});
