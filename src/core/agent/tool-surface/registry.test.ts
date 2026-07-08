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
      'test surface includes retired first-party tool aliases: session_new->session, spawn_subagent->subagent',
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
      canonicalName: 'media',
      replacementAction: 'analyze',
      exposure: 'retired',
    });
    expect(isCanonicalFirstPartyToolName('selfie_create')).toBe(true);
    expect(getRetiredToolAlias('selfie_create')).toBeUndefined();
  });
});
