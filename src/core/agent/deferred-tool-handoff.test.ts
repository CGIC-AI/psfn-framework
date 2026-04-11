import { describe, expect, it } from 'vitest';
import {
  normalizeDeferredToolHandoffIntent,
  normalizeToolNameList,
} from './deferred-tool-handoff.js';

describe('normalizeToolNameList', () => {
  it('accepts mixed string and object tool name entries', () => {
    expect(normalizeToolNameList([
      ' image_edit ',
      { name: 'image_analyze' },
      { name: 'image_edit' },
      { name: '   ' },
      { tool: 'ignored' },
      null,
    ])).toEqual(['image_edit', 'image_analyze']);
  });
});

describe('normalizeDeferredToolHandoffIntent', () => {
  it('accepts object tool name entries in deferred payloads', () => {
    expect(normalizeDeferredToolHandoffIntent({
      toolNames: [{ name: 'image_edit' }],
      intendedAction: 'continue edit flow',
      maxRetries: 2,
      sessionId: 'session-1',
    })).toEqual({
      toolNames: ['image_edit'],
      intendedAction: 'continue edit flow',
      maxRetries: 2,
      sessionId: 'session-1',
    });
  });
});
