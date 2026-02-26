import type { ServerResponse } from 'node:http';
import type { AdminChatBootstrapResponse, AdminChatBootstrapUpdateInput } from '../chat/index.js';
import type { AdminChatDebugStreamOptions } from '../types.js';
import type { LegacyAdminHandlers } from '../handlers-legacy.js';

export class AdminChatHandlers {
  constructor(private readonly legacy: LegacyAdminHandlers) {}

  chatPage(): string {
    return this.legacy.chatPage();
  }

  chatBootstrap(): AdminChatBootstrapResponse {
    return this.legacy.chatBootstrap();
  }

  updateChatBootstrap(body: string, contentTypeHeader: string | string[] | undefined): AdminChatBootstrapUpdateInput {
    return this.legacy.updateChatBootstrap(body, contentTypeHeader);
  }

  setupChatDebugSSE(
    res: ServerResponse,
    options: AdminChatDebugStreamOptions = {},
  ): () => void {
    return this.legacy.setupChatDebugSSE(res, options);
  }
}
