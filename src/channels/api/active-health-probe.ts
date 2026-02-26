import type { ApiHealthSubsystemStatus } from './types.js';

const DEFAULT_ACTIVE_PROBES_ENABLED = true;
const DEFAULT_ACTIVE_PROBE_TIMEOUT_MS = 2_000;
const DEFAULT_ACTIVE_PROBE_CACHE_TTL_MS = 10_000;

export interface ActiveHealthProbeConfig {
  enabled: boolean;
  timeoutMs: number;
  cacheTtlMs: number;
}

export interface ActiveHealthProbeResult {
  ok: boolean;
  checkedAt: string;
  latencyMs: number;
  cached: boolean;
  reason?: string;
}

export type ActiveHealthProbeTask = (signal: AbortSignal) => Promise<void>;

export function resolveActiveHealthProbeConfig(
  env: NodeJS.ProcessEnv,
): ActiveHealthProbeConfig {
  return {
    enabled: parseBooleanEnv(env.API_HEALTH_ACTIVE_PROBES, DEFAULT_ACTIVE_PROBES_ENABLED),
    timeoutMs: parsePositiveIntEnv(
      env.API_HEALTH_PROBE_TIMEOUT_MS,
      DEFAULT_ACTIVE_PROBE_TIMEOUT_MS,
    ),
    cacheTtlMs: parseNonNegativeIntEnv(
      env.API_HEALTH_PROBE_CACHE_TTL_MS,
      DEFAULT_ACTIVE_PROBE_CACHE_TTL_MS,
    ),
  };
}

export class CachedActiveHealthProbe {
  private cached: {
    expiresAtMs: number;
    result: Omit<ActiveHealthProbeResult, 'cached'>;
  } | null = null;
  private inFlight: Promise<Omit<ActiveHealthProbeResult, 'cached'>> | null = null;
  private timeoutMs: number;
  private cacheTtlMs: number;

  constructor(config: Pick<ActiveHealthProbeConfig, 'timeoutMs' | 'cacheTtlMs'>) {
    this.timeoutMs = config.timeoutMs;
    this.cacheTtlMs = config.cacheTtlMs;
  }

  async run(task: ActiveHealthProbeTask): Promise<ActiveHealthProbeResult> {
    const now = Date.now();

    if (this.cached && now < this.cached.expiresAtMs) {
      return { ...this.cached.result, cached: true };
    }

    if (this.inFlight) {
      const inFlightResult = await this.inFlight;
      return { ...inFlightResult, cached: true };
    }

    const probeExecution = this.execute(task);
    this.inFlight = probeExecution;

    try {
      const result = await probeExecution;
      if (this.cacheTtlMs > 0) {
        this.cached = {
          expiresAtMs: Date.now() + this.cacheTtlMs,
          result,
        };
      } else {
        this.cached = null;
      }
      return {
        ...result,
        cached: false,
      };
    } finally {
      this.inFlight = null;
    }
  }

  private async execute(task: ActiveHealthProbeTask): Promise<Omit<ActiveHealthProbeResult, 'cached'>> {
    const startedAt = Date.now();
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      const timeoutError = new Error(`timeout after ${this.timeoutMs}ms`);
      timeoutError.name = 'AbortError';
      controller.abort(timeoutError);
    }, this.timeoutMs);

    try {
      await task(controller.signal);
      return {
        ok: true,
        checkedAt: new Date().toISOString(),
        latencyMs: Math.max(0, Date.now() - startedAt),
      };
    } catch (error) {
      return {
        ok: false,
        reason: formatProbeFailureReason(error, timedOut, this.timeoutMs),
        checkedAt: new Date().toISOString(),
        latencyMs: Math.max(0, Date.now() - startedAt),
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function toActiveProbeMeta(
  probeConfig: ActiveHealthProbeConfig,
  probeResult?: ActiveHealthProbeResult,
): Record<string, unknown> {
  return {
    probeMode: probeConfig.enabled ? 'active' : 'passive',
    probeTimeoutMs: probeConfig.timeoutMs,
    probeCacheTtlMs: probeConfig.cacheTtlMs,
    ...(probeResult
      ? {
        probeCheckedAt: probeResult.checkedAt,
        probeLatencyMs: probeResult.latencyMs,
        probeCached: probeResult.cached,
      }
      : {}),
  };
}

export function toProbeFailureStatus(
  probeResult: ActiveHealthProbeResult,
  fallbackMessage: string,
  meta: Record<string, unknown>,
): ApiHealthSubsystemStatus {
  return {
    status: 'degraded',
    detail: probeResult.reason ?? fallbackMessage,
    meta,
  };
}

function formatProbeFailureReason(
  error: unknown,
  timedOut: boolean,
  timeoutMs: number,
): string {
  if (timedOut) {
    return `timeout after ${timeoutMs}ms`;
  }
  if (error instanceof Error) {
    const message = error.message.trim();
    if (message.length > 0) {
      return message;
    }
  }
  return String(error);
}

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function parsePositiveIntEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function parseNonNegativeIntEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}
