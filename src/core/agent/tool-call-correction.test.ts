import { describe, expect, it } from 'vitest';
import {
  buildMalformedArgumentsCorrection,
  buildSchemaValidationCorrection,
  buildUnknownToolCorrection,
  isMalformedToolArguments,
  suggestNearestToolName,
} from './tool-call-correction.js';

describe('tool-call-correction', () => {
  describe('unknown_tool', () => {
    it('resolves a retired first-party alias to its canonical replacement + action', () => {
      const correction = buildUnknownToolCorrection('fs_read', ['fs', 'web', 'memory']);
      expect(correction.defectClass).toBe('unknown_tool');
      expect(correction.suggestion).toBe('fs');
      expect(correction.text).toContain('"fs_read" is not callable');
      expect(correction.text).toContain('Call "fs" with action="read"');
    });

    it('suggests the nearest catalog name for a near-miss and echoes availability', () => {
      const correction = buildUnknownToolCorrection('memroy', ['memory', 'web', 'fs']);
      expect(correction.defectClass).toBe('unknown_tool');
      expect(correction.suggestion).toBe('memory');
      expect(correction.text).toContain('Did you mean "memory"?');
      expect(correction.text).toContain('Available tools: fs, memory, web.');
    });

    it('omits a suggestion when nothing is close but still echoes the catalog', () => {
      const correction = buildUnknownToolCorrection('completely_made_up_surface', ['memory', 'web']);
      expect(correction.suggestion).toBeUndefined();
      expect(correction.text).not.toContain('Did you mean');
      expect(correction.text).toContain('Available tools: memory, web.');
    });
  });

  describe('suggestNearestToolName', () => {
    it('returns a name within bounded edit distance', () => {
      expect(suggestNearestToolName('journl', ['journal', 'memory'])).toBe('journal');
    });

    it('returns undefined when the closest name is too far', () => {
      expect(suggestNearestToolName('xyz', ['journal', 'memory'])).toBeUndefined();
    });
  });

  describe('malformed_arguments', () => {
    it('flags non-object argument shapes but not objects, undefined, or empty objects', () => {
      expect(isMalformedToolArguments('{"action":"list"')).toBe(true);
      expect(isMalformedToolArguments(null)).toBe(true);
      expect(isMalformedToolArguments(['action'])).toBe(true);
      expect(isMalformedToolArguments(42)).toBe(true);
      expect(isMalformedToolArguments({})).toBe(false);
      expect(isMalformedToolArguments({ action: 'list' })).toBe(false);
      expect(isMalformedToolArguments(undefined)).toBe(false);
    });

    it('describes the observed shape in the corrective result', () => {
      const correction = buildMalformedArgumentsCorrection('memory', '"broken json');
      expect(correction.defectClass).toBe('malformed_arguments');
      expect(correction.text).toContain('malformed arguments (a JSON string)');
      expect(correction.text).toContain('single well-formed JSON object');
    });
  });

  describe('schema_invalid', () => {
    it('preserves the original validation message and appends a reprompt instruction', () => {
      const raw = 'Validation failed for tool "memory":\n  - action: must have required properties action';
      const correction = buildSchemaValidationCorrection('memory', raw);
      expect(correction.defectClass).toBe('schema_invalid');
      expect(correction.text).toContain(raw);
      expect(correction.text).toContain('call "memory" again with a complete JSON object');
    });
  });
});
