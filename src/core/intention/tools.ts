import type { AgentToolResult } from '@mariozechner/pi-agent-core';
import type {
  ActiveConcernEvidenceRef,
  ActiveConcernOwner,
  ActiveConcernPriority,
  ActiveConcernSensitivity,
  ActiveConcernStatus,
} from './concerns.js';
import type { ConcernStorePort } from './concern-store-port.js';
import { textResultWithError } from '../tools/results.js';
import { toErrorMessage } from '../../shared/utils/errors.js';

export interface ListConcernsParams {
  contactId?: string;
  includeResolved?: boolean;
  includeExpired?: boolean;
  limit?: number;
}

export interface CreateConcernParams {
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

function textResult(text: string): AgentToolResult<{ isError?: boolean }> {
  return {
    content: [{ type: 'text', text }],
    details: {},
  };
}

export async function executeListConcernsAction(
  store: ConcernStorePort,
  params: ListConcernsParams,
): Promise<AgentToolResult<{ isError?: boolean }>> {
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
}

export async function executeCreateConcernAction(
  store: ConcernStorePort,
  params: CreateConcernParams,
): Promise<AgentToolResult<{ isError?: boolean }>> {
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
}
