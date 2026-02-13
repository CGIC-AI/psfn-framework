// ── OpenAI-compatible API Server ──
// Exposes GET /v1/models and POST /v1/chat/completions.
// Uses Node.js built-in http module — no framework dependency.

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Lifecycle, SubstrateMessage } from '../../types.js';
import type { AgentLoop } from '../../agent-loop.js';
import type { EventBus } from '../../event-bus.js';
import type { SessionManager } from '../../session/manager.js';
import type { ChatCompletionRequest, ChatCompletionResponse, ChatCompletionChunk } from './types.js';
import { createComponentLogger } from '../../logger.js';

const log = createComponentLogger('ApiServer');

export interface ApiServerConfig {
  port: number;
  host?: string;
  agentLoop: AgentLoop;
  eventBus: EventBus;
  sessionManager: SessionManager;
  apiKey?: string;
  modelName?: string;
}

export class ApiServer implements Lifecycle {
  private server: Server;
  private port: number;
  private host: string;
  private agentLoop: AgentLoop;
  private eventBus: EventBus;
  private sessionManager: SessionManager;
  private apiKey?: string;
  private modelName: string;

  constructor(config: ApiServerConfig) {
    this.port = config.port;
    this.host = config.host ?? '127.0.0.1';
    this.agentLoop = config.agentLoop;
    this.eventBus = config.eventBus;
    this.sessionManager = config.sessionManager;
    this.apiKey = config.apiKey;
    this.modelName = config.modelName ?? 'purrsephone';
    this.server = createServer((req, res) => this.handleRequest(req, res));
  }

  async init(): Promise<void> {}

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(this.port, this.host, () => {
        log.info(`Listening on ${this.host}:${this.port}`);
        if (!this.apiKey) {
          log.warn('API server started WITHOUT authentication — set API_KEY to secure');
        }
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    // CORS headers on every response
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Session-ID');

    // Preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Auth check
    if (this.apiKey && !this.checkAuth(req, res)) return;

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;

    if (req.method === 'GET' && path === '/v1/models') {
      this.handleModels(res);
    } else if (req.method === 'POST' && path === '/v1/chat/completions') {
      this.handleChatCompletions(req, res);
    } else {
      this.sendError(res, 404, 'not_found', `No route for ${req.method} ${path}`);
    }
  }

  private checkAuth(req: IncomingMessage, res: ServerResponse): boolean {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ') || auth.slice(7) !== this.apiKey) {
      this.sendError(res, 401, 'invalid_api_key', 'Invalid or missing API key');
      return false;
    }
    return true;
  }

  private handleModels(res: ServerResponse): void {
    const body = {
      object: 'list',
      data: [{
        id: this.modelName,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'psfn',
      }],
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  private handleChatCompletions(req: IncomingMessage, res: ServerResponse): void {
    const MAX_BODY_SIZE = 1_048_576; // 1MB
    let body = '';
    let bodySize = 0;
    req.on('data', (chunk: Buffer) => {
      bodySize += chunk.length;
      if (bodySize > MAX_BODY_SIZE) {
        log.warn('Request body too large', { size: bodySize, limit: MAX_BODY_SIZE });
        res.writeHead(413, { 'Content-Type': 'text/plain' });
        res.end('Payload Too Large');
        req.destroy();
        return;
      }
      body += chunk.toString();
    });
    req.on('end', () => {
      if (bodySize > MAX_BODY_SIZE) return;
      let parsed: ChatCompletionRequest;
      try {
        parsed = JSON.parse(body) as ChatCompletionRequest;
      } catch {
        this.sendError(res, 400, 'invalid_json', 'Request body is not valid JSON');
        return;
      }

      if (!parsed.messages || !Array.isArray(parsed.messages) || parsed.messages.length === 0) {
        this.sendError(res, 400, 'invalid_request', 'messages field is required and must be a non-empty array');
        return;
      }

      if (parsed.stream) {
        this.handleStreaming(parsed, req, res);
      } else {
        this.handleNonStreaming(parsed, req, res);
      }
    });
  }

  private buildSubstrateMessage(channelId: string, content: string): SubstrateMessage {
    return {
      id: `api-${randomUUID()}`,
      channelId,
      channelType: 'api',
      authorId: 'api-user',
      authorName: 'User',
      content,
      timestamp: new Date(),
    };
  }

  private deriveChannelId(req: IncomingMessage): string {
    const sessionId = req.headers['x-session-id'] as string | undefined;
    return sessionId ? `api:${sessionId}` : `api:${randomUUID()}`;
  }

  private seedSession(channelId: string, messages: ChatCompletionRequest['messages']): void {
    // Only seed if this session has no prior messages
    const count = this.sessionManager.getMessageCount(channelId);
    if (count > 0) return;

    // Seed all messages except the last user message (which handleMessage will record)
    const prior = messages.slice(0, -1);
    for (const msg of prior) {
      if (msg.role === 'user') {
        this.sessionManager.recordUserMessage(channelId, msg.content, 'api-user', msg.name ?? 'User');
      } else if (msg.role === 'assistant') {
        this.sessionManager.recordAssistantMessage(channelId, msg.content);
      }
      // system messages are handled via systemPrompt, skip
    }
  }

  private getLastUserMessage(messages: ChatCompletionRequest['messages']): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') return messages[i].content;
    }
    return messages[messages.length - 1].content;
  }

  private async handleNonStreaming(
    request: ChatCompletionRequest,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const channelId = this.deriveChannelId(req);
    this.seedSession(channelId, request.messages);

    const lastUserMsg = this.getLastUserMessage(request.messages);
    const substrateMsg = this.buildSubstrateMessage(channelId, lastUserMsg);

    try {
      const agentResponse = await this.agentLoop.handleMessage(substrateMsg);

      const response: ChatCompletionResponse = {
        id: `chatcmpl-${randomUUID()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: this.modelName,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: agentResponse.content },
          finish_reason: 'stop',
        }],
        usage: {
          prompt_tokens: agentResponse.metadata.inputTokens,
          completion_tokens: agentResponse.metadata.outputTokens,
          total_tokens: agentResponse.metadata.inputTokens + agentResponse.metadata.outputTokens,
        },
      };

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));
    } catch (err) {
      log.error('Non-streaming completion error', { error: String(err) });
      this.sendError(res, 500, 'internal_error', 'Internal server error');
    }
  }

  private async handleStreaming(
    request: ChatCompletionRequest,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const channelId = this.deriveChannelId(req);
    this.seedSession(channelId, request.messages);

    const completionId = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);

    // Set SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    // Send initial role chunk
    const roleChunk: ChatCompletionChunk = {
      id: completionId,
      object: 'chat.completion.chunk',
      created,
      model: this.modelName,
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
    };
    res.write(`data: ${JSON.stringify(roleChunk)}\n\n`);

    // Subscribe to stream deltas for this channelId
    const unsubscribe = this.eventBus.on('agent.stream.delta', (data) => {
      if (data.channelId !== channelId) return;
      const chunk: ChatCompletionChunk = {
        id: completionId,
        object: 'chat.completion.chunk',
        created,
        model: this.modelName,
        choices: [{ index: 0, delta: { content: data.text }, finish_reason: null }],
      };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    });

    const lastUserMsg = this.getLastUserMessage(request.messages);
    const substrateMsg = this.buildSubstrateMessage(channelId, lastUserMsg);

    try {
      await this.agentLoop.handleMessage(substrateMsg);

      // Send finish chunk
      const finishChunk: ChatCompletionChunk = {
        id: completionId,
        object: 'chat.completion.chunk',
        created,
        model: this.modelName,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      };
      res.write(`data: ${JSON.stringify(finishChunk)}\n\n`);
      res.write('data: [DONE]\n\n');
    } catch (err) {
      log.error('Streaming completion error', { error: String(err) });
      // Best effort: send error as a content chunk, then terminate
      const errorChunk: ChatCompletionChunk = {
        id: completionId,
        object: 'chat.completion.chunk',
        created,
        model: this.modelName,
        choices: [{ index: 0, delta: { content: '\n[Error: Internal server error]' }, finish_reason: 'stop' }],
      };
      res.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
      res.write('data: [DONE]\n\n');
    } finally {
      unsubscribe();
      res.end();
    }
  }

  private sendError(
    res: ServerResponse,
    status: number,
    type: string,
    message: string,
  ): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: { message, type, param: null, code: null },
    }));
  }
}
