import { beforeEach, describe, expect, it } from 'vitest';
import type { ConcernStorePort } from './concern-store-port.js';
import { createTestPostgresIntentionPorts } from '../../test-support/postgres-intention-ports.js';
import { createOrientTool } from '../../faculties/core-memory/tools.js';

function resultText(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content.map(block => block.text).join('');
}

describe('orient concern actions', () => {
  let store: ConcernStorePort;

  function makeTool(): ReturnType<typeof createOrientTool> {
    const unusedCoreMemoryStore = {
      append: () => {
        throw new Error('core-memory store must not be touched by concern actions');
      },
      replace: () => {
        throw new Error('core-memory store must not be touched by concern actions');
      },
      rethink: () => {
        throw new Error('core-memory store must not be touched by concern actions');
      },
    };
    return createOrientTool(unusedCoreMemoryStore, { concernStore: store });
  }

  beforeEach(() => {
    store = createTestPostgresIntentionPorts().ports.concernStore;
  });

  it('create_concern writes a new concern', async () => {
    const tool = makeTool();
    const result = await tool.execute('call-1', {
      action: 'create_concern',
      text: 'Check if V has eaten.',
      priority: 'high',
      contactId: 'contact-v',
      status: 'deferred',
      evidenceRefs: [{ kind: 'message', ref: 'msg-tool-1' }],
      nextReviewAt: '2026-02-02T10:00:00.000Z',
    });

    const payload = JSON.parse(resultText(result)) as {
      created: boolean;
      concern: {
        id: string;
        text: string;
        priority: string;
        status: string;
        contactId?: string;
        evidenceRefs: Array<{ kind: string; ref: string }>;
        nextReviewAt?: string;
      };
    };
    expect(payload.created).toBe(true);
    expect(payload.concern.id).toBeTruthy();
    expect(payload.concern.text).toBe('Check if V has eaten.');
    expect(payload.concern.priority).toBe('high');
    expect(payload.concern.status).toBe('deferred');
    expect(payload.concern.contactId).toBe('contact-v');
    expect(payload.concern.evidenceRefs).toEqual([{ kind: 'message', ref: 'msg-tool-1' }]);
    expect(payload.concern.nextReviewAt).toBe('2026-02-02T10:00:00.000Z');
  });

  it('list_concerns returns serialized concern rows', async () => {
    const created = await store.create({
      text: 'Follow up on Thursday project discussion.',
      priority: 'medium',
    });
    const tool = makeTool();

    const result = await tool.execute('call-2', { action: 'list_concerns' });
    const payload = JSON.parse(resultText(result)) as {
      count: number;
      concerns: Array<{ id: string }>;
    };

    expect(payload.count).toBe(1);
    expect(payload.concerns[0]?.id).toBe(created.id);
  });

  it('resolve_concern is idempotent for resolved concerns and reports unknown ids', async () => {
    const created = await store.create({
      text: 'Resolve this concern.',
      priority: 'low',
    });
    const tool = makeTool();

    const resolvedResult = await tool.execute('call-3', {
      action: 'resolve_concern',
      concernId: created.id,
      outcome: 'Addressed in follow-up',
    });
    const resolvedPayload = JSON.parse(resultText(resolvedResult)) as {
      resolved: number;
      missing: string[];
      concerns: Array<{ resolvedAt?: string; resolutionOutcome?: string }>;
    };
    expect(resolvedPayload.resolved).toBe(1);
    expect(resolvedPayload.missing).toEqual([]);
    expect(resolvedPayload.concerns[0]?.resolvedAt).toBeDefined();
    expect(resolvedPayload.concerns[0]?.resolutionOutcome).toBe('Addressed in follow-up');

    const repeatedResult = await tool.execute('call-4', {
      action: 'resolve_concern',
      concernId: created.id,
    });
    const repeatedPayload = JSON.parse(resultText(repeatedResult)) as {
      resolved: number;
      missing: string[];
      concerns: Array<{ resolutionOutcome?: string }>;
    };
    expect(repeatedPayload.resolved).toBe(1);
    expect(repeatedPayload.missing).toEqual([]);
    expect(repeatedPayload.concerns[0]?.resolutionOutcome).toBe('Addressed in follow-up');
    expect(repeatedResult.details?.isError).toBeUndefined();

    const missingConcernId = 'missing-concern-id';
    const missingResult = await tool.execute('call-5', {
      action: 'resolve_concern',
      concernId: missingConcernId,
    });
    const missingPayload = JSON.parse(resultText(missingResult)) as {
      resolved: number;
      missing: string[];
    };
    expect(missingPayload.resolved).toBe(0);
    expect(missingPayload.missing).toEqual([missingConcernId]);
    expect(missingResult.details?.isError).toBe(true);
  });
});
