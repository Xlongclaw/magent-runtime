import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { RuntimeAgent } from "./agent.js";
import { enrollRuntimeAgent, normalizeApiBaseUrl, RuntimeAgentClient } from "./client.js";

const VERSION = "0.1.0";
const DEFAULT_TOKEN_FILE = "/var/lib/magent-agent/agent-token";

async function main(): Promise<void> {
  const apiBaseUrl = normalizeApiBaseUrl(process.env.MAGENT_API_URL ?? "");
  const tokenFile = resolve(process.env.MAGENT_AGENT_TOKEN_FILE ?? DEFAULT_TOKEN_FILE);
  const command = process.argv[2] ?? "run";

  if (command === "enroll") {
    const registrationToken = process.env.MAGENT_ENROLLMENT_TOKEN;
    if (!registrationToken) {
      throw new Error("MAGENT_ENROLLMENT_TOKEN is required for enrollment.");
    }
    const enrollment = await enrollRuntimeAgent(apiBaseUrl, registrationToken, VERSION);
    await storeToken(tokenFile, enrollment.token);
    console.info(`Runtime Agent enrolled as ${enrollment.runtimeId}.`);
    return;
  }

  if (command !== "run") {
    throw new Error("Usage: magent-agent [enroll|run].");
  }

  const token = await readToken(tokenFile);
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  const agent = new RuntimeAgent({
    client: new RuntimeAgentClient(apiBaseUrl, token),
    version: VERSION,
    onError: (error) => console.error(`Runtime Agent request failed: ${error.message}`),
  });
  console.info("Runtime Agent started.");
  await agent.start(controller.signal);
  console.info("Runtime Agent stopped.");
}

async function storeToken(path: string, token: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    await file.writeFile(`${token}\n`, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
}

async function readToken(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const fileStat = await file.stat();
    if (!fileStat.isFile()) {
      throw new Error("Runtime token path must be a regular file.");
    }
    if (
      process.platform !== "win32" &&
      ((fileStat.mode & 0o077) !== 0 ||
        (typeof process.getuid === "function" && fileStat.uid !== process.getuid()))
    ) {
      throw new Error("Runtime token file must be owned by the agent and restricted to its owner.");
    }
    const token = (await file.readFile("utf8")).trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
      throw new Error("Runtime token file contains an invalid token.");
    }
    return token;
  } finally {
    await file.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Runtime Agent failed.");
  process.exitCode = 1;
});
