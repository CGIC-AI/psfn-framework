import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { ActiveConcernStore } from './concerns.js';
import {
  createCreateConcernTool,
  createListConcernsTool,
  createResolveConcernTool,
} from './tools.js';

function resultText(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content.map(block => block.text).join('');
}

describe('intention tools', () => {
  let db: Database.Database;
  let store: ActiveConcernStore;

  beforeEach(() => {
    db = new Database(':memory:');
    store = new ActiveConcernStore(db);
  });

  it('create_concern writes a new concern', async () => {
    const tool = createCreateConcernTool(store);
    const result = await tool.execute('call-1', {
      text: 'Check if V has eaten.',
      priority: 'high',
      contactId: 'contact-v',
    });

    const payload = JSON.parse(resultText(result)) as {
      created: boolean;
      concern: { id: string; text: string; priority: string; contactId?: string };
    };
    expect(payload.created).toBe(true);
    expect(payload.concern.id).toBeTruthy();
    expect(payload.concern.text).toBe('Check if V has eaten.');
    expect(payload.concern.priority).toBe('high');
    expect(payload.concern.contactId).toBe('contact-v');
  });

  it('list_concerns returns serialized concern rows', async () => {
    const created = store.create({
      text: 'Follow up on Thursday project discussion.',
      priority: 'medium',
    });
    const tool = createListConcernsTool(store);

    const result = await tool.execute('call-2', {});
    const payload = JSON.parse(resultText(result)) as {
      count: number;
      concerns: Array<{ id: string }>;
    };

    expect(payload.count).toBe(1);
    expect(payload.concerns[0]?.id).toBe(created.id);
  });

  it('resolve_concern resolves an unresolved concern and errors for missing id', async () => {
    const created = store.create({
      text: 'Resolve this concern.',
      priority: 'low',
    });
    const tool = createResolveConcernTool(store);

    const resolvedResult = await tool.execute('call-3', {
      concernId: created.id,
      outcome: 'Addressed in follow-up',
    });
    const resolvedPayload = JSON.parse(resultText(resolvedResult)) as {
      resolved: boolean;
      concern: { resolvedAt?: string; resolutionOutcome?: string };
    };
    expect(resolvedPayload.resolved).toBe(true);
    expect(resolvedPayload.concern.resolvedAt).toBeDefined();
    expect(resolvedPayload.concern.resolutionOutcome).toBe('Addressed in follow-up');

    const missingResult = await tool.execute('call-4', {
      concernId: created.id,
    });
    expect(resultText(missingResult)).toContain('No unresolved concern found');
    expect(missingResult.details?.isError).toBe(true);
  });
});
