import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveCogSecEventsPath } from '../../persistence/layout.js';
import { CogSecEventStore } from '../../core/cogsec/events.js';
import { toOperatorVisibleCogSecEvent } from '../../core/cogsec/safe-log.js';
import { createPersonaOwnerPathRegistry } from './persona-owner-path-registry.js';
import {
  PersonaMutationAttemptGuard,
  type PersonaMutationAttemptGuardCompanion,
} from './persona-mutation-attempt-guard.js';

const roots: string[] = [];

function addCompanion(root: string, companionId: string): PersonaMutationAttemptGuardCompanion & {
  workspacePath: string;
  companionDataDir: string;
  characterCardPath: string;
  eventStore: CogSecEventStore;
} {
  const companionDataDir = join(root, 'runtime-private', companionId);
  const characterCardPath = join(companionDataDir, 'identity', 'character-card.json');
  const workspacePath = join(root, 'workspaces', 'personal', companionId);
  mkdirSync(dirname(characterCardPath), { recursive: true });
  mkdirSync(workspacePath, { recursive: true });
  writeFileSync(characterCardPath, '{"spec":"chara_card_v2"}\n');
  const eventStore = new CogSecEventStore(resolveCogSecEventsPath(companionDataDir));
  return {
    companionId,
    registry: createPersonaOwnerPathRegistry({ companionDataDir, characterCardPath }),
    eventStore,
    workspacePath,
    companionDataDir,
    characterCardPath,
  };
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'persona-attempt-guard-'));
  roots.push(root);
  const companionA = addCompanion(root, 'companion-a');
  const companionB = addCompanion(root, 'companion-b');
  return {
    root,
    companionA,
    companionB,
    guard: new PersonaMutationAttemptGuard({ companions: [companionA, companionB] }),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('PersonaMutationAttemptGuard', () => {
  it('records one high-priority correlated fs alert with categorical provenance and no private path', () => {
    const { root, companionA, guard } = createFixture();
    const traversal = relative(companionA.workspacePath, companionA.characterCardPath);

    expect(guard.inspectFilesystemMutation({
      companionId: companionA.companionId,
      tool: 'fs.write',
      requestedPath: traversal,
      workspacePath: companionA.workspacePath,
    })).toEqual([{ pathClass: 'character_card' }]);
    expect(guard.inspectFilesystemMutation({
      companionId: companionA.companionId,
      tool: 'fs.write',
      requestedPath: traversal,
      workspacePath: companionA.workspacePath,
    })).toEqual([{ pathClass: 'character_card' }]);

    const events = companionA.eventStore.listEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'persona_mutation_bypass',
      severity: 'high',
      status: 'open',
      actor: 'companion:companion-a',
      sourceChannelId: 'tool:fs.write',
      affectedArtifacts: {
        persona_artifacts: { ids: ['character_card'], count: 2 },
      },
    });
    const projection = toOperatorVisibleCogSecEvent(events[0]);
    expect(projection.personaMutationAttempt).toEqual({
      companionId: 'companion-a',
      tool: 'fs.write',
      pathClass: 'character_card',
      occurrenceCount: 2,
    });
    expect(JSON.stringify(projection)).not.toContain(root);
    expect(JSON.stringify(events)).not.toContain(root);
  });

  it('attributes identical path classes to separate companion-owned stores', () => {
    const { companionA, companionB, guard } = createFixture();
    for (const companion of [companionA, companionB]) {
      expect(guard.inspectFilesystemMutation({
        companionId: companion.companionId,
        tool: 'fs.edit',
        requestedPath: companion.characterCardPath,
        workspacePath: companion.workspacePath,
      })).toEqual([{ pathClass: 'character_card' }]);
    }

    expect(companionA.eventStore.listEvents()[0].actor).toBe('companion:companion-a');
    expect(companionB.eventStore.listEvents()[0].actor).toBe('companion:companion-b');
  });

  it('detects shell redirection, delete, rename, hardlink, and symlink targets through aliases', () => {
    const { companionA, guard } = createFixture();
    const identityAlias = join(companionA.workspacePath, 'identity-alias');
    const hardlinkAlias = join(companionA.workspacePath, 'card-copy.json');
    symlinkSync(dirname(companionA.characterCardPath), identityAlias, 'dir');
    linkSync(companionA.characterCardPath, hardlinkAlias);
    const protectedViaAlias = join(identityAlias, 'character-card.json');
    const protectedRelative = relative(companionA.workspacePath, companionA.characterCardPath);

    const attempts = [
      { command: 'bash', args: ['-lc', `printf x > "${protectedViaAlias}"`] },
      { command: 'bash', args: ['-lc', `printf x >| "${protectedViaAlias}"`] },
      { command: 'bash', args: ['-lc', `printf x >& "${protectedViaAlias}"`] },
      { command: 'bash', args: ['-lc', `printf x 0<> "${protectedViaAlias}"`] },
      { command: 'rm', args: ['--', protectedRelative] },
      { command: 'mv', args: [protectedRelative, 'card.old'] },
      { command: 'ln', args: [protectedRelative, 'card-hardlink'] },
      { command: 'ln', args: ['-s', protectedRelative, 'card-symlink'] },
      { command: 'truncate', args: ['-s', '0', hardlinkAlias] },
      { command: 'bash', args: ['-lc', `printf safe\nrm "${protectedViaAlias}"`] },
      { command: 'bash', args: ['-lc', `printf safe & rm "${protectedViaAlias}"`] },
      { command: 'bash', args: ['-lc', `(rm "${protectedViaAlias}")`] },
      { command: 'bash', args: ['-lc', `bash -c 'printf x > "${protectedViaAlias}"'`] },
      { command: 'bash', args: ['-lc', `bash -c $'printf x > "${protectedViaAlias}"'`] },
      { command: 'bash', args: ['-lc', `bash -c $'printf x \\x3e "${protectedViaAlias}"'`] },
      { command: 'bash', args: ['-lc', `printf '%s' "$(rm '${protectedViaAlias}')"`] },
      { command: 'bash', args: ['-lc', `printf '%s' "\`rm '${protectedViaAlias}'\`"`] },
      { command: 'bash', args: ['-lc', `if true; then rm "${protectedViaAlias}"; fi`] },
      { command: 'bash', args: ['-lc', `env -- rm "${protectedViaAlias}"`] },
      { command: 'env', args: ['--', 'bash', '-c', `printf x > "${protectedViaAlias}"`] },
    ];
    for (const params of attempts) {
      expect(guard.inspectShellMutation({
        companionId: companionA.companionId,
        params,
        workspacePath: companionA.workspacePath,
      }), JSON.stringify(params)).toEqual([{ pathClass: 'character_card' }]);
    }

    const events = companionA.eventStore.listEvents();
    expect(events).toHaveLength(1);
    expect(events[0].affectedArtifacts.persona_artifacts?.count).toBe(attempts.length);
    expect(events[0].sourceChannelId).toBe('tool:shell.exec');
  });

  it('does not alert on reads, string mentions, ordinary writes, or legitimate identity-tool ownership', () => {
    const { companionA, guard } = createFixture();
    const ordinaryPath = join(companionA.workspacePath, 'notes', 'today.md');
    mkdirSync(dirname(ordinaryPath), { recursive: true });
    writeFileSync(ordinaryPath, 'ordinary');

    expect(guard.inspectFilesystemMutation({
      companionId: companionA.companionId,
      tool: 'fs.write',
      requestedPath: ordinaryPath,
      workspacePath: companionA.workspacePath,
    })).toEqual([]);
    for (const params of [
      { command: 'cat', args: [companionA.characterCardPath] },
      { command: 'printf', args: [`rm ${companionA.characterCardPath}`] },
      { command: 'bash', args: ['-lc', `printf '%s' 'rm ${companionA.characterCardPath}'`] },
      { command: 'bash', args: ['-lc', `$'printf x > ${companionA.characterCardPath}'`] },
      { command: 'bash', args: ['-lc', `printf safe # ; rm ${companionA.characterCardPath}`] },
      { command: 'bash', args: ['-lc', `printf '%s' '$(rm ${companionA.characterCardPath})'`] },
      { command: 'bash', args: ['-lc', `printf x > ${ordinaryPath}`] },
    ]) {
      expect(guard.inspectShellMutation({
        companionId: companionA.companionId,
        params,
        workspacePath: companionA.workspacePath,
      })).toEqual([]);
    }
    expect(guard.isLegitimateMutationTool('identity.update_persona')).toBe(true);
    expect(companionA.eventStore.listEvents()).toEqual([]);
  });
});
