import type { GatewayClient } from '../gateway/client.js';
import type {
  FilesystemEditOptions,
  FilesystemEditResult,
  FilesystemOperations,
  FilesystemReadOptions,
  FilesystemReadResult,
  FilesystemSearchOptions,
  FilesystemSearchResult,
  FilesystemWriteOptions,
  FilesystemWriteResult,
} from './ops.js';

export class GatewayFilesystemOps implements FilesystemOperations {
  private readonly gateway: GatewayClient;

  constructor(gateway: GatewayClient) {
    this.gateway = gateway;
  }

  async read(path: string, options?: FilesystemReadOptions): Promise<FilesystemReadResult> {
    const result = await this.gateway.fsReadDetailed(path, options);
    return {
      content: result.content,
      truncated: result.truncated ?? false,
    };
  }

  async list(glob = '**/*', maxEntries = 200): Promise<string[]> {
    return this.gateway.fsList(glob, maxEntries);
  }

  async search(options: FilesystemSearchOptions): Promise<FilesystemSearchResult> {
    return this.gateway.fsSearch(options);
  }

  async write(options: FilesystemWriteOptions): Promise<FilesystemWriteResult> {
    const existing = await this.gateway.fsReadDetailed(options.path).catch((error: unknown) => {
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: unknown }).code)
        : '';
      const message = error instanceof Error ? error.message : String(error);
      if (code === 'ENOENT' || message.includes('ENOENT')) {
        return null;
      }
      throw error;
    });

    if (existing && existing.content === options.content) {
      return {
        path: options.path,
        status: 'unchanged',
        bytesWritten: Buffer.byteLength(options.content, 'utf-8'),
      };
    }

    if (existing && options.overwrite !== true) {
      throw new Error('fs write refuses to overwrite an existing file without overwrite=true');
    }

    await this.gateway.fsWrite(options.path, options.content);
    return {
      path: options.path,
      status: existing ? 'overwritten' : 'created',
      bytesWritten: Buffer.byteLength(options.content, 'utf-8'),
    };
  }

  async edit(options: FilesystemEditOptions): Promise<FilesystemEditResult> {
    const result = await this.gateway.fsEdit(options);
    return {
      path: options.path,
      replacements: result.replacements,
    };
  }
}
