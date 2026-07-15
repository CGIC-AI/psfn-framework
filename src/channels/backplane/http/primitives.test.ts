import type { IncomingMessage, ServerResponse } from 'node:http';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  bindRequestForResponse,
  sendCompressedJson,
  sendJson,
} from './primitives.js';

class CapturingResponse {
  statusCode = 0;
  headers: Record<string, string> = {};
  private chunks: Buffer[] = [];

  writeHead(statusCode: number, headers: Record<string, string>): this {
    this.statusCode = statusCode;
    this.headers = headers;
    return this;
  }

  end(chunk?: string | Buffer): void {
    if (chunk !== undefined) {
      this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
  }

  get rawBody(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

function makeReq(
  method: string,
  headers: Record<string, string | string[] | undefined> = {},
): IncomingMessage {
  return { method, headers } as unknown as IncomingMessage;
}

function largePayload(): { entries: string[] } {
  // Comfortably over the 1KB compression threshold and highly compressible.
  return { entries: Array.from({ length: 200 }, (_, i) => `entry-${i}-xxxxxxxxxx`) };
}

describe('sendJson request-bound negotiation', () => {
  it('compresses GET responses >=1KB when gzip is accepted', () => {
    const req = makeReq('GET', { 'accept-encoding': 'gzip' });
    const res = new CapturingResponse();
    bindRequestForResponse(res as unknown as ServerResponse, req);
    const body = largePayload();

    sendJson(res as unknown as ServerResponse, 200, body);

    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Encoding']).toBe('gzip');
    expect(res.headers.Vary).toContain('Accept-Encoding');
    expect(res.headers['Content-Length']).toBe(String(res.rawBody.length));
    // The compressed wire body must be strictly smaller than the raw JSON.
    expect(res.rawBody.length).toBeLessThan(Buffer.byteLength(JSON.stringify(body)));
    const decoded = JSON.parse(gunzipSync(res.rawBody).toString('utf8'));
    expect(decoded).toEqual(body);
  });

  it('prefers brotli when the client accepts it', () => {
    const req = makeReq('GET', { 'accept-encoding': 'br, gzip' });
    const res = new CapturingResponse();
    bindRequestForResponse(res as unknown as ServerResponse, req);
    const body = largePayload();

    sendJson(res as unknown as ServerResponse, 200, body);

    expect(res.headers['Content-Encoding']).toBe('br');
    const decoded = JSON.parse(brotliDecompressSync(res.rawBody).toString('utf8'));
    expect(decoded).toEqual(body);
  });

  it('does not compress payloads under 1KB but still emits Vary and ETag', () => {
    const req = makeReq('GET', { 'accept-encoding': 'gzip, br' });
    const res = new CapturingResponse();
    bindRequestForResponse(res as unknown as ServerResponse, req);
    const body = { ok: true };

    sendJson(res as unknown as ServerResponse, 200, body);

    expect(res.headers['Content-Encoding']).toBeUndefined();
    expect(res.headers.Vary).toContain('Accept-Encoding');
    expect(res.headers.ETag).toMatch(/^W\//);
    expect(JSON.parse(res.rawBody.toString('utf8'))).toEqual(body);
  });

  it('answers a matching If-None-Match with 304 and an empty body', () => {
    const body = largePayload();

    const firstReq = makeReq('GET', { 'accept-encoding': 'gzip' });
    const firstRes = new CapturingResponse();
    bindRequestForResponse(firstRes as unknown as ServerResponse, firstReq);
    sendJson(firstRes as unknown as ServerResponse, 200, body);
    const etag = firstRes.headers.ETag;
    expect(etag).toBeTruthy();

    const secondReq = makeReq('GET', { 'accept-encoding': 'gzip', 'if-none-match': etag });
    const secondRes = new CapturingResponse();
    bindRequestForResponse(secondRes as unknown as ServerResponse, secondReq);
    sendJson(secondRes as unknown as ServerResponse, 200, body);

    expect(secondRes.statusCode).toBe(304);
    expect(secondRes.rawBody.length).toBe(0);
    expect(secondRes.headers.ETag).toBe(etag);
    expect(secondRes.headers.Vary).toContain('Accept-Encoding');
    expect(secondRes.headers['Content-Encoding']).toBeUndefined();
  });

  it('does not tag or 304 mutation (POST) responses', () => {
    const body = largePayload();

    // First establish what ETag the equivalent GET would produce.
    const getReq = makeReq('GET', { 'accept-encoding': 'gzip' });
    const getRes = new CapturingResponse();
    bindRequestForResponse(getRes as unknown as ServerResponse, getReq);
    sendJson(getRes as unknown as ServerResponse, 200, body);
    const etag = getRes.headers.ETag;

    const postReq = makeReq('POST', { 'accept-encoding': 'gzip', 'if-none-match': etag });
    const postRes = new CapturingResponse();
    bindRequestForResponse(postRes as unknown as ServerResponse, postReq);
    sendJson(postRes as unknown as ServerResponse, 200, body);

    expect(postRes.statusCode).toBe(200);
    expect(postRes.headers.ETag).toBeUndefined();
    // Compression still applies to large mutation payloads; only caching is skipped.
    expect(postRes.headers['Content-Encoding']).toBe('gzip');
  });

  it('skips ETag/304 for no-store responses but still compresses', () => {
    const body = largePayload();

    const req = makeReq('GET', { 'accept-encoding': 'gzip' });
    const res = new CapturingResponse();
    bindRequestForResponse(res as unknown as ServerResponse, req);
    sendJson(res as unknown as ServerResponse, 200, body, { 'Cache-Control': 'no-store' });

    expect(res.headers.ETag).toBeUndefined();
    expect(res.headers['Content-Encoding']).toBe('gzip');
    expect(res.headers['Cache-Control']).toBe('no-store');
  });

  it('leaves responses without a bound request uncompressed and untagged (legacy path)', () => {
    const res = new CapturingResponse();
    const body = largePayload();

    sendJson(res as unknown as ServerResponse, 200, body);

    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Encoding']).toBeUndefined();
    expect(res.headers.ETag).toBeUndefined();
    expect(res.headers.Vary).toBeUndefined();
    expect(JSON.parse(res.rawBody.toString('utf8'))).toEqual(body);
  });

  it('serves an uncompressed body when the client sends no Accept-Encoding', () => {
    const req = makeReq('GET', {});
    const res = new CapturingResponse();
    bindRequestForResponse(res as unknown as ServerResponse, req);
    const body = largePayload();

    sendJson(res as unknown as ServerResponse, 200, body);

    expect(res.headers['Content-Encoding']).toBeUndefined();
    expect(JSON.parse(res.rawBody.toString('utf8'))).toEqual(body);
  });
});

describe('sendCompressedJson', () => {
  it('compresses and answers conditional requests via the shared responder', () => {
    const body = largePayload();

    const firstReq = makeReq('GET', { 'accept-encoding': 'gzip' });
    const firstRes = new CapturingResponse();
    sendCompressedJson(firstReq, firstRes as unknown as ServerResponse, 200, body);
    expect(firstRes.headers['Content-Encoding']).toBe('gzip');
    const etag = firstRes.headers.ETag;
    expect(etag).toBeTruthy();

    const secondReq = makeReq('GET', { 'accept-encoding': 'gzip', 'if-none-match': etag });
    const secondRes = new CapturingResponse();
    sendCompressedJson(secondReq, secondRes as unknown as ServerResponse, 200, body);
    expect(secondRes.statusCode).toBe(304);
    expect(secondRes.rawBody.length).toBe(0);
  });
});
