import { describe, it, expect } from 'vitest';
import { classifyToolArgumentProvenance, findCorruptEmptyToolCalls } from './client.js';
import type { ToolCall, ToolSchema } from '../../shared/contracts/runtime.js';

// gu8m: empty-argument tool-call provenance classification. Makes future incidents
// attributable from logs alone — distinguishing a genuine no-arg call from a stream
// accumulation drop from an ordinary schema rejection.
describe('classifyToolArgumentProvenance', () => {
  it('classifies empty args with zero streamed fragment bytes as provider_emitted_empty', () => {
    expect(classifyToolArgumentProvenance({ args: {}, argumentFragmentBytes: 0 }))
      .toBe('provider_emitted_empty');
    expect(classifyToolArgumentProvenance({ args: undefined, argumentFragmentBytes: 0 }))
      .toBe('provider_emitted_empty');
    expect(classifyToolArgumentProvenance({ args: null, argumentFragmentBytes: 0 }))
      .toBe('provider_emitted_empty');
  });

  it('classifies empty args with streamed fragment bytes as stream_parse_dropped', () => {
    // The pre-patch failure mode: argument fragments were on the wire (e.g. the orphaned
    // blank block) yet the named tool call ended up with {}.
    expect(classifyToolArgumentProvenance({ args: {}, argumentFragmentBytes: 42 }))
      .toBe('stream_parse_dropped');
  });

  it('classifies a literal empty-object payload (2 bytes) as provider_emitted_empty (mihm)', () => {
    // mihm: the provider-side GLM tool-template parser streamed exactly '{}' (2 bytes) as
    // the complete arguments — nothing was lost client-side, so this is provider-emitted,
    // not a stream_parse_dropped accumulator loss.
    expect(classifyToolArgumentProvenance({ args: {}, argumentFragmentBytes: 2 }))
      .toBe('provider_emitted_empty');
  });
});

// mihm: schema-aware detection of tool calls that can never validate — empty arguments
// against a schema that declares required properties. Drives the bounded completion retry.
describe('findCorruptEmptyToolCalls', () => {
  const requiredActionSchema: ToolSchema = {
    name: 'journal',
    description: 'journal tool',
    inputSchema: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] },
  };
  const optionalSchema: ToolSchema = {
    name: 'session',
    description: 'session tool',
    inputSchema: { type: 'object', properties: { action: { type: 'string' } } },
  };

  const emptyCall = (name: string): ToolCall => ({ id: `call-${name}`, name, input: {} });

  it('flags empty args against a required-property schema', () => {
    expect(findCorruptEmptyToolCalls([emptyCall('journal')], [requiredActionSchema]))
      .toHaveLength(1);
  });

  it('does not flag empty args when the schema accepts {} (no required properties)', () => {
    expect(findCorruptEmptyToolCalls([emptyCall('session')], [optionalSchema]))
      .toEqual([]);
  });

  it('does not flag empty args when required is present but empty', () => {
    const emptyRequired: ToolSchema = {
      name: 'noop',
      description: 'noop',
      inputSchema: { type: 'object', properties: {}, required: [] },
    };
    expect(findCorruptEmptyToolCalls([emptyCall('noop')], [emptyRequired]))
      .toEqual([]);
  });

  it('does not flag non-empty args even against a required-property schema', () => {
    const goodCall: ToolCall = { id: 'call-1', name: 'journal', input: { action: 'list' } };
    expect(findCorruptEmptyToolCalls([goodCall], [requiredActionSchema]))
      .toEqual([]);
  });

  it('does not flag an unknown tool (schema unknown → cannot prove required)', () => {
    expect(findCorruptEmptyToolCalls([emptyCall('mystery')], [requiredActionSchema]))
      .toEqual([]);
  });

  it('returns nothing when no tools are in scope', () => {
    expect(findCorruptEmptyToolCalls([emptyCall('journal')], undefined)).toEqual([]);
    expect(findCorruptEmptyToolCalls([emptyCall('journal')], [])).toEqual([]);
  });

  it('classifies non-empty args as validation_rejected (a real schema mismatch)', () => {
    expect(classifyToolArgumentProvenance({ args: { action: 'list' }, argumentFragmentBytes: 0 }))
      .toBe('validation_rejected');
    expect(classifyToolArgumentProvenance({ args: { tools: 'north_star' }, argumentFragmentBytes: 99 }))
      .toBe('validation_rejected');
  });

  it('classifies repaired non-empty streamed args as validation_rejected, not provider_emitted_empty', () => {
    expect(classifyToolArgumentProvenance({
      args: { action: 'write', note: 'line one\nline two with invalid \\q escape' },
      argumentFragmentBytes: 64,
    })).toBe('validation_rejected');
  });
});
