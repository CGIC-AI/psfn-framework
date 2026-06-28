import { describe, expect, it } from 'vitest';
import {
  assertNoRetiredFirstPartyToolAliases,
  isCanonicalFirstPartyToolName,
} from '../../../core/agent/tool-surface/registry.js';

describe('startup composition tool surface registry coverage', () => {
  it('keeps first-party tool names registered by shared composition paths canonical', () => {
    const compositionToolNames = [
      'analysis_workbench',
      'beads',
      'fs',
      'identity',
      'north_star',
      'orient',
      'schedule',
      'session',
      'subagent',
      'system',
      'tool_search',
      'toolset',
    ];

    expect(compositionToolNames.every(isCanonicalFirstPartyToolName)).toBe(true);
    expect(() => assertNoRetiredFirstPartyToolAliases(
      compositionToolNames,
      'shared startup composition',
    )).not.toThrow();
  });
});
