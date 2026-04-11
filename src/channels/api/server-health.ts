import {
  API_HEALTH_SUBSYSTEMS,
  type ApiContinuityWatchdogCheck,
  type ApiHealthResponse,
  type ApiHealthSubsystem,
  type ApiHealthSubsystemStatus,
  type ApiServerHealthChecks,
} from './types.js';
import { toErrorMessage } from '../../shared/utils/errors.js';

function mapSubsystemToContinuityCheck(
  source: ApiHealthSubsystemStatus,
  sourceSubsystem: ApiHealthSubsystem,
  degradedFallbackDetail: string,
): ApiHealthSubsystemStatus {
  const detail = source.detail?.trim();
  return {
    status: source.status === 'healthy' ? 'healthy' : 'degraded',
    ...(source.status === 'degraded' ? { detail: detail || degradedFallbackDetail } : {}),
    meta: {
      ...(source.meta ?? {}),
      sourceSubsystem,
    },
  };
}

function evaluateGatewayLinkHealth(
  subsystems: ApiHealthResponse['subsystems'],
): ApiHealthSubsystemStatus {
  const llmHealthy = subsystems.llm.status === 'healthy';
  const embeddingsHealthy = subsystems.embeddings.status === 'healthy';
  if (llmHealthy || embeddingsHealthy) {
    return {
      status: 'healthy',
      meta: {
        sourceSubsystems: ['llm', 'embeddings'],
        llmStatus: subsystems.llm.status,
        embeddingsStatus: subsystems.embeddings.status,
      },
    };
  }

  const llmDetail = subsystems.llm.detail?.trim();
  const embeddingsDetail = subsystems.embeddings.detail?.trim();
  const detailParts = [llmDetail, embeddingsDetail].filter((value): value is string => Boolean(value));
  return {
    status: 'degraded',
    detail: detailParts.join(' | ') || 'Gateway-linked LLM and embeddings checks are degraded',
    meta: {
      sourceSubsystems: ['llm', 'embeddings'],
      llmStatus: subsystems.llm.status,
      embeddingsStatus: subsystems.embeddings.status,
    },
  };
}

function evaluateSchedulerHealthcheckHealth(
  schedulerSubsystem: ApiHealthSubsystemStatus,
  checkedAtMs: number,
  options: {
    lastSchedulerHealthcheckAtMs: number | null;
    schedulerHealthcheckStaleAfterMs: number;
  },
): ApiHealthSubsystemStatus {
  const schedulerDetail = schedulerSubsystem.detail?.trim();
  const healthcheckObservedAtMs = options.lastSchedulerHealthcheckAtMs;
  const uptimeMs = Math.max(0, Math.floor(process.uptime() * 1_000));
  const healthcheckAgeMs = healthcheckObservedAtMs === null
    ? null
    : Math.max(0, checkedAtMs - healthcheckObservedAtMs);

  const baseMeta: Record<string, unknown> = {
    ...(schedulerSubsystem.meta ?? {}),
    sourceSubsystem: 'scheduler',
    schedulerHealthcheckStaleAfterMs: options.schedulerHealthcheckStaleAfterMs,
    ...(healthcheckObservedAtMs === null
      ? { healthcheckObserved: false }
      : {
        healthcheckObserved: true,
        schedulerHealthcheckAt: new Date(healthcheckObservedAtMs).toISOString(),
        schedulerHealthcheckAgeMs: healthcheckAgeMs,
      }),
  };

  if (schedulerSubsystem.status !== 'healthy') {
    return {
      status: 'degraded',
      detail: schedulerDetail || 'Scheduler subsystem is degraded',
      meta: baseMeta,
    };
  }

  if (healthcheckObservedAtMs === null) {
    if (uptimeMs <= options.schedulerHealthcheckStaleAfterMs) {
      return {
        status: 'healthy',
        meta: {
          ...baseMeta,
          schedulerHealthcheckGraceMsRemaining: Math.max(
            0,
            options.schedulerHealthcheckStaleAfterMs - uptimeMs,
          ),
        },
      };
    }
    return {
      status: 'degraded',
      detail: `No scheduler healthcheck observed within ${options.schedulerHealthcheckStaleAfterMs}ms`,
      meta: baseMeta,
    };
  }

  if (healthcheckAgeMs !== null && healthcheckAgeMs > options.schedulerHealthcheckStaleAfterMs) {
    return {
      status: 'degraded',
      detail: `Scheduler healthcheck stale: ${healthcheckAgeMs}ms since last pulse (limit ${options.schedulerHealthcheckStaleAfterMs}ms)`,
      meta: baseMeta,
    };
  }

  return {
    status: 'healthy',
    meta: baseMeta,
  };
}

async function evaluateSubsystemHealth(
  subsystem: ApiHealthSubsystem,
  healthChecks: ApiServerHealthChecks,
): Promise<ApiHealthSubsystemStatus> {
  const startedAt = Date.now();
  const check = healthChecks[subsystem];
  if (!check) {
    return normalizeSubsystemHealth({
      status: 'degraded',
      detail: 'Health check not configured',
    }, 0);
  }

  try {
    const result = await Promise.resolve(check());
    return normalizeSubsystemHealth(result, Date.now() - startedAt);
  } catch (error) {
    return normalizeSubsystemHealth({
      status: 'degraded',
      detail: toErrorMessage(error),
    }, Date.now() - startedAt);
  }
}

function normalizeSubsystemHealth(
  result: ApiHealthSubsystemStatus,
  checkLatencyMs: number,
): ApiHealthSubsystemStatus {
  const detail = result.detail?.trim();
  return {
    status: result.status === 'healthy' ? 'healthy' : 'degraded',
    ...(detail ? { detail } : {}),
    meta: {
      ...(result.meta ?? {}),
      checkLatencyMs: Math.max(0, Math.round(checkLatencyMs)),
    },
  };
}

function evaluateContinuityWatchdogHealth(
  subsystems: ApiHealthResponse['subsystems'],
  checkedAtMs: number,
  options: {
    lastSchedulerHealthcheckAtMs: number | null;
    schedulerHealthcheckStaleAfterMs: number;
  },
): ApiHealthResponse['continuity'] {
  const checks: Record<ApiContinuityWatchdogCheck, ApiHealthSubsystemStatus> = {
    database: mapSubsystemToContinuityCheck(
      subsystems.memory,
      'memory',
      'Database-backed memory subsystem is degraded',
    ),
    gatewayLink: evaluateGatewayLinkHealth(subsystems),
    schedulerHealthcheck: evaluateSchedulerHealthcheckHealth(
      subsystems.scheduler,
      checkedAtMs,
      options,
    ),
  };

  const status: ApiHealthResponse['continuity']['status'] = Object.values(checks).every(
    (check) => check.status === 'healthy',
  )
    ? 'healthy'
    : 'degraded';

  return {
    status,
    checks,
  };
}

export async function buildApiHealthResponse(options: {
  healthChecks: ApiServerHealthChecks;
  lastSchedulerHealthcheckAtMs: number | null;
  schedulerHealthcheckStaleAfterMs: number;
}): Promise<{ statusCode: number; body: ApiHealthResponse }> {
  const subsystemEntries = await Promise.all(
    API_HEALTH_SUBSYSTEMS.map(async (subsystem) => {
      const status = await evaluateSubsystemHealth(subsystem, options.healthChecks);
      return [subsystem, status] as const;
    }),
  );
  const checkedAtMs = Date.now();
  const subsystems = Object.fromEntries(subsystemEntries) as ApiHealthResponse['subsystems'];
  const subsystemStatus: ApiHealthResponse['status'] = API_HEALTH_SUBSYSTEMS.every(
    (subsystem) => subsystems[subsystem].status === 'healthy',
  )
    ? 'healthy'
    : 'degraded';
  const continuity = evaluateContinuityWatchdogHealth(subsystems, checkedAtMs, options);
  const status: ApiHealthResponse['status'] = subsystemStatus === 'healthy' && continuity.status === 'healthy'
    ? 'healthy'
    : 'degraded';

  return {
    statusCode: status === 'healthy' ? 200 : 503,
    body: {
      status,
      checkedAt: new Date(checkedAtMs).toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
      subsystems,
      continuity,
    },
  };
}
