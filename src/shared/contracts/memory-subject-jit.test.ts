import { describe, expect, it } from 'vitest';
import type { MemorySubjectClassification } from './memory-subject.js';
import {
  memorySubjectClassifierEvidenceDigest,
  memorySubjectJitRequestFor,
  memorySubjectScopeDigest,
  parseMemorySubjectJitRequest,
} from './memory-subject-jit.js';

const CLASSIFICATION: MemorySubjectClassification = {
  memoryId: 'memory-a',
  subjectClass: 'single_contact',
  status: 'current',
  classifierVersion: 1,
  memoryRevision: 7,
  evidenceDigest: 'a'.repeat(64),
  evidence: ['explicit_subject_contact'],
  subjectContactIds: ['contact-a'],
  reasonClass: 'explicit_subject_contact',
  classifiedAt: 1,
  updatedAt: 2,
};

describe('memory subject JIT contract', () => {
  it('binds companion, memory, viewer relation, revision, classifier, and evidence', () => {
    const request = memorySubjectJitRequestFor({
      companionId: '11111111-1111-4111-8111-111111111111',
      memoryId: 'memory-a',
      viewerContactId: 'contact-a',
      viewerRelation: 'self',
      classification: CLASSIFICATION,
      purpose: 'Review my private memory',
    });
    expect(parseMemorySubjectJitRequest(request)).toEqual(request);
    expect(request).toMatchObject({
      memoryRevision: 7,
      classifierVersion: 1,
      purpose: 'Review my private memory',
    });
    expect(request.classifierEvidenceDigest).toBe(
      memorySubjectClassifierEvidenceDigest(CLASSIFICATION),
    );
    expect(memorySubjectScopeDigest({
      companionId: '11111111-1111-4111-8111-111111111111',
      memoryId: 'memory-a',
      viewerContactId: 'contact-a',
      viewerRelation: 'co_subject',
      classification: CLASSIFICATION,
    })).not.toBe(request.subjectScopeDigest);
    expect(memorySubjectScopeDigest({
      companionId: '22222222-2222-4222-8222-222222222222',
      memoryId: 'memory-a',
      viewerContactId: 'contact-a',
      viewerRelation: 'self',
      classification: CLASSIFICATION,
    })).not.toBe(request.subjectScopeDigest);
  });

  it('rejects malformed, stale, and non-subject inputs', () => {
    expect(() => parseMemorySubjectJitRequest({
      subjectScopeDigest: 'a'.repeat(64),
      purpose: 'reason',
      memoryRevision: 1,
      classifierVersion: 1,
      classifierEvidenceDigest: 'b'.repeat(64),
      role: 'owner',
    })).toThrow(/unknown/u);
    expect(() => memorySubjectScopeDigest({
      companionId: '11111111-1111-4111-8111-111111111111',
      memoryId: 'memory-a',
      viewerContactId: 'contact-other',
      viewerRelation: 'self',
      classification: CLASSIFICATION,
    })).toThrow(/current proven subject/u);
    expect(() => memorySubjectScopeDigest({
      companionId: '11111111-1111-4111-8111-111111111111',
      memoryId: 'memory-a',
      viewerContactId: 'contact-a',
      viewerRelation: 'self',
      classification: { ...CLASSIFICATION, status: 'invalidated' },
    })).toThrow(/current proven subject/u);
  });
});
