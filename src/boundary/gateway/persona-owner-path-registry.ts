import { statSync } from 'node:fs';
import { isAbsolute, normalize, relative, resolve } from 'node:path';
import {
  resolveCharacterCardHistoryPath,
  resolvePromptHistoryPath,
  resolvePromptLastKnownGoodPath,
  resolvePromptLayersPath,
  resolvePromptRegistryHistoryPath,
  resolvePromptRegistryPath,
} from '../../persistence/layout.js';
import { resolvePromptRuntimeLayoutPath } from '../../core/identity/prompt-runtime.js';
import type { PersonaOwnerPathClass } from '../../shared/contracts/persona-owner-paths.js';
import { resolveCanonicalPath } from './filesystem-paths.js';

export type { PersonaOwnerPathClass } from '../../shared/contracts/persona-owner-paths.js';

interface PersonaOwnerPathDefinition {
  pathClass: Exclude<PersonaOwnerPathClass, 'persona_owner_container'>;
  configuredPath: string;
}

interface ResolvedOwnerPath extends PersonaOwnerPathDefinition {
  canonicalPath: string;
  physicalIdentity?: string;
}

export interface PersonaOwnerPathClassification {
  pathClass: PersonaOwnerPathClass;
}

export interface PersonaOwnerPathRegistry {
  classifyMutationTarget(
    targetPath: string,
    options?: { includeOwnerContainers?: boolean },
  ): PersonaOwnerPathClassification | null;
}

function physicalIdentity(pathValue: string): string | undefined {
  try {
    const stats = statSync(pathValue, { bigint: true });
    return `${stats.dev.toString()}:${stats.ino.toString()}:${stats.birthtimeNs.toString()}`;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw error;
  }
}

function canonicalMutationPath(pathValue: string): string | null {
  return resolveCanonicalPath(resolve(normalize(pathValue)), {
    missingPathBehavior: 'resolveParent',
    errorBehavior: 'deny',
  });
}

function pathContains(container: string, candidate: string): boolean {
  const relativePath = relative(container, candidate);
  return relativePath === ''
    || (relativePath !== '..' && !relativePath.startsWith('../') && !isAbsolute(relativePath));
}

function resolveOwnerPath(definition: PersonaOwnerPathDefinition): ResolvedOwnerPath {
  const canonicalPath = canonicalMutationPath(definition.configuredPath);
  if (!canonicalPath) {
    throw new Error(`Cannot resolve canonical ${definition.pathClass} owner path`);
  }
  const identity = physicalIdentity(definition.configuredPath);
  return {
    ...definition,
    canonicalPath,
    ...(identity ? { physicalIdentity: identity } : {}),
  };
}

export function createPersonaOwnerPathRegistry(input: {
  companionDataDir: string;
  characterCardPath: string;
}): PersonaOwnerPathRegistry {
  const companionDataDir = resolve(input.companionDataDir);
  const definitions: PersonaOwnerPathDefinition[] = [
    { pathClass: 'character_card', configuredPath: resolve(input.characterCardPath) },
    { pathClass: 'character_card_history', configuredPath: resolveCharacterCardHistoryPath(companionDataDir) },
    { pathClass: 'prompt_layers', configuredPath: resolvePromptLayersPath(companionDataDir) },
    { pathClass: 'prompt_history', configuredPath: resolvePromptHistoryPath(companionDataDir) },
    { pathClass: 'prompt_last_known_good', configuredPath: resolvePromptLastKnownGoodPath(companionDataDir) },
    { pathClass: 'prompt_registry', configuredPath: resolvePromptRegistryPath(companionDataDir) },
    { pathClass: 'prompt_registry_history', configuredPath: resolvePromptRegistryHistoryPath(companionDataDir) },
    { pathClass: 'prompt_runtime_layout', configuredPath: resolvePromptRuntimeLayoutPath(companionDataDir) },
  ];

  return {
    classifyMutationTarget(targetPath, options = {}) {
      const canonicalTarget = canonicalMutationPath(targetPath);
      if (!canonicalTarget) return null;
      const targetIdentity = physicalIdentity(targetPath);
      const owners = definitions.map(resolveOwnerPath);

      for (const owner of owners) {
        if (canonicalTarget === owner.canonicalPath
          || (targetIdentity !== undefined && targetIdentity === owner.physicalIdentity)) {
          return { pathClass: owner.pathClass };
        }
      }

      if (options.includeOwnerContainers) {
        const containedOwners = owners.filter(owner => pathContains(canonicalTarget, owner.canonicalPath));
        if (containedOwners.length === 1) {
          return { pathClass: containedOwners[0].pathClass };
        }
        if (containedOwners.length > 1) {
          return { pathClass: 'persona_owner_container' };
        }
      }
      return null;
    },
  };
}
