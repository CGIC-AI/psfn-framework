import type { GatewayClient } from '../gateway/client.js';
import type { FilesystemReadOperations } from './ops.js';

export class GatewayFilesystemOps implements FilesystemReadOperations {
  private readonly gateway: GatewayClient;

  constructor(gateway: GatewayClient) {
    this.gateway = gateway;
  }

  async read(path: string): Promise<string> {
    return this.gateway.fsRead(path);
  }

  async list(glob = '**/*', maxEntries = 200): Promise<string[]> {
    return this.gateway.fsList(glob, maxEntries);
  }
}
