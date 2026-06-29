import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import {
  ACTIVE_CONCERN_EVIDENCE_KINDS,
  ACTIVE_CONCERN_OWNERS,
  ACTIVE_CONCERN_PRIORITIES,
  ACTIVE_CONCERN_SENSITIVITIES,
  ACTIVE_CONCERN_STATUSES,
  type ActiveConcernEvidenceRef,
  type ActiveConcernOwner,
  type ActiveConcernPriority,
  type ActiveConcernSensitivity,
  type ActiveConcernStatus,
} from './concerns.js';
import type { ConcernStorePort } from './concern-store-port.js';
import { textResultWithError } from '../tools/results.js';
import { toErrorMessage } from '../../shared/utils/errors.js';

interface ListConcernsParams {
  contactId?: string;
  includeResolved?: boolean;
  includeExpired?: boolean;
  limit?: number;
}

interface ResolveConcernParams {
  concernId: string;
  outcome?: string;
  evidenceRefs?: ActiveConcernEvidenceRef[];
}

interface CreateConcernParams {
  text: string;
  priority?: ActiveConcernPriority;
  contactId?: string;
  source?: 'appraisal' | 'agent' | 'heartbeat';
  status?: ActiveConcernStatus;
  salience?: number;
  sensitivity?: ActiveConcernSensitivity;
  owner?: ActiveConcernOwner;
  evidenceRefs?: ActiveConcernEvidenceRef[];
  reopenResolved?: boolean;
  nextReviewAt?: string;
}

const CONCERN_EVIDENCE_REF_SCHEMA = Type.Object({
  kind: Type.Unsafe<ActiveConcernEvidenceRef['kind']>({
    type: 'string',
    enum: [...ACTIVE_CONCERN_EVIDENCE_KINDS],
    description: 'Safe evidence reference kind. Do not include raw sensitive content.',
  }),
  ref: Type.String({
    minLength: 1,
    maxLength: 240,
    description: 'Opaque id, pointer, or stable reference. Do not include raw source text.',
  }),
  sensitivity: Type.Optional(Type.Unsafe<ActiveConcernSensitivity>({
    type: 'string',
    enum: [...ACTIVE_CONCERN_SENSITIVITIES],
  })),
  redacted: Type.Optional(Type.Boolean({
    description: 'True when this points to redacted or sensitive source material.',
  })),
  hash: Type.Optional(Type.String({
    minLength: 1,
    maxLength: 240,
    description: 'Optional digest for source verification without copying source content.',
  })),
});

function textResult(text: string): AgentToolResult<{ isError?: boolean }> {
  return {
    content: [{ type: 'text', text }],
    details: {},
  };
}

export function createListConcernsTool(store: ConcernStorePort): AgentTool<any> {
  return {
    name: 'list_concerns',
    label: 'list_concerns',
    description:
      'List active open threads, reminders, checkups, and proactive follow-up items. '
      + 'These are not necessarily negative problems; they are short-lived attention threads.',
    parameters: Type.Object({
      contactId: Type.Optional(Type.String({ minLength: 1, description: 'Optional contact id filter.' })),
      includeResolved: Type.Optional(Type.Boolean({
        description: 'Include concerns that have already been resolved.',
      })),
      includeExpired: Type.Optional(Type.Boolean({
        description: 'Include concerns that are already expired.',
      })),
      limit: Type.Optional(Type.Integer({
        minimum: 1,
        maximum: 200,
        description: 'Maximum number of concerns to return (default 32).',
      })),
    }),
    execute: async (
      _toolCallId: string,
      params: ListConcernsParams,
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      try {
        const concerns = await store.list({
          contactId: params.contactId,
          includeResolved: params.includeResolved,
          includeExpired: params.includeExpired,
          limit: params.limit,
        });

        return textResult(JSON.stringify({
          count: concerns.length,
          concerns,
        }, null, 2));
      } catch (error) {
        return textResultWithError(`list_concerns failed: ${toErrorMessage(error)}`, true);
      }
    },
  };
}

export function createResolveConcernTool(store: ConcernStorePort): AgentTool<any> {
  return {
    name: 'resolve_concern',
    label: 'resolve_concern',
    description:
      'Resolve an active open thread once it has genuinely been handled or no longer needs tracking. '
      + 'Pass concernId copied exactly from the concern.id returned by create_concern or list_concerns.',
    parameters: Type.Object({
      concernId: Type.String({
        minLength: 1,
        description: 'Concern id to resolve. Copy the exact concern.id from create_concern or list_concerns.',
      }),
      outcome: Type.Optional(Type.String({
        minLength: 1,
        description: 'Optional concise outcome note.',
      })),
      evidenceRefs: Type.Optional(Type.Array(CONCERN_EVIDENCE_REF_SCHEMA, {
        maxItems: 20,
        description: 'Safe resolution evidence references. Do not include raw sensitive content.',
      })),
    }),
    execute: async (
      _toolCallId: string,
      params: ResolveConcernParams,
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      try {
        const resolved = await store.resolveConcern(params.concernId, {
          outcome: params.outcome,
          evidenceRefs: params.evidenceRefs,
        });
        if (!resolved) {
          return textResultWithError(`No unresolved concern found for id: ${params.concernId}`, true);
        }

        return textResult(JSON.stringify({
          resolved: true,
          concern: resolved,
        }, null, 2));
      } catch (error) {
        return textResultWithError(`resolve_concern failed: ${toErrorMessage(error)}`, true);
      }
    },
  };
}

export function createCreateConcernTool(store: ConcernStorePort): AgentTool<any> {
  return {
    name: 'create_concern',
    label: 'create_concern',
    description:
      'Create a new active open thread for short-lived reminders, checkups, proactive communication, or follow-up tracking. '
      + 'Use this for items like "reach out tonight"; do not put those durable follow-ups in scratchpad.',
    parameters: Type.Object({
      text: Type.String({
        minLength: 1,
        description: 'Concern text. Keep this concrete and actionable.',
      }),
      priority: Type.Optional(Type.Unsafe<ActiveConcernPriority>({
        type: 'string',
        enum: [...ACTIVE_CONCERN_PRIORITIES],
        description: 'Concern priority (high, medium, low). Defaults to medium.',
      })),
      status: Type.Optional(Type.Unsafe<ActiveConcernStatus>({
        type: 'string',
        enum: [...ACTIVE_CONCERN_STATUSES],
        description: 'Concern lifecycle status. Defaults to active.',
      })),
      contactId: Type.Optional(Type.String({
        minLength: 1,
        description: 'Optional contact id this concern is scoped to.',
      })),
      source: Type.Optional(Type.Union([
        Type.Literal('appraisal'),
        Type.Literal('agent'),
        Type.Literal('heartbeat'),
      ], {
        description: 'Creation source. Defaults to agent.',
      })),
      salience: Type.Optional(Type.Number({
        minimum: 0,
        maximum: 1,
        description: 'Lifecycle salience from 0 to 1. Defaults to 0.5.',
      })),
      sensitivity: Type.Optional(Type.Unsafe<ActiveConcernSensitivity>({
        type: 'string',
        enum: [...ACTIVE_CONCERN_SENSITIVITIES],
        description: 'Concern sensitivity metadata. Defaults to personal.',
      })),
      owner: Type.Optional(Type.Unsafe<ActiveConcernOwner>({
        type: 'string',
        enum: [...ACTIVE_CONCERN_OWNERS],
        description: 'Lifecycle owner. Defaults to companion.',
      })),
      evidenceRefs: Type.Optional(Type.Array(CONCERN_EVIDENCE_REF_SCHEMA, {
        maxItems: 20,
        description: 'Safe evidence references. Do not include raw sensitive content.',
      })),
      reopenResolved: Type.Optional(Type.Boolean({
        description: 'Only true when new evidence should reopen a matching terminal concern.',
      })),
      nextReviewAt: Type.Optional(Type.String({
        minLength: 1,
        description: 'Optional ISO timestamp for deferred or watching review.',
      })),
    }),
    execute: async (
      _toolCallId: string,
      params: CreateConcernParams,
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      try {
        const created = await store.create({
          text: params.text,
          priority: params.priority,
          contactId: params.contactId,
          source: params.source,
          status: params.status,
          salience: params.salience,
          sensitivity: params.sensitivity,
          owner: params.owner,
          evidenceRefs: params.evidenceRefs,
          reopenResolved: params.reopenResolved,
          nextReviewAt: params.nextReviewAt,
        });
        return textResult(JSON.stringify({
          created: true,
          concern: created,
        }, null, 2));
      } catch (error) {
        return textResultWithError(`create_concern failed: ${toErrorMessage(error)}`, true);
      }
    },
  };
}
