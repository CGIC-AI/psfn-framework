import type { ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  parsePositiveIntegerQueryNumber,
  parsePositiveIntegerQueryParam,
  sendInternalError,
} from './shared.js';

class CapturingResponse {
  statusCode = 0;
  headers: Record<string, string> = {};
  body = '';

  writeHead(statusCode: number, headers: Record<string, string>): this {
    this.statusCode = statusCode;
    this.headers = headers;
    return this;
  }

  end(chunk?: string): void {
    this.body = chunk ?? '';
  }
}

describe('Garden route helpers', () => {
  it('preserves the existing sanitized 500 response shape and optional headers', () => {
    const res = new CapturingResponse();

    sendInternalError(
      res as unknown as ServerResponse,
      new Error('<private>'),
      'fallback',
      { 'Cache-Control': 'no-store' },
    );

    expect(res.statusCode).toBe(500);
    expect(res.headers).toEqual({
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    expect(JSON.parse(res.body)).toEqual({ error: '&lt;private&gt;' });
  });

  it('preserves strict session query parsing and maximum errors', () => {
    expect(parsePositiveIntegerQueryParam(new URLSearchParams('limit=1e2'), 'limit')).toEqual({
      ok: false,
      error: 'limit must be a positive integer',
    });
    expect(parsePositiveIntegerQueryParam(
      new URLSearchParams('limit=51'),
      'limit',
      { max: 50 },
    )).toEqual({ ok: false, error: 'limit must be <= 50' });
    expect(parsePositiveIntegerQueryParam(new URLSearchParams('limit=50'), 'limit')).toEqual({
      ok: true,
      value: 50,
    });
  });

  it('preserves numeric query coercion and caller-specific rejection text', () => {
    expect(parsePositiveIntegerQueryNumber(new URLSearchParams('limit=1e2'), 'limit'))
      .toEqual({ ok: true, value: 100 });
    expect(parsePositiveIntegerQueryNumber(new URLSearchParams('limit=%20'), 'limit'))
      .toEqual({ ok: true });
    expect(parsePositiveIntegerQueryNumber(new URLSearchParams('limit=-1'), 'limit'))
      .toEqual({
        ok: false,
        error: 'Invalid limit query parameter. Expected a positive integer.',
      });
  });

  it('can preserve a route where an explicitly blank query value is rejected', () => {
    expect(parsePositiveIntegerQueryParam(
      new URLSearchParams('limit='),
      'limit',
      { syntax: 'number', blank: 'invalid' },
    )).toEqual({ ok: false, error: 'limit must be a positive integer' });
  });
});
