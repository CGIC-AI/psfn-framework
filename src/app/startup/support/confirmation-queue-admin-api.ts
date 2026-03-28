import type { ConfirmationQueue } from '../../../system/capabilities/confirmation-queue.js';
import type { ConfirmationQueueAdminApi } from '../../../operator/garden/types.js';
import type {
  ConfirmationListResult,
  ConfirmationResolveParams,
  ConfirmationResolveResult,
} from '../../../boundary/gateway/protocol.js';

type LocalConfirmationQueue = Pick<ConfirmationQueue, 'listPending' | 'resolve'>;
type LocalConfirmationQueueWithLookup = Pick<ConfirmationQueue, 'getPending' | 'listPending' | 'resolve'>;
type GatewayConfirmationQueueClient = Pick<
  ConfirmationQueueAdminApi,
  'listConfirmationQueue' | 'resolveConfirmationQueue'
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
      return gateway.resolveConfirmationQueue(params);
    },
  };
}
