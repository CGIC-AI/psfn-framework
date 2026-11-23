import { Type } from '@sinclair/typebox';
import { CANONICAL_TOOL_SURFACE_DESCRIPTIONS } from '../agent/tool-surface/descriptions.js';
import type { AgentToolResult, SubstrateAgentTool } from '../../boundary/pi-agent/index.js';
import { textResult, textResultWithError } from '../tools/results.js';
import type { EventBus } from '../../shared/event-bus.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import {
  ACTIVE_CONCERN_EVIDENCE_KINDS,
  ACTIVE_CONCERN_OWNERS,
  ACTIVE_CONCERN_PRIORITIES,
  ACTIVE_CONCERN_SENSITIVITIES,
  ACTIVE_CONCERN_STATUSES,
  isConcernTerminalStatus,
  type ActiveConcern,
  type ActiveConcernEvidenceRef,
  type ActiveConcernOwner,
  type ActiveConcernPriority,
  type ActiveConcernSensitivity,
  type ActiveConcernStatus,
  type ActiveConcernVAD,
} from './concerns.js';
import { emitConcernResolutionAppraisal } from './concern-resolution-appraisal.js';
import type { ConcernStorePort } from './concern-store-port.js';
import {
  executeCreateConcernAction,
  executeListConcernsAction,
} from './tools.js';

type AgentManagedConcernStatus = Exclude<ActiveConcernStatus, 'candidate'>;
const AGENT_MANAGED_CONCERN_STATUSES = ACTIVE_CONCERN_STATUSES.filter(
  (status): status is AgentManagedConcernStatus => status !== 'candidate',
);
const CONCERN_TOOL_ACTIONS = [
  'list',
  'create',
  'resolve',
  'transition',
] as const;
type ConcernToolAction = (typeof CONCERN_TOOL_ACTIONS)[number];

export interface ConcernsToolOptions {
  /**
   * Live emotional VAD provider (vw3w.1). Snapshots the current VAD as
   * resolutionVAD when resolving or terminally transitioning a concern.
   */
  resolutionVadProvider?: (concern: ActiveConcern) => ActiveConcernVAD | undefined;
  /** Event bus for the resolution-as-appraisal relief-delta event (vw3w.1). */
  eventBus?: EventBus | null;
}

interface ConcernsToolParams {
  action: ConcernToolAction;
  text?: string;
  priority?: ActiveConcernPriority;
  status?: AgentManagedConcernStatus;
  salience?: number;
  sensitivity?: ActiveConcernSensitivity;
  owner?: ActiveConcernOwner;
  evidenceRefs?: ActiveConcernEvidenceRef[];
  reopenResolved?: boolean;
  nextReviewAt?: string;
  clearNextReview?: boolean;
  contactId?: string;
  source?: 'appraisal' | 'agent' | 'heartbeat';
  includeResolved?: boolean;
  includeExpired?: boolean;
  limit?: number;
  concernId?: string;
  concernIds?: string[];
  outcome?: string;
}

const CONCERN_EVIDENCE_REF_SCHEMA = Type.Object({
  kind: Type.Unsafe<ActiveConcernEvidenceRef['kind']>({
    type: 'string',
    enum: [...ACTIVE_CONCERN_EVIDENCE_KINDS],
    description: 'Safe evidence reference kind. Do not include raw sensitive content.',
  }),
  ref: Type.String({
    description: 'Opaque id, pointer, or stable reference. Do not include raw source text.',
  }),
  sensitivity: Type.Optional(Type.Unsafe<ActiveConcernSensitivity>({
    type: 'string',
    enum: [...ACTIVE_CONCERN_SENSITIVITIES],
  })),
  redacted: Type.Optional(Type.Boolean()),
  hash: Type.Optional(Type.String()),
});

function ensureAction(raw: unknown): ConcernToolAction | null {
  if (typeof raw !== 'string') return null;
  return (CONCERN_TOOL_ACTIONS as readonly string[]).includes(raw)
    ? raw as ConcernToolAction
    : null;
}

function ensureString(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const normalized = raw.trim();
  return normalized.length > 0 ? normalized : null;
}

export function createConcernsTool(
  concernStore: ConcernStorePort,
  options: ConcernsToolOptions = {},
): SubstrateAgentTool {
  return {
    name: 'concerns',
    label: 'concerns',
    description: CANONICAL_TOOL_SURFACE_DESCRIPTIONS.concerns,
    parameters: Type.Object({
      action: Type.Unsafe<ConcernToolAction>({
        type: 'string',
        enum: [...CONCERN_TOOL_ACTIONS],
        description: 'Required concern action: list, create, resolve, or transition.',
      }),
      text: Type.Optional(Type.String({
        description: 'Open-thread / commitment text for action=create.',
      })),
      priority: Type.Optional(Type.Unsafe<ActiveConcernPriority>({
        type: 'string',
        enum: [...ACTIVE_CONCERN_PRIORITIES],
        description: 'Relative priority metadata for action=create.',
      })),
      status: Type.Optional(Type.Unsafe<AgentManagedConcernStatus>({
        type: 'string',
        enum: [...AGENT_MANAGED_CONCERN_STATUSES],
        description: 'Lifecycle status for action=create or action=transition.',
      })),
      salience: Type.Optional(Type.Number({
        description: 'How present the concern should be (0 to 1) for action=create or action=transition.',
      })),
      sensitivity: Type.Optional(Type.Unsafe<ActiveConcernSensitivity>({
        type: 'string',
        enum: [...ACTIVE_CONCERN_SENSITIVITIES],
        description: 'Sensitivity metadata for action=create.',
      })),
      owner: Type.Optional(Type.Unsafe<ActiveConcernOwner>({
        type: 'string',
        enum: [...ACTIVE_CONCERN_OWNERS],
        description: 'Lifecycle owner for action=create.',
      })),
      evidenceRefs: Type.Optional(Type.Array(CONCERN_EVIDENCE_REF_SCHEMA, {
        description: 'Safe evidence references for create, resolve, or transition.',
      })),
      reopenResolved: Type.Optional(Type.Boolean({
        description: 'For action=create, true only when new evidence should reopen a matching terminal concern.',
      })),
      nextReviewAt: Type.Optional(Type.String({
        description: 'Optional ISO timestamp for deferred/watching lifecycle review.',
      })),
      clearNextReview: Type.Optional(Type.Boolean({
        description: 'For action=transition, clear any existing nextReviewAt timestamp.',
      })),
      contactId: Type.Optional(Type.String({
        description: 'Optional contact scope for action=create or action=list.',
      })),
      source: Type.Optional(Type.Union([
        Type.Literal('appraisal'),
        Type.Literal('agent'),
        Type.Literal('heartbeat'),
      ], {
        description: 'Creation source for action=create.',
      })),
      includeResolved: Type.Optional(Type.Boolean({
        description: 'Include resolved concerns for action=list.',
      })),
      includeExpired: Type.Optional(Type.Boolean({
        description: 'Include expired concerns for action=list.',
      })),
      limit: Type.Optional(Type.Integer({
        description: 'Optional bounded limit for action=list.',
      })),
      concernId: Type.Optional(Type.String({
        description: 'Exact concern id returned by create or list for action=resolve or action=transition.',
      })),
      concernIds: Type.Optional(Type.Array(Type.String(), {
        description: 'Multiple concern ids for batch action=resolve or action=transition.',
      })),
      outcome: Type.Optional(Type.String({
        description: 'Optional concise resolution note for action=resolve or action=transition.',
      })),
    }),
    execute: async (
      _toolCallId: string,
      params: ConcernsToolParams,
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      const action = ensureAction(params.action);
      if (!action) {
        return textResultWithError(
          `Error: action must be one of ${CONCERN_TOOL_ACTIONS.join(', ')}`,
          true,
        );
      }

      try {
        if (action === 'create') {
          return executeCreateConcernAction(concernStore, {
            text: params.text ?? '',
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
        }

        if (action === 'list') {
          return executeListConcernsAction(concernStore, {
            contactId: params.contactId,
            includeResolved: params.includeResolved,
            includeExpired: params.includeExpired,
            limit: params.limit,
          });
        }

        const concernIds = Array.isArray(params.concernIds)
          ? params.concernIds.map(ensureString).filter((id): id is string => Boolean(id))
          : [];
        const singleConcernId = ensureString(params.concernId);
        if (singleConcernId) {
          concernIds.unshift(singleConcernId);
        }
        const uniqueConcernIds = [...new Set(concernIds)];

        if (action === 'resolve') {
          if (uniqueConcernIds.length === 0) {
            return textResultWithError(JSON.stringify({
              error: 'missing_required_parameter',
              action: 'resolve',
              required: 'concernId or concernIds',
              hint: 'Retry concerns with action="resolve" and concernId or concernIds set to ids returned by create or list. Do not use tool_search, fs, or analysis_workbench for this.',
            }, null, 2), true);
          }
          const resolved = [];
          const missing = [];
          for (const concernId of uniqueConcernIds) {
            const beforeResolution = await concernStore.getById(concernId);
            const resolutionVAD = beforeResolution
              ? options.resolutionVadProvider?.(beforeResolution)
              : undefined;
            const concern = await concernStore.resolveConcern(concernId, {
              outcome: params.outcome,
              evidenceRefs: params.evidenceRefs,
              ...(resolutionVAD ? { resolutionVAD } : {}),
            });
            if (concern) {
              resolved.push(concern);
              await emitConcernResolutionAppraisal(options.eventBus, {
                concern,
                source: 'decision',
              });
            } else {
              missing.push(concernId);
            }
          }
          const resultText = JSON.stringify({
            resolved: resolved.length,
            missing,
            concerns: resolved,
          }, null, 2);
          return missing.length > 0
            ? textResultWithError(resultText, true)
            : textResult(resultText);
        }

        if (uniqueConcernIds.length === 0 || !params.status) {
          return textResultWithError(JSON.stringify({
            error: 'missing_required_parameter',
            action: 'transition',
            required: 'concernId or concernIds, and status',
            hint: 'Retry concerns with action="transition", status, and concern id(s) returned by list.',
          }, null, 2), true);
        }
        const transitioned = [];
        const missing = [];
        for (const concernId of uniqueConcernIds) {
          const beforeTransition = await concernStore.getById(concernId);
          const transitionResolutionVAD = isConcernTerminalStatus(params.status)
            && beforeTransition
            ? options.resolutionVadProvider?.(beforeTransition)
            : undefined;
          const concern = await concernStore.transitionConcernStatus(concernId, {
            status: params.status,
            outcome: params.outcome,
            evidenceRefs: params.evidenceRefs,
            resolutionEvidenceRefs: params.evidenceRefs,
            nextReviewAt: params.nextReviewAt,
            clearNextReview: params.clearNextReview,
            salience: params.salience,
            ...(transitionResolutionVAD ? { resolutionVAD: transitionResolutionVAD } : {}),
          });
          if (concern) {
            transitioned.push(concern);
            if (isConcernTerminalStatus(concern.status)) {
              await emitConcernResolutionAppraisal(options.eventBus, {
                concern,
                source: 'decision',
              });
            }
          } else {
            missing.push(concernId);
          }
        }
        const resultText = JSON.stringify({
          transitioned: transitioned.length,
          missing,
          concerns: transitioned,
        }, null, 2);
        return missing.length > 0
          ? textResultWithError(resultText, true)
          : textResult(resultText);
      } catch (error) {
        return textResultWithError(
          `Error updating concerns: ${toErrorMessage(error)}`,
          true,
        );
      }
    },
  };
}
