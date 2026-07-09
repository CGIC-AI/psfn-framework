import { describe, expect, it } from 'vitest';
import {
  CANONICAL_FIRST_PARTY_TOOL_SURFACES,
  MODEL_FACING_DRIFT_GUARD_RETIRED_TOOL_ALIASES,
  assertNoModelFacingDriftGuardToolAliases,
  assertNoRetiredFirstPartyToolAliases,
  getCanonicalToolSurface,
  getRetiredToolAlias,
  isCanonicalFirstPartyToolName,
  listRetiredToolAliases,
  resolveToolPresentationRank,
} from './registry.js';
import { createJournalTool } from '../../../boundary/integrations/journal/tools.js';
import { isRecord } from '../../../shared/utils/types.js';

const FORBIDDEN_LEGACY_ACTION_NAMES = [
  'session_new',
  'session_resume',
  'session_list',
  'session_search',
  'session_grep',
  'focus_start',
  'focus_complete',
  'spawn_subagent',
  'image_create',
  'image_edit',
  'image_analyze',
  'scratchpad_write',
  'memory_import_batch',
  'memory_patch',
  'memory_redact',
  'memory_delete',
  'undo_memory_delete',
  'contact_note',
  'contact_set_trust',
  'contact_link_identity',
  'contact_set_channel_privacy',
] as const;

function extractLiteralStrings(schema: unknown): string[] {
  if (!isRecord(schema)) return [];
  if (typeof schema.const === 'string') return [schema.const];
  const unionItems = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf)
      ? schema.oneOf
      : [];
  return unionItems.flatMap(extractLiteralStrings);
}

function extractActionLiterals(toolParameters: unknown): string[] {
  if (!isRecord(toolParameters)) return [];
  const properties = isRecord(toolParameters.properties) ? toolParameters.properties : {};
  return extractLiteralStrings(properties.action).sort();
}

describe('first-party tool surface registry', () => {
  it('keeps canonical tool names unique and self-describing', () => {
    const names = CANONICAL_FIRST_PARTY_TOOL_SURFACES.map(entry => entry.name);
    expect(new Set(names).size).toBe(names.length);

    for (const entry of CANONICAL_FIRST_PARTY_TOOL_SURFACES) {
      expect(entry.name).toMatch(/^[a-z][a-z0-9_]*$/u);
      expect(entry.description.trim().length).toBeGreaterThan(12);
      expect(entry.domain).toBeTruthy();
      expect(entry.exposure).toMatch(/^(core|extended)$/u);
      expect(entry.capabilityMetadata.source).toMatch(/^src\/|^docs\//u);
      if (entry.actions) {
        expect(entry.actions.length).toBeGreaterThan(0);
      }
    }
  });

  it('maps every retired alias to a canonical surface without name collisions', () => {
    const retiredAliases = listRetiredToolAliases();
    const retiredNames = retiredAliases.map(entry => entry.alias);
    expect(new Set(retiredNames).size).toBe(retiredNames.length);

    for (const retired of retiredAliases) {
      expect(isCanonicalFirstPartyToolName(retired.alias)).toBe(false);
      expect(getCanonicalToolSurface(retired.canonicalName)).toBeDefined();
      expect(retired.reason.trim().length).toBeGreaterThan(12);
      if (retired.exposure === 'retired') {
        expect(retired.replacementAction).toBeDefined();
      }
    }
  });

  it('has no open charter exceptions for retired model-facing aliases', () => {
    expect(listRetiredToolAliases().filter(alias => alias.charterException)).toEqual([]);
  });

  it('keeps the high-risk split tool names retired and non-canonical', () => {
    for (const name of MODEL_FACING_DRIFT_GUARD_RETIRED_TOOL_ALIASES) {
      expect(isCanonicalFirstPartyToolName(name)).toBe(false);
      expect(getRetiredToolAlias(name), name).toBeDefined();
    }
    expect(() => assertNoModelFacingDriftGuardToolAliases(
      MODEL_FACING_DRIFT_GUARD_RETIRED_TOOL_ALIASES,
      'high-risk split tool set',
    )).toThrow();
  });

  it('keeps canonical action metadata free of legacy callable names', () => {
    for (const entry of CANONICAL_FIRST_PARTY_TOOL_SURFACES) {
      expect(entry.actions ?? []).not.toEqual(
        expect.arrayContaining([...FORBIDDEN_LEGACY_ACTION_NAMES]),
      );
    }
  });

  it('declares memory visibility actions on the canonical memory surface', () => {
    expect(getCanonicalToolSurface('memory')?.actions).toEqual(
      expect.arrayContaining(['census', 'exists']),
    );
  });

  it('declares virtual navigation on the canonical world surface', () => {
    expect(getCanonicalToolSurface('world')?.actions).toEqual(
      expect.arrayContaining(['perceive', 'list', 'control', 'move']),
    );
  });

  it('keeps journal canonical actions aligned with the actual tool schema', () => {
    const journalTool = createJournalTool({
      list: async () => ({ root: '/tmp/journal', notes: [] }),
      read: async () => ({ path: 'note.md', content: '' }),
      write: async (path: string) => ({ path, mode: 'write', created: true }),
      append: async (path: string) => ({ path, mode: 'append', created: false }),
      search: async (query: string) => ({ query, results: [] }),
    });

    expect(getCanonicalToolSurface('journal')?.actions?.slice().sort()).toEqual(
      extractActionLiterals(journalTool.parameters),
    );
  });

  it('throws when a model-facing list contains retired aliases without an explicit exception', () => {
    expect(() => assertNoRetiredFirstPartyToolAliases([
      'tool_search',
      'session_new',
      'media',
      'spawn_subagent',
    ], 'test surface')).toThrow(
      'test surface includes retired first-party tool aliases: session_new->session, media->generate_image, spawn_subagent->subagent',
    );
  });

  it('keeps the high-risk retired aliases attached to their canonical owners', () => {
    expect(getRetiredToolAlias('session_new')).toMatchObject({
      canonicalName: 'session',
      replacementAction: 'new',
      exposure: 'retired',
    });
    expect(getRetiredToolAlias('values_add')).toMatchObject({
      canonicalName: 'orient',
      replacementAction: 'values_add',
      exposure: 'retired',
    });
    expect(getRetiredToolAlias('image_analyze')).toMatchObject({
      canonicalName: 'generate_image',
      replacementAction: 'analyze',
      exposure: 'retired',
    });
    expect(getRetiredToolAlias('image_edit')).toMatchObject({
      canonicalName: 'generate_image',
      replacementAction: 'edit',
      exposure: 'retired',
    });
    expect(getRetiredToolAlias('image_create')).toMatchObject({
      canonicalName: 'generate_image',
      replacementAction: 'generate',
      exposure: 'retired',
    });
    expect(getRetiredToolAlias('media')).toMatchObject({
      canonicalName: 'generate_image',
      replacementAction: 'generate',
      exposure: 'retired',
    });
    expect(isCanonicalFirstPartyToolName('media')).toBe(false);
    expect(isCanonicalFirstPartyToolName('generate_image')).toBe(true);
    expect(isCanonicalFirstPartyToolName('selfie_create')).toBe(true);
    expect(getRetiredToolAlias('selfie_create')).toBeUndefined();
  });

  it('keeps the audited img2 default stack: social/self/expressive core, dev/admin/heavy extended', () => {
    // Core = tools the companion reaches for in ordinary social/self/expressive
    // interaction, plus the discovery/control surfaces that reach everything else.
    const expectedCore = [
      'tool_search', 'toolset', 'response_control',
      'selfie_create', 'generate_image',
      'memory', 'scratchpad', 'journal',
      'orient', 'contact', 'session', 'self_status', 'system', 'identity',
      'fs', 'web',
      'skill', 'wiki', 'schedule', 'subagent', 'analysis_workbench',
    ];
    for (const name of expectedCore) {
      expect(getCanonicalToolSurface(name)?.exposure, `${name} should be core`).toBe('core');
    }
    // Extended = dev / admin / infrequent / heavy, reached via toolset + promotion.
    const expectedExtended = ['repo', 'shell', 'north_star', 'beads', 'notify', 'shard', 'vault'];
    for (const name of expectedExtended) {
      expect(getCanonicalToolSurface(name)?.exposure, `${name} should be extended`).toBe('extended');
    }
  });

  it('ranks unknown/plugin tools behind every audited first-party domain', () => {
    // psfn img2 audit decision: unaudited third-party/plugin verbs sort to the
    // very tail, after boundary and system, so audited tools present first.
    const tailCanonicalRanks = ['system', 'shell', 'repo', 'web', 'fs'].map(resolveToolPresentationRank);
    const unknownRank = resolveToolPresentationRank('some_plugin_tool_xyz');
    for (const rank of tailCanonicalRanks) {
      expect(unknownRank).toBeGreaterThan(rank);
    }
  });

  it('registers the image tools as core surfaces ranked before admin/dev domains', () => {
    expect(getCanonicalToolSurface('generate_image')?.exposure).toBe('core');
    expect(getCanonicalToolSurface('selfie_create')?.exposure).toBe('core');
    // Social/expressive tools present before admin/boundary/system machinery;
    // selfie_create (self_expression) leads generate_image (media).
    expect(resolveToolPresentationRank('selfie_create'))
      .toBeLessThan(resolveToolPresentationRank('generate_image'));
    for (const adminToolName of ['fs', 'repo', 'shell', 'web', 'system', 'self_status', 'toolset', 'tool_search']) {
      expect(resolveToolPresentationRank('generate_image'))
        .toBeLessThan(resolveToolPresentationRank(adminToolName));
      expect(resolveToolPresentationRank('selfie_create'))
        .toBeLessThan(resolveToolPresentationRank(adminToolName));
    }
  });
});
