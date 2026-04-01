import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  assembleReflectionSubstrateContext,
  buildReflectionProcessId,
  ReflectionDailyJournalStore,
  ReflectionProcessLogStore,
  toReflectionDailyJournalProvenanceRef,
  toReflectionProcessLogProvenanceRef,
  toReflectionJournalProvenanceRef,
} from './reflection-substrate.js';
import { NON_CANONICAL_REFLECTION_SUBSTRATE } from './reflection-journal.js';

describe('reflection substrate stores', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'reflection-substrate-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('appends reflection daily journal entries into per-day append-only files', () => {
    const store = new ReflectionDailyJournalStore(join(tempDir, 'daily'), {
      now: () => Date.parse('2026-03-31T12:00:00.000Z'),
    });

    store.append({
      source: 'heartbeat_template',
      executionSource: 'scheduled',
      templateId: 'whisper',
      templateName: 'Whisper',
      channelId: 'internal:reflection:whisper',
      prompt: 'Reflect on the day.',
      reflection: 'I stayed steady through a long afternoon.',
      mode: 'agent',
      reflectionJournalEntryId: 'reflection-1',
    });

    const raw = readFileSync(join(tempDir, 'daily', '2026-03-31.jsonl'), 'utf-8').trim();
    const persisted = JSON.parse(raw) as {
      kind: string;
      source: string;
      executionSource: string;
      reflection: string;
      reflectionJournalEntryId?: string;
    };
    expect(persisted.kind).toBe('daily_journal_entry');
    expect(persisted.source).toBe('heartbeat_template');
    expect(persisted.executionSource).toBe('scheduled');
    expect(persisted.reflection).toContain('long afternoon');
    expect(persisted.reflectionJournalEntryId).toBe('reflection-1');
  });

  it('appends long-process reflection entries into a per-process log', () => {
    const store = new ReflectionProcessLogStore(join(tempDir, 'processes'), {
      now: () => Date.parse('2026-03-31T13:00:00.000Z'),
    });
    const processId = buildReflectionProcessId('Values Reflection Deliberation', () => 1_700_000_000_000);

    store.append({
      processId,
      processLabel: 'Values Reflection Deliberation',
      processType: 'reflection_deliberation',
      stage: 'started',
      executionSource: 'scheduled',
      templateId: 'values-reflection',
      templateName: 'Values Reflection',
      channelId: 'internal:reflection:values-reflection',
      prompt: 'Reflect carefully on your current values.',
    });
    store.append({
      processId,
      processLabel: 'Values Reflection Deliberation',
      processType: 'reflection_deliberation',
      stage: 'completed',
      executionSource: 'scheduled',
      templateId: 'values-reflection',
      templateName: 'Values Reflection',
      channelId: 'internal:reflection:values-reflection',
      prompt: 'Reflect carefully on your current values.',
      reflection: 'I noticed continuity mattered more than novelty.',
      deliberation: {
        sessionId: 'delib-1',
        stopReason: 'stop',
        rounds: 2,
        totalInputTokens: 120,
        totalOutputTokens: 80,
        totalTokens: 200,
        estimatedCostUsd: 0.004,
        durationMs: 800,
      },
    });

    const files = readdirSync(join(tempDir, 'processes'));
    expect(files).toHaveLength(1);

    const raw = readFileSync(join(tempDir, 'processes', files[0] ?? ''), 'utf-8').trim();
    const lines = raw.split('\n').filter(line => line.trim().length > 0);
    expect(lines).toHaveLength(2);
    const started = JSON.parse(lines[0] ?? '{}') as { stage: string };
    const completed = JSON.parse(lines[1] ?? '{}') as {
      stage: string;
      reflection?: string;
      deliberation?: { sessionId?: string };
    };
    expect(started.stage).toBe('started');
    expect(completed.stage).toBe('completed');
    expect(completed.reflection).toContain('continuity mattered');
    expect(completed.deliberation?.sessionId).toBe('delib-1');
  });

  it('lists recent entries and assembles non-canonical substrate replay context', () => {
    const dailyStore = new ReflectionDailyJournalStore(join(tempDir, 'daily'));
    const processStore = new ReflectionProcessLogStore(join(tempDir, 'processes'));

    dailyStore.append({
      source: 'heartbeat_template',
      executionSource: 'scheduled',
      templateId: 'daily-review',
      templateName: 'Daily Review',
      channelId: 'internal:reflection:daily-review',
      prompt: 'Review the day.',
      reflection: 'The day kept returning to steadiness under pressure.',
      mode: 'agent',
      createdAt: '2026-03-31T08:00:00.000Z',
    });
    const processId = buildReflectionProcessId('Values Reflection Deliberation', () => 1_700_000_000_000);
    processStore.append({
      processId,
      processLabel: 'Values Reflection Deliberation',
      processType: 'reflection_deliberation',
      stage: 'completed',
      executionSource: 'scheduled',
      templateId: 'values-reflection',
      templateName: 'Values Reflection',
      channelId: 'internal:reflection:values-reflection',
      prompt: 'Reflect carefully on your current values.',
      reflection: 'Continuity and care remained durable values.',
      createdAt: '2026-03-31T09:00:00.000Z',
    });

    const recentDaily = dailyStore.listRecent({ limit: 1 });
    const recentProcesses = processStore.listRecent({ limit: 1, stages: ['completed'] });
    const recentJournal = [{
      id: 'reflection-1',
      templateId: 'experiential-review',
      templateName: 'Experiential Review',
      prompt: 'Describe your recent experience.',
      reflection: 'I noticed an uncertainty pattern around unresolved ownership.',
      channelId: 'internal:reflection:experiential-review',
      mode: 'agent' as const,
      createdAt: '2026-03-31T07:00:00.000Z',
    }];

    const context = assembleReflectionSubstrateContext({
      recentReflectionJournalEntries: recentJournal,
      recentDailyJournalEntries: recentDaily,
      recentProcessLogEntries: recentProcesses,
    });

    expect(context?.canonicalTruthBoundary).toBe(NON_CANONICAL_REFLECTION_SUBSTRATE);
    expect(context?.promptBlock).toContain('[Reflection Substrate Replay]');
    expect(context?.promptBlock).toContain('not canonical truth');
    expect(context?.promptBlock).toContain('steadiness under pressure');
    expect(context?.promptBlock).toContain('Continuity and care remained durable values');
    expect(context?.promptBlock).toContain('uncertainty pattern around unresolved ownership');
    expect(context?.provenanceRefs).toEqual([
      toReflectionJournalProvenanceRef(recentJournal[0]!),
      toReflectionDailyJournalProvenanceRef(recentDaily[0]!),
      toReflectionProcessLogProvenanceRef(recentProcesses[0]!),
    ]);
  });

  it('fails closed when required process-stage fields are missing', () => {
    const store = new ReflectionProcessLogStore(join(tempDir, 'processes'));

    expect(() => store.append({
      processId: 'proc-1',
      processLabel: 'Broken process',
      processType: 'reflection_deliberation',
      stage: 'completed',
      executionSource: 'manual',
    })).toThrow('reflection is required');

    expect(() => store.append({
      processId: 'proc-1',
      processLabel: 'Broken process',
      processType: 'reflection_deliberation',
      stage: 'failed',
      executionSource: 'manual',
      prompt: 'Prompt text',
    })).toThrow('error is required');
  });
});
