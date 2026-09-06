import { afterEach, describe, expect, it, vi } from 'vitest';
import { fromPartial } from '@total-typescript/shoehorn';
import { createServer, type Server } from 'node:http';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { ExternalMemoryMcpRoute } from './external-memory-mcp.js';
import type { ExternalMemoryExecuteParams } from '../../../shared/contracts/external-memory.js';
import { ApiServer } from '../server.js';
import { EventBus } from '../../../shared/event-bus.js';

const binding = {
  bodyId: 'hermes-work', companionId: '11111111-1111-4111-8111-111111111111', contactId: 'contact-operator',
};
const token = 'dedicated-external-memory-token';
const servers: Server[] = [];
const clients: Client[] = [];
const execute = vi.fn(async (_params: ExternalMemoryExecuteParams) => ({ context: 'A useful remembered preference.' }));

async function listen(route: ExternalMemoryMcpRoute, api?: ApiServer): Promise<string> {
  const server = createServer((req, res) => {
    if (api) {
      Reflect.get(api, 'handleRequest').call(api, req, res);
      return;
    }
    if (route.matches(req.url ?? '/')) void route.handle(req, res);
    else res.writeHead(404).end();
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  return `http://127.0.0.1:${address.port}/v1/memory/mcp`;
}

function route(extraBindings: Array<typeof binding & { apiKey: string }> = []): ExternalMemoryMcpRoute {
  return new ExternalMemoryMcpRoute({ bindings: [{ ...binding, apiKey: token }, ...extraBindings] }, execute, ['ordinary-api-key', 'testing-harness-key']);
}

async function client(url: string, bearer = token): Promise<Client> {
  const instance = new Client({ name: 'memory-test', version: '1.0.0' });
  clients.push(instance);
  await instance.connect(new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
  }));
  return instance;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map(instance => instance.close()));
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  })));
  execute.mockClear();
});

describe('external memory MCP', () => {
  it('negotiates with the SDK client and exposes exactly the five memory operations', async () => {
    const instance = await client(await listen(route()));
    const listed = await instance.listTools();
    expect(listed.tools.map(tool => tool.name).sort()).toEqual([
      'psfn_memory_context', 'psfn_memory_get', 'psfn_memory_ingest', 'psfn_memory_remember', 'psfn_memory_search',
    ]);
    const result = await instance.callTool({ name: 'psfn_memory_context', arguments: { sessionId: 's1', query: 'preferences' } });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({ context: 'A useful remembered preference.' });
    expect(execute).toHaveBeenCalledWith({ binding, request: { operation: 'context', sessionId: 's1', query: 'preferences' } });
  });

  it('supports the Hermes 2025 protocol initialization and tool calls', async () => {
    const url = await listen(route());
    const send = async (id: number, method: string, params: object) => {
      const response = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      });
      expect(response.status).toBe(200);
      return await response.text();
    };
    expect(await send(1, 'initialize', {
      protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'hermes', version: '0.21.0' },
    })).toContain('companion-memory');
    expect(await send(2, 'tools/call', { name: 'psfn_memory_context', arguments: { sessionId: 's1', query: 'task' } }))
      .toContain('A useful remembered preference.');
  });

  it('authenticates each request and routes separate credentials to exact fixed bindings', async () => {
    const other = { bodyId: 'hermes-other', companionId: '22222222-2222-4222-8222-222222222222', contactId: 'contact-other' };
    const url = await listen(route([{ ...other, apiKey: 'second-dedicated-memory-token' }]));
    const first = await client(url);
    const second = await client(url, 'second-dedicated-memory-token');
    await Promise.all([first, second].map(instance => instance.callTool({ name: 'psfn_memory_search', arguments: { sessionId: 'same-session', query: 'task' } })));
    expect(execute.mock.calls.map(([params]) => params.binding)).toEqual(expect.arrayContaining([binding, other]));
    for (const credential of [undefined, 'ordinary-api-key', 'testing-harness-key', 'sso-cookie-value']) {
      const response = await fetch(url, { method: 'POST', headers: credential ? { Authorization: `Bearer ${credential}` } : { Cookie: 'session=sso-cookie-value' } });
      expect(response.status).toBe(401);
    }
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('rejects caller identity overrides, unknown operations, browser origins and transport sessions', async () => {
    const url = await listen(route());
    const instance = await client(url);
    const override = await instance.callTool({ name: 'psfn_memory_context', arguments: { sessionId: 's1', query: 'task', companionId: binding.companionId } });
    expect(override.isError).toBe(true);
    await expect(instance.callTool({ name: 'psfn_memory_delete', arguments: { id: 'm1' } })).rejects.toThrow('not found');
    for (const headers of [{ Origin: 'https://example.test' }, { 'Mcp-Session-Id': 'some-session' }]) {
      const response = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, ...headers } });
      expect(response.status).toBe(headers.Origin ? 403 : 400);
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it('admits the dedicated route before fleet SSO while rejecting SSO and test credentials', async () => {
    const memoryRoute = route();
    const sso = vi.fn();
    const agent = vi.fn();
    const api = new ApiServer({
      port: 0, modelName: binding.companionId, fleetAuthBootstrapOnly: true,
      agentLoop: fromPartial({ handleMessage: agent }), eventBus: new EventBus(),
      sessionManager: fromPartial({}), externalMemoryMcp: memoryRoute,
      fleetSsoRouter: fromPartial({ matches: () => true, handle: sso, registerGardenChatHandler: vi.fn() }),
    });
    const instance = await client(await listen(memoryRoute, api));
    await instance.callTool({ name: 'psfn_memory_get', arguments: { sessionId: 's1', id: 'm1' } });
    expect(execute).toHaveBeenCalledOnce();
    expect(sso).not.toHaveBeenCalled();
    expect(agent).not.toHaveBeenCalled();
  });

  it('fails startup on ambiguous or reused credentials', () => {
    expect(() => new ExternalMemoryMcpRoute({ bindings: [{ ...binding, apiKey: '' }] }, execute, [])).toThrow('unique');
    expect(() => route([{ ...binding, apiKey: 'different-key' }])).toThrow('unique');
    expect(() => route([{ ...binding, bodyId: 'another-body', apiKey: token }])).toThrow('unique');
    expect(() => new ExternalMemoryMcpRoute({ bindings: [{ ...binding, apiKey: token }] }, execute, [token])).toThrow('separate');
    expect(route().matches('/v1/chat/completions')).toBe(false);
    expect(new ExternalMemoryMcpRoute({ bindings: [] }, execute, []).matches('/v1/memory/mcp')).toBe(false);
  });
});
