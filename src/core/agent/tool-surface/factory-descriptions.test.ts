import { describe, expect, it } from 'vitest';
import { isRecord } from '../../../shared/utils/types.js';
import { createProviderFactoryToolCatalog } from './canonical-tool-catalog.test-support.js';
import {
  CANONICAL_TOOL_SURFACE_CONTRACTS,
  CANONICAL_TOOL_SURFACE_DESCRIPTIONS,
} from './descriptions.js';
import { CANONICAL_FIRST_PARTY_TOOL_SURFACES } from './registry.js';

const LEGACY_ACTION_ALIASES_BY_TOOL: Readonly<Record<string, ReadonlySet<string>>> = {
  beads: new Set([
    'issue_ready',
    'issue_show',
    'issue_create',
    'issue_update',
    'issue_close',
    'issue_sync',
  ]),
  repo: new Set(['status', 'diff', 'create_branch', 'open_pr']),
  skill: new Set(['skill_list', 'skill_view', 'skill_stats', 'skill_create', 'skill_update']),
  system: new Set(['settings_get', 'self_restart', 'self_rebuild']),
  vault: new Set(['vault_read', 'vault_write', 'vault_search', 'vault_daily']),
};

function extractLiteralStrings(schema: unknown): string[] {
  if (!isRecord(schema)) return [];

  const literals = [
    ...(typeof schema.const === 'string' ? [schema.const] : []),
    ...(Array.isArray(schema.enum)
      ? schema.enum.filter((value): value is string => typeof value === 'string')
      : []),
  ];
  const variants = [
    ...(Array.isArray(schema.anyOf) ? schema.anyOf : []),
    ...(Array.isArray(schema.oneOf) ? schema.oneOf : []),
  ];
  return [...literals, ...variants.flatMap(extractLiteralStrings)];
}

function extractActionLiterals(schema: unknown): string[] {
  if (!isRecord(schema)) return [];

  const properties = isRecord(schema.properties) ? schema.properties : {};
  const variants = [
    ...(Array.isArray(schema.anyOf) ? schema.anyOf : []),
    ...(Array.isArray(schema.oneOf) ? schema.oneOf : []),
    ...(Array.isArray(schema.allOf) ? schema.allOf : []),
  ];
  return [...new Set([
    ...extractLiteralStrings(properties.action),
    ...variants.flatMap(extractActionLiterals),
  ])].sort();
}

function extractSchemaPropertyNames(schema: unknown): Set<string> {
  if (!isRecord(schema)) return new Set();
  const properties = isRecord(schema.properties) ? Object.keys(schema.properties) : [];
  const variants = [
    ...(Array.isArray(schema.anyOf) ? schema.anyOf : []),
    ...(Array.isArray(schema.oneOf) ? schema.oneOf : []),
    ...(Array.isArray(schema.allOf) ? schema.allOf : []),
  ];
  return new Set([
    ...properties,
    ...variants.flatMap(variant => [...extractSchemaPropertyNames(variant)]),
  ]);
}

function actionContractPattern(action: string): RegExp {
  const escaped = action.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`\\baction\\s*=\\s*["']?${escaped}\\b`, 'u');
}

function countCompleteSentences(description: string): number {
  return description.match(/[.!?](?=\s|$)/gu)?.length ?? 0;
}

describe('canonical first-party tool factories', () => {
  it('enumerates every canonical registry surface exactly once', () => {
    const factoryNames = createProviderFactoryToolCatalog().map(tool => tool.name).sort();
    const registryNames = CANONICAL_FIRST_PARTY_TOOL_SURFACES.map(entry => entry.name).sort();

    expect(factoryNames).toEqual(registryNames);
  });

  it('derives every concrete factory description from the canonical table', () => {
    for (const tool of createProviderFactoryToolCatalog()) {
      expect(tool.description, tool.name).toBe(
        CANONICAL_TOOL_SURFACE_DESCRIPTIONS[
          tool.name as keyof typeof CANONICAL_TOOL_SURFACE_DESCRIPTIONS
        ],
      );
    }
  });

  it('gives every provider-visible factory a decision-ready schema description', () => {
    for (const tool of createProviderFactoryToolCatalog()) {
      const context = `${tool.name} description`;
      expect(countCompleteSentences(tool.description), context).toBeGreaterThanOrEqual(3);
      expect(tool.description, context).toMatch(/\bUse\b/u);
      expect(tool.description, context).toContain('Example:');
      expect(tool.description, context).toMatch(
        /\b(?:returns?|reads?|writes?|changes?|reports?|does not|never|only)\b/iu,
      );
      expect(tool.description, `${context} missing adjacent-tool or when-not-use guidance`).toMatch(
        /\b(?:do not|never|instead|prefer|does not replace)\b|\buse\s+[^.]{0,80}\b(?:for|first)\b/iu,
      );

      const contract = CANONICAL_TOOL_SURFACE_CONTRACTS[
        tool.name as keyof typeof CANONICAL_TOOL_SURFACE_CONTRACTS
      ];
      expect(contract, `${tool.name} structured contract`).toBeDefined();
      if (contract.actions.length <= 1) continue;
      expect(tool.description, `${context} required-input boundary`).toMatch(/\brequire(?:d|s)?\b/iu);
      expect(tool.description, `${context} optional-input boundary`).toMatch(/\boptional\b/iu);
    }
  });

  it('documents every preferred action exposed by a concrete factory schema', () => {
    for (const tool of createProviderFactoryToolCatalog()) {
      const legacyAliases = LEGACY_ACTION_ALIASES_BY_TOOL[tool.name] ?? new Set<string>();
      const preferredActions = extractActionLiterals(tool.parameters)
        .filter(action => !legacyAliases.has(action));

      for (const action of preferredActions) {
        expect(tool.description, `${tool.name} description missing action=${action}`)
          .toMatch(actionContractPattern(action));
      }
    }
  });

  it('keeps structured action contracts aligned with concrete factory schemas', () => {
    for (const tool of createProviderFactoryToolCatalog()) {
      const contract = CANONICAL_TOOL_SURFACE_CONTRACTS[
        tool.name as keyof typeof CANONICAL_TOOL_SURFACE_CONTRACTS
      ];
      expect(contract, `${tool.name} structured contract`).toBeDefined();
      const propertyNames = extractSchemaPropertyNames(tool.parameters);
      const legacyAliases = LEGACY_ACTION_ALIASES_BY_TOOL[tool.name] ?? new Set<string>();
      const schemaActions = extractActionLiterals(tool.parameters)
        .filter(action => !legacyAliases.has(action));
      const contractActions = [...new Set(
        contract.actions.filter(action => action.actionField !== false).map(action => action.action),
      )].sort();

      expect(contractActions, `${tool.name} structured action inventory`).toEqual(schemaActions);
      for (const action of contract.actions) {
        for (const field of [
          ...action.required,
          ...action.optional,
          ...(action.requiredAnyOf ?? []).flat(),
          ...(action.requiredOneOf ?? []),
        ]) {
          expect(propertyNames.has(field), `${tool.name}/${action.id} unknown field ${field}`).toBe(true);
        }
      }
    }
  });

  it('renders the subagent tool description in the automata register (rqn1.6)', () => {
    const description = CANONICAL_TOOL_SURFACE_DESCRIPTIONS.subagent;
    // Charter 6.28/8.12: the companion-facing prose names bounded automata, not fleet "workers".
    expect(description).toMatch(/\bautomat(?:a|on)\b/iu);
    expect(description, 'fleet term "worker" leaked into companion-read description')
      .not.toMatch(/\bworkers?\b/iu);
    // "subagent" survives only as the wire schema field name subagent_id, never as self-description prose.
    const selfDescription = description.replace(/subagent_id/g, '');
    expect(selfDescription, 'fleet self-description "subagent" leaked into companion-read description')
      .not.toMatch(/subagent/iu);
  });

  it('keeps every companion-rendered description out of fleet register (rqn1.8)', () => {
    // Charter 6.28/8.12: internal machinery is presented to her as integrated
    // parts of a breathing machine-intelligence, never fleet-managed "workers"
    // or self-described "subagents". The rqn1.6 pin above covers only the
    // subagent entry, which is how the analysis_workbench "bounded worker" leak
    // survived; this sweeps EVERY entry so any future drift fails here.
    //
    // Wire-required schema field names are the sole exemption: "subagent_id" is
    // a callable parameter, not self-description prose, so it is stripped before
    // the fleet-term assertions. This exemption must never widen to cover prose.
    const WIRE_FIELD_NAMES = /subagent_id/g;
    for (const [name, description] of Object.entries(CANONICAL_TOOL_SURFACE_DESCRIPTIONS)) {
      const prose = description.replace(WIRE_FIELD_NAMES, '');
      expect(prose, `fleet term "worker" leaked into companion-read description: ${name}`)
        .not.toMatch(/\bworkers?\b/iu);
      expect(prose, `fleet self-description "subagent" leaked into companion-read description: ${name}`)
        .not.toMatch(/subagent/iu);
    }
  });
});
