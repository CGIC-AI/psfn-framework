import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

import { isRecord } from '../../../shared/utils/types.js';
import type {
  AutomataBusEvidence,
} from './contract.js';
import {
  AUTOMATA_BUS_TOOL_ACTIONS,
  type AutomataBusToolAction,
  type AutomataBusWorkerBounds,
  type AutomataBusWorkerOperation,
} from './worker-access-contracts.js';

export const AUTOMATA_BUS_TOOL_PARAMETERS = Type.Object({
  action: Type.Union(AUTOMATA_BUS_TOOL_ACTIONS.map(action => Type.Literal(action))),
  query: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1 })),
  claim: Type.Optional(Type.String()),
  provenance: Type.Optional(Type.Union([
    Type.Literal('computed'), Type.Literal('fetched'), Type.Literal('recalled'), Type.Literal('testimony'),
  ])),
  evidence: Type.Optional(Type.Array(Type.Object({
    kind: Type.Union([
      Type.Literal('artifact'), Type.Literal('command'), Type.Literal('external'), Type.Literal('session-span'),
    ]),
    reference: Type.String(),
    summary: Type.String(),
    digest: Type.Optional(Type.String()),
  }, { additionalProperties: false }))),
  artifact_refs: Type.Optional(Type.Array(Type.String())),
  verification_status: Type.Optional(Type.Union([
    Type.Literal('pending'), Type.Literal('rejected'), Type.Literal('verified'),
  ])),
  source: Type.Optional(Type.String()),
  confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  lesson_attribution: Type.Optional(Type.Object({
    prompt_revision: Type.String(),
    tool_name: Type.String(),
    failure_category: Type.String(),
    lesson_code: Type.String(),
    contradiction_event_ids: Type.Array(Type.String()),
  }, { additionalProperties: false })),
  target_event_id: Type.Optional(Type.String()),
  relation: Type.Optional(Type.Union([
    Type.Literal('corrects'), Type.Literal('retracts'), Type.Literal('supersedes'),
  ])),
  reason: Type.Optional(Type.String()),
  replacement_claim: Type.Optional(Type.String()),
  summary: Type.Optional(Type.String()),
  output_refs: Type.Optional(Type.Array(Type.String())),
  validation_performed: Type.Optional(Type.Array(Type.String())),
  blocker: Type.Optional(Type.String()),
  next_action: Type.Optional(Type.String()),
  status: Type.Optional(Type.String()),
  class_id: Type.Optional(Type.String()),
  task_id: Type.Optional(Type.String()),
  event_id: Type.Optional(Type.String()),
  run_id: Type.Optional(Type.String()),
}, { additionalProperties: false });

type AutomataBusToolParams = Static<typeof AUTOMATA_BUS_TOOL_PARAMETERS>;

const ACTION_KEYS: Readonly<Record<AutomataBusToolAction, ReadonlySet<string>>> = {
  brief: new Set(['action', 'query']),
  search: new Set(['action', 'query', 'limit']),
  append: new Set([
    'action', 'claim', 'provenance', 'evidence', 'artifact_refs', 'verification_status', 'source', 'confidence',
    'lesson_attribution',
  ]),
  correct: new Set(['action', 'target_event_id', 'relation', 'reason', 'replacement_claim']),
  handoff: new Set([
    'action', 'summary', 'output_refs', 'validation_performed', 'blocker', 'next_action',
  ]),
  runs: new Set(['action', 'status', 'class_id', 'task_id', 'limit']),
  inspect: new Set(['action', 'event_id', 'run_id']),
};

function boundedText(
  value: unknown,
  field: string,
  bounds: AutomataBusWorkerBounds,
  required = false,
): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} must be non-empty`);
  const max = field === 'query' ? bounds.maxQueryChars : bounds.maxTextChars;
  if (normalized.length > max) throw new Error(`${field} exceeds its ${max}-character bound`);
  return normalized;
}

function boundedTexts(
  value: unknown,
  field: string,
  bounds: AutomataBusWorkerBounds,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  if (value.length > bounds.maxArrayItems) {
    throw new Error(`${field} exceeds maxArrayItems (${bounds.maxArrayItems})`);
  }
  return value.map((entry, index) => boundedText(entry, `${field}[${index}]`, bounds, true)!);
}

function boundedEvidence(
  value: unknown,
  bounds: AutomataBusWorkerBounds,
): AutomataBusEvidence[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('evidence must be an array');
  if (value.length > bounds.maxArrayItems) {
    throw new Error(`evidence exceeds maxArrayItems (${bounds.maxArrayItems})`);
  }
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`evidence[${index}] must be an object`);
    const unknown = Object.keys(entry)
      .filter(key => !['kind', 'reference', 'summary', 'digest'].includes(key));
    if (unknown.length > 0) {
      throw new Error(`evidence[${index}] contains unknown fields: ${unknown.sort().join(', ')}`);
    }
    if (!['artifact', 'command', 'external', 'session-span'].includes(String(entry.kind))) {
      throw new Error(`evidence[${index}].kind is invalid`);
    }
    const reference = boundedText(entry.reference, `evidence[${index}].reference`, bounds, true)!;
    const summary = boundedText(entry.summary, `evidence[${index}].summary`, bounds, true)!;
    const digest = boundedText(entry.digest, `evidence[${index}].digest`, bounds);
    if (digest !== undefined && !/^sha256:[0-9a-f]{64}$/u.test(digest)) {
      throw new Error(`evidence[${index}].digest must be a lowercase sha256 digest`);
    }
    return {
      kind: entry.kind as AutomataBusEvidence['kind'],
      reference,
      summary,
      ...(digest !== undefined ? { digest } : {}),
    };
  });
}

function boundedLimit(value: unknown, field: string, maximum: number): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new Error(`${field} must be an integer between 1 and ${maximum}`);
  }
  return value as number;
}

function requiredBoundedText(
  value: unknown,
  field: string,
  bounds: AutomataBusWorkerBounds,
): string {
  const normalized = boundedText(value, field, bounds, true);
  if (normalized === undefined) throw new Error(`${field} must be non-empty`);
  return normalized;
}

/** Validate provider/model arguments and normalize them into the canonical dispatch shape. */
export function normalizeAutomataBusWorkerOperation(
  params: unknown,
  bounds: AutomataBusWorkerBounds,
): AutomataBusWorkerOperation {
  if (!isRecord(params) || !AUTOMATA_BUS_TOOL_ACTIONS.includes(params.action as AutomataBusToolAction)) {
    throw new Error(`action must be one of: ${AUTOMATA_BUS_TOOL_ACTIONS.join(', ')}`);
  }
  const action = params.action as AutomataBusToolAction;
  const allowed = ACTION_KEYS[action];
  const unknown = Object.keys(params).filter(key => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`action=${action} contains unknown fields: ${unknown.sort().join(', ')}`);
  }
  if (!Value.Check(AUTOMATA_BUS_TOOL_PARAMETERS, params)) {
    throw new Error(`action=${action} arguments do not match the automata_bus schema`);
  }
  const typed = params as AutomataBusToolParams;
  switch (action) {
    case 'brief': {
      const query = boundedText(typed.query, 'query', bounds);
      return { action, ...(query === undefined ? {} : { query }) };
    }
    case 'search': {
      const limit = boundedLimit(typed.limit, 'limit', bounds.maxSearchResults);
      return {
        action,
        query: requiredBoundedText(typed.query, 'query', bounds),
        ...(limit === undefined ? {} : { limit }),
      };
    }
    case 'append': {
      const claim = requiredBoundedText(typed.claim, 'claim', bounds);
      const provenance = typed.provenance ?? 'computed';
      const evidence = boundedEvidence(typed.evidence, bounds);
      const artifactRefs = boundedTexts(typed.artifact_refs, 'artifact_refs', bounds) ?? [];
      const verificationStatus = typed.verification_status ?? 'pending';
      const source = boundedText(typed.source, 'source', bounds);
      let confidence: number | undefined;
      if (typed.confidence !== undefined) {
        if (!Number.isFinite(typed.confidence) || typed.confidence < 0 || typed.confidence > 1) {
          throw new Error('confidence must be a finite number in [0,1]');
        }
        confidence = typed.confidence;
      }
      let normalizedLessonAttribution: Extract<
        AutomataBusWorkerOperation,
        { action: 'append' }
      >['lessonAttribution'];
      if (typed.lesson_attribution !== undefined) {
        normalizedLessonAttribution = {
          promptRevision: requiredBoundedText(
            typed.lesson_attribution.prompt_revision,
            'lesson_attribution.prompt_revision',
            bounds,
          ),
          toolName: requiredBoundedText(
            typed.lesson_attribution.tool_name,
            'lesson_attribution.tool_name',
            bounds,
          ),
          failureCategory: requiredBoundedText(
            typed.lesson_attribution.failure_category,
            'lesson_attribution.failure_category',
            bounds,
          ),
          lessonCode: requiredBoundedText(
            typed.lesson_attribution.lesson_code,
            'lesson_attribution.lesson_code',
            bounds,
          ),
          contradictionEventIds: boundedTexts(
            typed.lesson_attribution.contradiction_event_ids,
            'lesson_attribution.contradiction_event_ids',
            bounds,
          ) ?? [],
        };
      }
      if (provenance === 'computed' && evidence.length === 0) {
        throw new Error('computed findings require structured evidence');
      }
      if (
        provenance === 'fetched'
        && !evidence.some(entry => entry.kind === 'external')
      ) {
        throw new Error('fetched findings require external evidence');
      }
      if (provenance === 'testimony' && source === undefined) {
        throw new Error('testimony findings require source');
      }
      if (provenance === 'recalled' && verificationStatus !== 'pending') {
        throw new Error('recalled findings must remain pending');
      }
      if (verificationStatus !== 'pending' && evidence.length === 0) {
        throw new Error('verified or rejected findings require evidence');
      }
      return {
        action,
        claim,
        provenance,
        evidence,
        artifactRefs,
        verificationStatus,
        ...(source === undefined ? {} : { source }),
        ...(confidence === undefined ? {} : { confidence }),
        ...(normalizedLessonAttribution === undefined
          ? {}
          : { lessonAttribution: normalizedLessonAttribution }),
      };
    }
    case 'correct': {
      if (!typed.relation) throw new Error('relation is required for action=correct');
      const replacementClaim = boundedText(typed.replacement_claim, 'replacement_claim', bounds);
      if (typed.relation !== 'retracts' && replacementClaim === undefined) {
        throw new Error('replacement_claim is required for corrects and supersedes');
      }
      if (typed.relation === 'retracts' && replacementClaim !== undefined) {
        throw new Error('replacement_claim is not allowed for retracts');
      }
      return {
        action,
        targetEventId: requiredBoundedText(typed.target_event_id, 'target_event_id', bounds),
        relation: typed.relation,
        reason: requiredBoundedText(typed.reason, 'reason', bounds),
        ...(replacementClaim === undefined ? {} : { replacementClaim }),
      };
    }
    case 'handoff': {
      const blocker = boundedText(typed.blocker, 'blocker', bounds);
      const nextAction = boundedText(typed.next_action, 'next_action', bounds);
      return {
        action,
        summary: requiredBoundedText(typed.summary, 'summary', bounds),
        outputRefs: boundedTexts(typed.output_refs, 'output_refs', bounds) ?? [],
        validationPerformed: boundedTexts(
          typed.validation_performed,
          'validation_performed',
          bounds,
        ) ?? [],
        ...(blocker === undefined ? {} : { blocker }),
        ...(nextAction === undefined ? {} : { nextAction }),
      };
    }
    case 'runs': {
      const status = boundedText(typed.status, 'status', bounds);
      const classId = boundedText(typed.class_id, 'class_id', bounds);
      const taskId = boundedText(typed.task_id, 'task_id', bounds);
      const limit = boundedLimit(typed.limit, 'limit', bounds.maxRunResults);
      return {
        action,
        ...(status === undefined ? {} : { status }),
        ...(classId === undefined ? {} : { classId }),
        ...(taskId === undefined ? {} : { taskId }),
        ...(limit === undefined ? {} : { limit }),
      };
    }
    case 'inspect': {
      const eventId = boundedText(typed.event_id, 'event_id', bounds);
      const runId = boundedText(typed.run_id, 'run_id', bounds);
      if (eventId === undefined && runId === undefined) {
        throw new Error('event_id or run_id is required for action=inspect');
      }
      return {
        action,
        ...(eventId === undefined ? {} : { eventId }),
        ...(runId === undefined ? {} : { runId }),
      };
    }
  }
}
