import {
  isCanonicalIsoTimestamp,
  isRecord,
} from '../../../shared/utils/types.js';

export const AUTOMATA_BUS_SCHEMA_VERSION = 1 as const;
export const AUTOMATA_BUS_RELATIONS_FEATURE = 'finding-relations-v1' as const;
export const AUTOMATA_BUS_LESSON_ATTRIBUTION_FEATURE = 'lesson-attribution-v1' as const;
export const AUTOMATA_BUS_SUPPORTED_FEATURES = [
  AUTOMATA_BUS_RELATIONS_FEATURE,
  AUTOMATA_BUS_LESSON_ATTRIBUTION_FEATURE,
] as const;

export type AutomataBusFeature = typeof AUTOMATA_BUS_SUPPORTED_FEATURES[number];
export type AutomataBusEventType = 'finding' | 'relation';
export type AutomataBusProvenance = 'computed' | 'fetched' | 'recalled' | 'testimony';
export type AutomataBusEvidenceKind = 'artifact' | 'command' | 'external' | 'session-span';
export type AutomataBusVerificationStatus = 'pending' | 'rejected' | 'verified';
export type AutomataBusRelationKind = 'corrects' | 'retracts' | 'supersedes';

export interface AutomataBusEventContext {
  automatonClass: string;
  runId: string;
  taskId: string;
  sessionIds: string[];
  artifactRefs: string[];
  parentRunId?: string;
}

export interface AutomataBusEvidence {
  kind: AutomataBusEvidenceKind;
  reference: string;
  summary: string;
  digest?: string;
}

export interface AutomataBusVerification {
  status: AutomataBusVerificationStatus;
  by?: string;
  artifactDigest?: string;
  evidenceRefs?: string[];
}

export interface AutomataBusLessonAttribution {
  promptRevision: string;
  toolName: string;
  failureCategory: string;
  lessonCode: string;
  contradictionEventIds: string[];
}

export interface AutomataBusFindingBody {
  claim: string;
  provenance: AutomataBusProvenance;
  evidence: AutomataBusEvidence[];
  verification: AutomataBusVerification;
  lessonAttribution?: AutomataBusLessonAttribution;
  source?: string;
  confidence?: number;
}

interface AutomataBusEventBase {
  schemaVersion: typeof AUTOMATA_BUS_SCHEMA_VERSION;
  eventId: string;
  companionId: string;
  sequence: number;
  occurredAt: string;
  mustUnderstand: AutomataBusFeature[];
  context: AutomataBusEventContext;
}

export interface AutomataBusFindingEvent extends AutomataBusEventBase {
  type: 'finding';
  body: AutomataBusFindingBody;
}

export interface AutomataBusRelationBody {
  targetEventId: string;
  relation: AutomataBusRelationKind;
  reason: string;
  replacement?: AutomataBusFindingBody;
}

export interface AutomataBusRelationEvent extends AutomataBusEventBase {
  type: 'relation';
  body: AutomataBusRelationBody;
}

export type AutomataBusEvent = AutomataBusFindingEvent | AutomataBusRelationEvent;

export interface AutomataBusAccepted<T> {
  status: 'accepted';
  value: T;
}

export interface AutomataBusRejected {
  status: 'rejected';
  issues: string[];
}

export interface AutomataBusNotUnderstood {
  status: 'not-understood';
  schemaVersion: number;
  unsupportedFeatures: string[];
  issues: string[];
}

export type AutomataBusParseResult<T> =
  | AutomataBusAccepted<T>
  | AutomataBusRejected
  | AutomataBusNotUnderstood;

const EVENT_KEYS = [
  'schemaVersion',
  'eventId',
  'companionId',
  'sequence',
  'occurredAt',
  'mustUnderstand',
  'context',
  'type',
  'body',
] as const;
const CONTEXT_KEYS = [
  'automatonClass',
  'runId',
  'taskId',
  'sessionIds',
  'artifactRefs',
  'parentRunId',
] as const;
const FINDING_KEYS = [
  'claim',
  'provenance',
  'evidence',
  'verification',
  'lessonAttribution',
  'source',
  'confidence',
] as const;
const EVIDENCE_KEYS = ['kind', 'reference', 'summary', 'digest'] as const;
const VERIFICATION_KEYS = ['status', 'by', 'artifactDigest', 'evidenceRefs'] as const;
const LESSON_ATTRIBUTION_KEYS = [
  'promptRevision',
  'toolName',
  'failureCategory',
  'lessonCode',
  'contradictionEventIds',
] as const;
const RELATION_KEYS = ['targetEventId', 'relation', 'reason', 'replacement'] as const;
const PROVENANCE_VALUES = ['computed', 'fetched', 'recalled', 'testimony'] as const;
const EVIDENCE_KIND_VALUES = ['artifact', 'command', 'external', 'session-span'] as const;
const VERIFICATION_STATUS_VALUES = ['pending', 'rejected', 'verified'] as const;
const RELATION_VALUES = ['corrects', 'retracts', 'supersedes'] as const;
const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const CONTENT_SAFE_ATTRIBUTION_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}$/u;

function reportUnknownKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  path: string,
  issues: string[],
): void {
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(value).filter(key => !allowed.has(key)).sort();
  if (unknown.length > 0) {
    issues.push(`${path} contains unknown fields: ${unknown.join(', ')}`);
  }
}

function readNonEmptyString(
  value: unknown,
  path: string,
  issues: string[],
): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) {
    issues.push(`${path} must be a non-empty string`);
    return undefined;
  }
  return value;
}

function readContentSafeAttribution(
  value: unknown,
  path: string,
  issues: string[],
): string | undefined {
  const parsed = readNonEmptyString(value, path, issues);
  if (parsed !== undefined && !CONTENT_SAFE_ATTRIBUTION_PATTERN.test(parsed)) {
    issues.push(`${path} must be a content-safe identifier`);
  }
  return parsed;
}

function readStringArray(
  value: unknown,
  path: string,
  issues: string[],
  options: { allowEmpty: boolean },
): string[] | undefined {
  if (!Array.isArray(value)) {
    issues.push(`${path} must be an array of non-empty strings`);
    return undefined;
  }
  const strings: string[] = [];
  for (const [index, item] of value.entries()) {
    const parsed = readNonEmptyString(item, `${path}[${index}]`, issues);
    if (parsed !== undefined) strings.push(parsed);
  }
  if (!options.allowEmpty && strings.length === 0) {
    issues.push(`${path} must not be empty`);
  }
  if (new Set(strings).size !== strings.length) {
    issues.push(`${path} must not contain duplicates`);
  }
  return strings;
}

function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

function readDigest(value: unknown, path: string, issues: string[]): string | undefined {
  const digest = readNonEmptyString(value, path, issues);
  if (digest !== undefined && !SHA256_DIGEST_PATTERN.test(digest)) {
    issues.push(`${path} must be a lowercase sha256 digest`);
  }
  return digest;
}

function parseContext(value: unknown, issues: string[]): AutomataBusEventContext | undefined {
  if (!isRecord(value)) {
    issues.push('event.context must be an object');
    return undefined;
  }
  reportUnknownKeys(value, CONTEXT_KEYS, 'event.context', issues);
  const automatonClass = readNonEmptyString(value.automatonClass, 'event.context.automatonClass', issues);
  const runId = readNonEmptyString(value.runId, 'event.context.runId', issues);
  const taskId = readNonEmptyString(value.taskId, 'event.context.taskId', issues);
  const sessionIds = readStringArray(
    value.sessionIds,
    'event.context.sessionIds',
    issues,
    { allowEmpty: true },
  );
  const artifactRefs = readStringArray(
    value.artifactRefs,
    'event.context.artifactRefs',
    issues,
    { allowEmpty: true },
  );
  const parentRunId = value.parentRunId === undefined
    ? undefined
    : readNonEmptyString(value.parentRunId, 'event.context.parentRunId', issues);
  if (
    automatonClass === undefined
    || runId === undefined
    || taskId === undefined
    || sessionIds === undefined
    || artifactRefs === undefined
  ) {
    return undefined;
  }
  return {
    automatonClass,
    runId,
    taskId,
    sessionIds,
    artifactRefs,
    ...(parentRunId !== undefined ? { parentRunId } : {}),
  };
}

function parseEvidence(value: unknown, index: number, issues: string[]): AutomataBusEvidence | undefined {
  const path = `event.body.evidence[${index}]`;
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    return undefined;
  }
  reportUnknownKeys(value, EVIDENCE_KEYS, path, issues);
  const kind = value.kind;
  if (!isOneOf(kind, EVIDENCE_KIND_VALUES)) {
    issues.push(`${path}.kind must be one of ${EVIDENCE_KIND_VALUES.join('|')}`);
  }
  const reference = readNonEmptyString(value.reference, `${path}.reference`, issues);
  const summary = readNonEmptyString(value.summary, `${path}.summary`, issues);
  const digest = value.digest === undefined
    ? undefined
    : readDigest(value.digest, `${path}.digest`, issues);
  if (!isOneOf(kind, EVIDENCE_KIND_VALUES) || reference === undefined || summary === undefined) {
    return undefined;
  }
  return { kind, reference, summary, ...(digest !== undefined ? { digest } : {}) };
}

function parseVerification(
  value: unknown,
  evidenceReferences: ReadonlySet<string>,
  issues: string[],
): AutomataBusVerification | undefined {
  if (!isRecord(value)) {
    issues.push('event.body.verification must be an object');
    return undefined;
  }
  reportUnknownKeys(value, VERIFICATION_KEYS, 'event.body.verification', issues);
  const status = value.status;
  if (!isOneOf(status, VERIFICATION_STATUS_VALUES)) {
    issues.push(`event.body.verification.status must be one of ${VERIFICATION_STATUS_VALUES.join('|')}`);
  }
  const by = value.by === undefined
    ? undefined
    : readNonEmptyString(value.by, 'event.body.verification.by', issues);
  const artifactDigest = value.artifactDigest === undefined
    ? undefined
    : readDigest(value.artifactDigest, 'event.body.verification.artifactDigest', issues);
  const evidenceRefs = value.evidenceRefs === undefined
    ? undefined
    : readStringArray(
        value.evidenceRefs,
        'event.body.verification.evidenceRefs',
        issues,
        { allowEmpty: false },
      );
  if (evidenceRefs !== undefined) {
    for (const reference of evidenceRefs) {
      if (!evidenceReferences.has(reference)) {
        issues.push(`event.body.verification.evidenceRefs names unknown evidence: ${reference}`);
      }
    }
  }
  if (status === 'verified' || status === 'rejected') {
    if (by === undefined) {
      issues.push(`event.body.verification status ${status} requires by`);
    }
    if (artifactDigest === undefined && (evidenceRefs === undefined || evidenceRefs.length === 0)) {
      issues.push(`event.body.verification status ${status} requires artifactDigest or evidenceRefs`);
    }
  }
  if (!isOneOf(status, VERIFICATION_STATUS_VALUES)) return undefined;
  return {
    status,
    ...(by !== undefined ? { by } : {}),
    ...(artifactDigest !== undefined ? { artifactDigest } : {}),
    ...(evidenceRefs !== undefined ? { evidenceRefs } : {}),
  };
}

function parseLessonAttribution(
  value: unknown,
  issues: string[],
): AutomataBusLessonAttribution | undefined {
  if (!isRecord(value)) {
    issues.push('event.body.lessonAttribution must be an object');
    return undefined;
  }
  reportUnknownKeys(value, LESSON_ATTRIBUTION_KEYS, 'event.body.lessonAttribution', issues);
  const promptRevision = readContentSafeAttribution(
    value.promptRevision,
    'event.body.lessonAttribution.promptRevision',
    issues,
  );
  const toolName = readContentSafeAttribution(
    value.toolName,
    'event.body.lessonAttribution.toolName',
    issues,
  );
  const failureCategory = readContentSafeAttribution(
    value.failureCategory,
    'event.body.lessonAttribution.failureCategory',
    issues,
  );
  const lessonCode = readContentSafeAttribution(
    value.lessonCode,
    'event.body.lessonAttribution.lessonCode',
    issues,
  );
  const contradictionEventIds = readStringArray(
    value.contradictionEventIds,
    'event.body.lessonAttribution.contradictionEventIds',
    issues,
    { allowEmpty: true },
  );
  if (
    promptRevision === undefined
    || toolName === undefined
    || failureCategory === undefined
    || lessonCode === undefined
    || contradictionEventIds === undefined
  ) return undefined;
  return { promptRevision, toolName, failureCategory, lessonCode, contradictionEventIds };
}

function parseFindingBody(
  value: unknown,
  context: AutomataBusEventContext,
  issues: string[],
): AutomataBusFindingBody | undefined {
  if (!isRecord(value)) {
    issues.push('event.body must be an object');
    return undefined;
  }
  reportUnknownKeys(value, FINDING_KEYS, 'event.body', issues);
  const claim = readNonEmptyString(value.claim, 'event.body.claim', issues);
  const provenance = value.provenance;
  if (!isOneOf(provenance, PROVENANCE_VALUES)) {
    issues.push(`event.body.provenance must be one of ${PROVENANCE_VALUES.join('|')}`);
  }
  const evidence: AutomataBusEvidence[] = [];
  if (!Array.isArray(value.evidence)) {
    issues.push('event.body.evidence must be an array');
  } else {
    for (const [index, entry] of value.evidence.entries()) {
      const parsed = parseEvidence(entry, index, issues);
      if (parsed !== undefined) evidence.push(parsed);
    }
  }
  const evidenceReferences = new Set([
    ...evidence.map(entry => entry.reference),
    ...context.artifactRefs,
  ]);
  const verification = parseVerification(value.verification, evidenceReferences, issues);
  const lessonAttribution = value.lessonAttribution === undefined
    ? undefined
    : parseLessonAttribution(value.lessonAttribution, issues);
  const source = value.source === undefined
    ? undefined
    : readNonEmptyString(value.source, 'event.body.source', issues);
  const confidence = value.confidence;
  if (
    confidence !== undefined
    && (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1)
  ) {
    issues.push('event.body.confidence must be a finite number in [0,1]');
  }
  if (provenance === 'computed' && evidence.length === 0) {
    issues.push('computed findings require structured evidence');
  }
  if (provenance === 'fetched' && !evidence.some(entry => entry.kind === 'external')) {
    issues.push('fetched findings require external evidence');
  }
  if (provenance === 'testimony' && source === undefined) {
    issues.push('testimony findings require source');
  }
  if (provenance === 'recalled' && verification?.status !== 'pending') {
    issues.push('recalled findings must remain pending until supported by evidence');
  }
  if (
    claim === undefined
    || !isOneOf(provenance, PROVENANCE_VALUES)
    || verification === undefined
    || !Array.isArray(value.evidence)
  ) {
    return undefined;
  }
  return {
    claim,
    provenance,
    evidence,
    verification,
    ...(lessonAttribution !== undefined ? { lessonAttribution } : {}),
    ...(source !== undefined ? { source } : {}),
    ...(typeof confidence === 'number' && Number.isFinite(confidence) ? { confidence } : {}),
  };
}

function parseRelationBody(
  value: unknown,
  context: AutomataBusEventContext,
  issues: string[],
): AutomataBusRelationBody | undefined {
  if (!isRecord(value)) {
    issues.push('event.body must be an object');
    return undefined;
  }
  reportUnknownKeys(value, RELATION_KEYS, 'event.body', issues);
  const targetEventId = readNonEmptyString(value.targetEventId, 'event.body.targetEventId', issues);
  const relation = value.relation;
  if (!isOneOf(relation, RELATION_VALUES)) {
    issues.push(`event.body.relation must be one of ${RELATION_VALUES.join('|')}`);
  }
  const reason = readNonEmptyString(value.reason, 'event.body.reason', issues);
  const replacement = value.replacement === undefined
    ? undefined
    : parseFindingBody(value.replacement, context, issues);
  if ((relation === 'corrects' || relation === 'supersedes') && replacement === undefined) {
    issues.push(`relation ${relation} requires a replacement finding`);
  }
  if (relation === 'retracts' && value.replacement !== undefined) {
    issues.push('relation retracts must not carry a replacement');
  }
  if (targetEventId === undefined || !isOneOf(relation, RELATION_VALUES) || reason === undefined) {
    return undefined;
  }
  return {
    targetEventId,
    relation,
    reason,
    ...(replacement !== undefined ? { replacement } : {}),
  };
}

function parseMustUnderstand(value: unknown, issues: string[]): string[] | undefined {
  if (value === undefined) return [];
  return readStringArray(value, 'event.mustUnderstand', issues, { allowEmpty: true });
}

/**
 * Parse one untrusted Automata Bus event without guessing at unknown semantics.
 * Newer generations and unsupported must-understand features are structurally
 * accepted only far enough to return `not-understood`; their bodies are never read.
 */
export function parseAutomataBusEvent(input: unknown): AutomataBusParseResult<AutomataBusEvent> {
  if (!isRecord(input)) {
    return { status: 'rejected', issues: ['event must be an object'] };
  }
  const structuralIssues: string[] = [];
  const schemaVersion = input.schemaVersion;
  if (!Number.isSafeInteger(schemaVersion) || typeof schemaVersion !== 'number' || schemaVersion < 1) {
    structuralIssues.push('event.schemaVersion must be a positive safe integer');
  }
  const eventId = readNonEmptyString(input.eventId, 'event.eventId', structuralIssues);
  const companionId = readNonEmptyString(input.companionId, 'event.companionId', structuralIssues);
  const sequence = input.sequence;
  if (!Number.isSafeInteger(sequence) || typeof sequence !== 'number' || sequence < 1) {
    structuralIssues.push('event.sequence must be a positive safe integer');
  }
  const occurredAt = readNonEmptyString(input.occurredAt, 'event.occurredAt', structuralIssues);
  if (occurredAt !== undefined && !isCanonicalIsoTimestamp(occurredAt)) {
    structuralIssues.push('event.occurredAt must be a canonical UTC ISO-8601 timestamp');
  }
  if (!isRecord(input.context)) structuralIssues.push('event.context must be an object');
  const type = readNonEmptyString(input.type, 'event.type', structuralIssues);
  if (!isRecord(input.body)) structuralIssues.push('event.body must be an object');
  const mustUnderstand = parseMustUnderstand(input.mustUnderstand, structuralIssues);
  if (structuralIssues.length > 0 || typeof schemaVersion !== 'number') {
    return { status: 'rejected', issues: structuralIssues };
  }

  const supportedFeatures = new Set<string>(AUTOMATA_BUS_SUPPORTED_FEATURES);
  const unsupportedFeatures = (mustUnderstand ?? []).filter(token => !supportedFeatures.has(token));
  if (schemaVersion > AUTOMATA_BUS_SCHEMA_VERSION || unsupportedFeatures.length > 0) {
    const reasons: string[] = [];
    if (schemaVersion > AUTOMATA_BUS_SCHEMA_VERSION) {
      reasons.push(
        `schema generation ${schemaVersion} is newer than ${AUTOMATA_BUS_SCHEMA_VERSION}`,
      );
    }
    if (unsupportedFeatures.length > 0) {
      reasons.push(`unsupported must-understand features: ${unsupportedFeatures.join(', ')}`);
    }
    return {
      status: 'not-understood',
      schemaVersion,
      unsupportedFeatures,
      issues: reasons,
    };
  }

  const issues: string[] = [];
  reportUnknownKeys(input, EVENT_KEYS, 'event', issues);
  const context = parseContext(input.context, issues);
  if (type !== 'finding' && type !== 'relation') {
    issues.push('event.type must be one of finding|relation');
  }
  if (type === 'relation' && !(mustUnderstand ?? []).includes(AUTOMATA_BUS_RELATIONS_FEATURE)) {
    issues.push(`relation events must declare ${AUTOMATA_BUS_RELATIONS_FEATURE} in mustUnderstand`);
  }
  const body = context === undefined
    ? undefined
    : type === 'finding'
      ? parseFindingBody(input.body, context, issues)
      : type === 'relation'
        ? parseRelationBody(input.body, context, issues)
        : undefined;
  const hasLessonAttribution = body !== undefined && (
    type === 'finding'
      ? (body as AutomataBusFindingBody).lessonAttribution !== undefined
      : type === 'relation'
        ? (body as AutomataBusRelationBody).replacement?.lessonAttribution !== undefined
        : false
  );
  if (
    hasLessonAttribution
    && !(mustUnderstand ?? []).includes(AUTOMATA_BUS_LESSON_ATTRIBUTION_FEATURE)
  ) {
    issues.push(
      `attributed findings must declare ${AUTOMATA_BUS_LESSON_ATTRIBUTION_FEATURE} in mustUnderstand`,
    );
  }
  if (
    issues.length > 0
    || eventId === undefined
    || companionId === undefined
    || typeof sequence !== 'number'
    || occurredAt === undefined
    || mustUnderstand === undefined
    || context === undefined
    || body === undefined
  ) {
    return { status: 'rejected', issues };
  }
  const base = {
    schemaVersion: AUTOMATA_BUS_SCHEMA_VERSION,
    eventId,
    companionId,
    sequence,
    occurredAt,
    mustUnderstand: mustUnderstand as AutomataBusFeature[],
    context,
  };
  return type === 'finding'
    ? { status: 'accepted', value: { ...base, type, body: body as AutomataBusFindingBody } }
    : { status: 'accepted', value: { ...base, type: 'relation', body: body as AutomataBusRelationBody } };
}

/** Validate ordering and lineage invariants over one companion's event history. */
export function validateAutomataBusHistory(
  inputs: readonly unknown[],
): AutomataBusParseResult<AutomataBusEvent[]> {
  const events: AutomataBusEvent[] = [];
  const rejected: string[] = [];
  const notUnderstood: AutomataBusNotUnderstood[] = [];
  for (const [index, input] of inputs.entries()) {
    const parsed = parseAutomataBusEvent(input);
    if (parsed.status === 'accepted') {
      events.push(parsed.value);
    } else if (parsed.status === 'rejected') {
      rejected.push(...parsed.issues.map(issue => `events[${index}]: ${issue}`));
    } else {
      notUnderstood.push({
        ...parsed,
        issues: parsed.issues.map(issue => `events[${index}]: ${issue}`),
      });
    }
  }
  if (rejected.length > 0) return { status: 'rejected', issues: rejected };
  if (notUnderstood.length > 0) {
    return {
      status: 'not-understood',
      schemaVersion: Math.max(...notUnderstood.map(result => result.schemaVersion)),
      unsupportedFeatures: [...new Set(notUnderstood.flatMap(result => result.unsupportedFeatures))].sort(),
      issues: notUnderstood.flatMap(result => result.issues),
    };
  }

  const issues: string[] = [];
  const seenIds = new Set<string>();
  const currentFindingIds = new Set<string>();
  let companionId: string | undefined;
  let previousSequence: number | undefined;
  for (const [index, event] of events.entries()) {
    if (companionId === undefined) companionId = event.companionId;
    if (event.companionId !== companionId) {
      issues.push(`events[${index}]: companionId differs from earlier events`);
    }
    if (seenIds.has(event.eventId)) {
      issues.push(`events[${index}]: duplicate eventId ${event.eventId}`);
    }
    if (previousSequence !== undefined && event.sequence <= previousSequence) {
      issues.push(`events[${index}]: sequence must increase across companion history`);
    }
    seenIds.add(event.eventId);
    previousSequence = event.sequence;
    if (event.type === 'finding') {
      currentFindingIds.add(event.eventId);
      continue;
    }
    const target = event.body.targetEventId;
    if (!currentFindingIds.has(target)) {
      issues.push(
        `events[${index}]: relation target ${target} is not an earlier current lineage end`,
      );
      continue;
    }
    currentFindingIds.delete(target);
    if (event.body.relation !== 'retracts') currentFindingIds.add(event.eventId);
  }
  return issues.length > 0
    ? { status: 'rejected', issues }
    : { status: 'accepted', value: events };
}
