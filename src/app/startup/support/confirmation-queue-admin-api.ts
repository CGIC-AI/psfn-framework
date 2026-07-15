import type { ApprovalQueuePort } from '../../../system/capabilities/approval-queue-port.js';
import type { ConfirmationQueueAdminApi } from '../../../operator/garden/admin-contract.js';
import type { ConfirmationResolveResult } from '../../../system/capabilities/confirmation-queue.js';
import type {
  ConfirmationListResult,
  ConfirmationResolveParams,
} from '../../../boundary/gateway/protocol.js';

type LocalConfirmationQueue = Pick<ApprovalQueuePort, 'listPending' | 'resolve'>;
type LocalConfirmationQueueWithLookup = Pick<ApprovalQueuePort, 'getPending' | 'listPending' | 'resolve'>;
type GatewayConfirmationQueueClient = Pick<
  ConfirmationQueueAdminApi,
  'listConfirmationQueue'
>;

export function createLocalConfirmationQueueAdminApi(
  queue: LocalConfirmationQueue,
): ConfirmationQueueAdminApi {
  return {
    listConfirmationQueue: async (): Promise<ConfirmationListResult> => ({
      entries: queue.listPending(),
    }),
    resolveConfirmationQueue: (
      params: ConfirmationResolveParams,
    ): Promise<ConfirmationResolveResult> => queue.resolve(params),
  };
}

export function createGatewayConfirmationQueueAdminApi(
  gateway: GatewayConfirmationQueueClient,
  localQueue: LocalConfirmationQueueWithLookup,
): ConfirmationQueueAdminApi {
  return {
    listConfirmationQueue: async (): Promise<ConfirmationListResult> => {
      const [gatewayList, localEntries] = await Promise.all([
        gateway.listConfirmationQueue(),
        Promise.resolve(localQueue.listPending()),
      ]);
      return {
        entries: [...localEntries, ...gatewayList.entries]
          .sort((a, b) => a.requestedAt - b.requestedAt),
      };
    },
    resolveConfirmationQueue: async (
      params: ConfirmationResolveParams,
    ): Promise<ConfirmationResolveResult> => {
      if (localQueue.getPending(params.id)) {
        return localQueue.resolve(params);
      }
      // Operator-owned (gateway) confirmations are never resolvable from the
      // less-trusted agent process. Resolving them requires the operator
      // ADMIN_TOKEN, which must never traverse the agent (x5rt.10): the
      // independently authenticated Garden operator process resolves them
      // directly against the gateway. Fail closed here — the entry stays
      // pending rather than the agent capturing/replaying a credential.
      return {
        id: params.id,
        status: 'not_found',
        message: 'Confirmation is not resolvable by the agent; operator authority is required.',
        executed: false,
      };
    },
  };
}
