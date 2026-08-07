import type {
  ConfirmationListParams,
  ConfirmationHistoryListParams,
  ConfirmationListResult,
  ConfirmationHistoryListResult,
  ConfirmationResolveParams,
} from '../protocol.js';
import type { ConfirmationResolveResult } from '../../../system/capabilities/confirmation-queue.js';
import type { GatewayMethodRuntime } from './types.js';
import { defineAuditedMethod } from './types.js';
import { registerAuditedDescriptors } from './register.js';
import { gatewayMethodParamDecoders } from './params.js';

const confirmationDescriptors = [
  defineAuditedMethod({
    name: 'confirmation.list',
    decode: gatewayMethodParamDecoders['confirmation.list'],
    handler: async (_params: ConfirmationListParams, runtime): Promise<ConfirmationListResult> => {
      return {
        entries: runtime.listPendingConfirmations(),
      };
    },
  }),
  defineAuditedMethod({
    name: 'confirmation.history',
    decode: gatewayMethodParamDecoders['confirmation.history'],
    handler: async (_params: ConfirmationHistoryListParams, runtime): Promise<ConfirmationHistoryListResult> => {
      return {
        entries: runtime.listConfirmationHistory(),
      };
    },
  }),
  defineAuditedMethod({
    name: 'confirmation.resolve',
    decode: gatewayMethodParamDecoders['confirmation.resolve'],
    handler: async (params: ConfirmationResolveParams, runtime): Promise<ConfirmationResolveResult> => {
      return await runtime.resolveConfirmation({
        id: params.id,
        decision: params.decision,
        modifiedParams: params.modifiedParams,
      });
    },
    summary: (p: ConfirmationResolveParams) => ({
      id: p.id,
      decision: p.decision,
    }),
  }),
];

export function registerConfirmationMethods(runtime: GatewayMethodRuntime): void {
  registerAuditedDescriptors(runtime, confirmationDescriptors);
}
