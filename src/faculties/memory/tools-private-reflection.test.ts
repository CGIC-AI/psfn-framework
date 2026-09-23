import { describe, expect, it } from 'vitest';
import { composeCompanionDmChannelId } from '../../shared/contracts/companion-channels.js';
import { createCompanionId } from '../../shared/routing/companion-id.js';
import { fromAny } from '@total-typescript/shoehorn';
import { InMemoryMemoryStore } from '../../test-support/in-memory-memory-store.js';
import { getRequestContext, runWithRequestContext } from '../../primitives/llm/request-context.js';
import { createSubjectAuthorizedMemoryStore, memorySubjectAccessContextFromCorrelation } from './subject-authorized-store.js';
import { createSharedBackgroundProvider } from './retrieval/shared-background.js';
import { MemoryRetriever } from './retrieval.js';
import { createMemoryTool } from './tools.js';
import type { PurrMemory } from './types.js';

function fixtureMemory(id: string, contactId?: string): PurrMemory {
  return {
    id, text: `Reflection evidence ${id}`, type: 'semantic', importance: 0.8,
    confidence: 0.9, emotionalValence: 0, salience: 0.7, sourceRef: 'test:reflection',
    extractedAt: 1, lastAccessed: 1, accessCount: 0, tags: [], sensitivity: 'confidential',
    consentFlags: { allowRecall: false },
    ...(contactId ? { contactId, provenance: { subjectContactId: contactId } } : {}),
  };
}

describe('private reflection memory tool authority', () => {
  it.each([undefined, 'contact-a'])('recalls every own subject and sensitivity with focus contact %s', async viewerMemorySubjectContactId => {
    const ownStore = new InMemoryMemoryStore();
    for (const memory of [{ ...fixtureMemory('own-private'), sourceType: 'reflection' as const }, fixtureMemory('own-unattributed'), fixtureMemory('own-a', 'contact-a'), fixtureMemory('own-b', 'contact-b')]) {
      await ownStore.insertMemory(memory, new Float32Array([1]));
    }
    await ownStore.insertMemory({ ...fixtureMemory('sibling-only'),
      provenance: { channelId: composeCompanionDmChannelId(
        createCompanionId('22222222-2222-4222-8222-222222222222'),
        createCompanionId('33333333-3333-4333-8333-333333333333'),
      ) },
    }, new Float32Array([1]));
    const store = createSubjectAuthorizedMemoryStore(ownStore, () => memorySubjectAccessContextFromCorrelation(getRequestContext()));
    const tool = createMemoryTool(fromAny({}), store, { retrievalAccessScope: () => 'companion_self_reflection', companionId: '11111111-1111-4111-8111-111111111111' });
    const context = {
      channelId: 'internal:reflection:daily-review', requesterProvenance: 'self_directed' as const,
      requestAudience: 'self' as const, callType: 'scheduled' as const, originType: 'scheduled' as const,
      purpose: 'agent.turn.prompt', originStage: 'agent.turn.prompt', viewerTrustLevel: 'regular' as const,
      viewerChannelPrivacy: 'private' as const, ...(viewerMemorySubjectContactId ? { viewerMemorySubjectContactId } : {}),
    };
    for (const action of ['search', 'census', 'exists']) {
      const result = await runWithRequestContext(context, () => tool.execute(`reflection-${action}`, { action, query: 'Reflection evidence' }));
      expect(result.details?.isError).not.toBe(true);
      const text = result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
      if (action === 'search') {
        expect(text).toContain('own-private');
        expect(text).toContain('own-unattributed');
        expect(text).toContain('own-a');
        expect(text).toContain('own-b');
      }
      expect(text).not.toContain('sibling-only');
      const foreign = await runWithRequestContext(context, () => tool.execute(`foreign-${action}`, { action, query: 'sibling-only' }));
      expect(JSON.stringify(foreign)).not.toContain('Reflection evidence sibling-only');
    }
  });

  it('keeps private contact-focused retrieval authorized over the whole own store', async () => {
    const store = new InMemoryMemoryStore();
    await store.insertMemory(fixtureMemory('other-contact', 'contact-b'), new Float32Array([1]));
    const retriever = new MemoryRetriever(store, fromAny({
      embed: async () => new Float32Array([1]),
    }), { retrievalLimit: 20 }, undefined, null, null, null, null, true);
    const output = await runWithRequestContext({
      channelId: 'internal:reflection:daily-review', requesterProvenance: 'self_directed',
      requestAudience: 'self', callType: 'scheduled', purpose: 'agent.turn.prompt',
    }, () => retriever.retrieve(
      'Reflection evidence', 'internal:reflection:daily-review', 'regular',
      undefined, 'contact-a', undefined, undefined, undefined, undefined,
      { accessScope: 'companion_self_reflection' },
    ));
    expect(output).toContain('other-contact');
  });

  it('admits confidential shared-background evidence only for trusted private reflection', async () => {
    const store = new InMemoryMemoryStore();
    await store.insertMemory({
      ...fixtureMemory('shared-confidential', 'contact-b'),
      provenance: { sourceAuthorId: 'contact-a', subjectContactId: 'contact-b' },
    }, new Float32Array([1]));
    const subjectStore = createSubjectAuthorizedMemoryStore(store, () => memorySubjectAccessContextFromCorrelation(getRequestContext()));
    const tool = createMemoryTool(fromAny({}), subjectStore, {
      retrievalAccessScope: () => getRequestContext()?.requestAudience === 'self' ? 'companion_self_reflection' : undefined,
      sharedBackgroundProvider: createSharedBackgroundProvider({
        memoryStore: subjectStore,
        contactStore: fromAny({
          getById: (id: string) => ({ id, displayName: id, conversationChannels: [] }),
          getSocialGraphEntityByContactId: () => undefined,
          listSocialRelationshipEdges: () => [],
        }),
      }),
    });
    for (const privateReflection of [true, false]) {
      const result = await runWithRequestContext({
        channelId: privateReflection ? 'internal:reflection:daily-review' : 'api:contact-b',
        requesterProvenance: privateReflection ? 'self_directed' : 'human',
        requestAudience: privateReflection ? 'self' : 'external',
        viewerTrustLevel: 'regular', viewerChannelPrivacy: 'private', viewerMemorySubjectContactId: 'contact-b',
      }, () => tool.execute('shared-background', { action: 'shared_background', contact_a: 'contact-a', contact_b: 'contact-b' }));
      expect(result.details?.isError).not.toBe(true);
      expect(JSON.stringify(result).includes('Reflection evidence shared-confidential')).toBe(privateReflection);
    }
  });

  it.each([
    { channelId: 'api:external', requesterProvenance: 'human' as const, requestAudience: 'external' as const },
    { channelId: 'internal:reflection:daily-review', requesterProvenance: 'human' as const, requestAudience: 'self' as const },
    { channelId: 'internal:reflection:daily-review', requesterProvenance: 'self_directed' as const, requestAudience: 'external' as const },
    { channelId: 'internal:reflection:daily-review', requesterProvenance: 'self_directed' as const },
  ])('rejects a reflection scope without private runtime authority: %j', async authority => {
    const store = new InMemoryMemoryStore();
    await store.insertMemory(fixtureMemory('must-stay-private', 'contact-other'), new Float32Array([1]));
    const subjectStore = createSubjectAuthorizedMemoryStore(store, () => memorySubjectAccessContextFromCorrelation(getRequestContext()));
    const tool = createMemoryTool(fromAny({}), subjectStore, { retrievalAccessScope: () => 'companion_self_reflection', companionId: '11111111-1111-4111-8111-111111111111' });
    const result = await runWithRequestContext({
      ...authority, callType: 'scheduled', purpose: 'agent.turn.prompt', viewerTrustLevel: 'primary',
      viewerChannelPrivacy: 'private', viewerMemorySubjectContactId: 'contact-a',
    }, () => tool.execute('spoofed-reflection', { action: 'search', query: 'Reflection evidence' }));
    expect(result.details?.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain('must-stay-private');
  });
});
