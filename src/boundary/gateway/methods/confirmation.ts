import type {
  ConfirmationListParams,
  ConfirmationHistoryListParams,
  ConfirmationListResult,
  ConfirmationHistoryListResult,
  ConfirmationResolveParams,
  ConfirmationResolveResult,
} from '../protocol.js';
import type { AuditedMethodDescriptor, GatewayMethodRuntime } from './types.js';
import { registerAuditedDescriptors } from './register.js';

const confirmationDescriptors: Array<AuditedMethodDescriptor<any, unknown>> = [
  {
    name: 'confirmation.list',
    handler: async (_params: ConfirmationListParams, runtime): Promise<ConfirmationListResult> => {
      return {
        entries: runtime.listPendingConfirmations(),
      };
    },
  },
  {
    name: 'confirmation.history',
    handler: async (_params: ConfirmationHistoryListParams, runtime): Promise<ConfirmationHistoryListResult> => {
      return {
        entries: runtime.listConfirmationHistory(),
      };
    },
  },
  {
    name: 'confirmation.resolve',
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
  },
];

export function registerConfirmationMethods(runtime: GatewayMethodRuntime): void {
  registerAuditedDescriptors(runtime, confirmationDescriptors);
}
