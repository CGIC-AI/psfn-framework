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

  it('keeps every collapsed per-action alias behind the canonical retired-alias guard', () => {
    const collapsedAliases = [
      'create_concern',
      'list_concerns',
      'resolve_concern',
      'north_star_list',
      'north_star_create',
      'north_star_update',
      'north_star_delete',
      'north_star_reorder',
      'self_restart',
      'self_rebuild',
    ];

    for (const alias of collapsedAliases) {
      expect(() => assertNoRetiredFirstPartyToolAliases(
        [alias],
        'shared startup composition',
      )).toThrow(`shared startup composition includes retired first-party tool aliases: ${alias}->`);
    }
  });
});
