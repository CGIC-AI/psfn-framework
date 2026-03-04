import type { LegacyAdminHandlers } from '../handlers-legacy.js';
import type { AdminAuditDecision } from '../types.js';
import type {
  ConfirmationResolveParams,
  ConfirmationResolveResult,
} from '../../../gateway/protocol.js';
import { toErrorMessage } from '../../../utils/errors.js';
import * as tpl from '../templates.js';

export class AdminConfirmationsHandlers {
  constructor(private readonly legacy: LegacyAdminHandlers) {}

  async confirmationsPage(): Promise<string> {
    const body = await this.renderConfirmationQueueFragment();
    return tpl.layout('Confirmations', tpl.confirmationsPage(body), 'confirmations');
  }

  async confirmationsListFragment(): Promise<string> {
    return this.renderConfirmationQueueFragment();
  }

  async resolveConfirmation(body: string): Promise<string> {
    const legacy = this.legacy as any;
    if (!legacy.confirmationQueueApi) {
      legacy.appendAuditTimelineEntry(
        'external_action',
        'denied',
        'Confirmation decision was denied: confirmation queue is unavailable.',
      );
      return this.renderConfirmationQueueFragment(
        'Confirmation queue is unavailable (gateway integration not configured).',
        true,
      );
    }

    const params = new URLSearchParams(body);
    const id = (params.get('id') ?? '').trim();
    const decisionRaw = (params.get('decision') ?? '').trim();
    if (!id) {
      legacy.appendAuditTimelineEntry(
        'external_action',
        'denied',
        'Confirmation decision was denied: missing confirmation id.',
      );
      return this.renderConfirmationQueueFragment('Confirmation ID is required.', true);
    }

    if (decisionRaw !== 'approve' && decisionRaw !== 'deny' && decisionRaw !== 'modify') {
      legacy.appendAuditTimelineEntry(
        'external_action',
        'denied',
        `Confirmation ${id} was denied: invalid decision "${decisionRaw}".`,
      );
      return this.renderConfirmationQueueFragment('Invalid confirmation decision.', true);
    }

    const resolveParams: ConfirmationResolveParams = {
      id,
      decision: decisionRaw,
    };

    if (decisionRaw === 'modify') {
      const modifiedParamsRaw = (params.get('modifiedParamsJson') ?? '').trim();
      if (!modifiedParamsRaw) {
        legacy.appendAuditTimelineEntry(
          'external_action',
          'denied',
          `Confirmation ${id} modify request was denied: modified params were not provided.`,
        );
        return this.renderConfirmationQueueFragment('Modified params JSON is required for modify.', true);
      }
      try {
        const parsed = JSON.parse(modifiedParamsRaw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          legacy.appendAuditTimelineEntry(
            'external_action',
            'denied',
            `Confirmation ${id} modify request was denied: modified params were not a JSON object.`,
          );
          return this.renderConfirmationQueueFragment('Modified params must be a JSON object.', true);
        }
        resolveParams.modifiedParams = parsed as Record<string, unknown>;
      } catch {
        legacy.appendAuditTimelineEntry(
          'external_action',
          'denied',
          `Confirmation ${id} modify request was denied: modified params JSON was invalid.`,
        );
        return this.renderConfirmationQueueFragment('Modified params JSON is invalid.', true);
      }
    }

    let result: ConfirmationResolveResult;
    try {
      result = await legacy.confirmationQueueApi.resolveConfirmationQueue(resolveParams);
    } catch (error) {
      const message = toErrorMessage(error);
      legacy.appendAuditTimelineEntry(
        'external_action',
        'denied',
        `Confirmation ${id} failed to resolve: ${message}`,
      );
      return this.renderConfirmationQueueFragment(`Confirmation update failed: ${message}`, true);
    }

    const isError = result.status === 'failed';
    const decision: AdminAuditDecision = (
      result.status === 'denied'
      || result.status === 'failed'
      || result.status === 'expired'
      || result.status === 'not_found'
    ) ? 'denied' : 'allowed';
    const decisionLabel = decisionRaw === 'modify'
      ? 'modified'
      : (decisionRaw === 'approve' ? 'approved' : 'denied');
    legacy.appendAuditTimelineEntry(
      'external_action',
      decision,
      `Operator ${decisionLabel} confirmation ${id}.`,
      [`status=${result.status}`, `executed=${result.executed}`],
    );
    return this.renderConfirmationQueueFragment(result.message, isError);
  }

  private async renderConfirmationQueueFragment(
    message?: string,
    isError = false,
  ): Promise<string> {
    const legacy = this.legacy as any;
    if (!legacy.confirmationQueueApi) {
      return tpl.confirmationQueueFragment({
        entries: [],
        available: false,
        message: message ?? 'Confirmation queue is unavailable (gateway integration not configured).',
        isError: true,
      });
    }

    try {
      const list = await legacy.confirmationQueueApi.listConfirmationQueue();
      return tpl.confirmationQueueFragment({
        entries: list.entries,
        available: true,
        message,
        isError,
      });
    } catch (error) {
      const details = toErrorMessage(error);
      return tpl.confirmationQueueFragment({
        entries: [],
        available: true,
        message: message ?? `Unable to load confirmation queue: ${details}`,
        isError: true,
      });
    }
  }
}
