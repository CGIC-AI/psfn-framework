import { beforeEach, describe, expect, it } from 'vitest';
import { runWithRequestContext } from '../../primitives/llm/request-context.js';
import { EventBus } from '../../shared/event-bus.js';
import type { ConcernStorePort } from './concern-store-port.js';
import { createTestPostgresIntentionPorts } from '../../test-support/postgres-intention-ports.js';
import { createConcernsTool, type ConcernsToolOptions } from './concerns-tool.js';

function resultText(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content.map(block => block.text).join('');
}

describe('concerns tool actions', () => {
  let store: ConcernStorePort;

  function makeTool(options?: ConcernsToolOptions): ReturnType<typeof createConcernsTool> {
    return createConcernsTool(store, options);
  }

  beforeEach(() => {
    store = createTestPostgresIntentionPorts().ports.concernStore;
  });

  it('keeps the internal candidate lifecycle state out of ordinary concern actions', () => {
    const tool = makeTool();
    const parameters = tool.parameters as {
      properties: { status: { enum: string[] } };
    };

    expect(parameters.properties.status.enum).not.toContain('candidate');
  });

  it('create writes a new concern', async () => {
    const tool = makeTool();
    const result = await tool.execute('call-1', {
      action: 'create',
      text: 'Check if Morgan has eaten.',
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
    expect(payload.concern.text).toBe('Check if Morgan has eaten.');
    expect(payload.concern.priority).toBe('high');
    expect(payload.concern.status).toBe('deferred');
    expect(payload.concern.contactId).toBe('contact-v');
    expect(payload.concern.evidenceRefs).toEqual([{ kind: 'message', ref: 'msg-tool-1' }]);
    expect(payload.concern.nextReviewAt).toBe('2026-02-02T10:00:00.000Z');
  });

  it('list returns serialized concern rows', async () => {
    const created = await store.create({
      text: 'Follow up on Thursday project discussion.',
      priority: 'medium',
    });
    const tool = makeTool();

    const result = await runWithRequestContext({
      callType: 'tool',
      purpose: 'agent.turn',
      channelId: 'api:owner-console',
      viewerTrustLevel: 'primary',
      viewerChannelPrivacy: 'private',
    }, () => tool.execute('call-2', { action: 'list' }));
    const payload = JSON.parse(resultText(result)) as {
      count: number;
      concerns: Array<{ id: string }>;
    };

    expect(payload.count).toBe(1);
    expect(payload.concerns[0]?.id).toBe(created.id);
  });

  it('list withholds concerns a lower-trust room may not see (o5wf5)', async () => {
    const open = await store.create({ text: 'Water the shared garden.', priority: 'low', sensitivity: 'public' });
    await store.create({ text: 'Private worry about a partner.', priority: 'high', sensitivity: 'confidential' });
    await store.create({ text: 'Check on another contact.', priority: 'medium', sensitivity: 'public', contactId: 'contact-other' });
    const tool = makeTool();

    const result = await runWithRequestContext({
      callType: 'tool', purpose: 'agent.turn', channelId: 'api:stranger-room',
      viewerTrustLevel: 'public', viewerChannelPrivacy: 'public',
    }, () => tool.execute('call-gated', { action: 'list' }));
    const text = resultText(result);
    const payload = JSON.parse(text) as { count: number; withheldByVisibility?: number; concerns: Array<{ id: string }> };

    expect(payload.concerns.map(concern => concern.id)).toEqual([open.id]);
    expect(payload.withheldByVisibility).toBe(2);
    expect(text).not.toContain('Private worry');
    expect(text).not.toContain('another contact');
  });

  it('resolve is idempotent for resolved concerns and reports unknown ids', async () => {
    const created = await store.create({
      text: 'Resolve this concern.',
      priority: 'low',
    });
    const tool = makeTool();

    const resolvedResult = await tool.execute('call-3', {
      action: 'resolve',
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
      action: 'resolve',
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
      action: 'resolve',
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

  it('captures resolutionVAD and emits a resolution appraisal when resolving a concern', async () => {
    const eventBus = new EventBus();
    const appraisals: Array<{
      concernId: string;
      source: string;
      reliefDelta: { valence: number; arousal: number; dominance: number };
    }> = [];
    eventBus.on('intention.concern.resolution_appraisal', event => {
      appraisals.push(event as (typeof appraisals)[number]);
    });

    const tool = makeTool({
      eventBus,
      resolutionVadProvider: () => ({ valence: 0.4, arousal: -0.1, dominance: 0.2 }),
    });

    const created = await store.create({
      text: 'Decision-path resolution capture',
      formationVAD: { valence: -0.3, arousal: 0.5, dominance: -0.1 },
    });

    const resolvedResult = await tool.execute('call-concern-resolve-vad', {
      action: 'resolve',
      concernId: created.id,
      outcome: 'Resolved by decision.',
    });
    const resolvedPayload = JSON.parse(resultText(resolvedResult)) as {
      resolved: number;
      concerns: Array<{ resolutionVAD?: { valence: number; arousal: number; dominance: number } }>;
    };

    expect(resolvedPayload.resolved).toBe(1);
    expect(resolvedPayload.concerns[0]?.resolutionVAD).toEqual({
      valence: 0.4,
      arousal: -0.1,
      dominance: 0.2,
    });

    expect(appraisals).toHaveLength(1);
    expect(appraisals[0]?.concernId).toBe(created.id);
    expect(appraisals[0]?.source).toBe('decision');
    expect(appraisals[0]?.reliefDelta.valence).toBeCloseTo(0.7, 10);
    expect(appraisals[0]?.reliefDelta.arousal).toBeCloseTo(-0.6, 10);
    expect(appraisals[0]?.reliefDelta.dominance).toBeCloseTo(0.3, 10);
  });

  it('transitions concern status and resolves multiple concerns in one batch action', async () => {
    const tool = makeTool();

    const first = JSON.parse(resultText(await tool.execute('call-create-1', {
      action: 'create',
      text: 'Blocked until the operator reviews it.',
    }))) as { concern: { id: string } };
    const second = JSON.parse(resultText(await tool.execute('call-create-2', {
      action: 'create',
      text: 'Ask about sleep tomorrow.',
    }))) as { concern: { id: string } };

    const transitioned = JSON.parse(resultText(await tool.execute('call-transition', {
      action: 'transition',
      concernId: first.concern.id,
      status: 'blocked',
      outcome: 'Waiting on operator context.',
      evidenceRefs: [{ kind: 'runtime', ref: 'operator-gate:1' }],
    }))) as {
      transitioned: number;
      missing: string[];
      concerns: Array<{ status: string; evidenceRefs: Array<{ kind: string; ref: string }> }>;
    };
    expect(transitioned.transitioned).toBe(1);
    expect(transitioned.missing).toEqual([]);
    expect(transitioned.concerns[0]?.status).toBe('blocked');
    expect(transitioned.concerns[0]?.evidenceRefs).toEqual([{ kind: 'runtime', ref: 'operator-gate:1' }]);

    const batchResolved = JSON.parse(resultText(await tool.execute('call-resolve-many', {
      action: 'resolve',
      concernIds: [first.concern.id, second.concern.id],
      outcome: 'Handled together.',
    }))) as {
      resolved: number;
      missing: string[];
      concerns: Array<{ id: string; resolutionOutcome?: string }>;
    };
    expect(batchResolved.resolved).toBe(2);
    expect(batchResolved.missing).toEqual([]);
    expect(batchResolved.concerns.map(c => c.id).sort()).toEqual([first.concern.id, second.concern.id].sort());
    expect(batchResolved.concerns.every(c => c.resolutionOutcome === 'Handled together.')).toBe(true);
  });

  it('returns an actionable error when resolving without concernId or concernIds', async () => {
    const tool = makeTool();
    const result = await tool.execute('call-resolve-missing-id', {
      action: 'resolve',
    });
    const payload = JSON.parse(resultText(result)) as {
      error: string;
      required: string;
      hint: string;
    };

    expect(result.details?.isError).toBe(true);
    expect(payload.error).toBe('missing_required_parameter');
    expect(payload.required).toBe('concernId or concernIds');
    expect(payload.hint).toContain('concernId or concernIds');
    expect(payload.hint).toContain('Do not use tool_search');
  });
});
