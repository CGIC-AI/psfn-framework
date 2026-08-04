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
    expect(predicate.sql).not.toContain('classification.subject_class NOT IN');
    expect(predicate.sql).toContain('classification.subject_class = ANY');
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
      false,
    ]);
  });

  it('keeps unresolved subject classes behind the explicit class and no-contact relation allowlists', () => {
    const predicate = buildMemorySubjectAuthorizationPredicate({
      action: 'list',
      viewerContactIds: ['contact-admin'],
      allowedSubjectClasses: ['unbound_person', 'unattributed', 'ambiguous'],
      allowedViewerRelations: ['none'],
      classifierVersion: MEMORY_SUBJECT_CLASSIFIER_VERSION,
      grantBindings: [],
    });

    expect(predicate.sql).toContain('classification.subject_class = ANY($2::text[])');
    expect(predicate.sql).toContain("'none' = ANY($4::text[])");
    expect(predicate.sql).toContain('NOT EXISTS (');
    expect(predicate.values[1]).toEqual(['unbound_person', 'unattributed', 'ambiguous']);
    expect(predicate.values[3]).toEqual(['none']);
  });

  it('activates the D1 high-sensitivity other-relation carve-out only when requested', () => {
    const predicate = buildMemorySubjectAuthorizationPredicate({
      action: 'detail',
      viewerContactIds: ['contact-a'],
      allowedSubjectClasses: [
        'single_contact', 'multiple_contacts', 'shared_room', 'companion_private',
      ],
      allowedViewerRelations: ['self', 'co_subject', 'other', 'none'],
      classifierVersion: MEMORY_SUBJECT_CLASSIFIER_VERSION,
      grantBindings: [],
      excludeHighSensitivityOtherRelation: true,
    }, { memoryAlias: 'memory' });
    expect(predicate.sql).toContain("COALESCE(memory.sensitivity, 'personal') IN ('intimate', 'confidential')");
    expect(predicate.values.at(-1)).toBe(true);

    const withoutCarveOut = buildMemorySubjectAuthorizationPredicate({
      action: 'detail',
      viewerContactIds: ['contact-a'],
      allowedSubjectClasses: ['single_contact'],
      allowedViewerRelations: ['self'],
      classifierVersion: MEMORY_SUBJECT_CLASSIFIER_VERSION,
      grantBindings: [],
    }, { memoryAlias: 'memory' });
    expect(withoutCarveOut.values.at(-1)).toBe(false);
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
