import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  resolveWatchdogConfig,
  runWatchdogOnce,
} from '../../../../scripts/ops/continuity-watchdog-healthcheck.mjs';

const tempDirs: string[] = [];

function healthyPayload(): Record<string, unknown> {
  return {
    status: 'healthy',
    checkedAt: new Date('2026-06-29T12:00:00.000Z').toISOString(),
    uptimeSeconds: 120,
    subsystems: {
      memory: { status: 'healthy' },
      llm: { status: 'healthy' },
      discord: { status: 'healthy' },
      embeddings: { status: 'healthy' },
      scheduler: { status: 'healthy' },
    },
    continuity: {
      status: 'healthy',
      checks: {
        database: { status: 'healthy' },
        gatewayLink: { status: 'healthy' },
        schedulerHealthcheck: { status: 'healthy' },
      },
    },
  };
}

function staleSchedulerPayload(): Record<string, unknown> {
  return {
    ...healthyPayload(),
    status: 'degraded',
    continuity: {
      status: 'degraded',
      checks: {
        database: { status: 'healthy' },
        gatewayLink: { status: 'healthy' },
        schedulerHealthcheck: {
          status: 'degraded',
          detail: 'Scheduler healthcheck stale: 120000ms since last pulse (limit 60000ms)',
        },
      },
    },
  };
}

async function makeStateFile(): Promise<string> {
  const root = join(process.cwd(), 'data', 'test-continuity-watchdog');
  await mkdir(root, { recursive: true });
  const dir = join(root, randomUUID());
  await mkdir(dir, { recursive: true });
  tempDirs.push(dir);
  return join(dir, 'state.json');
}

function makeConfig(
  stateFile: string,
  env: Record<string, string> = {},
): ReturnType<typeof resolveWatchdogConfig> {
  return resolveWatchdogConfig({
    CONTINUITY_WATCHDOG_ENDPOINT: 'http://runtime.local/health',
    CONTINUITY_WATCHDOG_TIMEOUT_MS: '1000',
    CONTINUITY_WATCHDOG_MAX_FAILURES: '1',
    CONTINUITY_WATCHDOG_STATE_FILE: stateFile,
    CONTINUITY_WATCHDOG_SYSTEMD_SERVICE: '',
    CONTINUITY_WATCHDOG_PROCESS_PATTERN: '',
    CONTINUITY_WATCHDOG_NTFY_BASE_URL: 'https://ntfy.local',
    CONTINUITY_WATCHDOG_NTFY_TOPIC: 'ops',
    CONTINUITY_WATCHDOG_NTFY_TOKEN: 'secret-token',
    ...env,
  }, []);
}

function makeFetch(options: {
  healthStatus: number;
  healthPayload: Record<string, unknown>;
  ntfyStatus?: number;
}): {
  fetchImpl: typeof fetch;
  ntfyRequests: Array<{ url: string; body: string; headers: Headers }>;
} {
  const ntfyRequests: Array<{ url: string; body: string; headers: Headers }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith('https://ntfy.local/')) {
      ntfyRequests.push({
        url,
        body: String(init?.body ?? ''),
        headers: new Headers(init?.headers),
      });
      return new Response('', {
        status: options.ntfyStatus ?? 200,
        statusText: options.ntfyStatus === 503 ? 'Service Unavailable' : 'OK',
        headers: { 'x-message-id': 'watchdog-page-1' },
      });
    }

    return new Response(JSON.stringify(options.healthPayload), {
      status: options.healthStatus,
      headers: { 'content-type': 'application/json' },
    });
  };

  return { fetchImpl, ntfyRequests };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('continuity watchdog healthcheck paging', () => {
  it('clears state and does not page when service, process, and health checks are healthy', async () => {
    const stateFile = await makeStateFile();
    const config = makeConfig(stateFile);
    const { fetchImpl, ntfyRequests } = makeFetch({
      healthStatus: 200,
      healthPayload: healthyPayload(),
    });

    const result = await runWatchdogOnce(config, {
      fetchImpl,
      now: () => Date.parse('2026-06-29T12:00:00.000Z'),
    });

    expect(result.exitCode).toBe(0);
    expect(result.status).toBe('healthy');
    expect(ntfyRequests).toHaveLength(0);
  });

  it('pages through ntfy when the configured user service is down', async () => {
    const stateFile = await makeStateFile();
    const config = makeConfig(stateFile, {
      CONTINUITY_WATCHDOG_SYSTEMD_SERVICE: 'purrsephone.service',
    });
    const { fetchImpl, ntfyRequests } = makeFetch({
      healthStatus: 200,
      healthPayload: healthyPayload(),
    });

    const result = await runWatchdogOnce(config, {
      fetchImpl,
      execFileImpl: async () => ({
        stdout: [
          'ActiveState=failed',
          'SubState=failed',
          'MainPID=0',
          'Result=exit-code',
          'ExecMainStatus=1',
        ].join('\n'),
        stderr: '',
      }),
      now: () => Date.parse('2026-06-29T12:01:00.000Z'),
    });

    expect(result.exitCode).toBe(1);
    expect(result.status).toBe('unhealthy');
    expect(result.reason).toContain('service_down');
    expect(ntfyRequests).toHaveLength(1);
    expect(ntfyRequests[0]?.url).toBe('https://ntfy.local/ops');
    expect(ntfyRequests[0]?.headers.get('authorization')).toBe('Bearer secret-token');
    expect(ntfyRequests[0]?.body).toContain('systemd --user service: purrsephone.service');
  });

  it('pages when the health endpoint reports stale scheduler liveness', async () => {
    const stateFile = await makeStateFile();
    const config = makeConfig(stateFile);
    const { fetchImpl, ntfyRequests } = makeFetch({
      healthStatus: 503,
      healthPayload: staleSchedulerPayload(),
    });

    const result = await runWatchdogOnce(config, {
      fetchImpl,
      now: () => Date.parse('2026-06-29T12:02:00.000Z'),
    });

    expect(result.exitCode).toBe(1);
    expect(result.status).toBe('unhealthy');
    expect(result.reason).toContain('schedulerHealthcheck');
    expect(result.reason).toContain('stale');
    expect(ntfyRequests).toHaveLength(1);
    expect(ntfyRequests[0]?.body).toContain('Scheduler healthcheck stale');
  });

  it('fails closed when ntfy delivery fails and does not record a sent page', async () => {
    const stateFile = await makeStateFile();
    const config = makeConfig(stateFile);
    const { fetchImpl, ntfyRequests } = makeFetch({
      healthStatus: 503,
      healthPayload: staleSchedulerPayload(),
      ntfyStatus: 503,
    });

    const result = await runWatchdogOnce(config, {
      fetchImpl,
      now: () => Date.parse('2026-06-29T12:03:00.000Z'),
    });

    const state = JSON.parse(await readFile(stateFile, 'utf8')) as {
      pageHistory?: Record<string, unknown>;
      lastNtfyFailure?: string;
    };
    expect(result.exitCode).toBe(2);
    expect(result.pageStatus).toBe('failed');
    expect(result.pageError).toContain('ntfy request failed: 503');
    expect(ntfyRequests).toHaveLength(1);
    expect(Object.keys(state.pageHistory ?? {})).toHaveLength(0);
    expect(state.lastNtfyFailure).toContain('ntfy request failed: 503');
  });

  it('suppresses repeat pages for the same unresolved incident inside the replay window', async () => {
    const stateFile = await makeStateFile();
    const config = makeConfig(stateFile, {
      CONTINUITY_WATCHDOG_REPEAT_PAGE_AFTER_MS: String(60 * 60_000),
    });
    const { fetchImpl, ntfyRequests } = makeFetch({
      healthStatus: 503,
      healthPayload: staleSchedulerPayload(),
    });

    const first = await runWatchdogOnce(config, {
      fetchImpl,
      now: () => Date.parse('2026-06-29T12:04:00.000Z'),
    });
    const second = await runWatchdogOnce(config, {
      fetchImpl,
      now: () => Date.parse('2026-06-29T12:05:00.000Z'),
    });

    expect(first.pageStatus).toBe('sent');
    expect(second.pageStatus).toBe('debounced');
    expect(second.exitCode).toBe(1);
    expect(ntfyRequests).toHaveLength(1);
  });

  it('refuses to run when ntfy target or required token is missing', async () => {
    const stateFile = await makeStateFile();
    const config = makeConfig(stateFile, {
      CONTINUITY_WATCHDOG_NTFY_BASE_URL: '',
      CONTINUITY_WATCHDOG_NTFY_TOKEN: '',
    });
    const { fetchImpl, ntfyRequests } = makeFetch({
      healthStatus: 200,
      healthPayload: healthyPayload(),
    });

    const result = await runWatchdogOnce(config, { fetchImpl });

    expect(result.exitCode).toBe(2);
    expect(result.status).toBe('config_error');
    expect(result.errors).toContain('NTFY_BASE_URL or CONTINUITY_WATCHDOG_NTFY_BASE_URL is required');
    expect(result.errors).toContain('NTFY_TOKEN or CONTINUITY_WATCHDOG_NTFY_TOKEN is required');
    expect(ntfyRequests).toHaveLength(0);
  });
});
