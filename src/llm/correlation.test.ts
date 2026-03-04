import { describe, expect, it } from 'vitest';
import {
  inferCallType,
  isObservabilityCallType,
  normalizeCorrelationValue,
  resolveCorrelationMetadata,
  toCorrelationLogFields,
} from './correlation.js';
import type { CorrelationMetadata } from '../types.js';

describe('correlation helpers', () => {
  describe('normalizeCorrelationValue', () => {
    it('trims non-empty strings and rejects empty values', () => {
      expect(normalizeCorrelationValue('  turn-123  ')).toBe('turn-123');
      expect(normalizeCorrelationValue('   ')).toBeUndefined();
      expect(normalizeCorrelationValue(undefined)).toBeUndefined();
    });
  });

  describe('isObservabilityCallType', () => {
    it('accepts only supported observability call types', () => {
      expect(isObservabilityCallType('chat')).toBe(true);
      expect(isObservabilityCallType('tool')).toBe(true);
      expect(isObservabilityCallType('memory')).toBe(true);
      expect(isObservabilityCallType('summary')).toBe(true);
      expect(isObservabilityCallType('background')).toBe(true);
      expect(isObservabilityCallType('scheduled')).toBe(true);

      expect(isObservabilityCallType('CHAT')).toBe(false);
      expect(isObservabilityCallType('invalid')).toBe(false);
      expect(isObservabilityCallType(123)).toBe(false);
      expect(isObservabilityCallType(null)).toBe(false);
    });
  });

  describe('inferCallType', () => {
    it('maps completion purpose to a stable call type', () => {
      expect(inferCallType('chat')).toBe('chat');
      expect(inferCallType('reasoning')).toBe('tool');
      expect(inferCallType('extraction')).toBe('memory');
      expect(inferCallType('summary')).toBe('summary');
      expect(inferCallType('background')).toBe('background');
      expect(inferCallType('import_processing')).toBe('background');
    });

    it('marks internal channel calls as scheduled regardless of purpose', () => {
      expect(inferCallType('chat', '  Internal:Heartbeat  ')).toBe('scheduled');
      expect(inferCallType('reasoning', 'internal:jobs')).toBe('scheduled');
    });
  });

  describe('resolveCorrelationMetadata', () => {
    it('normalizes merged metadata and applies option precedence', () => {
      const context: CorrelationMetadata = {
        turnId: 'context-turn',
        requestId: 'context-request',
        channelId: 'discord:general',
        callType: 'chat',
        toolName: 'context-tool',
        toolCallId: 'context-call',
        purpose: 'context.stage',
        originType: 'chat',
        originStage: 'context.stage',
      };

      const options: Partial<CorrelationMetadata> = {
        turnId: '  option-turn  ',
        requestId: '   ',
        channelId: '  internal:heartbeat  ',
        callType: 'tool',
        toolName: '  option-tool  ',
        toolCallId: '   ',
        purpose: '  option.stage  ',
        originType: 'summary',
        originStage: '  option.origin  ',
      };

      expect(resolveCorrelationMetadata(context, options, 'background')).toEqual({
        turnId: 'option-turn',
        requestId: 'option-turn',
        channelId: 'internal:heartbeat',
        callType: 'tool',
        toolName: 'option-tool',
        purpose: 'option.stage',
        originType: 'summary',
        originStage: 'option.origin',
      });
    });

    it('falls back to inferred values when provided call types are invalid', () => {
      const context: CorrelationMetadata = {
        turnId: '  turn-1  ',
        channelId: '  internal:jobs  ',
        callType: 'chat',
        purpose: 'context.purpose',
      };

      const options = {
        requestId: '   ',
        callType: 'invalid',
        originType: 'not-real',
        originStage: '   ',
        purpose: '   ',
      } as unknown as Partial<CorrelationMetadata>;

      expect(resolveCorrelationMetadata(context, options, 'reasoning')).toEqual({
        turnId: 'turn-1',
        requestId: 'turn-1',
        channelId: 'internal:jobs',
        callType: 'scheduled',
        purpose: 'reasoning',
        originType: 'scheduled',
        originStage: 'reasoning',
      });
    });

    it('uses defaults when no correlation metadata is provided', () => {
      expect(resolveCorrelationMetadata(undefined, undefined, 'summary')).toEqual({
        requestId: 'unknown',
        callType: 'summary',
        purpose: 'summary',
        originType: 'summary',
        originStage: 'summary',
      });
    });
  });

  describe('toCorrelationLogFields', () => {
    it('normalizes log fields and uses callType when originType is invalid', () => {
      const correlation = {
        turnId: '  turn-log  ',
        requestId: '   ',
        channelId: '  discord:general  ',
        toolName: '  planner  ',
        toolCallId: '   ',
        callType: 'memory',
        originType: 'invalid',
        originStage: '   ',
        purpose: '  extraction.run  ',
      } as unknown as Partial<CorrelationMetadata>;

      expect(toCorrelationLogFields(correlation)).toEqual({
        turnId: 'turn-log',
        requestId: 'turn-log',
        channelId: 'discord:general',
        toolName: 'planner',
        originType: 'memory',
        originStage: 'extraction.run',
      });
    });

    it('falls back to unknown/background defaults without metadata', () => {
      expect(toCorrelationLogFields(undefined)).toEqual({
        requestId: 'unknown',
        originType: 'background',
        originStage: 'unknown',
      });
    });
  });
});
