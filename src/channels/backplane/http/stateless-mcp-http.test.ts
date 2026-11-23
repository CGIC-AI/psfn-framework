import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import {
  rejectBrowserOriginForMcp,
  rejectInvalidStatelessMcpRequest,
  sanitizeHeadersForStatelessMcp,
} from './stateless-mcp-http.js';

function fakeResponse() {
  let status = 0;
  let headers: Record<string, string> = {};
  let body = '';
  const res = {
    writeHead(code: number, hdrs: Record<string, string>) {
      status = code;
      headers = hdrs;
    },
    end(chunk?: string | Buffer) {
      body = chunk ? chunk.toString() : '';
    },
  } as unknown as ServerResponse;
  return { res, getStatus: () => status, getHeaders: () => headers, getBody: () => JSON.parse(body) as unknown };
}

describe('stateless HTTP MCP helpers', () => {
  it('rejects browser origins with 403', () => {
    const req = { headers: { origin: 'https://evil.example' } } as IncomingMessage;
    const capture = fakeResponse();
    expect(rejectBrowserOriginForMcp(req, capture.res, { originRejectedError: 'No browser' })).toBe(true);
    expect(capture.getStatus()).toBe(403);
    expect(capture.getBody()).toEqual({ error: 'No browser' });
  });

  it('rejects non-POST methods with 405 and session headers with 400', () => {
    const getReq = { method: 'GET', headers: {} } as IncomingMessage;
    const getCapture = fakeResponse();
    expect(rejectInvalidStatelessMcpRequest(getReq, getCapture.res)).toBe(true);
    expect(getCapture.getStatus()).toBe(405);
    expect(getCapture.getHeaders().Allow).toBe('POST');

    const sessionReq = { method: 'POST', headers: { 'mcp-session-id': 'abc' } } as IncomingMessage;
    const sessionCapture = fakeResponse();
    expect(rejectInvalidStatelessMcpRequest(sessionReq, sessionCapture.res)).toBe(true);
    expect(sessionCapture.getStatus()).toBe(400);

    const okReq = { method: 'POST', headers: {} } as IncomingMessage;
    const okCapture = fakeResponse();
    expect(rejectInvalidStatelessMcpRequest(okReq, okCapture.res)).toBe(false);
    expect(okCapture.getStatus()).toBe(0);
  });

  it('strips authorization and cookie headers while preserving other headers', () => {
    const req = {
      headers: {
        authorization: 'Bearer secret',
        cookie: 'session=abc',
        accept: 'application/json',
        'x-custom': ['one', 'two'],
      },
    } as unknown as IncomingMessage;

    const sanitized = sanitizeHeadersForStatelessMcp(req);
    expect(sanitized.has('authorization')).toBe(false);
    expect(sanitized.has('cookie')).toBe(false);
    expect(sanitized.get('accept')).toBe('application/json');
    expect(sanitized.get('x-custom')).toBe('one, two');
    expect(vi.isMockFunction(sanitizeHeadersForStatelessMcp)).toBe(false);
  });
});
