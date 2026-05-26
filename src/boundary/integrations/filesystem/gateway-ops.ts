import type { GatewayOpsPort } from '../../gateway/gateway-ops-port.js';
import type {
  FilesystemEditOptions,
  FilesystemEditResult,
  FilesystemListOptions,
  FilesystemOperations,
  FilesystemReadOptions,
  FilesystemReadResult,
  FilesystemSearchOptions,
  FilesystemSearchResult,
  FilesystemWriteOptions,
  FilesystemWriteResult,
} from './ops.js';

export class GatewayFilesystemOps implements FilesystemOperations {
  private readonly filesystemOps: FilesystemOperations;

  constructor(gatewayOps: Pick<GatewayOpsPort, 'filesystem'> | FilesystemOperations) {
    this.filesystemOps = 'filesystem' in gatewayOps ? gatewayOps.filesystem : gatewayOps;
  }

  async read(path: string, options?: FilesystemReadOptions): Promise<FilesystemReadResult> {
    return this.filesystemOps.read(path, options);
  }

  async list(
    glob = '**/*',
    maxEntries = 200,
    options?: FilesystemListOptions,
  ): Promise<string[]> {
    return this.filesystemOps.list(glob, maxEntries, options);
  }

  async search(options: FilesystemSearchOptions): Promise<FilesystemSearchResult> {
    return this.filesystemOps.search(options);
  }

  async write(options: FilesystemWriteOptions): Promise<FilesystemWriteResult> {
    return this.filesystemOps.write(options);
  }

  async edit(options: FilesystemEditOptions): Promise<FilesystemEditResult> {
    return this.filesystemOps.edit(options);
  }
}
