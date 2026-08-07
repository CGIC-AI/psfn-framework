import { describe, expect, it } from 'vitest';
import { parseAdminJsonBody } from './request-body.js';

describe('parseAdminJsonBody', () => {
  it.each([
    { label: 'empty bytes', input: Buffer.alloc(0), expected: {} },
    { label: 'empty text', input: '  ', expected: {} },
    { label: 'valid JSON bytes', input: Buffer.from('{"ok":true}'), expected: { ok: true } },
    { label: 'valid JSON text', input: '{"ok":true}', expected: { ok: true } },
    { label: 'an already-decoded object', input: { ok: true }, expected: { ok: true } },
    { label: 'an already-decoded null', input: null, expected: null },
  ])('normalizes $label exactly once', ({ input, expected }) => {
    expect(parseAdminJsonBody(input)).toEqual({ ok: true, value: expected });
  });

  it('rejects malformed JSON without throwing', () => {
    expect(parseAdminJsonBody('{')).toEqual({
      ok: false,
      error: 'Invalid JSON payload',
    });
  });
});
