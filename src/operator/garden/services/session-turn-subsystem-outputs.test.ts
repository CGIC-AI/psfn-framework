import { describe, expect, it, vi } from 'vitest';
import type { ContactStorePort } from '../../../core/contacts/contact-store-port.js';
import type { Contact } from '../../../core/contacts/types.js';
import type { ConcernStorePort } from '../../../core/intention/concern-store-port.js';
import type { ActiveConcern } from '../../../core/intention/concerns.js';
import type { MemoryStorePort } from '../../../faculties/memory/memory-store-port.js';
import type { PurrMemory } from '../../../faculties/memory/types.js';
import type { TurnRecord } from '../../../shared/contracts/runtime.js';
import {
  buildPromptLoomData,
  resolvePromptLoomSubsystemOutputs,
} from './session-turn-observability.js';
import { buildSubsystemOutputRef } from '../../../shared/contracts/subsystem-output-refs.js';

function buildRecord(overrides: Partial<TurnRecord> = {}): TurnRecord {
  return {
    schemaVersion: 1,
    turnId: 'turn-subsystem-1' as TurnRecord['turnId'],
    requestId: 'request-subsystem-1',
    channelId: 'api:subsystem-test',
    channelType: 'api',
    startedAt: 1,
    completedAt: 2,
    status: 'completed',
    userMessage: { role: 'user', content: 'test input', timestamp: 1 },
    assistantMessage: { role: 'assistant', content: 'test output', timestamp: 2 },
    toolCalls: [],
    contextManifestRef: 'session:api:subsystem-test|messages:2|memory_chars:24',
    internalStateSnapshotRef: 'internal-state-v1:0123456789abcdef',
    extractedMemoryIds: [buildSubsystemOutputRef('memory', 'memory-1')],
    concernDeltaRefs: [buildSubsystemOutputRef('concern', 'concern-1')],
    contactDeltaRefs: [buildSubsystemOutputRef('contact', 'contact-1')],
    versionPointers: { model: 'test-model' },
    provenanceRefs: [],
    ...overrides,
  };
}

function buildMemory(overrides: Partial<PurrMemory> = {}): PurrMemory {
  return {
    id: 'memory-1',
    text: 'A representative memory write.',
    type: 'semantic',
    importance: 0.8,
    confidence: 0.9,
    emotionalValence: 0.1,
    salience: 0.7,
    sourceRef: 'turn:turn-subsystem-1',
    extractedAt: 2,
    lastAccessed: 2,
    accessCount: 0,
    tags: ['test'],
    sensitivity: 'personal',
    ...overrides,
  };
}

function buildConcern(): ActiveConcern {
  return {
    id: 'concern-1',
    text: 'Follow up on the representative concern.',
    priority: 'medium',
    source: 'appraisal',
    status: 'candidate',
    createdAt: '2026-07-16T12:00:00.000Z',
    expiresAt: '2026-07-23T12:00:00.000Z',
    salience: 0.6,
    sensitivity: 'personal',
    owner: 'companion',
    evidenceRefs: [],
    resolutionEvidenceRefs: [],
    contactId: 'contact-1',
  };
}

function buildContact(): Contact {
  return {
    id: 'contact-1',
    displayName: 'Representative Contact',
    trustLevel: 'regular',
    relationshipType: 'friend',
    firstSeen: '2026-07-01T00:00:00.000Z',
    lastSeen: '2026-07-16T12:00:00.000Z',
    notes: 'This private note must not enter the Loom projection.',
  };
}

function stores(input: {
  memory?: PurrMemory;
  concern?: ActiveConcern | null;
  contact?: Contact;
} = {}): {
  memoryStore: MemoryStorePort;
  concernStore: ConcernStorePort;
  contactStore: ContactStorePort;
} {
  return {
    memoryStore: {
      getById: vi.fn(async id => id === input.memory?.id ? input.memory : undefined),
    } as unknown as MemoryStorePort,
    concernStore: {
      getById: vi.fn(async id => id === input.concern?.id ? input.concern : null),
    } as unknown as ConcernStorePort,
    contactStore: {
      getById: vi.fn(async id => id === input.contact?.id ? input.contact : undefined),
    } as unknown as ContactStorePort,
  };
}

describe('Prompt Loom subsystem output resolution', () => {
  it('resolves representative memory, concern, and contact refs without growing TurnRecord JSON', async () => {
    const record = buildRecord();
    const persistedBefore = JSON.stringify(record);
    const outputs = await resolvePromptLoomSubsystemOutputs(record, stores({
      memory: buildMemory(),
      concern: buildConcern(),
      contact: buildContact(),
    }));

    expect(outputs.contextManifestRef).toBe(record.contextManifestRef);
    expect(outputs.internalStateSnapshotRef).toBe(record.internalStateSnapshotRef);
    expect(outputs.memoryWrites).toEqual([expect.objectContaining({
      ref: buildSubsystemOutputRef('memory', 'memory-1'),
      status: 'resolved',
      value: expect.objectContaining({ id: 'memory-1', text: 'A representative memory write.' }),
    })]);
    expect(outputs.concernDeltas).toEqual([expect.objectContaining({
      ref: buildSubsystemOutputRef('concern', 'concern-1'),
      status: 'resolved',
      value: expect.objectContaining({ id: 'concern-1', status: 'candidate' }),
    })]);
    expect(outputs.contactDeltas).toEqual([expect.objectContaining({
      ref: buildSubsystemOutputRef('contact', 'contact-1'),
      status: 'resolved',
      value: expect.objectContaining({ id: 'contact-1' }),
    })]);
    expect(outputs.contactDeltas[0]?.value).not.toHaveProperty('notes');
    expect(outputs.contactDeltas[0]?.value).not.toHaveProperty('displayName');

    const loom = buildPromptLoomData(record, null, outputs);
    expect(loom.subsystemOutputs).toEqual(outputs);
    expect(JSON.stringify(record)).toBe(persistedBefore);
  });

  it('keeps missing and soft-deleted targets content-free', async () => {
    const outputs = await resolvePromptLoomSubsystemOutputs(buildRecord(), stores({
      memory: buildMemory({ deletedAt: 3, deletedBy: 'operator' }),
      concern: null,
    }));

    expect(outputs.memoryWrites).toEqual([{
      ref: buildSubsystemOutputRef('memory', 'memory-1'),
      status: 'missing',
    }]);
    expect(outputs.concernDeltas).toEqual([{
      ref: buildSubsystemOutputRef('concern', 'concern-1'),
      status: 'missing',
    }]);
    expect(outputs.contactDeltas).toEqual([{
      ref: buildSubsystemOutputRef('contact', 'contact-1'),
      status: 'missing',
    }]);
  });

  it('fails closed when a referenced subsystem has no configured store', async () => {
    const record = buildRecord({ concernDeltaRefs: [], contactDeltaRefs: [] });
    await expect(resolvePromptLoomSubsystemOutputs(record, {})).rejects.toThrow(
      'no memory store is configured',
    );
  });
});
