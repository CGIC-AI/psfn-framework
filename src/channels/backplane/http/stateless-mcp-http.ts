// ── Shared stateless HTTP MCP route helper ──
//
// Machine-to-machine MCP surfaces (external memory, external channel bridges)
// share the exact same fail-closed HTTP posture: reject browser Origins, allow
// POST only, reject MCP session resumption headers, strip ambient auth/cookie
// headers before constructing the Fetch Request, run the stateless MCP handler
// over the pre-parsed JSON body, write status/headers/body back, and always
// close the handler.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createMcpHandler, type McpServer } from '@modelcontextprotocol/server';
import { sendJson } from './primitives.js';

interface StatelessMcpGuardOptions {
  originRejectedError: string;
}

/**
 * Enforce the shared pre-auth / post-auth stateless HTTP MCP invariants.
 * Returns `true` when the request may proceed; writes the HTTP error response
 * and returns `false` otherwise.
 */
export function rejectBrowserOriginForMcp(
  req: IncomingMessage,
  res: ServerResponse,
  options: StatelessMcpGuardOptions,
): boolean {
  if (req.headers.origin !== undefined) {
    sendJson(res, 403, { error: options.originRejectedError });
    return true;
  }
  return false;
}

export function rejectInvalidStatelessMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' }, { Allow: 'POST' });
    return true;
  }
  // Stateless serving cannot resume an authenticated transport under another key.
  if (req.headers['mcp-session-id'] !== undefined) {
    sendJson(res, 400, { error: 'MCP sessions are not supported' });
    return true;
  }
  return false;
}

export function sanitizeHeadersForStatelessMcp(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value !== undefined && name !== 'authorization' && name !== 'cookie') {
      headers.set(name, Array.isArray(value) ? value.join(', ') : value);
    }
  }
  return headers;
}

interface DispatchStatelessMcpHttpOptions {
  req: IncomingMessage;
  res: ServerResponse;
  endpointPath: string;
  rawBody: string;
  parsedBody: unknown;
  createServer: () => McpServer;
  onError: (error: Error) => void;
}

export async function dispatchStatelessMcpHttp(
  options: DispatchStatelessMcpHttpOptions,
): Promise<void> {
  const { req, res, endpointPath, rawBody, parsedBody, createServer, onError } = options;
  const handler = createMcpHandler(createServer, { onerror: onError });
  try {
    const request = new Request(`http://localhost${endpointPath}`, {
      method: 'POST',
      headers: sanitizeHeadersForStatelessMcp(req),
      body: rawBody,
    });
    const response = await handler.fetch(request, { parsedBody });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } finally {
    await handler.close();
  }
}
