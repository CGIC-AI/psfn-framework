import type { ServerResponse } from 'node:http';
import type {
  AdminChatBootstrapResponse,
  AdminModelRoomBootstrapResponse,
} from '../chat/index.js';
import type { AdminChatDebugStreamOptions } from '../types.js';
import type { LegacyAdminHandlers } from '../handlers-legacy.js';

export class AdminChatHandlers {
  constructor(private readonly legacy: LegacyAdminHandlers) {}

  chatPage(): string {
    return this.legacy.chatPage();
  }

  chatBootstrap(requestOrigin?: string): AdminChatBootstrapResponse {
    return this.legacy.chatBootstrap(requestOrigin);
  }

  chatModelRoomBootstrap(requestOrigin?: string): AdminModelRoomBootstrapResponse {
    return this.legacy.chatModelRoomBootstrap(requestOrigin);
  }

  updateChatBootstrap(
    body: string,
    contentTypeHeader: string | string[] | undefined,
    requestOrigin?: string,
  ): AdminChatBootstrapResponse {
    return this.legacy.updateChatBootstrap(body, contentTypeHeader, requestOrigin);
  }

  setupChatDebugSSE(
    res: ServerResponse,
    options: AdminChatDebugStreamOptions = {},
  ): () => void {
    return this.legacy.setupChatDebugSSE(res, options);
  }
}
