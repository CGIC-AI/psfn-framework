import type { GatewayOpsPort } from '../../gateway/gateway-ops-port.js';
import type { WebFetchLane } from '../../gateway/protocol.js';
import type { WebFetchOperations, WebSearchOperationResult } from './ops.js';

export class GatewayWebFetchOps implements WebFetchOperations {
  private readonly webOps: WebFetchOperations;

  constructor(gatewayOps: Pick<GatewayOpsPort, 'web'> | WebFetchOperations) {
    this.webOps = 'web' in gatewayOps ? gatewayOps.web : gatewayOps;
  }

  async fetch(
    url: string,
    options: { lane?: WebFetchLane; prompt?: string } = {},
  ): Promise<string> {
    return await this.webOps.fetch(url, options);
  }

  async search(
    query: string,
    options: { maxResults?: number } = {},
  ): Promise<WebSearchOperationResult> {
    if (!this.webOps.search) {
      throw new Error('web search operation is not available on the gateway web ops');
    }
    return await this.webOps.search(query, options);
  }
}
