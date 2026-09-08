// Wiring proof for the passive Blind Reviewer lane: it stays off unless the
// operator turns it on and a durable window is actually reachable, it never
// touches the database while disabled, and a transient connect failure is
// retried on the next due tick rather than killing the lane for the process.

import { fromPartial } from '@total-typescript/shoehorn';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { wireBlindReviewLane } from './blind-review-lane.js';
import { PostgresCogSecBlindReviewStore } from '../../../persistence/postgres/cogsec-blind-review-store.js';
import {
  InMemoryBlindReviewStore,
  blindReviewTestConfig,
} from '../../../core/cogsec/blind-review/blind-review.test-support.js';
import type { LLMProviderPort } from '../../../core/agent/contracts.js';
import type { IntakePolicyConfig } from '../../../system/config/intake-policy-config.js';
import type { SchedulerRuntimeConfig } from '../../../system/config/scheduler-config.js';
import type { SessionManager } from '../../../core/session/manager.js';
import type { SessionStore } from '../../../persistence/sessions/store.js';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';

const DATABASE_URL = 'postgresql://example.invalid:5432/psfn-blind-review';

let root: string;

function logDouble() {
  return { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
}

function deps(overrides: { enabled?: boolean; postgresDatabaseUrl?: string } = {}) {
  const log = logDouble();
  return {
    log,
    input: {
      schedulerConfig: fromPartial<SchedulerRuntimeConfig>({
        blindReviewer: blindReviewTestConfig({ root: { enabled: overrides.enabled ?? true } }),
      }),
      intakePolicy: fromPartial<IntakePolicyConfig>({ mode: 'boundary' }),
      // No sessions: the lane ingests nothing and never reaches a model.
      sessionManager: fromPartial<SessionManager>({
        listRecentSessions: () => [],
        isSessionRetiredOrQuarantined: () => false,
      }),
      sessionStore: fromPartial<SessionStore>({ getRecentSourceTurnRecords: () => [] }),
      llmProvider: fromPartial<LLMProviderPort>({}),
      postgresDatabaseUrl: overrides.postgresDatabaseUrl ?? DATABASE_URL,
      config: fromPartial<SubstrateConfig>({}),
      companionDataDir: root,
      log: fromPartial<Parameters<typeof wireBlindReviewLane>[0]['log']>(log),
    },
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'psfn-blind-review-wiring-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe('wireBlindReviewLane', () => {
  it('stays off, and opens no database connection, while the owner file disables it', () => {
    const connect = vi.spyOn(PostgresCogSecBlindReviewStore, 'connect');
    const { log, input } = deps({ enabled: false });
    expect(wireBlindReviewLane(input)).toBeNull();
    expect(connect).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('disabled by scheduler.json'));
  });

  it('refuses loudly when it is enabled without a durable window to write to', () => {
    const { log, input } = deps({ postgresDatabaseUrl: '  ' });
    expect(wireBlindReviewLane(input)).toBeNull();
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('NOT wired'));
  });

  it('connects lazily, only on the first due run', async () => {
    const connect = vi.spyOn(PostgresCogSecBlindReviewStore, 'connect')
      .mockResolvedValue(fromPartial<PostgresCogSecBlindReviewStore>(new InMemoryBlindReviewStore()));
    const { input } = deps();
    const lane = wireBlindReviewLane(input);
    expect(lane).not.toBeNull();
    expect(connect).not.toHaveBeenCalled();
    await expect(lane?.runIfDue()).resolves.toBe(true);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('honors the owner-file interval as a due-gate over the shared maintenance tick', async () => {
    vi.spyOn(PostgresCogSecBlindReviewStore, 'connect')
      .mockResolvedValue(fromPartial<PostgresCogSecBlindReviewStore>(new InMemoryBlindReviewStore()));
    const { input } = deps();
    const lane = wireBlindReviewLane(input);
    const startedAtMs = 1_700_000_000_000;
    await expect(lane?.runIfDue(startedAtMs)).resolves.toBe(true);
    await expect(lane?.runIfDue(startedAtMs + 60_000)).resolves.toBe(false);
    await expect(lane?.runIfDue(startedAtMs + 4_000_000)).resolves.toBe(true);
  });

  it('retries a failed connect on the next due tick instead of dying for the process', async () => {
    const connect = vi.spyOn(PostgresCogSecBlindReviewStore, 'connect')
      .mockRejectedValueOnce(new Error('database is starting up'))
      .mockResolvedValue(fromPartial<PostgresCogSecBlindReviewStore>(new InMemoryBlindReviewStore()));
    const { input } = deps();
    const lane = wireBlindReviewLane(input);
    await expect(lane?.runIfDue(1_700_000_000_000)).rejects.toThrow('database is starting up');
    await expect(lane?.runIfDue(1_700_000_000_000)).resolves.toBe(true);
    expect(connect).toHaveBeenCalledTimes(2);
  });
});
