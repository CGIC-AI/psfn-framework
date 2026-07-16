import { describe, expect, it } from 'vitest';
import {
  MEMORY_SUBJECT_CLASSES,
  MEMORY_SUBJECT_CLASSIFIER_VERSION,
  MEMORY_VIEWER_RELATIONS,
  parseMemorySubjectClassification,
  parseMemorySubjectQueryAuthorization,
} from './memory-subject.js';

describe('memory subject contracts', () => {
  it('accepts every canonical subject class and keeps viewer relation separate', () => {
    for (const subjectClass of MEMORY_SUBJECT_CLASSES) {
      expect(parseMemorySubjectClassification({
        memoryId: 'memory-1',
        subjectClass,
        status: 'current',
        classifierVersion: MEMORY_SUBJECT_CLASSIFIER_VERSION,
        memoryRevision: 4,
        evidenceDigest: 'a'.repeat(64),
        evidence: ['explicit_subject_contact'],
        subjectContactIds: subjectClass === 'single_contact'
          ? ['contact-1']
          : (subjectClass === 'multiple_contacts' ? ['contact-1', 'contact-2'] : []),
        ...(subjectClass === 'shared_room' ? { roomId: 'room-1' } : {}),
        ...(subjectClass === 'unbound_person' ? { unboundPersonLabelHash: 'c'.repeat(64) } : {}),
        reasonClass: 'classified',
        classifiedAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
      }).subjectClass).toBe(subjectClass);
    }

    expect(MEMORY_VIEWER_RELATIONS).toEqual(['self', 'co_subject', 'other', 'none']);
  });

  it('rejects unknown classes, fields, malformed digests, and invalid revisions', () => {
    const base = {
      memoryId: 'memory-1',
      subjectClass: 'single_contact',
      status: 'current',
      classifierVersion: MEMORY_SUBJECT_CLASSIFIER_VERSION,
      memoryRevision: 1,
      evidenceDigest: 'b'.repeat(64),
      evidence: ['explicit_subject_contact'],
      subjectContactIds: ['contact-1'],
      reasonClass: 'classified',
      classifiedAt: 1,
      updatedAt: 1,
    };

    expect(() => parseMemorySubjectClassification({ ...base, subjectClass: 'everyone' }))
      .toThrow(/subjectClass/);
    expect(() => parseMemorySubjectClassification({ ...base, evidenceDigest: 'not-a-digest' }))
      .toThrow(/evidenceDigest/);
    expect(() => parseMemorySubjectClassification({ ...base, memoryRevision: 0 }))
      .toThrow(/memoryRevision/);
    expect(() => parseMemorySubjectClassification({ ...base, surprise: true }))
      .toThrow(/unknown keys/);
  });

  it('normalizes a fail-closed SQL authorization request and rejects unknown actions', () => {
    expect(parseMemorySubjectQueryAuthorization({
      action: 'prompt_preview',
      viewerContactIds: [' contact-1 ', 'contact-1'],
      allowedSubjectClasses: ['single_contact'],
      allowedViewerRelations: ['self'],
      classifierVersion: MEMORY_SUBJECT_CLASSIFIER_VERSION,
    })).toEqual({
      action: 'prompt_preview',
      viewerContactIds: ['contact-1'],
      allowedSubjectClasses: ['single_contact'],
      allowedViewerRelations: ['self'],
      classifierVersion: MEMORY_SUBJECT_CLASSIFIER_VERSION,
      grantBindings: [],
    });

    expect(() => parseMemorySubjectQueryAuthorization({
      action: 'read_everything',
      viewerContactIds: ['contact-1'],
      allowedSubjectClasses: ['single_contact'],
      allowedViewerRelations: ['self'],
      classifierVersion: MEMORY_SUBJECT_CLASSIFIER_VERSION,
    })).toThrow(/action/);
    expect(() => parseMemorySubjectQueryAuthorization({
      action: 'list',
      viewerContactIds: [],
      allowedSubjectClasses: ['single_contact'],
      allowedViewerRelations: ['self'],
      classifierVersion: MEMORY_SUBJECT_CLASSIFIER_VERSION,
    })).toThrow(/viewerContactIds/);
  });
});
