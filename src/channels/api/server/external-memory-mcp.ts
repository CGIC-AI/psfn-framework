import type { IncomingMessage, ServerResponse } from 'node:http';
import { createMcpHandler, fromJsonSchema, McpServer, type JsonSchemaType } from '@modelcontextprotocol/server';
import {
  EXTERNAL_MEMORY_TOOL_SCHEMAS,
  parseExternalMemoryBinding,
  parseExternalMemoryRequest,
  type ExternalMemoryBinding,
  type ExternalMemoryExecuteParams,
  type ExternalMemoryExecuteResult,
} from '../../../shared/contracts/external-memory.js';
import type { ExternalMemoryApiConfig } from '../../backplane/external-memory-config.js';
import { getBearerToken, isExpectedApiToken } from '../../backplane/http/auth.js';
import { readJsonBodyWithLimit, sendJson } from '../../backplane/http/primitives.js';
import { createComponentLogger } from '../../../shared/logger.js';
import { MAX_BODY_SIZE } from './http.js';

const log = createComponentLogger('ExternalMemoryMcp');
const descriptions = {
  context: 'Recall companion memories relevant to the current task.',
  search: 'Find memories accessible to the bound companion and contact.',
  get: 'Read one accessible memory by its ID.',
  remember: 'Durably submit an explicit memory with an idempotent event ID.',
  ingest: 'Archive a completed top-level user and assistant exchange for memory processing.',
};

type Execute = (params: ExternalMemoryExecuteParams) => Promise<ExternalMemoryExecuteResult>;

/** A separate service credential admits only the fixed companion memory surface. */
export class ExternalMemoryMcpRoute {
  private readonly bindings: ExternalMemoryApiConfig['bindings'];

  constructor(config: ExternalMemoryApiConfig, private readonly execute: Execute, reservedTokens: Array<string | undefined>) {
    const seenBodies = new Set<string>();
    const seenTokens = new Set<string>();
    this.bindings = config.bindings.map(({ apiKey, ...identity }) => {
      const binding = parseExternalMemoryBinding(identity);
      const token = apiKey.trim();
      if (!token || seenBodies.has(binding.bodyId) || seenTokens.has(token)
        || reservedTokens.some(reserved => isExpectedApiToken(reserved, token))) {
        throw new Error('External memory credentials must be unique and separate from other API credentials');
      }
      seenBodies.add(binding.bodyId);
      seenTokens.add(token);
      return { ...binding, apiKey: token };
    });
  }

  matches(url: string): boolean {
    return this.bindings.length > 0 && url.split('?', 1)[0] === '/v1/memory/mcp';
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // This is a machine-to-machine surface; browser credentials never authorize it.
    if (req.headers.origin !== undefined) {
      sendJson(res, 403, { error: 'Browser origins are not supported for external memory' });
      return;
    }
    const bearer = getBearerToken(req);
    const credential = this.bindings.find(binding => isExpectedApiToken(bearer, binding.apiKey));
    if (!credential) {
      sendJson(res, 401, { error: 'External memory credential required' }, { 'WWW-Authenticate': 'Bearer' });
      return;
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Method not allowed' }, { Allow: 'POST' });
      return;
    }
    // Stateless serving cannot resume an authenticated transport under another key.
    if (req.headers['mcp-session-id'] !== undefined) {
      sendJson(res, 400, { error: 'MCP sessions are not supported' });
      return;
    }
    const parsed = await readJsonBodyWithLimit(req, res, { maxBytes: MAX_BODY_SIZE, logger: log });
    if (!parsed.ok) {
      if (parsed.errorCode !== 'payload_too_large') sendJson(res, 400, { error: 'Invalid request body' });
      return;
    }
    const { apiKey: _apiKey, ...binding } = credential;
    const handler = createMcpHandler(() => this.createServer(binding), {
      onerror: error => log.warn('External memory MCP request rejected', { error: error.message }),
    });
    try {
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (value !== undefined && name !== 'authorization' && name !== 'cookie') {
          headers.set(name, Array.isArray(value) ? value.join(', ') : value);
        }
      }
      const request = new Request('http://localhost/v1/memory/mcp', {
        method: 'POST', headers, body: parsed.rawBody,
      });
      const response = await handler.fetch(request, { parsedBody: parsed.value });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      log.error('External memory MCP transport failed', { error });
      if (!res.headersSent) sendJson(res, 500, { error: 'External memory transport failed' });
      else res.destroy();
    } finally {
      await handler.close();
    }
  }

  private createServer(binding: ExternalMemoryBinding): McpServer {
    const server = new McpServer({ name: 'psfn-memory', version: '1.0.0' });
    for (const [operation, schema] of Object.entries(EXTERNAL_MEMORY_TOOL_SCHEMAS)) {
      server.registerTool(`psfn_memory_${operation}`, {
        description: descriptions[operation as keyof typeof descriptions],
        inputSchema: fromJsonSchema(schema as JsonSchemaType),
      }, async args => {
        const request = parseExternalMemoryRequest(operation, args);
        const result = await this.execute({ binding, request });
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
      });
    }
    return server;
  }
}
