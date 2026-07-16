import { describe, expect, it } from 'vitest';
import { MEMORY_SUBJECT_CLASSIFIER_VERSION } from '../../../shared/contracts/memory-subject.js';
import { buildMemorySubjectAuthorizationPredicate } from './subject-policy.js';

describe('buildMemorySubjectAuthorizationPredicate', () => {
  it('binds current projection revision, digest, class, viewer relation, and grant in SQL', () => {
    const predicate = buildMemorySubjectAuthorizationPredicate({
      action: 'detail',
      viewerContactIds: ['contact-a'],
      allowedSubjectClasses: ['single_contact'],
      allowedViewerRelations: ['self'],
      classifierVersion: MEMORY_SUBJECT_CLASSIFIER_VERSION,
      grantBindings: [{
        memoryId: 'memory-1',
        memoryRevision: 7,
        classifierVersion: MEMORY_SUBJECT_CLASSIFIER_VERSION,
        evidenceDigest: 'd'.repeat(64),
      }],
    }, { memoryAlias: 'candidate', firstParameter: 3 });

    expect(predicate.sql).toContain('classification.memory_revision = candidate.authorization_revision');
    expect(predicate.sql).toContain('classification.evidence_digest = candidate.subject_evidence_digest');
    expect(predicate.sql).toContain("classification.subject_class NOT IN ('ambiguous', 'unattributed', 'unbound_person')");
    expect(predicate.sql).toContain('subject_contact.contact_id = ANY');
    expect(predicate.sql).toContain('grant_binding."memoryRevision" = classification.memory_revision');
    expect(predicate.values).toEqual([
      MEMORY_SUBJECT_CLASSIFIER_VERSION,
      ['single_contact'],
      ['contact-a'],
      ['self'],
      JSON.stringify([{
        memoryId: 'memory-1',
        memoryRevision: 7,
        classifierVersion: MEMORY_SUBJECT_CLASSIFIER_VERSION,
        evidenceDigest: 'd'.repeat(64),
      }]),
    ]);
  });

  it('rejects malformed or version-mismatched policy instead of widening access', () => {
    expect(() => buildMemorySubjectAuthorizationPredicate({
      action: 'list',
      viewerContactIds: ['contact-a'],
      allowedSubjectClasses: ['single_contact'],
      allowedViewerRelations: ['self'],
      classifierVersion: MEMORY_SUBJECT_CLASSIFIER_VERSION + 1,
      grantBindings: [],
    })).toThrow(/classifier version/);
  });
});
