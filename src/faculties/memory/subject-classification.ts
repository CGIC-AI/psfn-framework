import { createHash } from 'node:crypto';
import {
  MEMORY_SUBJECT_CLASSIFIER_VERSION,
  type MemorySubjectClassification,
  type MemorySubjectEvidenceKind,
} from '../../shared/contracts/memory-subject.js';
import { resolveCanonicalMemorySubjectContactId } from './subject-evidence.js';
import type { PurrMemory } from './types.js';

export interface ClassifyMemorySubjectOptions {
  memoryRevision: number;
  now?: number;
  embedding?: Float32Array;
  validSubjectContactIds?: ReadonlySet<string>;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => (
    `${JSON.stringify(key)}:${stableStringify(record[key])}`
  )).join(',')}}`;
}

function normalizeIds(values: readonly (string | undefined)[]): string[] {
  return [...new Set(values.flatMap(value => {
    const normalized = value?.trim();
    return normalized ? [normalized] : [];
  }))].sort();
}

function resolveRoom(memory: Pick<PurrMemory, 'scopeRef' | 'provenance'>): {
  roomId?: string;
  inconsistent: boolean;
} {
  const scopeRoom = memory.scopeRef?.kind === 'conversation'
    ? memory.scopeRef.id.trim() || undefined
    : undefined;
  const provenanceRoom = memory.provenance?.channelId?.trim() || undefined;
  return {
    roomId: scopeRoom ?? provenanceRoom,
    inconsistent: scopeRoom !== undefined
      && provenanceRoom !== undefined
      && scopeRoom !== provenanceRoom,
  };
}

function embeddingForDigest(memory: PurrMemory, embedding?: Float32Array): number[] | null {
  const resolved = embedding ?? memory.embedding;
  return resolved ? Array.from(resolved) : null;
}

export function createMemorySubjectEvidenceDigest(
  memory: PurrMemory,
  embedding?: Float32Array,
): string {
  return createHash('sha256').update(stableStringify({
    text: memory.text,
    type: memory.type,
    sourceRef: memory.sourceRef,
    sourceType: memory.sourceType ?? 'unknown',
    provenance: memory.provenance ?? null,
    provenanceRefs: [...(memory.provenanceRefs ?? [])].sort(),
    contactId: memory.contactId ?? null,
    scopeRef: memory.scopeRef ?? null,
    scopeTags: [...(memory.scopeTags ?? [])].sort(),
    tags: [...memory.tags].sort(),
    embedding: embeddingForDigest(memory, embedding),
  })).digest('hex');
}

function isCompanionPrivate(memory: PurrMemory): boolean {
  return memory.sourceType === 'reflection'
    || memory.sourceType === 'heartbeat'
    || memory.sourceType === 'shard'
    || memory.sourceType === 'subagent'
    || memory.scopeRef?.kind === 'system'
    || memory.scopeRef?.kind === 'shard';
}

function hashUnboundSubject(name: string): string {
  return createHash('sha256').update(name.trim().toLocaleLowerCase('en-US')).digest('hex');
}

export function classifyMemorySubject(
  memory: PurrMemory,
  options: ClassifyMemorySubjectOptions,
): MemorySubjectClassification {
  if (!Number.isSafeInteger(options.memoryRevision) || options.memoryRevision < 1) {
    throw new Error('Memory subject classification requires a positive memory revision');
  }
  const now = options.now ?? Date.now();
  const room = resolveRoom(memory);
  const explicitContacts = normalizeIds([
    memory.provenance?.subjectContactId,
    ...(memory.provenance?.subjectContactIds ?? []),
  ]);
  const evidence: MemorySubjectEvidenceKind[] = [];
  let subjectClass: MemorySubjectClassification['subjectClass'];
  let subjectContactIds: string[] = [];
  let reasonClass: string;
  let unboundPersonLabelHash: string | undefined;

  if (room.inconsistent) {
    subjectClass = 'ambiguous';
    subjectContactIds = explicitContacts;
    evidence.push('contradictory_evidence');
    reasonClass = 'conflicting_room_evidence';
  } else if (explicitContacts.length > 0) {
    subjectContactIds = explicitContacts;
    evidence.push(explicitContacts.length === 1
      ? 'explicit_subject_contact'
      : 'explicit_subject_contacts');
    if (
      explicitContacts.length > 1
      && room.roomId
      && memory.provenance?.addressMode === 'overheard_room_context'
    ) {
      subjectClass = 'shared_room';
      evidence.push('structured_room');
      reasonClass = 'explicit_room_subjects';
    } else if (explicitContacts.length > 1) {
      subjectClass = 'multiple_contacts';
      reasonClass = 'explicit_multiple_subjects';
    } else {
      subjectClass = 'single_contact';
      reasonClass = 'explicit_single_subject';
    }
  } else {
    const routedSubject = resolveCanonicalMemorySubjectContactId(memory);
    if (routedSubject) {
      subjectClass = 'single_contact';
      subjectContactIds = [routedSubject];
      evidence.push('mention_routed_contact');
      reasonClass = 'canonical_mention_routing';
    } else if (isCompanionPrivate(memory)) {
      subjectClass = 'companion_private';
      evidence.push('companion_internal');
      reasonClass = 'companion_internal_source';
    } else if (memory.provenance?.subjectName?.trim()) {
      subjectClass = 'unbound_person';
      evidence.push('unbound_subject');
      reasonClass = 'unresolved_named_subject';
      unboundPersonLabelHash = hashUnboundSubject(memory.provenance.subjectName);
    } else {
      subjectClass = 'unattributed';
      evidence.push('no_subject_evidence');
      reasonClass = 'no_subject_evidence';
    }
  }

  const hasUnknownContact = options.validSubjectContactIds !== undefined
    && subjectContactIds.some(contactId => !options.validSubjectContactIds!.has(contactId));
  if (hasUnknownContact) {
    subjectClass = 'ambiguous';
    evidence.push('contradictory_evidence');
    reasonClass = 'unknown_subject_contact';
    unboundPersonLabelHash = undefined;
  }

  return {
    memoryId: memory.id,
    subjectClass,
    status: 'current',
    classifierVersion: MEMORY_SUBJECT_CLASSIFIER_VERSION,
    memoryRevision: options.memoryRevision,
    evidenceDigest: createMemorySubjectEvidenceDigest(memory, options.embedding),
    evidence,
    subjectContactIds,
    ...(subjectClass === 'shared_room' && room.roomId ? { roomId: room.roomId } : {}),
    ...(unboundPersonLabelHash ? { unboundPersonLabelHash } : {}),
    reasonClass,
    classifiedAt: now,
    updatedAt: now,
  };
}
