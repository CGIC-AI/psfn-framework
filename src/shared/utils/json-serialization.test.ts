import { describe, expect, it } from 'vitest';
import {
  normalizeJsonRecordForSerialization,
  normalizeJsonValueForSerialization,
} from './json-serialization.js';

describe('JSON serialization normalization', () => {
  it('mirrors JSON wire semantics and returns a detached value', () => {
    const source = {
      observedAt: new Date('2026-08-06T12:00:00.000Z'),
      omitted: undefined,
      rows: [undefined, { label: 'kept' }],
      nested: { enabled: true },
    };

    const normalized = normalizeJsonRecordForSerialization(source, 'test payload');

    expect(normalized).toEqual({
      observedAt: '2026-08-06T12:00:00.000Z',
      rows: [null, { label: 'kept' }],
      nested: { enabled: true },
    });
    expect(normalized).not.toBe(source);
    expect(normalized.nested).not.toBe(source.nested);
  });

  it('fails loudly when a root value has no JSON representation', () => {
    expect(() => normalizeJsonValueForSerialization(undefined, 'missing payload'))
      .toThrow('missing payload cannot be represented as JSON');
    expect(() => normalizeJsonValueForSerialization(() => undefined, 'callback payload'))
      .toThrow('callback payload cannot be represented as JSON');
  });

  it('rejects values JSON.stringify cannot serialize and non-record projections', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() => normalizeJsonValueForSerialization(circular, 'circular payload')).toThrow();
    expect(() => normalizeJsonValueForSerialization(1n, 'bigint payload')).toThrow();
    expect(() => normalizeJsonRecordForSerialization({
      toJSON: () => ['not', 'a', 'record'],
    }, 'record payload')).toThrow('record payload must serialize to a JSON object');
  });
});
