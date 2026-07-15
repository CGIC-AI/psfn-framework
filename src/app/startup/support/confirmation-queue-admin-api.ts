import type { ApprovalQueuePort } from '../../../system/capabilities/approval-queue-port.js';
import type { ConfirmationQueueAdminApi } from '../../../operator/garden/admin-contract.js';
import type { ConfirmationOperatorAuthContext } from '../../../operator/garden/admin-contract.js';
import type { ConfirmationResolveResult } from '../../../system/capabilities/confirmation-queue.js';
import type {
  ConfirmationListResult,
  ConfirmationResolveParams,
} from '../../../boundary/gateway/protocol.js';
import type { GatewayOperatorConfirmationClient } from './gateway-operator-confirmation-client.js';

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
  operatorClient?: GatewayOperatorConfirmationClient,
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
      auth: ConfirmationOperatorAuthContext = {},
    ): Promise<ConfirmationResolveResult> => {
      if (localQueue.getPending(params.id)) {
        return localQueue.resolve(params);
      }
      if (!operatorClient) {
        throw new Error('Gateway operator confirmation endpoint is not configured.');
      }
      return operatorClient.resolve(params, auth);
    },
  };
}
