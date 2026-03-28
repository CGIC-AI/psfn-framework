import type { GatewayClient } from '../gateway/client.js';
import type { WebFetchLane } from '../gateway/protocol.js';
import type { WebFetchOperations } from './ops.js';

export class GatewayWebFetchOps implements WebFetchOperations {
  constructor(private readonly gateway: GatewayClient) {}

  async fetch(
    url: string,
    options: { lane?: WebFetchLane; prompt?: string } = {},
  ): Promise<string> {
    return await this.gateway.webFetch(url, options.prompt, options.lane ?? 'default');
  }
}
