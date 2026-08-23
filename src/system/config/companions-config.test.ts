import { afterEach, describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  COMPANIONS_FILE_NAME,
  loadCompanionsConfig,
  resolveCompanionFleet,
  resolveCompanionFleetPaths,
  resolveCompanionRuntimeIdentity,
  validateCompanionsConfig,
  type CompanionsFleetConfig,
} from './companions-config.js';

const VALID_FLEET: CompanionsFleetConfig = {
  postgres: {
    sharedMigrationRole: 'shared_schema_migration',
    sharedMigrationDatabaseUrlRef: {
      kind: 'env',
      envName: 'SHARED_SCHEMA_MIGRATION_DATABASE_URL',
    },
  },
  companions: [
    {
      companionId: '11111111-1111-4111-8111-111111111111',
      companionDataDir: 'companions/flagship',
      characterCardPath: 'companions/flagship/character-card.json',
      postgresSchema: 'companion_flagship',
      postgresRole: 'companion_flagship_runtime',
      postgresDatabaseUrlRef: { kind: 'env', envName: 'COMPANION_FLAGSHIP_DATABASE_URL' },
    },
    {
      companionId: '22222222-2222-4222-8222-222222222222',
      companionDataDir: 'companions/aria',
      characterCardPath: 'companions/aria/character-card.json',
      postgresSchema: 'companion_aria',
      postgresRole: 'companion_aria_runtime',
      postgresDatabaseUrlRef: { kind: 'env', envName: 'COMPANION_ARIA_DATABASE_URL' },
    },
  ],
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

function createFleetWithObserverRoots(
  firstRoot: string,
  secondRoot: string,
): CompanionsFleetConfig {
  const fleet = clone(VALID_FLEET);
  fleet.companions[0].observerEvalSidecar = {
    sidecarId: 'observer-one',
    serverUrl: 'http://observer-one.internal:17342',
    sessionLabel: 'observer-session-one',
    agentName: 'observer-agent-one',
    persistenceRootDir: firstRoot,
  };
  fleet.companions[1].observerEvalSidecar = {
    sidecarId: 'observer-two',
    serverUrl: 'http://observer-two.internal:17342',
    sessionLabel: 'observer-session-two',
    agentName: 'observer-agent-two',
    persistenceRootDir: secondRoot,
  };
  return fleet;
}

describe('companions owner-file config', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeDataDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'psfn-companions-'));
    tempDirs.push(dir);
    return dir;
  }

  function writeCompanionsFile(dataDir: string, contents: unknown): void {
    writeFileSync(
      join(dataDir, COMPANIONS_FILE_NAME),
      `${JSON.stringify(contents, null, 2)}\n`,
      'utf-8',
    );
  }

  describe('validateCompanionsConfig', () => {
    it('accepts a valid fleet', () => {
      expect(validateCompanionsConfig(clone(VALID_FLEET), 'companions.json')).toEqual(VALID_FLEET);
    });

    it('rejects an empty fleet', () => {
      expect(() => validateCompanionsConfig({ companions: [] }, 'companions.json'))
        .toThrow(/at least one companion/);
    });

    it('rejects a non-array companions field', () => {
      expect(() => validateCompanionsConfig({ companions: {} }, 'companions.json'))
        .toThrow(/companions must be an array/);
    });

    it('rejects unknown root keys', () => {
      expect(() => validateCompanionsConfig(
        { companions: clone(VALID_FLEET.companions), extra: true },
        'companions.json',
      )).toThrow(/root contains unknown keys: extra/);
    });

    it('rejects unknown entry keys', () => {
      const fleet = clone(VALID_FLEET);
      (fleet.companions[0] as Record<string, unknown>).nickname = 'flag';
      expect(() => validateCompanionsConfig(fleet, 'companions.json'))
        .toThrow(/companions\[0\] contains unknown keys: nickname/);
    });

    it('rejects a non-UUID companionId', () => {
      const fleet = clone(VALID_FLEET);
      fleet.companions[0].companionId = 'not-a-uuid';
      expect(() => validateCompanionsConfig(fleet, 'companions.json'))
        .toThrow(/companionId must be a lowercase RFC-4122 UUID/);
    });

    it('rejects an uppercase companionId', () => {
      const fleet = clone(VALID_FLEET);
      fleet.companions[0].companionId = '11111111-1111-4111-8111-11111111111A';
      expect(() => validateCompanionsConfig(fleet, 'companions.json'))
        .toThrow(/companionId must be a lowercase RFC-4122 UUID/);
    });

    it('rejects a duplicate companionId', () => {
      const fleet = clone(VALID_FLEET);
      fleet.companions[1].companionId = fleet.companions[0].companionId;
      expect(() => validateCompanionsConfig(fleet, 'companions.json'))
        .toThrow(/duplicate companionId/);
    });

    it('rejects a duplicate postgresSchema', () => {
      const fleet = clone(VALID_FLEET);
      fleet.companions[1].postgresSchema = fleet.companions[0].postgresSchema;
      expect(() => validateCompanionsConfig(fleet, 'companions.json'))
        .toThrow(/duplicate postgresSchema/);
    });

    it('rejects reused topology roles and credential references', () => {
      const duplicateRole = clone(VALID_FLEET);
      duplicateRole.companions[1].postgresRole = duplicateRole.companions[0].postgresRole;
      expect(() => validateCompanionsConfig(duplicateRole, 'companions.json'))
        .toThrow(/duplicate postgresRole/);

      const duplicateCredential = clone(VALID_FLEET);
      duplicateCredential.companions[1].postgresDatabaseUrlRef =
        duplicateCredential.companions[0].postgresDatabaseUrlRef;
      expect(() => validateCompanionsConfig(duplicateCredential, 'companions.json'))
        .toThrow(/duplicate postgresDatabaseUrlRef/);

      const sharedRole = clone(VALID_FLEET);
      sharedRole.postgres.sharedMigrationRole = sharedRole.companions[0].postgresRole;
      expect(() => validateCompanionsConfig(sharedRole, 'companions.json'))
        .toThrow(/shared migration role must be distinct/);
    });

    it('rejects reuse of every observer identity field across three companions', () => {
      const createFleet = () => {
        const fleet = clone(VALID_FLEET) as unknown as {
          companions: Array<Record<string, unknown>>;
        };
        fleet.companions.push({
          ...structuredClone(fleet.companions[1]),
          companionId: '33333333-3333-4333-8333-333333333333',
          companionDataDir: 'companions/sol',
          characterCardPath: 'companions/sol/character-card.json',
          postgresSchema: 'companion_sol',
          postgresRole: 'companion_sol_runtime',
          postgresDatabaseUrlRef: { kind: 'env', envName: 'COMPANION_SOL_DATABASE_URL' },
        });
        fleet.companions.forEach((companion, index) => {
          const ordinal = String(index + 1);
          companion.observerEvalSidecar = {
            sidecarId: `observer-${ordinal}`,
            serverUrl: `http://observer-${ordinal}.internal:17342`,
            sessionLabel: `observer-session-${ordinal}`,
            agentName: `observer-agent-${ordinal}`,
            persistenceRootDir: `/var/lib/observer-${ordinal}`,
          };
        });
        return fleet;
      };
      const fields = [
        'sidecarId',
        'serverUrl',
        'sessionLabel',
        'agentName',
        'persistenceRootDir',
      ] as const;

      expect(() => validateCompanionsConfig(createFleet(), 'companions.json')).not.toThrow();
      for (const field of fields) {
        const fleet = createFleet();
        const primaryBinding = fleet.companions[0].observerEvalSidecar as Record<string, unknown>;
        const siblingBinding = fleet.companions[2].observerEvalSidecar as Record<string, unknown>;
        siblingBinding[field] = primaryBinding[field];
        expect(() => validateCompanionsConfig(fleet, 'companions.json'))
          .toThrow(field === 'persistenceRootDir'
            ? /observerEvalSidecar\.persistenceRootDir must not overlap/
            : `duplicate observerEvalSidecar.${field}`);
      }
    });

    it('rejects nested observer persistence roots in either fleet order', () => {
      expect(() => validateCompanionsConfig(
        createFleetWithObserverRoots('/var/lib/observer-one', '/var/lib/observer-one/child'),
        'companions.json',
      )).toThrow(/observerEvalSidecar\.persistenceRootDir.*must not overlap/);
      expect(() => validateCompanionsConfig(
        createFleetWithObserverRoots('/var/lib/observer-one/child', '/var/lib/observer-one'),
        'companions.json',
      )).toThrow(/observerEvalSidecar\.persistenceRootDir.*must not overlap/);
      expect(() => validateCompanionsConfig(
        createFleetWithObserverRoots('/var/lib/observer-one', '/var/lib/observer-one/../observer-two'),
        'companions.json',
      )).not.toThrow();
    });

    it('rejects observer persistence roots that overlap through a symlinked existing ancestor', () => {
      const dataDir = makeDataDir();
      const canonicalParent = join(dataDir, 'observer-storage');
      const aliasParent = join(dataDir, 'observer-storage-alias');
      mkdirSync(canonicalParent);
      symlinkSync(canonicalParent, aliasParent, 'dir');

      const canonicalFutureRoot = join(canonicalParent, 'future-root');
      const aliasedNestedFutureRoot = join(aliasParent, 'future-root', 'nested');

      expect(() => validateCompanionsConfig(
        createFleetWithObserverRoots(canonicalFutureRoot, aliasedNestedFutureRoot),
        'companions.json',
      )).toThrow(/observerEvalSidecar\.persistenceRootDir.*must not overlap/);
      expect(() => validateCompanionsConfig(
        createFleetWithObserverRoots(aliasedNestedFutureRoot, canonicalFutureRoot),
        'companions.json',
      )).toThrow(/observerEvalSidecar\.persistenceRootDir.*must not overlap/);
    });

    it('rejects an uppercase postgresSchema', () => {
      const fleet = clone(VALID_FLEET);
      fleet.companions[0].postgresSchema = 'Companion_Flagship';
      expect(() => validateCompanionsConfig(fleet, 'companions.json'))
        .toThrow(/postgresSchema must be a lowercase identifier/);
    });

    it('rejects a reserved pg_ postgresSchema', () => {
      const fleet = clone(VALID_FLEET);
      fleet.companions[0].postgresSchema = 'pg_flagship';
      expect(() => validateCompanionsConfig(fleet, 'companions.json'))
        .toThrow(/must not start with the reserved "pg_" prefix/);
    });

    it('rejects a duplicate companionDataDir (overlap)', () => {
      const fleet = clone(VALID_FLEET);
      fleet.companions[1].companionDataDir = fleet.companions[0].companionDataDir;
      expect(() => validateCompanionsConfig(fleet, 'companions.json'))
        .toThrow(/must not overlap companionDataDir/);
    });

    it('rejects a nested/overlapping companionDataDir', () => {
      const fleet = clone(VALID_FLEET);
      fleet.companions[1].companionDataDir = 'companions/flagship/nested';
      expect(() => validateCompanionsConfig(fleet, 'companions.json'))
        .toThrow(/must not overlap companionDataDir/);
    });

    it('rejects an absolute companionDataDir', () => {
      const fleet = clone(VALID_FLEET);
      fleet.companions[0].companionDataDir = '/etc/psfn';
      expect(() => validateCompanionsConfig(fleet, 'companions.json'))
        .toThrow(/must be a relative path under the persistence root/);
    });

    it('rejects a traversal companionDataDir', () => {
      const fleet = clone(VALID_FLEET);
      fleet.companions[0].companionDataDir = '../escape';
      expect(() => validateCompanionsConfig(fleet, 'companions.json'))
        .toThrow(/must not escape the persistence root/);
    });

    it('rejects the retired per-companion gardenPort key without a compatibility reader', () => {
      const fleet = clone(VALID_FLEET) as unknown as {
        companions: Array<Record<string, unknown>>;
      };
      fleet.companions[0].gardenPort = 10061;
      expect(() => validateCompanionsConfig(fleet, 'companions.json'))
        .toThrow(
          /companions\[0\]\.gardenPort is retired; configure the one fleet Garden listener with ADMIN_PORT/u,
        );
    });

    it('accepts optional displayName and avatarRef roster fields', () => {
      const fleet = clone(VALID_FLEET);
      fleet.companions[0].displayName = 'Flagship';
      fleet.companions[1].displayName = 'Aria';
      fleet.companions[1].avatarRef = 'avatars/aria.png';
      const validated = validateCompanionsConfig(fleet, 'companions.json');
      expect(validated.companions[0].displayName).toBe('Flagship');
      expect(validated.companions[1].avatarRef).toBe('avatars/aria.png');
      // Absent fields stay absent (no character-card reads, no synthetic default).
      expect(validated.companions[0]).not.toHaveProperty('avatarRef');
    });

    it('trims displayName and avatarRef like the other string fields', () => {
      const fleet = clone(VALID_FLEET);
      fleet.companions[0].displayName = '  Flagship  ' as string;
      fleet.companions[0].avatarRef = '  avatars/a.png  ' as string;
      const validated = validateCompanionsConfig(fleet, 'companions.json');
      expect(validated.companions[0].displayName).toBe('Flagship');
      expect(validated.companions[0].avatarRef).toBe('avatars/a.png');
    });

    it('rejects an empty displayName', () => {
      const fleet = clone(VALID_FLEET) as unknown as { companions: Record<string, unknown>[] };
      fleet.companions[0].displayName = '   ';
      expect(() => validateCompanionsConfig(fleet, 'companions.json'))
        .toThrow(/displayName must be a non-empty string/);
    });

    it('rejects a non-string avatarRef', () => {
      const fleet = clone(VALID_FLEET) as unknown as { companions: Record<string, unknown>[] };
      fleet.companions[0].avatarRef = 42;
      expect(() => validateCompanionsConfig(fleet, 'companions.json'))
        .toThrow(/avatarRef must be a string/);
    });

    it('rejects an over-long displayName', () => {
      const fleet = clone(VALID_FLEET);
      fleet.companions[0].displayName = 'x'.repeat(121);
      expect(() => validateCompanionsConfig(fleet, 'companions.json'))
        .toThrow(/displayName must be at most 120 characters/);
    });

    it('rejects control characters in a displayName', () => {
      const fleet = clone(VALID_FLEET);
      fleet.companions[0].displayName = 'bad\nname';
      expect(() => validateCompanionsConfig(fleet, 'companions.json'))
        .toThrow(/displayName must not contain control characters/);
    });
  });

  describe('loadCompanionsConfig', () => {
    it('loads and validates a fleet file on disk', () => {
      const dataDir = makeDataDir();
      writeCompanionsFile(dataDir, VALID_FLEET);
      expect(loadCompanionsConfig(dataDir)).toEqual(VALID_FLEET);
    });

    it('fails closed on an invalid fleet file', () => {
      const dataDir = makeDataDir();
      writeCompanionsFile(dataDir, { companions: [] });
      expect(() => loadCompanionsConfig(dataDir)).toThrow(/at least one companion/);
    });
  });

  describe('resolveCompanionFleet (manifest always required)', () => {
    it('refuses to start when the manifest is missing', () => {
      const dataDir = makeDataDir();
      expect(() => resolveCompanionFleet({ dataDir }))
        .toThrow(/fleet manifest is required but missing/);
    });

    it('returns the validated fleet when the manifest is valid', () => {
      const dataDir = makeDataDir();
      writeCompanionsFile(dataDir, VALID_FLEET);
      expect(resolveCompanionFleet({ dataDir })).toEqual(VALID_FLEET);
    });

    it('returns a one-entry fleet (single-companion is a fleet of one)', () => {
      const dataDir = makeDataDir();
      const oneEntry: CompanionsFleetConfig = {
        postgres: VALID_FLEET.postgres,
        companions: [VALID_FLEET.companions[0]],
      };
      writeCompanionsFile(dataDir, oneEntry);
      expect(resolveCompanionFleet({ dataDir })).toEqual(oneEntry);
    });

    it('fails closed when the manifest is invalid', () => {
      const dataDir = makeDataDir();
      writeCompanionsFile(dataDir, { companions: [{ companionId: 'bad' }] });
      expect(() => resolveCompanionFleet({ dataDir }))
        .toThrow(/Invalid companions config/);
    });
  });

  describe('resolved fleet paths and runtime identity', () => {
    it('resolves every manifest path beneath the canonical persistence root', () => {
      const root = makeDataDir();
      const resolved = resolveCompanionFleetPaths(VALID_FLEET, root);
      const canonicalRoot = realpathSync(root);

      expect(resolved.persistenceRoot).toBe(canonicalRoot);
      expect(resolved.workspacesRoot).toBe(join(canonicalRoot, 'workspaces'));
      expect(resolved.sharedWorkspacePath).toBe(join(canonicalRoot, 'workspaces/shared'));
      expect(resolved.companions[0]).toMatchObject({
        companionDataDir: join(canonicalRoot, 'companions/flagship'),
        characterCardPath: join(canonicalRoot, 'companions/flagship/character-card.json'),
        personalWorkspacePath: join(
          canonicalRoot,
          'workspaces/personal/11111111-1111-4111-8111-111111111111',
        ),
      });
      expect(resolved.companions[1].personalWorkspacePath)
        .not.toBe(resolved.companions[0].personalWorkspacePath);
    });

    it('rejects paths that traverse an existing symlink outside the persistence root', () => {
      const root = makeDataDir();
      const outside = makeDataDir();
      mkdirSync(join(root, 'companions'), { recursive: true });
      symlinkSync(outside, join(root, 'companions/flagship'));

      expect(() => resolveCompanionFleetPaths(VALID_FLEET, root))
        .toThrow(/resolves through a symlink outside persistence root/);
    });

    it('rejects distinct fleet paths that resolve to the same physical data root', () => {
      const root = makeDataDir();
      const actual = join(root, 'companions/actual');
      mkdirSync(actual, { recursive: true });
      symlinkSync(actual, join(root, 'companions/alias'));
      const fleet = clone(VALID_FLEET);
      fleet.companions[0].companionDataDir = 'companions/actual';
      fleet.companions[0].characterCardPath = 'companions/actual/character-card.json';
      fleet.companions[1].companionDataDir = 'companions/alias';
      fleet.companions[1].characterCardPath = 'companions/alias/character-card.json';

      expect(() => resolveCompanionFleetPaths(fleet, root))
        .toThrow(/must not overlap companionDataDir/);
    });

    it('rejects a workspace root that escapes the runtime root through a symlink', () => {
      const root = makeDataDir();
      const outside = makeDataDir();
      symlinkSync(outside, join(root, 'workspaces'));

      expect(() => resolveCompanionFleetPaths(VALID_FLEET, root))
        .toThrow(/workspaces root resolves through a symlink outside persistence root/);
    });

    it('rejects personal or shared workspace overlap with companion runtime state', () => {
      const root = makeDataDir();
      const fleet = clone(VALID_FLEET);
      fleet.companions[0].companionDataDir =
        'workspaces/personal/11111111-1111-4111-8111-111111111111/state';
      fleet.companions[0].characterCardPath =
        'workspaces/personal/11111111-1111-4111-8111-111111111111/state/character-card.json';

      expect(() => resolveCompanionFleetPaths(fleet, root))
        .toThrow(/Personal Workspace.*must not overlap.*companionDataDir/);
    });

    it('rejects observer storage overlapping any companion data or personal workspace boundary', () => {
      const root = makeDataDir();
      const siblingDataRoot = join(root, 'companions/aria');
      const siblingWorkspaceRoot = join(
        root,
        'workspaces/personal/22222222-2222-4222-8222-222222222222',
      );

      expect(() => resolveCompanionFleetPaths(
        createFleetWithObserverRoots(
          join(siblingDataRoot, 'observer'),
          join(root, 'observer-two'),
        ),
        root,
      )).toThrow(/observerEvalSidecar\.persistenceRootDir.*companionDataDir/);

      expect(() => resolveCompanionFleetPaths(
        createFleetWithObserverRoots(
          join(root, 'observer-one'),
          join(siblingWorkspaceRoot, 'observer'),
        ),
        root,
      )).toThrow(/observerEvalSidecar\.persistenceRootDir.*personalWorkspacePath/);
    });

    it('binds one runtime to the complete selected fleet tuple', () => {
      const fleet = resolveCompanionFleetPaths(VALID_FLEET, makeDataDir());
      const expected = fleet.companions[0];

      expect(resolveCompanionRuntimeIdentity({
        fleet,
        companionId: expected.companionId,
        companionDataDir: expected.companionDataDir,
        characterCardPath: expected.characterCardPath,
        postgresSchema: expected.postgresSchema,
        workspacePath: expected.personalWorkspacePath,
      })).toEqual(expected);
    });

    it('rejects unknown identities and every mismatched tuple field', () => {
      const fleet = resolveCompanionFleetPaths(VALID_FLEET, makeDataDir());
      const expected = fleet.companions[0];
      const valid = {
        fleet,
        companionId: expected.companionId,
        companionDataDir: expected.companionDataDir,
        characterCardPath: expected.characterCardPath,
        postgresSchema: expected.postgresSchema,
        workspacePath: expected.personalWorkspacePath,
      };

      expect(() => resolveCompanionRuntimeIdentity({ ...valid, companionId: 'missing' }))
        .toThrow(/is not present in companions\.json/);
      expect(() => resolveCompanionRuntimeIdentity({ ...valid, companionDataDir: fleet.companions[1].companionDataDir }))
        .toThrow(/COMPANION_DATA_DIR/);
      expect(() => resolveCompanionRuntimeIdentity({ ...valid, characterCardPath: fleet.companions[1].characterCardPath }))
        .toThrow(/CHARACTER_CARD_PATH/);
      expect(() => resolveCompanionRuntimeIdentity({ ...valid, postgresSchema: fleet.companions[1].postgresSchema }))
        .toThrow(/COMPANION_PG_SCHEMA/);
      expect(() => resolveCompanionRuntimeIdentity({ ...valid, workspacePath: fleet.companions[1].personalWorkspacePath }))
        .toThrow(/WORKSPACE_PATH/);
      expect(() => resolveCompanionRuntimeIdentity({ ...valid, workspacePath: undefined }))
        .toThrow(/WORKSPACE_PATH/);
    });
  });
});
