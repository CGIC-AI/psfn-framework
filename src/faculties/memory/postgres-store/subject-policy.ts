import {
  MEMORY_SUBJECT_CLASSIFIER_VERSION,
  parseMemorySubjectQueryAuthorization,
  type MemorySubjectQueryAuthorization,
} from '../../../shared/contracts/memory-subject.js';

export interface MemorySubjectAuthorizationPredicate {
  sql: string;
  values: unknown[];
}

export interface MemorySubjectAuthorizationPredicateOptions {
  memoryAlias?: string;
  firstParameter?: number;
}

const SQL_ALIAS_PATTERN = /^[a-z][a-z0-9_]*$/u;

export function buildMemorySubjectAuthorizationPredicate(
  input: MemorySubjectQueryAuthorization,
  options: MemorySubjectAuthorizationPredicateOptions = {},
): MemorySubjectAuthorizationPredicate {
  const authorization = parseMemorySubjectQueryAuthorization(input);
  if (authorization.classifierVersion !== MEMORY_SUBJECT_CLASSIFIER_VERSION) {
    throw new Error(
      `Memory subject authorization classifier version ${authorization.classifierVersion} is stale or unsupported`,
    );
  }
  const memoryAlias = options.memoryAlias ?? 'memory';
  if (!SQL_ALIAS_PATTERN.test(memoryAlias)) {
    throw new Error('Memory subject SQL alias is invalid');
  }
  const firstParameter = options.firstParameter ?? 1;
  if (!Number.isSafeInteger(firstParameter) || firstParameter < 1) {
    throw new Error('Memory subject SQL first parameter must be a positive integer');
  }
  const classifierVersionParameter = `$${firstParameter}`;
  const subjectClassesParameter = `$${firstParameter + 1}`;
  const viewerContactsParameter = `$${firstParameter + 2}`;
  const viewerRelationsParameter = `$${firstParameter + 3}`;
  const grantBindingsParameter = `$${firstParameter + 4}`;

  return {
    sql: `EXISTS (
      SELECT 1
      FROM l2_memory_subject_classifications classification
      WHERE classification.memory_id = ${memoryAlias}.id
        AND classification.status = 'current'
        AND classification.classifier_version = ${classifierVersionParameter}
        AND classification.memory_revision = ${memoryAlias}.authorization_revision
        AND classification.evidence_digest = ${memoryAlias}.subject_evidence_digest
        AND classification.subject_class NOT IN ('ambiguous', 'unattributed', 'unbound_person')
        AND classification.subject_class = ANY(${subjectClassesParameter}::text[])
        AND (
          'companion_private' = ANY(${subjectClassesParameter}::text[])
          OR NOT (
            lower(${memoryAlias}.source_ref) LIKE 'source:context_feedback|%'
            OR (
              jsonb_typeof(${memoryAlias}.tags) = 'array'
              AND EXISTS (
                SELECT 1
                FROM jsonb_array_elements_text(${memoryAlias}.tags) AS internal_tag(value)
                WHERE lower(internal_tag.value) = 'context_feedback'
              )
            )
          )
        )
        AND (
          (
            'self' = ANY(${viewerRelationsParameter}::text[])
            AND classification.subject_class = 'single_contact'
            AND EXISTS (
              SELECT 1 FROM l2_memory_subject_contacts subject_contact
              WHERE subject_contact.memory_id = classification.memory_id
                AND subject_contact.contact_id = ANY(${viewerContactsParameter}::text[])
            )
          )
          OR (
            'co_subject' = ANY(${viewerRelationsParameter}::text[])
            AND classification.subject_class IN ('multiple_contacts', 'shared_room')
            AND EXISTS (
              SELECT 1 FROM l2_memory_subject_contacts subject_contact
              WHERE subject_contact.memory_id = classification.memory_id
                AND subject_contact.contact_id = ANY(${viewerContactsParameter}::text[])
            )
          )
          OR (
            'other' = ANY(${viewerRelationsParameter}::text[])
            AND EXISTS (
              SELECT 1 FROM l2_memory_subject_contacts subject_contact
              WHERE subject_contact.memory_id = classification.memory_id
            )
            AND NOT EXISTS (
              SELECT 1 FROM l2_memory_subject_contacts subject_contact
              WHERE subject_contact.memory_id = classification.memory_id
                AND subject_contact.contact_id = ANY(${viewerContactsParameter}::text[])
            )
          )
          OR (
            'none' = ANY(${viewerRelationsParameter}::text[])
            AND NOT EXISTS (
              SELECT 1 FROM l2_memory_subject_contacts subject_contact
              WHERE subject_contact.memory_id = classification.memory_id
            )
          )
        )
        AND (
          ${grantBindingsParameter}::jsonb = '[]'::jsonb
          OR EXISTS (
            SELECT 1
            FROM jsonb_to_recordset(${grantBindingsParameter}::jsonb) AS grant_binding(
              "memoryId" text,
              "memoryRevision" bigint,
              "classifierVersion" integer,
              "evidenceDigest" text
            )
            WHERE grant_binding."memoryId" = classification.memory_id
              AND grant_binding."memoryRevision" = classification.memory_revision
              AND grant_binding."classifierVersion" = classification.classifier_version
              AND grant_binding."evidenceDigest" = classification.evidence_digest
          )
        )
    )`,
    values: [
      authorization.classifierVersion,
      authorization.allowedSubjectClasses,
      authorization.viewerContactIds,
      authorization.allowedViewerRelations,
      JSON.stringify(authorization.grantBindings),
    ],
  };
}
