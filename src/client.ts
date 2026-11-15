import { agentCommandOperationSchema } from "@magent/runtime-protocol";
import type {
  AgentCommandOperation,
  ApplicationCommand,
  ApplicationCredential,
  ApplicationLifecycleResult,
  ApplicationLogsCommand,
  ApplicationLogsResult,
  LeasedCommand,
  MapActionCommand,
  MapEventCommand,
  MapCommandResult,
  RuntimeInspection,
} from "@magent/runtime-protocol";

export type {
  AgentCommandOperation,
  ApplicationCommand,
  ApplicationCredential,
  ApplicationLifecycleResult,
  ApplicationLogsCommand,
  ApplicationLogsResult,
  LeasedCommand,
  MapActionCommand,
  MapEventCommand,
  MapCommandResult,
  RuntimeInspection,
} from "@magent/runtime-protocol";

export interface EnrollmentResponse {
  runtimeId: string;
  token: string;
  heartbeatIntervalSeconds: number;
}

export class RuntimeAgentApiError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "RuntimeAgentApiError";
  }
}

function truncateErrorMessage(message: string, limit: number): string {
  const normalized = message.trim();
  if (normalized.length <= limit) return normalized;
  const separator = " ... ";
  const prefixLength = Math.floor((limit - separator.length) / 3);
  const suffixLength = limit - separator.length - prefixLength;
  return `${normalized.slice(0, prefixLength)}${separator}${normalized.slice(-suffixLength)}`;
}

export function normalizeApiBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("MAGENT_API_URL must be an absolute URL.");
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("MAGENT_API_URL must be an HTTP(S) URL without credentials, query, or fragment.");
  }
  const isLoopback = url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
  if (url.protocol !== "https:" && !isLoopback) {
    throw new Error("MAGENT_API_URL must use HTTPS except for loopback development.");
  }
  return url.toString().replace(/\/+$/, "");
}

export async function enrollRuntimeAgent(
  apiBaseUrl: string,
  registrationToken: string,
  agentVersion: string,
  fetchImpl: typeof fetch = fetch,
): Promise<EnrollmentResponse> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(registrationToken)) {
    throw new Error("Enrollment token has an invalid format.");
  }
  const response = await fetchImpl(
    `${normalizeApiBaseUrl(apiBaseUrl)}/runtimes/agent/enroll`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ registrationToken, agentVersion }),
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok) {
    throw new RuntimeAgentApiError("Runtime enrollment failed.", response.status);
  }
  const body: unknown = await response.json();
  if (!isObject(body) ||
      typeof body.runtimeId !== "string" ||
      typeof body.token !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(body.token) ||
      !Number.isInteger(body.heartbeatIntervalSeconds)) {
    throw new Error("Magent returned an invalid enrollment response.");
  }
  return {
    runtimeId: body.runtimeId,
    token: body.token,
    heartbeatIntervalSeconds: body.heartbeatIntervalSeconds as number,
  };
}

export class RuntimeAgentClient {
  private readonly apiBaseUrl: string;

  constructor(
    apiBaseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.apiBaseUrl = normalizeApiBaseUrl(apiBaseUrl);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
      throw new Error("Runtime token has an invalid format.");
    }
  }

  async heartbeat(): Promise<void> {
    const response = await this.request("/runtimes/agent/heartbeat", {
      method: "POST",
      body: JSON.stringify({ health: "healthy" }),
    });
    if (!response.ok) {
      throw new RuntimeAgentApiError("Runtime heartbeat failed.", response.status);
    }
  }

  async claimCommand(): Promise<LeasedCommand | null> {
    const response = await this.request("/runtimes/agent/commands/claim", {
      method: "POST",
    });
    if (response.status === 204) {
      return null;
    }
    if (!response.ok) {
      throw new RuntimeAgentApiError("Could not poll for runtime commands.", response.status);
    }
    const body: unknown = await response.json();
    if (!isObject(body) || !isObject(body.command)) {
      throw new Error("Magent returned an invalid command response.");
    }
    const command = body.command;
    if (
      typeof command.id !== "string" ||
      !isAgentCommandOperation(command.operation) ||
      typeof command.leaseToken !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(command.leaseToken)
    ) {
      throw new Error("Magent returned an unsupported runtime command.");
    }
    if (command.operation !== "runtime.inspect" && !isObject(command.payload)) {
      throw new Error("Magent returned an invalid application command.");
    }
    return {
      id: command.id,
      operation: command.operation,
      leaseToken: command.leaseToken,
      ...(isObject(command.payload) ? { payload: command.payload } : {}),
    };
  }

  async acknowledgeSuccess(
    command: LeasedCommand,
    result: RuntimeInspection | ApplicationLifecycleResult | ApplicationLogsResult | MapCommandResult,
  ): Promise<void> {
    const response = await this.request(
      `/runtimes/agent/commands/${encodeURIComponent(command.id)}/acknowledge`,
      {
        method: "POST",
        body: JSON.stringify({
          leaseToken: command.leaseToken,
          status: "succeeded",
          result,
        }),
      },
    );
    if (!response.ok) {
      throw new RuntimeAgentApiError("Could not acknowledge runtime command.", response.status);
    }
  }

  async acknowledgeFailure(command: LeasedCommand, error: string): Promise<void> {
    const response = await this.request(
      `/runtimes/agent/commands/${encodeURIComponent(command.id)}/acknowledge`,
      {
        method: "POST",
        body: JSON.stringify({
          leaseToken: command.leaseToken,
          status: "failed",
          error: truncateErrorMessage(error, 500),
        }),
      },
    );
    if (!response.ok) {
      throw new RuntimeAgentApiError("Could not acknowledge runtime command failure.", response.status);
    }
  }

  async getApplicationCredential(appId: string, credentialId: string): Promise<string> {
    if (
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(appId) ||
      !/^[a-f\d]{24}$/i.test(credentialId)
    ) {
      throw new Error("Application credential reference has an invalid format.");
    }
    const response = await this.request(
      `/credentials/agent/applications/${encodeURIComponent(appId)}/${encodeURIComponent(credentialId)}`,
      { method: "GET" },
    );
    if (!response.ok) {
      throw new RuntimeAgentApiError("Could not retrieve an application credential.", response.status);
    }
    const body: unknown = await response.json();
    if (!isObject(body) || typeof body.value !== "string" || body.value.length === 0) {
      throw new Error("Magent returned an invalid application credential.");
    }
    return body.value;
  }

  async getMapToken(appId: string): Promise<string | null> {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(appId)) {
      throw new Error("MAP application reference has an invalid format.");
    }
    const response = await this.request(
      `/credentials/agent/applications/${encodeURIComponent(appId)}/map-token`,
      { method: "GET" },
    );
    if (!response.ok) {
      throw new RuntimeAgentApiError("Could not retrieve the MAP application token.", response.status);
    }
    const body: unknown = await response.json();
    if (!isObject(body) || typeof body.enabled !== "boolean") {
      throw new Error("Magent returned an invalid MAP token response.");
    }
    if (!body.enabled) return null;
    if (typeof body.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(body.token)) {
      throw new Error("Magent returned an invalid MAP application token.");
    }
    return body.token;
  }

  async proxyMapRequest(path: string, token: string, body: string): Promise<Response> {
    if (
      path !== "/map/actions/invoke" &&
      path !== "/map/events"
    ) {
      throw new Error("MAP relay path is not allowed.");
    }
    if (!/^[A-Za-z0-9_-]{43}$/.test(token) || body.length > 1024 * 1024) {
      throw new Error("MAP relay request is invalid.");
    }
    return this.fetchImpl(`${this.apiBaseUrl}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body,
      signal: AbortSignal.timeout(35_000),
    });
  }

  private request(path: string, init: RequestInit): Promise<Response> {
    return this.fetchImpl(`${this.apiBaseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
      signal: init.signal ?? AbortSignal.timeout(15_000),
    });
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAgentCommandOperation(value: unknown): value is AgentCommandOperation {
  return agentCommandOperationSchema.safeParse(value).success;
}
