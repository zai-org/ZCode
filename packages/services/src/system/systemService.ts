import { homedir } from "node:os";
import { Socket } from "node:net";
import type {
  IntegratedTerminalShellOption,
  IntranetProbeRequest,
  IntranetProbeResult,
  IntranetProbeServiceResponse,
  IntranetProbeServiceTarget,
  IntranetProbeServiceTargetResult,
  IntranetProbeTarget,
  IntranetProbeTcpTarget,
  IntranetProbeTcpTargetResult,
  SystemInfo,
} from "@zcode/shared";
import type { WindowsGitBashDiscoveryOptions } from "@zcode/shared/node";
import type { ISystemService } from "./system.js";
import { listIntegratedTerminalShellOptions } from "./integratedTerminalShells.js";

const DEFAULT_PROBE_TIMEOUT_MS = 800;
const DEFAULT_PROBE_ATTEMPTS = 2;
const MAX_PROBE_ATTEMPTS = 3;
const DEFAULT_PROBE_PORT = 22;

interface NormalizedProbeTarget {
  kind: "tcp";
  targetId: string;
  host: string;
  port: number;
  timeoutMs: number;
}

interface NormalizedServiceProbeTarget {
  kind: "service";
  targetId: string;
  url: string;
  expectedMarker?: string;
  token?: string;
  timeoutMs: number;
}

type NormalizedTarget = NormalizedProbeTarget | NormalizedServiceProbeTarget;

interface TcpProbeParams {
  host: string;
  port: number;
  timeoutMs: number;
}

interface CreateSystemServiceOptions {
  env?: NodeJS.ProcessEnv;
  gitBashDiscovery?: Omit<WindowsGitBashDiscoveryOptions, "env" | "platform" | "isExecutable">;
  isExecutable?: WindowsGitBashDiscoveryOptions["isExecutable"];
  platform?: NodeJS.Platform;
  tcpProbe?: (params: TcpProbeParams) => Promise<number>;
  serviceProbe?: (params: ServiceProbeParams) => Promise<ServiceProbeResult>;
  now?: () => number;
}

interface ServiceProbeParams {
  url: string;
  timeoutMs: number;
  token?: string;
}

interface ServiceProbeResult {
  latencyMs: number;
  marker?: string;
}

function normalizeProbeAttempts(attempts: number | undefined): number {
  if (typeof attempts !== "number" || !Number.isFinite(attempts)) {
    return DEFAULT_PROBE_ATTEMPTS;
  }

  return Math.min(MAX_PROBE_ATTEMPTS, Math.max(1, Math.floor(attempts)));
}

function normalizeRequiredSuccessCount(
  requiredSuccessCount: number | undefined,
  totalTargets: number,
): number {
  if (totalTargets <= 0) {
    return 1;
  }

  if (typeof requiredSuccessCount !== "number" || !Number.isFinite(requiredSuccessCount)) {
    return 1;
  }

  return Math.min(totalTargets, Math.max(1, Math.floor(requiredSuccessCount)));
}

function normalizeProbeTimeout(timeoutMs: number | undefined): number {
  return typeof timeoutMs === "number" && Number.isFinite(timeoutMs)
    ? Math.min(10_000, Math.max(100, Math.floor(timeoutMs)))
    : DEFAULT_PROBE_TIMEOUT_MS;
}

function normalizeTcpTarget(target: IntranetProbeTcpTarget): NormalizedProbeTarget | null {
  const host = target.host.trim();
  if (host.length === 0) {
    return null;
  }

  const resolvedPort =
    typeof target.port === "number" &&
    Number.isInteger(target.port) &&
    target.port >= 1 &&
    target.port <= 65535
      ? target.port
      : DEFAULT_PROBE_PORT;

  return {
    kind: "tcp",
    targetId: target.id?.trim() || `${host}:${resolvedPort}`,
    host,
    port: resolvedPort,
    timeoutMs: normalizeProbeTimeout(target.timeoutMs),
  };
}

function normalizeServiceTarget(
  target: IntranetProbeServiceTarget,
): NormalizedServiceProbeTarget | null {
  const urlText = target.url.trim();
  if (urlText.length === 0) {
    return null;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(urlText);
  } catch {
    return null;
  }

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    return null;
  }

  const expectedMarker = target.expectedMarker?.trim();
  const token = target.token?.trim();

  return {
    kind: "service",
    targetId: target.id?.trim() || parsedUrl.toString(),
    url: parsedUrl.toString(),
    expectedMarker: expectedMarker && expectedMarker.length > 0 ? expectedMarker : undefined,
    token: token && token.length > 0 ? token : undefined,
    timeoutMs: normalizeProbeTimeout(target.timeoutMs),
  };
}

function normalizeProbeTarget(target: IntranetProbeTarget): NormalizedTarget | null {
  if (target.kind === "service") {
    return normalizeServiceTarget(target);
  }

  return normalizeTcpTarget(target);
}

async function runProbeWithRetry(
  target: NormalizedProbeTarget,
  attempts: number,
  tcpProbe: (params: TcpProbeParams) => Promise<number>,
): Promise<IntranetProbeTcpTargetResult> {
  let lastError = "";

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const latencyMs = await tcpProbe({
        host: target.host,
        port: target.port,
        timeoutMs: target.timeoutMs,
      });
      return {
        targetId: target.targetId,
        kind: "tcp",
        host: target.host,
        port: target.port,
        reachable: true,
        attemptCount: attempt,
        latencyMs,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    targetId: target.targetId,
    kind: "tcp",
    host: target.host,
    port: target.port,
    reachable: false,
    attemptCount: attempts,
    latencyMs: null,
    error: lastError || "probe failed",
  };
}

function parseProbeServiceResponse(payload: unknown): IntranetProbeServiceResponse {
  if (!payload || typeof payload !== "object") {
    throw new Error("invalid service response");
  }

  const response = payload as IntranetProbeServiceResponse;
  if (typeof response.ok !== "boolean") {
    throw new Error("invalid service response: missing ok");
  }

  if (
    "marker" in response &&
    response.marker !== undefined &&
    typeof response.marker !== "string"
  ) {
    throw new Error("invalid service response: marker must be string");
  }

  return response;
}

async function probeServiceEndpoint(params: ServiceProbeParams): Promise<ServiceProbeResult> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), params.timeoutMs);

  try {
    const response = await fetch(params.url, {
      method: "GET",
      headers: params.token ? { "x-zcode-intranet-token": params.token } : undefined,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const responseBody = parseProbeServiceResponse(await response.json());
    if (!responseBody.ok) {
      throw new Error("service returned ok=false");
    }

    return {
      latencyMs: Math.max(0, Date.now() - startedAt),
      marker: responseBody.marker,
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`timeout(${params.timeoutMs}ms)`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function runServiceProbeWithRetry(
  target: NormalizedServiceProbeTarget,
  attempts: number,
  serviceProbe: (params: ServiceProbeParams) => Promise<ServiceProbeResult>,
): Promise<IntranetProbeServiceTargetResult> {
  let lastError = "";

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await serviceProbe({
        url: target.url,
        timeoutMs: target.timeoutMs,
        token: target.token,
      });

      if (target.expectedMarker && result.marker !== target.expectedMarker) {
        throw new Error(
          `marker mismatch(expected=${target.expectedMarker}, actual=${result.marker ?? "<empty>"})`,
        );
      }

      return {
        targetId: target.targetId,
        kind: "service",
        url: target.url,
        reachable: true,
        attemptCount: attempt,
        latencyMs: result.latencyMs,
        marker: result.marker,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    targetId: target.targetId,
    kind: "service",
    url: target.url,
    reachable: false,
    attemptCount: attempts,
    latencyMs: null,
    error: lastError || "probe failed",
  };
}

function resolveProbeStrategy(targets: NormalizedTarget[]): IntranetProbeResult["strategy"] {
  if (targets.every((target) => target.kind === "tcp")) {
    return "tcp-connect";
  }
  if (targets.every((target) => target.kind === "service")) {
    return "service-http";
  }
  return "mixed";
}

function probeTcpPort(params: TcpProbeParams): Promise<number> {
  const { host, port, timeoutMs } = params;
  const startedAt = Date.now();

  return new Promise<number>((resolve, reject) => {
    const socket = new Socket();
    let settled = false;

    const finalize = (handler: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      handler();
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      const latencyMs = Math.max(0, Date.now() - startedAt);
      finalize(() => resolve(latencyMs));
    });
    socket.once("timeout", () => {
      finalize(() => reject(new Error(`timeout(${timeoutMs}ms)`)));
    });
    socket.once("error", (error) => {
      finalize(() => reject(error));
    });
    socket.connect(port, host);
  });
}

export function createSystemService(options: CreateSystemServiceOptions = {}): ISystemService {
  const tcpProbe = options.tcpProbe ?? probeTcpPort;
  const serviceProbe = options.serviceProbe ?? probeServiceEndpoint;
  const now = options.now ?? Date.now;
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;

  return {
    async info(): Promise<SystemInfo> {
      return { homedir: homedir(), platform: process.platform };
    },

    async listIntegratedTerminalShells(): Promise<IntegratedTerminalShellOption[]> {
      return listIntegratedTerminalShellOptions({
        env,
        gitBashDiscovery: options.gitBashDiscovery,
        isExecutable: options.isExecutable,
        platform,
      });
    },

    async probeIntranet(request: IntranetProbeRequest): Promise<IntranetProbeResult> {
      const normalizedTargets = request.targets
        .map(normalizeProbeTarget)
        .filter((target): target is NormalizedTarget => target !== null);
      const attempts = normalizeProbeAttempts(request.attempts);
      const requiredSuccessCount = normalizeRequiredSuccessCount(
        request.requiredSuccessCount,
        normalizedTargets.length,
      );

      const results = await Promise.all(
        normalizedTargets.map((target) => {
          if (target.kind === "service") {
            return runServiceProbeWithRetry(target, attempts, serviceProbe);
          }
          return runProbeWithRetry(target, attempts, tcpProbe);
        }),
      );
      const reachedTargetCount = results.filter((result) => result.reachable).length;

      return {
        isIntranet: normalizedTargets.length > 0 && reachedTargetCount >= requiredSuccessCount,
        reachedTargetCount,
        requiredSuccessCount,
        totalTargets: normalizedTargets.length,
        checkedAt: now(),
        strategy: resolveProbeStrategy(normalizedTargets),
        results,
      };
    },
  };
}
