import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LLMProvider } from '../agent/contracts.js';
import {
  CompressionFailureLogStore,
  CompressionGuidelineRuntime,
  CompressionGuidelineStore,
} from './compression-guideline.js';

function makeMockLLM(content: string): LLMProvider {
  return {
    stream: async () => ({
      content: '',
      model: 'mock',
      inputTokens: 0,
      outputTokens: 0,
      toolCalls: [],
      stopReason: 'end_turn',
    }),
    complete: async () => ({
      content,
      model: 'mock',
      inputTokens: 0,
      outputTokens: 0,
      toolCalls: [],
      stopReason: 'end_turn',
    }),
  };
}

describe('CompressionGuidelineRuntime', () => {
  it('stores defaults and persists guideline revisions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'psfn-guideline-'));
    try {
      const now = () => 1_700_000_000_000;
      const store = new CompressionGuidelineStore(join(dir, 'guideline.json'), { now });
      const initial = store.load();
      expect(initial.version).toBe(1);
      expect(initial.guideline.length).toBeGreaterThan(0);

      const saved = store.save({
        version: 2,
        updatedAt: new Date(now()).toISOString(),
        guideline: 'Preserve IDs verbatim.\nCarry unresolved questions forward.',
      });
      const reloaded = store.load();
      expect(saved.version).toBe(2);
      expect(reloaded.guideline).toContain('Preserve IDs verbatim.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('captures compression failure logs from post-turn failure signals', () => {
    const dir = mkdtempSync(join(tmpdir(), 'psfn-compfail-'));
    try {
      let nowValue = 1_700_000_000_000;
      const now = () => nowValue;
      const guidelineStore = new CompressionGuidelineStore(join(dir, 'guideline.json'), { now });
      const failureStore = new CompressionFailureLogStore(join(dir, 'failures.jsonl'), { now });
      const runtime = new CompressionGuidelineRuntime(guidelineStore, failureStore, {
        now,
        minimumFailuresForUpdate: 1,
      });

      runtime.recordCompactionTrajectory({
        channelId: 'api:test',
        originalContext: 'Original long context.',
        compressedContext: 'Compressed summary context.',
      });

      const logged = runtime.captureFailureFromResponse({
        channelId: 'api:test',
        sourceMessageId: 'msg-1',
        assistantResponse: 'Can you remind me which project we were discussing?',
      });
      expect(logged).not.toBeNull();
      expect(logged?.indicator).toBe('asked_for_reminder');
      expect(logged?.originalContext).toContain('Original long context.');
      expect(failureStore.listRecent()).toHaveLength(1);

      nowValue += 5;
      const ignored = runtime.captureFailureFromResponse({
        channelId: 'api:test',
        sourceMessageId: 'msg-2',
        assistantResponse: 'I can continue from here without asking for context.',
      });
      expect(ignored).toBeNull();
      expect(failureStore.listRecent()).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs periodic guideline updates from logged failures', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'psfn-guideline-update-'));
    try {
      let nowValue = 1_700_000_000_000;
      const now = () => nowValue;
      const guidelineStore = new CompressionGuidelineStore(join(dir, 'guideline.json'), { now });
      const failureStore = new CompressionFailureLogStore(join(dir, 'failures.jsonl'), { now });
      const runtime = new CompressionGuidelineRuntime(guidelineStore, failureStore, { now });

      runtime.recordCompactionTrajectory({
        channelId: 'api:test',
        originalContext: 'Original context version A',
        compressedContext: 'Summary context A',
      });
      runtime.captureFailureFromResponse({
        channelId: 'api:test',
        sourceMessageId: 'msg-1',
        assistantResponse: 'Can you remind me which project we were discussing?',
      });

      nowValue += 10;
      runtime.recordCompactionTrajectory({
        channelId: 'api:test',
        originalContext: 'Original context version B',
        compressedContext: 'Summary context B',
      });
      runtime.captureFailureFromResponse({
        channelId: 'api:test',
        sourceMessageId: 'msg-2',
        assistantResponse: 'I might be missing some context before I continue.',
      });

      nowValue += 10;
      const llm = makeMockLLM(
        JSON.stringify({
          updatedGuideline: [
            'Preserve identifiers and unresolved asks verbatim.',
            'When uncertain, state uncertainty and request only the missing fact.',
          ].join('\n'),
        }),
      );
      const result = await runtime.runPeriodicGuidelineUpdate(llm);
      expect(result.status).toBe('updated');
      expect(result.version).toBe(2);

      const stored = guidelineStore.load();
      expect(stored.version).toBe(2);
      expect(stored.lastReviewedFailureAt).toBeGreaterThan(0);
      expect(stored.guideline).toContain('Preserve identifiers');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when guideline update output is malformed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'psfn-guideline-malformed-'));
    try {
      const now = () => 1_700_000_000_000;
      const guidelineStore = new CompressionGuidelineStore(join(dir, 'guideline.json'), { now });
      const failureStore = new CompressionFailureLogStore(join(dir, 'failures.jsonl'), { now });
      const runtime = new CompressionGuidelineRuntime(guidelineStore, failureStore, {
        now,
        minimumFailuresForUpdate: 1,
      });

      runtime.recordCompactionTrajectory({
        channelId: 'api:test',
        originalContext: 'Original context',
        compressedContext: 'Summary context',
      });
      runtime.captureFailureFromResponse({
        channelId: 'api:test',
        sourceMessageId: 'msg-1',
        assistantResponse: 'Can you remind me what task we were in?',
      });

      await expect(runtime.runPeriodicGuidelineUpdate(makeMockLLM('not-json'))).rejects.toThrow(
        /updatedGuideline/i,
      );
      expect(guidelineStore.load().version).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
