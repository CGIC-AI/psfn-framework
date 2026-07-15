import { describe, expect, it } from 'vitest';
import type { AgentTool } from '../../../boundary/pi-agent/index.js';
import { createBeadsTool } from '../../../boundary/integrations/beads/tools.js';
import { createFsTool } from '../../../boundary/integrations/filesystem/tools.js';
import { createRepoTool } from '../../../boundary/integrations/git/tools.js';
import { createJournalTool } from '../../../boundary/integrations/journal/tools.js';
import { createShellTool } from '../../../boundary/integrations/shell/tools.js';
import { createVaultTool } from '../../../boundary/integrations/vault/tools.js';
import { createWebTool } from '../../../boundary/integrations/web/tools.js';
import { createWorldTool } from '../../../boundary/integrations/world/tools.js';
import { createContactTool } from '../../contacts/tools.js';
import { createIdentityTool } from '../../identity/prompt-tools.js';
import { createScheduleTool } from '../../scheduler/schedule-tool.js';
import { createAnalysisWorkbenchTool } from '../../tools/analysis-workbench/tools.js';
import { createSystemTool } from '../../tools/lifecycle.js';
import { createNotifyTool } from '../../tools/ntfy.js';
import { createSelfStatusTool } from '../../tools/self-status.js';
import { createSessionTool } from '../../tools/session.js';
import { createOrientTool } from '../../../faculties/core-memory/tools.js';
import { createMemoryTool } from '../../../faculties/memory/tools.js';
import { createScratchpadTool } from '../../../faculties/memory/tools/scratchpad.js';
import { createNorthStarTool } from '../../../faculties/north-star/tools.js';
import { createSkillTool } from '../../../faculties/skills/tools.js';
import { createSubagentTool } from '../../../faculties/subagents/tools.js';
import { createWikiTool } from '../../../faculties/wiki/tools.js';
import { createGenerateImageTool, createSelfieTool } from '../../../primitives/images/tools.js';
import { isRecord } from '../../../shared/utils/types.js';
import { createResponseControlTool } from '../no-reply-tool.js';
import { createToolSearchTool, createToolsetTool } from '../substrate-agent/adaptive-tools-runtime.js';
import { CANONICAL_TOOL_SURFACE_DESCRIPTIONS } from './descriptions.js';
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

function createCanonicalFactoryTools(): AgentTool<any>[] {
  const inert = {} as never;

  return [
    createToolSearchTool(inert),
    createToolsetTool(inert),
    createResponseControlTool(() => null),
    createFsTool(inert),
    createRepoTool(inert),
    createShellTool(inert),
    createWebTool(inert),
    createWorldTool(inert, inert),
    createAnalysisWorkbenchTool(inert),
    createOrientTool(inert),
    createIdentityTool(inert),
    createMemoryTool(inert, inert),
    createScratchpadTool(inert),
    createContactTool(inert),
    createSessionTool(inert),
    createSelfStatusTool(inert),
    createSystemTool(inert),
    createSkillTool(inert),
    createWikiTool(inert),
    createScheduleTool(inert),
    createNorthStarTool(inert),
    createBeadsTool(inert),
    createNotifyTool(inert),
    createGenerateImageTool(inert),
    createSelfieTool(inert),
    createSubagentTool(inert),
    createVaultTool(inert),
    createJournalTool(inert),
  ];
}

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

function actionContractPattern(action: string): RegExp {
  const escaped = action.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`\\baction\\s*=\\s*["']?${escaped}\\b`, 'u');
}

describe('canonical first-party tool factories', () => {
  it('enumerates every canonical registry surface exactly once', () => {
    const factoryNames = createCanonicalFactoryTools().map(tool => tool.name).sort();
    const registryNames = CANONICAL_FIRST_PARTY_TOOL_SURFACES.map(entry => entry.name).sort();

    expect(factoryNames).toEqual(registryNames);
  });

  it('derives every concrete factory description from the canonical table', () => {
    for (const tool of createCanonicalFactoryTools()) {
      expect(tool.description, tool.name).toBe(
        CANONICAL_TOOL_SURFACE_DESCRIPTIONS[
          tool.name as keyof typeof CANONICAL_TOOL_SURFACE_DESCRIPTIONS
        ],
      );
    }
  });

  it('documents every preferred action exposed by a concrete factory schema', () => {
    for (const tool of createCanonicalFactoryTools()) {
      const legacyAliases = LEGACY_ACTION_ALIASES_BY_TOOL[tool.name] ?? new Set<string>();
      const preferredActions = extractActionLiterals(tool.parameters)
        .filter(action => !legacyAliases.has(action));

      for (const action of preferredActions) {
        expect(tool.description, `${tool.name} description missing action=${action}`)
          .toMatch(actionContractPattern(action));
      }
    }
  });
});
