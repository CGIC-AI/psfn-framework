import type { GatewayOpsPort } from '../../gateway/gateway-ops-port.js';
import type { FilesystemReadOperations } from './ops.js';

export class GatewayFilesystemOps implements FilesystemReadOperations {
  private readonly filesystemOps: FilesystemReadOperations;

  constructor(gatewayOps: Pick<GatewayOpsPort, 'filesystem'> | FilesystemReadOperations) {
    this.filesystemOps = 'filesystem' in gatewayOps ? gatewayOps.filesystem : gatewayOps;
  }

  async read(path: string): Promise<string> {
    return this.filesystemOps.read(path);
  }

  async list(glob = '**/*', maxEntries = 200): Promise<string[]> {
    return this.filesystemOps.list(glob, maxEntries);
  }
}
