import { describe, expect, it } from 'vitest';
import {
  MalformedWorkSpecError,
  parseWorkSpecWireParams,
  toWorkSpecWireParams,
} from './work-spec-wire.js';
import { buildLLMWorkSpec } from './work-spec.js';

describe('parseWorkSpecWireParams (fail-closed RPC boundary)', () => {
  const valid = {
    purpose: 'extraction',
    lane: 'maintenance_reflection',
    durable: true,
    maxOutputTokens: 512,
    deadlineMs: 1_000,
    tokenCeiling: 4096,
    costCeilingUsd: 0,
    cancellation: 'deadline',
    retryPolicy: 'none',
    preemptionProtected: true,
    welfareGrantJobId: 'job-abc-123',
  };

  it('accepts a fully-populated valid spec and returns only recognized fields', () => {
    const parsed = parseWorkSpecWireParams({ ...valid, unknownJunk: 'dropped' });
    expect(parsed).toEqual(valid);
    expect(parsed).not.toHaveProperty('unknownJunk');
  });

  it('carries a non-empty welfareGrantJobId (fxt1)', () => {
    const parsed = parseWorkSpecWireParams({
      purpose: 'extraction',
      lane: 'maintenance_reflection',
      durable: true,
      preemptionProtected: true,
      welfareGrantJobId: 'job-xyz',
    });
    expect(parsed.welfareGrantJobId).toBe('job-xyz');
  });

  it('accepts a minimal spec (required fields only)', () => {
    expect(parseWorkSpecWireParams({
      purpose: 'background',
      lane: 'background_continuation',
      durable: false,
    })).toEqual({
      purpose: 'background',
      lane: 'background_continuation',
      durable: false,
    });
  });

  it.each([
    ['non-object', 42],
    ['null', null],
    ['array', [{ purpose: 'chat' }]],
    ['invalid purpose', { purpose: 'nope', lane: 'foreground_chat', durable: true }],
    ['invalid lane', { purpose: 'chat', lane: 'not_a_lane', durable: true }],
    ['missing durable', { purpose: 'chat', lane: 'foreground_chat' }],
    ['non-boolean durable', { purpose: 'chat', lane: 'foreground_chat', durable: 'yes' }],
    ['zero maxOutputTokens', { purpose: 'chat', lane: 'foreground_chat', durable: true, maxOutputTokens: 0 }],
    ['negative deadlineMs', { purpose: 'chat', lane: 'foreground_chat', durable: true, deadlineMs: -1 }],
    ['negative costCeilingUsd', { purpose: 'chat', lane: 'foreground_chat', durable: true, costCeilingUsd: -0.5 }],
    ['bad cancellation', { purpose: 'chat', lane: 'foreground_chat', durable: true, cancellation: 'maybe' }],
    ['bad retryPolicy', { purpose: 'chat', lane: 'foreground_chat', durable: true, retryPolicy: 'always' }],
    ['non-boolean preemptionProtected', { purpose: 'chat', lane: 'foreground_chat', durable: true, preemptionProtected: 1 }],
    ['non-string welfareGrantJobId', { purpose: 'chat', lane: 'foreground_chat', durable: true, welfareGrantJobId: 42 }],
    ['empty welfareGrantJobId', { purpose: 'chat', lane: 'foreground_chat', durable: true, welfareGrantJobId: '' }],
    ['blank welfareGrantJobId', { purpose: 'chat', lane: 'foreground_chat', durable: true, welfareGrantJobId: '   ' }],
  ])('fails closed on %s', (_label, value) => {
    expect(() => parseWorkSpecWireParams(value)).toThrow(MalformedWorkSpecError);
  });

  it('round-trips a built LLMWorkSpec through the wire form, dropping correlation', () => {
    const spec = buildLLMWorkSpec({
      purpose: 'extraction',
      durable: true,
      maxOutputTokens: 256,
      correlation: { callType: 'background', originStage: 'memory.extraction', channelId: 'c1' },
    });
    const wire = toWorkSpecWireParams(spec);
    expect(wire).not.toHaveProperty('correlation');
    // The wire form re-parses cleanly (the boundary accepts what the client sends).
    expect(parseWorkSpecWireParams(wire)).toEqual(wire);
    expect(wire.lane).toBe(spec.lane);
    expect(wire.purpose).toBe('extraction');
  });
});
