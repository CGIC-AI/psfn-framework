import { describe, expect, it } from 'vitest';

import {
  buildAutomataPath,
  resolveAutomataPageState,
  type AutomataSnapshot,
} from './automata';

const snapshot = {
  classes: [],
  runs: [],
  runPage: { offset: 0, limit: 20, hasMore: false },
  bus: {
    available: true,
    health: {
      condition: 'healthy',
      freshness: 'fresh',
      observedAt: null,
      lastEventAt: null,
      indexState: 'ready',
      reindexState: 'current',
      pendingIndexCount: 0,
      degradationReasons: [],
    },
    events: [],
    currentFindings: [],
    correctionHistory: [],
    page: { offset: 0, limit: 20, hasMore: false },
  },
  lessons: {
    available: true,
    condition: 'ready',
    groups: [],
    hasMore: false,
    sourceFindingCount: 0,
    proposalReviewPath: '/api/admin/shared-workspace/proposals',
  },
  extensions: { managementPanels: [] },
} satisfies AutomataSnapshot;

describe('Automata Garden endpoint', () => {
  it('builds a selected-companion-safe relative API query with filters and pagination', () => {
    expect(buildAutomataPath({
      classId: 'subagent.bounded',
      taskId: 'task / one',
      status: 'running',
      limit: 20,
      runOffset: 40,
      busOffset: 10,
      verificationStatus: 'pending',
    })).toBe(
      '/api/admin/automata?classId=subagent.bounded&taskId=task+%2F+one&status=running&limit=20&runOffset=40&busOffset=10&verificationStatus=pending',
    );
  });

  it('distinguishes loading, empty, stale, degraded, ready, and fatal error states', () => {
    expect(resolveAutomataPageState({ loading: true, error: '', snapshot: null })).toBe('loading');
    expect(resolveAutomataPageState({ loading: false, error: 'boom', snapshot: null })).toBe('error');
    expect(resolveAutomataPageState({ loading: false, error: '', snapshot })).toBe('empty');
    expect(resolveAutomataPageState({
      loading: false,
      error: '',
      snapshot: { ...snapshot, bus: { ...snapshot.bus, health: { ...snapshot.bus.health, freshness: 'stale' } } },
    })).toBe('stale');
    expect(resolveAutomataPageState({
      loading: false,
      error: '',
      snapshot: { ...snapshot, bus: { ...snapshot.bus, health: { ...snapshot.bus.health, condition: 'degraded' } } },
    })).toBe('degraded');
    expect(resolveAutomataPageState({
      loading: false,
      error: '',
      snapshot: { ...snapshot, runs: [{ runId: 'run-1' } as AutomataSnapshot['runs'][number]] },
    })).toBe('ready');
  });
});
