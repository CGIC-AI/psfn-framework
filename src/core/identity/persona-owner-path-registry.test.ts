import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createPersonaOwnerPathRegistry,
  type PersonaOwnerPathClass,
} from '../../boundary/gateway/persona-owner-path-registry.js';
import {
  resolveCharacterCardHistoryPath,
  resolvePromptHistoryPath,
  resolvePromptLastKnownGoodPath,
  resolvePromptLayersPath,
  resolvePromptRegistryHistoryPath,
  resolvePromptRegistryPath,
} from '../../persistence/layout.js';
import { resolvePromptRuntimeLayoutPath } from './prompt-runtime.js';

const roots: string[] = [];

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'persona-owner-registry-'));
  roots.push(root);
  const companionDataDir = join(root, 'companion-data', 'companion-a');
  const characterCardPath = join(companionDataDir, 'identity', 'character-card.json');
  const workspacePath = join(root, 'workspaces', 'personal', 'companion-a');
  mkdirSync(dirname(characterCardPath), { recursive: true });
  mkdirSync(workspacePath, { recursive: true });
  writeFileSync(characterCardPath, '{"spec":"chara_card_v2"}\n');

  const knownPaths: Array<[PersonaOwnerPathClass, string]> = [
    ['character_card', characterCardPath],
    ['character_card_history', resolveCharacterCardHistoryPath(companionDataDir)],
    ['prompt_layers', resolvePromptLayersPath(companionDataDir)],
    ['prompt_history', resolvePromptHistoryPath(companionDataDir)],
    ['prompt_last_known_good', resolvePromptLastKnownGoodPath(companionDataDir)],
    ['prompt_registry', resolvePromptRegistryPath(companionDataDir)],
    ['prompt_registry_history', resolvePromptRegistryHistoryPath(companionDataDir)],
    ['prompt_runtime_layout', resolvePromptRuntimeLayoutPath(companionDataDir)],
  ];
  for (const [, path] of knownPaths) {
    mkdirSync(dirname(path), { recursive: true });
    if (path !== characterCardPath) writeFileSync(path, '{}\n');
  }
  return {
    root,
    companionDataDir,
    characterCardPath,
    workspacePath,
    knownPaths,
    registry: createPersonaOwnerPathRegistry({ companionDataDir, characterCardPath }),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('persona owner path registry', () => {
  it('classifies every canonical persona and prompt owner file without treating sibling state as persona', () => {
    const fixture = createFixture();
    for (const [pathClass, path] of fixture.knownPaths) {
      expect(fixture.registry.classifyMutationTarget(path)).toEqual({ pathClass });
    }
    const unrelatedState = join(fixture.companionDataDir, 'state', 'session.db');
    writeFileSync(unrelatedState, 'not persona state');
    expect(fixture.registry.classifyMutationTarget(unrelatedState)).toBeNull();
  });

  it('canonicalizes traversal and directory-symlink aliases before classification', () => {
    const fixture = createFixture();
    const identityAlias = join(fixture.workspacePath, 'identity-alias');
    symlinkSync(dirname(fixture.characterCardPath), identityAlias, 'dir');

    expect(fixture.registry.classifyMutationTarget(
      join(fixture.workspacePath, '..', '..', '..', 'companion-data', 'companion-a', 'identity', '.', 'character-card.json'),
    )).toEqual({ pathClass: 'character_card' });
    expect(fixture.registry.classifyMutationTarget(
      join(identityAlias, 'character-card.json'),
    )).toEqual({ pathClass: 'character_card' });
  });

  it('detects a hardlink alias by physical identity even when its canonical spelling is in the workspace', () => {
    const fixture = createFixture();
    const hardlinkAlias = join(fixture.workspacePath, 'apparently-ordinary.json');
    linkSync(fixture.characterCardPath, hardlinkAlias);

    expect(fixture.registry.classifyMutationTarget(hardlinkAlias))
      .toEqual({ pathClass: 'character_card' });
  });

  it('classifies destructive container operations but not ordinary writes to an owner-file parent directory', () => {
    const fixture = createFixture();
    const stateDir = dirname(resolvePromptLayersPath(fixture.companionDataDir));
    expect(fixture.registry.classifyMutationTarget(stateDir)).toBeNull();
    expect(fixture.registry.classifyMutationTarget(stateDir, { includeOwnerContainers: true }))
      .toEqual({ pathClass: 'persona_owner_container' });
  });
});
