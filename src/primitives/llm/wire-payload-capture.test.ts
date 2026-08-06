import { describe, it, expect } from 'vitest';
import {
  captureProviderWirePayload,
  cloneWireBody,
  countWireToolDefinitions,
} from './wire-payload-capture.js';

describe('wire-payload-capture (bead hgw3-80f6)', () => {
  const anthropicBody = {
    model: 'claude-sonnet-4.5',
    max_tokens: 1024,
    system: [{ type: 'text', text: 'You are a companion.', cache_control: { type: 'ephemeral' } }],
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ],
    tools: [
      { name: 'search', description: 'Search', input_schema: { type: 'object', properties: {} } },
      { name: 'recall', description: 'Recall', input_schema: { type: 'object', properties: {} } },
      { name: 'note', description: 'Note', input_schema: { type: 'object', properties: {} } },
    ],
  };

  it('counts each tool definition exactly once', () => {
    expect(countWireToolDefinitions(anthropicBody)).toBe(3);
  });

  it('reports zero tools for bodies without a tools array', () => {
    expect(countWireToolDefinitions({ model: 'x', messages: [] })).toBe(0);
    expect(countWireToolDefinitions({ tools: 'not-an-array' })).toBe(0);
    expect(countWireToolDefinitions(null)).toBe(0);
    expect(countWireToolDefinitions('nope')).toBe(0);
  });

  it('deep-clones the body so later mutation of the source does not leak in', () => {
    const source = { messages: [{ role: 'user', content: 'a' }], tools: [{ name: 't' }] };
    const cloned = cloneWireBody(source) as typeof source;
    source.messages[0].content = 'MUTATED';
    source.tools.push({ name: 't2' });
    expect(cloned.messages[0].content).toBe('a');
    expect(cloned.tools).toHaveLength(1);
  });

  it('captures the exact Date, undefined, array, and plain-object JSON projection', () => {
    const body = cloneWireBody({
      observedAt: new Date('2026-08-06T12:00:00.000Z'),
      omitted: undefined,
      rows: [undefined, { label: 'kept' }],
      nested: { enabled: true },
    });

    expect(body).toEqual({
      observedAt: '2026-08-06T12:00:00.000Z',
      rows: [null, { label: 'kept' }],
      nested: { enabled: true },
    });
  });

  it('captures the summary with tools counted once, byte length, and preserved body', () => {
    const captured = captureProviderWirePayload(anthropicBody, {
      id: 'claude-sonnet-4.5',
      api: 'anthropic-messages',
    });
    expect(captured.api).toBe('anthropic-messages');
    expect(captured.model).toBe('claude-sonnet-4.5');
    expect(captured.toolCount).toBe(3);
    expect(captured.byteLength).toBe(Buffer.byteLength(JSON.stringify(anthropicBody), 'utf8'));
    expect(captured.capturedAtMs).toBeGreaterThan(0);
    // The body is byte-identical to the source (the raw-wire view).
    expect(JSON.stringify(captured.body)).toBe(JSON.stringify(anthropicBody));
    // input_schema appears once per tool — acceptance: count == active-tool count.
    const inputSchemaCount = JSON.stringify(captured.body).match(/input_schema/g)?.length ?? 0;
    expect(inputSchemaCount).toBe(captured.toolCount);
  });

  it('falls back to "unknown" api when the model omits it', () => {
    const captured = captureProviderWirePayload({ messages: [] }, { id: 'm' });
    expect(captured.api).toBe('unknown');
    expect(captured.toolCount).toBe(0);
  });

  it('throws on a non-serializable payload so callers fail loudly', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => captureProviderWirePayload(circular, { id: 'm', api: 'x' })).toThrow();
  });
});
