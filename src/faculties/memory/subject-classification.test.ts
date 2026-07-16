import { describe, expect, it } from 'vitest';
import type { PurrMemory } from './types.js';
import {
  classifyMemorySubject,
  createMemorySubjectEvidenceDigest,
} from './subject-classification.js';

function memory(overrides: Partial<PurrMemory> = {}): PurrMemory {
  return {
    id: overrides.id ?? 'memory-1',
    text: overrides.text ?? 'A durable memory',
    type: overrides.type ?? 'semantic',
    importance: overrides.importance ?? 0.7,
    confidence: overrides.confidence ?? 0.9,
    emotionalValence: overrides.emotionalValence ?? 0.1,
    salience: overrides.salience ?? 0.6,
    sourceRef: overrides.sourceRef ?? 'source:test',
    sourceType: overrides.sourceType ?? 'turn',
    extractedAt: overrides.extractedAt ?? 100,
    lastAccessed: overrides.lastAccessed ?? 100,
    accessCount: overrides.accessCount ?? 0,
    tags: overrides.tags ?? [],
    sensitivity: overrides.sensitivity ?? 'personal',
    consentFlags: overrides.consentFlags ?? {},
    ...(overrides.provenance ? { provenance: overrides.provenance } : {}),
    ...(overrides.provenanceRefs ? { provenanceRefs: overrides.provenanceRefs } : {}),
    ...(overrides.scopeRef ? { scopeRef: overrides.scopeRef } : {}),
    ...(overrides.scopeTags ? { scopeTags: overrides.scopeTags } : {}),
    ...(overrides.contactId ? { contactId: overrides.contactId } : {}),
    ...(overrides.embedding ? { embedding: overrides.embedding } : {}),
  };
}

describe('classifyMemorySubject', () => {
  it.each([
    [
      'single_contact',
      memory({ provenance: { subjectContactId: 'contact-a' } }),
      ['contact-a'],
    ],
    [
      'multiple_contacts',
      memory({ provenance: { subjectContactIds: ['contact-b', 'contact-a'] } }),
      ['contact-a', 'contact-b'],
    ],
    [
      'shared_room',
      memory({
        provenance: {
          subjectContactIds: ['contact-a', 'contact-b'],
          channelId: 'room-1',
          addressMode: 'overheard_room_context',
        },
      }),
      ['contact-a', 'contact-b'],
    ],
    [
      'companion_private',
      memory({ sourceType: 'reflection' }),
      [],
    ],
    [
      'unbound_person',
      memory({ provenance: { subjectName: '  A Person  ' } }),
      [],
    ],
    [
      'unattributed',
      memory({ provenance: { sourceContactId: 'speaker-only' } }),
      [],
    ],
    [
      'ambiguous',
      memory({
        provenance: { channelId: 'room-a', subjectContactId: 'contact-a' },
        scopeRef: { kind: 'conversation', id: 'room-b' },
      }),
      ['contact-a'],
    ],
  ] as const)('classifies %s without conflating the viewer or speaker', (subjectClass, input, contacts) => {
    const result = classifyMemorySubject(input, { memoryRevision: 3, now: 1234 });

    expect(result).toMatchObject({
      memoryId: input.id,
      subjectClass,
      status: 'current',
      memoryRevision: 3,
      subjectContactIds: contacts,
      classifiedAt: 1234,
      updatedAt: 1234,
    });
    expect(result.evidenceDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('reuses mention-routing precedence without treating a source speaker as the subject', () => {
    expect(classifyMemorySubject(memory({
      contactId: 'contact-mentioned',
      provenance: {
        sourceContactId: 'contact-speaker',
        routedContactId: 'contact-speaker',
        triggerContactId: 'contact-speaker',
      },
    }), { memoryRevision: 1 }).subjectContactIds).toEqual(['contact-mentioned']);

    expect(classifyMemorySubject(memory({
      contactId: 'contact-speaker',
      provenance: {
        sourceContactId: 'contact-speaker',
        routedContactId: 'contact-speaker',
        triggerContactId: 'contact-speaker',
      },
    }), { memoryRevision: 1 }).subjectClass).toBe('unattributed');
  });

  it('keeps explicit subject evidence authoritative when routing points elsewhere', () => {
    const result = classifyMemorySubject(memory({
      contactId: 'contact-routed',
      provenance: {
        subjectContactId: 'contact-subject',
        sourceContactId: 'contact-speaker',
        routedContactId: 'contact-routed',
        triggerContactId: 'contact-speaker',
      },
    }), { memoryRevision: 1 });

    expect(result).toMatchObject({
      subjectClass: 'single_contact',
      subjectContactIds: ['contact-subject'],
      reasonClass: 'explicit_single_subject',
    });
  });

  it('binds text, provenance, contact, provenance references, and embeddings into evidence digest', () => {
    const base = memory({
      provenance: { subjectContactId: 'contact-a' },
      provenanceRefs: ['turn:1'],
      embedding: new Float32Array([0.1, 0.2]),
    });
    const digest = createMemorySubjectEvidenceDigest(base);
    const mutations = [
      memory({ ...base, text: 'changed' }),
      memory({ ...base, provenance: { subjectContactId: 'contact-b' } }),
      memory({ ...base, contactId: 'contact-a' }),
      memory({ ...base, provenanceRefs: ['turn:2'] }),
      memory({ ...base, embedding: new Float32Array([0.2, 0.1]) }),
    ];

    expect(new Set(mutations.map(createMemorySubjectEvidenceDigest))).not.toContain(digest);
  });
});
