import { describe, expect, it } from 'vitest';
import { fromPartial } from '@total-typescript/shoehorn';

import type { MemoryStorePort } from '../memory-store-port.js';
import { classifyMemorySubject } from '../subject-classification.js';
import type { PurrMemory } from '../types.js';
import { InMemoryBiographicalProfileStore } from './in-memory-store.js';
import {
  discoverLiveBiographicalMemoryEvidence,
  rebuildBiographicalClaimsFromLiveSources,
} from './live-source-rebuild.js';
import type { BiographicalProfileStorePort } from './store-port.js';
import type { BiographicalSubjectRef } from './types.js';

const NOW = new Date('2026-08-10T12:00:00.000Z');
const CONTACT: BiographicalSubjectRef = {
  kind: 'contact',
  contactId: 'contact-1',
  subjectVersion: 1,
};
const COMPANION = {
  kind: 'companion' as const,
  companionId: 'purrsephone',
  subjectVersion: 1,
};

function memory(id: string, subjectContactId = 'contact-1'): PurrMemory {
  return fromPartial<PurrMemory>({
    id,
    text: 'The contact explicitly prefers concise technical explanations.',
    type: 'semantic',
    importance: 0.9,
    confidence: 0.95,
    salience: 0.8,
    emotionalValence: 0,
    sourceRef: `memory:${id}`,
    sourceType: 'conversation',
    extractedAt: NOW.getTime(),
    lastAccessed: NOW.getTime(),
    accessCount: 0,
    tags: ['preference'],
    sensitivity: 'personal',
    consentFlags: { allowRecall: true },
    contactId: subjectContactId,
    provenance: {
      channelId: 'discord:dm:contact-1',
      subjectContactId,
    },
  });
}

function store(rows: Map<string, PurrMemory>): MemoryStorePort {
  return fromPartial<MemoryStorePort>({
    getById: async (id: string) => rows.get(id),
    getMemorySubjectClassification: async (id: string) => {
      const row = rows.get(id);
      return row
        ? classifyMemorySubject(row, {
            memoryRevision: 1,
            now: NOW.getTime(),
            validSubjectContactIds: new Set(['contact-1', 'contact-2']),
          })
        : undefined;
    },
  });
}

function candidateResponse(sourceMemoryIds: readonly string[]): string {
  return `<recent_contact_shape><summary>Recent tone only.</summary></recent_contact_shape>
<biographical_candidates>${JSON.stringify([{
    kind: 'stable-preference',
    value: {
      kind: 'stable-preference',
      schemaVersion: 1,
      domain: 'communication',
      target: 'concise technical explanations',
      polarity: 'prefers',
    },
    basis: 'explicit',
    confidence: 0.95,
    sourceMemoryIds,
  }])}</biographical_candidates>`;
}

describe('live-source biographical rebuild', () => {
  it('admits a structured candidate using exact current canonical source snapshots', async () => {
    const rows = new Map([['memory-1', memory('memory-1')]]);
    const memoryStore = store(rows);
    const profileStore = new InMemoryBiographicalProfileStore(() => NOW);
    const evidence = await discoverLiveBiographicalMemoryEvidence({
      memoryStore,
      memoryIds: ['memory-1'],
      subject: CONTACT,
    });

    const result = await rebuildBiographicalClaimsFromLiveSources({
      responseContent: candidateResponse(['memory-1']),
      memoryStore,
      profileStore,
      subject: CONTACT,
      companionSubject: COMPANION,
      availableEvidence: evidence,
      depth: 'developing',
      candidateLimit: 4,
      now: NOW,
    });

    expect(result).toMatchObject({ emittedCount: 1, withheld: [] });
    expect(result.admittedClaimIds).toHaveLength(1);
    await expect(profileStore.listClaims({ subject: CONTACT, status: 'active' }))
      .resolves.toMatchObject([{
        kind: 'stable-preference',
        depthDecision: 'developing',
        sources: [{ ref: 'memory:memory-1', revision: '1' }],
      }]);
  });

  it('never parses legacy summary prose into a durable claim', async () => {
    const rows = new Map([['memory-1', memory('memory-1')]]);
    const memoryStore = store(rows);
    const profileStore = new InMemoryBiographicalProfileStore(() => NOW);
    const evidence = await discoverLiveBiographicalMemoryEvidence({
      memoryStore,
      memoryIds: ['memory-1'],
      subject: CONTACT,
    });

    const result = await rebuildBiographicalClaimsFromLiveSources({
      responseContent: '<profile><summary>The contact is a principal engineer.</summary></profile>',
      memoryStore,
      profileStore,
      subject: CONTACT,
      companionSubject: COMPANION,
      availableEvidence: evidence,
      depth: 'recognition',
      candidateLimit: 4,
      now: NOW,
    });

    expect(result).toEqual({ emittedCount: 0, admittedClaimIds: [], withheld: [] });
    await expect(profileStore.listClaims({ includeTerminal: true })).resolves.toEqual([]);
  });

  it('withholds candidates that cite another subject or drift after discovery', async () => {
    const rows = new Map([['memory-1', memory('memory-1')]]);
    const memoryStore = store(rows);
    const profileStore = new InMemoryBiographicalProfileStore(() => NOW);
    const evidence = await discoverLiveBiographicalMemoryEvidence({
      memoryStore,
      memoryIds: ['memory-1'],
      subject: CONTACT,
    });
    rows.set('memory-1', memory('memory-1', 'contact-2'));

    const result = await rebuildBiographicalClaimsFromLiveSources({
      responseContent: candidateResponse(['memory-1']),
      memoryStore,
      profileStore,
      subject: CONTACT,
      companionSubject: COMPANION,
      availableEvidence: evidence,
      depth: 'recognition',
      candidateLimit: 4,
      now: NOW,
    });

    expect(result.admittedClaimIds).toEqual([]);
    expect(result.withheld).toEqual([{ candidateIndex: 0, reason: 'source_drift' }]);
  });

  it('propagates operational admission failures instead of misreporting malformed model output', async () => {
    const rows = new Map([['memory-1', memory('memory-1')]]);
    const memoryStore = store(rows);
    const evidence = await discoverLiveBiographicalMemoryEvidence({
      memoryStore,
      memoryIds: ['memory-1'],
      subject: CONTACT,
    });
    const profileStore = fromPartial<BiographicalProfileStorePort>({
      runClaimTransaction: async () => {
        throw new Error('database unavailable');
      },
    });

    await expect(rebuildBiographicalClaimsFromLiveSources({
      responseContent: candidateResponse(['memory-1']),
      memoryStore,
      profileStore,
      subject: CONTACT,
      companionSubject: COMPANION,
      availableEvidence: evidence,
      depth: 'recognition',
      candidateLimit: 4,
      now: NOW,
    })).rejects.toThrow('database unavailable');
  });
});
