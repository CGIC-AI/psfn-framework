import { spawn, type ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createBackgroundWorkIdentity,
  fingerprintBackgroundWorkPayload,
  type BackgroundWorkPayload,
  type EnqueueBackgroundWorkInput,
} from '../../../core/agent/background-work/types.js';
import { createPostgresPool } from '../../../persistence/postgres.js';
import { PostgresBackgroundWorkStore } from '../../../persistence/postgres/background-work-store.js';
import {
  DEFAULT_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../../test-support/postgres-test-harness.js';

/**
 * psfn-framework-69l9c regression: a graceful shutdown that cannot release its
 * durable background claims (the database went away mid-shutdown) must end the
 * process with a failure status within the force-exit bound. Before the fix the
 * signal handler cleared its force-exit timer and left the process alive with a
 * latched supervisor, so every later turn failed with "Background work
 * supervisor is stopping".
 *
 * The child runs the real Postgres background-work store, the real supervisor
 * holding a live claim, the production shutdown step shape from the agent
 * control plane, and the real signal and process-error handlers with
 * `process.exit`. A referenced interval stands in for the live gateway
 * transport that keeps a production agent's event loop alive.
 */
const CHILD_SOURCE = `
(async () => {
  const env = process.env;
  const { PostgresBackgroundWorkStore } = await import(env.STORE_MODULE_URL);
  const { BackgroundWorkSupervisor } = await import(env.SUPERVISOR_MODULE_URL);
  const { EventBus } = await import(env.EVENT_BUS_MODULE_URL);
  const signals = await import(env.SIGNAL_MODULE_URL);
  const helpers = await import(env.HELPERS_MODULE_URL);
  const emit = (event, meta) => process.stdout.write(JSON.stringify({ event, ...(meta ?? {}) }) + '\\n');
  const logger = {
    info: (message, meta) => emit('log', { level: 'info', message, ...(meta ?? {}) }),
    warn: (message, meta) => emit('log', { level: 'warn', message, ...(meta ?? {}) }),
    error: (message, meta) => emit('log', { level: 'error', message, ...(meta ?? {}) }),
  };
  const store = await PostgresBackgroundWorkStore.connect(env.DATABASE_URL, { schema: 'companion_a' });
  const supervisor = new BackgroundWorkSupervisor({
    maxConcurrentSessions: 1,
    leaseDurationMs: 300000,
    retryBaseDelayMs: 1000,
    retryMaxDelayMs: 300000,
    shutdownTimeoutMs: 1000,
    terminalRetentionMs: 604800000,
    cleanupIntervalMs: 3600000,
    welfare: { deferThreshold: 100, ageThresholdMs: 60000, reserveSlots: 0, maxDefers: 200 },
    store,
    eventBus: new EventBus(),
    leaseOwner: 'signal-shutdown-child',
    executor: async ({ signal }) => {
      emit('claimed');
      await new Promise((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', () => resolve(), { once: true });
      });
    },
  });
  const releaseClaims = helpers.createRetryableShutdown(async () => {
    await helpers.runShutdownStep(
      'stop durable background work supervisor',
      () => supervisor.stop(),
      logger,
      2,
      true,
    );
  });
  const stopFn = helpers.createRetryableShutdown(async () => {
    await helpers.runShutdownSequence([
      {
        step: 'stop durable background work supervisor',
        action: releaseClaims,
        maxAttempts: 1,
        failClosed: true,
      },
      { step: 'close database', action: () => store.close() },
    ], logger);
  });
  const shutdown = signals.createSignalShutdownHandler({
    logger,
    runGracefulShutdown: stopFn,
    exit: (code) => process.exit(code),
    forceExitTimeoutMs: Number(env.FORCE_EXIT_TIMEOUT_MS),
  });
  signals.installSignalHandlers(shutdown, logger);
  signals.registerProcessErrorHandlers({
    logger,
    backgroundFailureEscalationThreshold: 3,
    requestShutdown: () => {
      void shutdown('uncaughtException').catch(() => process.exit(1));
    },
  });
  setInterval(() => undefined, 1000);
  await supervisor.tick();
})().catch((error) => {
  process.stdout.write(JSON.stringify({ event: 'child_setup_failed', error: String(error) }) + '\\n');
  process.exit(3);
});
`;

const FORCE_EXIT_TIMEOUT_MS = 10_000;
// Wait past the bound before declaring the process lingering, so a failure
// reads as "never exited" rather than as a race with the force-exit timer.
const LINGER_OBSERVATION_MS = FORCE_EXIT_TIMEOUT_MS + 5_000;

interface ChildEvent {
  event: string;
  level?: string;
  message?: string;
  [key: string]: unknown;
}

function makeMemoryExtractionInput(logicalSessionId: string, turnId: string): EnqueueBackgroundWorkInput {
  const createdAtMs = Date.now();
  const payload: BackgroundWorkPayload = {
    schemaVersion: 1,
    kind: 'memory_extraction',
    source: {
      schemaVersion: 1,
      logicalSessionId,
      channelId: logicalSessionId,
      turnId,
      requestId: `request-${turnId}`,
      turnRecordFingerprint: 'a'.repeat(64),
      createdAtMs,
    },
  };
  return {
    ...createBackgroundWorkIdentity({ logicalSessionId, turnId, kind: 'memory_extraction' }),
    logicalSessionId,
    kind: 'memory_extraction',
    payload,
    payloadFingerprint: fingerprintBackgroundWorkPayload(payload),
    sourceTurnId: turnId,
    sourceRequestId: `request-${turnId}`,
    sourceChannelId: logicalSessionId,
    createdAtMs,
    maxAttempts: 3,
  };
}

function collectChildEvents(child: ChildProcess): ChildEvent[] {
  const events: ChildEvent[] = [];
  let buffered = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    buffered += chunk;
    let newline = buffered.indexOf('\n');
    while (newline >= 0) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (line.startsWith('{')) events.push(JSON.parse(line) as ChildEvent);
      newline = buffered.indexOf('\n');
    }
  });
  return events;
}

async function waitForEvent(events: ChildEvent[], name: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!events.some(event => event.event === name)) {
    const setupFailure = events.find(event => event.event === 'child_setup_failed');
    if (setupFailure) throw new Error(`Child setup failed: ${String(setupFailure.error)}`);
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for child event ${name}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<number | null | 'lingering'> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('lingering'), timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

describe('signal shutdown with an unavailable database (psfn-framework-69l9c)', () => {
  let harness: PostgresTestHarness | undefined;

  beforeAll(async () => {
    harness = await startPostgresTestHarness({ image: DEFAULT_POSTGRES_TEST_IMAGE });
  }, 90_000);

  afterAll(async () => {
    await harness?.stop();
  });

  it('exits non-zero within the force-exit bound when the durable claim release fails', async () => {
    if (!harness) throw new Error('Postgres test harness did not start');
    const database = await harness.createDatabase();
    const seedStore = await PostgresBackgroundWorkStore.connect(database.databaseUrl, {
      schema: 'companion_a',
    });
    const input = makeMemoryExtractionInput('session-shutdown', 'turn-shutdown');
    try {
      await seedStore.enqueue(input);
    } finally {
      await seedStore.close();
    }

    const admin = createPostgresPool(harness.adminDatabaseUrl, { applicationName: 'psfn-shutdown-test-admin' });
    const quotedDatabase = `"${database.databaseName.replace(/"/g, '""')}"`;
    const child = spawn(process.execPath, ['--import', 'tsx', '--eval', CHILD_SOURCE], {
      env: {
        ...process.env,
        DATABASE_URL: database.databaseUrl,
        FORCE_EXIT_TIMEOUT_MS: String(FORCE_EXIT_TIMEOUT_MS),
        STORE_MODULE_URL: new URL('../../../persistence/postgres/background-work-store.ts', import.meta.url).href,
        SUPERVISOR_MODULE_URL: new URL('../../../core/agent/background-work/supervisor.ts', import.meta.url).href,
        EVENT_BUS_MODULE_URL: new URL('../../../shared/event-bus.ts', import.meta.url).href,
        SIGNAL_MODULE_URL: new URL('./signal-shutdown.ts', import.meta.url).href,
        HELPERS_MODULE_URL: new URL('./shutdown-helpers.ts', import.meta.url).href,
      },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const events = collectChildEvents(child);
    try {
      await waitForEvent(events, 'claimed', 30_000);

      // Take the database away the way a crash-recovering server does: refuse
      // new sessions and terminate the child's live ones.
      await admin.query(`ALTER DATABASE ${quotedDatabase} WITH ALLOW_CONNECTIONS false`);
      await admin.query(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
        [database.databaseName],
      );

      const signalledAt = Date.now();
      if (child.exitCode === null) child.kill('SIGTERM');
      const exitCode = await waitForExit(child, LINGER_OBSERVATION_MS);
      const elapsedMs = Date.now() - signalledAt;

      expect(exitCode).toBe(1);
      expect(elapsedMs).toBeLessThan(FORCE_EXIT_TIMEOUT_MS);
      const errors = events.filter(event => event.level === 'error').map(event => event.message);
      expect(errors).toContain('Shutdown step failed; aborting shutdown');
      expect(errors).toContain('Graceful shutdown failed; exiting with failure status');
      expect(events.some(event => event.message === 'Graceful shutdown timed out; forcing exit')).toBe(false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await admin.query(`ALTER DATABASE ${quotedDatabase} WITH ALLOW_CONNECTIONS true`);
      await admin.end();
    }

    // The unreleased claim is still durably owned by the dead process and is
    // left for lease-expiry recovery; nothing was lost or double-counted.
    const verifyStore = await PostgresBackgroundWorkStore.connect(database.databaseUrl, {
      schema: 'companion_a',
    });
    try {
      expect(await verifyStore.get(input.jobId)).toMatchObject({ state: 'running', attemptCount: 0 });
    } finally {
      await verifyStore.close();
    }
  }, 120_000);
});
