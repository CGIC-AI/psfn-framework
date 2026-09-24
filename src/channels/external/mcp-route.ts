// ── External channel MCP endpoint (psfn-framework-pus8m) ──
//
// Mounted on the gateway API server beside the external memory route and
// modeled on it: a machine-to-machine, stateless MCP surface where each
// adapter has its own path and its own bearer token. `handle` is total — it
// answers every request with a status and never rejects — so a malformed,
// oversized, stalled, or unauthenticated bridge request cannot escape into
// the API server or any other channel.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createMcpHandler, fromJsonSchema, McpServer, type JsonSchemaType } from '@modelcontextprotocol/server';
import { createComponentLogger } from '../../shared/logger.js';
import { toError } from '../../shared/utils/errors.js';
import { getBearerToken, isExpectedApiToken } from '../backplane/http/auth.js';
import { readJsonBodyWithLimit, sendJson } from '../backplane/http/primitives.js';
import type { ExternalChannelAdapter } from './adapter.js';
import { EXTERNAL_CHANNEL_PLUGIN_ID } from './config.js';
import {
  EXTERNAL_CHANNEL_TOOL_NAMES,
  EXTERNAL_CHANNEL_TOOL_SCHEMAS,
  parseExternalChannelToolInput,
} from './protocol.js';

const log = createComponentLogger('ExternalChannelMcp');
const ROUTE_PREFIX = `/v1/channels/${EXTERNAL_CHANNEL_PLUGIN_ID}/`;
const ROUTE_SUFFIX = '/mcp';

export function externalChannelEndpointPath(instanceId: string): string {
  return `${ROUTE_PREFIX}${instanceId}${ROUTE_SUFFIX}`;
}

const descriptions = {
  hello: 'Negotiate the external channel protocol version and read this adapter\'s identity and limits.',
  inbound: 'Deliver one inbound message; the companion reply, if any, is returned in the result.',
  pullOutbound: 'Drain companion-initiated messages queued for this bridge.',
  health: 'Report bridge liveness and read this adapter\'s status.',
};

type BodyOutcome =
  | { ok: true; rawBody: string; value: unknown }
  | { ok: false };

export class ExternalChannelMcpRoute {
  readonly #adapters = new Map<string, ExternalChannelAdapter>();

  /**
   * Admits every adapter whose credential is unique and distinct from the
   * gateway's other API credentials. An adapter that fails that check is
   * refused (its own start then fails closed) while the others are served.
   */
  constructor(adapters: readonly ExternalChannelAdapter[], reservedTokens: ReadonlyArray<string | undefined>) {
    const tokenOwners = new Map<string, ExternalChannelAdapter[]>();
    for (const adapter of adapters) {
      const token = adapter.token.trim();
      tokenOwners.set(token, [...(tokenOwners.get(token) ?? []), adapter]);
    }
    for (const adapter of adapters) {
      const token = adapter.token.trim();
      const shared = (tokenOwners.get(token)?.length ?? 0) > 1;
      const reserved = reservedTokens.some(candidate => candidate !== undefined && isExpectedApiToken(candidate, token));
      if (!token || shared || reserved) {
        adapter.refuseEndpoint(new Error(
          `External channel adapter "${adapter.instanceId}" credential must be unique `
          + 'and separate from every other API credential',
        ));
        continue;
      }
      this.#adapters.set(adapter.instanceId, adapter);
      adapter.attachEndpoint();
    }
  }

  matches(url: string): boolean {
    return this.#adapters.size > 0 && (url.split('?', 1)[0] ?? '').startsWith(ROUTE_PREFIX);
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      await this.#handle(req, res);
    } catch (error) {
      log.error('External channel request failed', { error: toError(error).message });
      if (!res.headersSent) sendJson(res, 500, { error: 'External channel transport failed' });
      else res.destroy();
    }
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Machine-to-machine only: browser credentials never authorize a bridge.
    if (req.headers.origin !== undefined) {
      sendJson(res, 403, { error: 'Browser origins are not supported for external channels' });
      return;
    }
    const adapter = this.#resolve(req.url ?? '/');
    // Unknown adapters and bad credentials are indistinguishable to the caller.
    if (!adapter || !adapter.authenticates(getBearerToken(req))) {
      sendJson(res, 401, { error: 'External channel credential required' }, { 'WWW-Authenticate': 'Bearer' });
      return;
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Method not allowed' }, { Allow: 'POST' });
      return;
    }
    if (req.headers['mcp-session-id'] !== undefined) {
      sendJson(res, 400, { error: 'MCP sessions are not supported' });
      return;
    }
    if (!adapter.running) {
      sendJson(res, 503, { error: 'External channel adapter is not running' });
      return;
    }
    const body = await this.#readBody(req, res, adapter);
    if (!body.ok) return;
    const handler = createMcpHandler(() => this.#createServer(adapter), {
      onerror: error => log.warn('External channel MCP request rejected', {
        instanceId: adapter.instanceId,
        error: error.message,
      }),
    });
    try {
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (value !== undefined && name !== 'authorization' && name !== 'cookie') {
          headers.set(name, Array.isArray(value) ? value.join(', ') : value);
        }
      }
      const request = new Request(`http://localhost${externalChannelEndpointPath(adapter.instanceId)}`, {
        method: 'POST', headers, body: body.rawBody,
      });
      const response = await handler.fetch(request, { parsedBody: body.value });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } finally {
      await handler.close();
    }
  }

  #resolve(url: string): ExternalChannelAdapter | undefined {
    const path = url.split('?', 1)[0] ?? '';
    if (!path.startsWith(ROUTE_PREFIX) || !path.endsWith(ROUTE_SUFFIX)) return undefined;
    const instanceId = path.slice(ROUTE_PREFIX.length, path.length - ROUTE_SUFFIX.length);
    return this.#adapters.get(instanceId);
  }

  async #readBody(
    req: IncomingMessage,
    res: ServerResponse,
    adapter: ExternalChannelAdapter,
  ): Promise<BodyOutcome> {
    const { maxRequestBytes, requestReadTimeoutMs } = adapter.limits;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stalled = new Promise<'stalled'>((resolve) => {
      timer = setTimeout(() => resolve('stalled'), requestReadTimeoutMs);
    });
    try {
      const outcome = await Promise.race([
        readJsonBodyWithLimit(req, res, { maxBytes: maxRequestBytes, logger: log }),
        stalled,
      ]);
      if (outcome === 'stalled') {
        adapter.recordMalformedRequest(`request body not received within ${requestReadTimeoutMs}ms`);
        if (!res.headersSent) sendJson(res, 408, { error: 'Request body not received in time' });
        req.destroy();
        return { ok: false };
      }
      if (!outcome.ok) {
        adapter.recordMalformedRequest(outcome.errorCode);
        // readJsonBodyWithLimit already answered an oversized body with 413.
        if (outcome.errorCode !== 'payload_too_large') sendJson(res, 400, { error: 'Invalid request body' });
        return { ok: false };
      }
      return { ok: true, rawBody: outcome.rawBody, value: outcome.value };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  #createServer(adapter: ExternalChannelAdapter): McpServer {
    const server = new McpServer({ name: 'companion-channel', version: '1.0.0' });
    const register = <K extends keyof typeof EXTERNAL_CHANNEL_TOOL_SCHEMAS>(
      key: K,
      run: (input: ReturnType<typeof parseExternalChannelToolInput<typeof EXTERNAL_CHANNEL_TOOL_SCHEMAS[K]>>) => unknown,
    ): void => {
      const schema = EXTERNAL_CHANNEL_TOOL_SCHEMAS[key];
      server.registerTool(EXTERNAL_CHANNEL_TOOL_NAMES[key], {
        description: descriptions[key],
        inputSchema: fromJsonSchema(schema as unknown as JsonSchemaType),
      }, async (args) => {
        let input: ReturnType<typeof parseExternalChannelToolInput<typeof EXTERNAL_CHANNEL_TOOL_SCHEMAS[K]>>;
        try {
          input = parseExternalChannelToolInput(schema, args);
        } catch (error) {
          adapter.recordMalformedRequest(toError(error).message);
          throw error;
        }
        const result = await run(input) as Record<string, unknown>;
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
      });
    };
    register('hello', () => adapter.hello());
    register('inbound', input => adapter.receiveInbound(input));
    register('pullOutbound', input => adapter.pullOutbound(input));
    register('health', input => adapter.reportHealth(input));
    return server;
  }
}
