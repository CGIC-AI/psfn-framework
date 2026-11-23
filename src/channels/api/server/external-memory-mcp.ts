import type { IncomingMessage, ServerResponse } from 'node:http';
import { fromJsonSchema, McpServer, type JsonSchemaType } from '@modelcontextprotocol/server';
import {
  EXTERNAL_MEMORY_TOOL_SCHEMAS,
  parseExternalMemoryBinding,
  parseExternalMemoryRequest,
  type ExternalCompanionToolDescriptor,
  type ExternalMemoryBinding,
  type ExternalMemoryExecuteParams,
  type ExternalMemoryExecuteResult,
} from '../../../shared/contracts/external-memory.js';
import type { ExternalMemoryApiConfig } from '../../backplane/external-memory-config.js';
import { getBearerToken, isExpectedApiToken } from '../../backplane/http/auth.js';
import { readJsonBodyWithLimit, sendJson } from '../../backplane/http/primitives.js';
import {
  dispatchStatelessMcpHttp,
  rejectBrowserOriginForMcp,
  rejectInvalidStatelessMcpRequest,
} from '../../backplane/http/stateless-mcp-http.js';
import { createComponentLogger } from '../../../shared/logger.js';
import { isRecord } from '../../../shared/utils/types.js';
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

/** A separate service credential admits the bound companion's memory and internal tool surface. */
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
    if (rejectBrowserOriginForMcp(req, res, {
      originRejectedError: 'Browser origins are not supported for external memory',
    })) {
      return;
    }
    const bearer = getBearerToken(req);
    const credential = this.bindings.find(binding => isExpectedApiToken(bearer, binding.apiKey));
    if (!credential) {
      sendJson(res, 401, { error: 'External memory credential required' }, { 'WWW-Authenticate': 'Bearer' });
      return;
    }
    if (rejectInvalidStatelessMcpRequest(req, res)) {
      return;
    }
    const parsed = await readJsonBodyWithLimit(req, res, { maxBytes: MAX_BODY_SIZE, logger: log });
    if (!parsed.ok) {
      if (parsed.errorCode !== 'payload_too_large') sendJson(res, 400, { error: 'Invalid request body' });
      return;
    }
    const { apiKey: _apiKey, ...binding } = credential;
    try {
      const companionTools = await this.resolveCompanionToolsForPayload(binding, parsed.value);
      await dispatchStatelessMcpHttp({
        req,
        res,
        endpointPath: '/v1/memory/mcp',
        rawBody: parsed.rawBody,
        parsedBody: parsed.value,
        createServer: () => this.createServer(binding, companionTools),
        onError: error => log.warn('External memory MCP request rejected', { error: error.message }),
      });
    } catch (error) {
      log.error('External memory MCP transport failed', { error });
      if (!res.headersSent) sendJson(res, 500, { error: 'External memory transport failed' });
      else res.destroy();
    }
  }

  private async resolveCompanionToolsForPayload(
    binding: ExternalMemoryBinding,
    payload: unknown,
  ): Promise<ExternalCompanionToolDescriptor[]> {
    if (!payloadNeedsCompanionTools(payload)) return [];
    const result = await this.execute({ binding, request: { operation: 'list_tools' } });
    return 'tools' in result && Array.isArray(result.tools) ? result.tools : [];
  }

  private createServer(
    binding: ExternalMemoryBinding,
    companionTools: readonly ExternalCompanionToolDescriptor[] = [],
  ): McpServer {
    const server = new McpServer({ name: 'companion-memory', version: '1.0.0' });
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
    const registeredNames = new Set(
      Object.keys(EXTERNAL_MEMORY_TOOL_SCHEMAS).map(operation => `psfn_memory_${operation}`),
    );
    for (const tool of companionTools) {
      if (!tool.name || tool.name.startsWith('psfn_memory_') || registeredNames.has(tool.name)) continue;
      registeredNames.add(tool.name);
      const inputSchema = fromJsonSchema({ type: 'object', ...tool.inputSchema } as JsonSchemaType);
      server.registerTool(tool.name, {
        description: tool.description,
        inputSchema,
      }, async args => {
        const argumentsRecord = isRecord(args) ? args : {};
        const request = parseExternalMemoryRequest('call_tool', {
          tool: tool.name,
          arguments: argumentsRecord,
        });
        const result = await this.execute({ binding, request });
        if (!('toolResult' in result)) {
          throw new Error(`Unexpected result for companion tool "${tool.name}"`);
        }
        const { toolResult } = result;
        return {
          content: toolResult.content,
          ...(toolResult.details ? { structuredContent: toolResult.details } : {}),
          ...(toolResult.isError ? { isError: true } : {}),
        };
      });
    }
    return server;
  }
}

function payloadNeedsCompanionTools(payload: unknown): boolean {
  const messages = Array.isArray(payload) ? payload : [payload];
  return messages.some(message => {
    if (!isRecord(message)) return false;
    if (message.method === 'tools/list') return true;
    if (message.method !== 'tools/call') return false;
    if (!isRecord(message.params)) return false;
    const name = message.params.name;
    return typeof name === 'string' && name.length > 0 && !name.startsWith('psfn_memory_');
  });
}
