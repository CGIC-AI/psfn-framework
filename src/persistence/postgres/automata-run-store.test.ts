import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PostgresAutomataRunStore } from './automata-run-store.js';

const mocks = vi.hoisted(() => ({
  pool: {
    query: vi.fn(async () => ({ rowCount: 1 })),
    end: vi.fn(async () => undefined),
  },
  createPostgresPool: vi.fn(),
  ensurePostgresSchema: vi.fn(async () => undefined),
  queryRows: vi.fn(async () => [] as unknown[]),
}));

vi.mock('../postgres.js', () => ({
  createPostgresPool: mocks.createPostgresPool,
  ensurePostgresSchema: mocks.ensurePostgresSchema,
  queryRows: mocks.queryRows,
}));

const ROW = {
  companion_id: 'companion-a',
  run_id: 'run-1',
  automaton_class: 'subagent.bounded',
  worker_id: 'subagent-1',
  worker_generation: 1,
  task_id: 'task-1',
  task_label: 'Review',
  task_summary: 'Review a focused change.',
  parent_run_id: null,
  source_run_id: null,
  session_ids_json: ['subagent:subagent-1'],
  artifacts_json: [],
  status: 'running',
  status_reason: 'agent_initialized',
  outcome: null,
  failure_reason: null,
  promotion_state: 'not_requested',
  fold_state: 'not_required',
  created_at_ms: 10,
  started_at_ms: 11,
  finished_at_ms: null,
  retention_deadline_ms: 1_000,
};

beforeEach(() => {
  mocks.createPostgresPool.mockReset().mockReturnValue(mocks.pool);
  mocks.ensurePostgresSchema.mockClear();
  mocks.queryRows.mockReset().mockResolvedValue([]);
  mocks.pool.query.mockReset().mockResolvedValue({ rowCount: 1 });
  mocks.pool.end.mockClear();
});

describe('PostgresAutomataRunStore', () => {
  it('loads only retained rows inside its fixed companion scope', async () => {
    mocks.queryRows.mockResolvedValue([ROW]);
    const store = await PostgresAutomataRunStore.connect('postgres://test', 'companion-a', {
      schema: 'companion_a',
      role: 'companion_a_runtime',
    });

    const rows = await store.loadRetained('companion-a', 100);

    expect(mocks.createPostgresPool).toHaveBeenCalledWith('postgres://test', expect.objectContaining({
      schema: 'companion_a',
      role: 'companion_a_runtime',
    }));
    expect(mocks.queryRows).toHaveBeenCalledWith(
      mocks.pool,
      expect.stringContaining('WHERE companion_id = $1 AND retention_deadline_ms > $2'),
      ['companion-a', 100],
    );
    expect(rows[0]).toMatchObject({ runId: 'run-1', taskId: 'task-1', status: 'running' });
    await expect(store.loadRetained('companion-b', 100)).rejects.toThrow('companion scope mismatch');
  });

  it('uses prior-status compare-and-swap for transitions', async () => {
    const store = await PostgresAutomataRunStore.connect('postgres://test', 'companion-a');
    const record = {
      companionId: 'companion-a',
      runId: 'run-1',
      automatonClass: 'subagent.bounded' as const,
      workerId: 'subagent-1',
      workerGeneration: 1,
      taskId: 'task-1',
      taskLabel: 'Review',
      taskSummary: 'Review a focused change.',
      sessionIds: ['subagent:subagent-1'],
      artifacts: [],
      status: 'completed' as const,
      statusReason: 'completed',
      outcome: 'completed' as const,
      promotionState: 'not_requested' as const,
      foldState: 'not_required' as const,
      createdAtMs: 10,
      startedAtMs: 11,
      finishedAtMs: 12,
      retentionDeadlineMs: 1_000,
    };

    await store.update(record, 'running');
    expect(mocks.pool.query).toHaveBeenCalledWith(
      expect.stringContaining('status = $23'),
      expect.arrayContaining(['companion-a', 'run-1', 'running']),
    );
    mocks.pool.query.mockResolvedValueOnce({ rowCount: 0 });
    await expect(store.update(record, 'running')).rejects.toThrow('changed concurrently');
  });
});
