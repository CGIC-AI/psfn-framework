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
  MULTI_COMPANION_ENV_VAR,
  isMultiCompanionEnabled,
  loadCompanionsConfig,
  resolveCompanionFleet,
  resolveCompanionFleetPaths,
  resolveCompanionRuntimeIdentity,
  validateCompanionsConfig,
  type CompanionsFleetConfig,
} from './companions-config.js';

const VALID_FLEET: CompanionsFleetConfig = {
  companions: [
    {
      companionId: '11111111-1111-4111-8111-111111111111',
      companionDataDir: 'companions/flagship',
      characterCardPath: 'companions/flagship/character-card.json',
      postgresSchema: 'companion_flagship',
    },
    {
      companionId: '22222222-2222-4222-8222-222222222222',
      companionDataDir: 'companions/aria',
      characterCardPath: 'companions/aria/character-card.json',
      postgresSchema: 'companion_aria',
    },
  ],
};

function clone<T>(value: T): T {
  return structuredClone(value);
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

    it('accepts a fleet with per-companion gardenPort values', () => {
      const fleet = clone(VALID_FLEET);
      fleet.companions[0].gardenPort = 10061;
      fleet.companions[1].gardenPort = 10062;
      expect(validateCompanionsConfig(fleet, 'companions.json')).toEqual(fleet);
    });

    it('accepts a fleet where only some companions have a gardenPort', () => {
      const fleet = clone(VALID_FLEET);
      fleet.companions[0].gardenPort = 10061;
      const validated = validateCompanionsConfig(fleet, 'companions.json');
      expect(validated.companions[0].gardenPort).toBe(10061);
      expect(validated.companions[1].gardenPort).toBeUndefined();
    });

    it('rejects a non-integer gardenPort', () => {
      const fleet = clone(VALID_FLEET);
      (fleet.companions[0] as Record<string, unknown>).gardenPort = '10061';
      expect(() => validateCompanionsConfig(fleet, 'companions.json'))
        .toThrow(/gardenPort must be an integer TCP port/);
      (fleet.companions[0] as Record<string, unknown>).gardenPort = 10061.5;
      expect(() => validateCompanionsConfig(fleet, 'companions.json'))
        .toThrow(/gardenPort must be an integer TCP port/);
    });

    it('rejects an out-of-range gardenPort', () => {
      const fleet = clone(VALID_FLEET);
      fleet.companions[0].gardenPort = 0;
      expect(() => validateCompanionsConfig(fleet, 'companions.json'))
        .toThrow(/gardenPort must be between 1 and 65535/);
      fleet.companions[0].gardenPort = 70_000;
      expect(() => validateCompanionsConfig(fleet, 'companions.json'))
        .toThrow(/gardenPort must be between 1 and 65535/);
    });

    it('rejects a gardenPort collision across the fleet (fail closed)', () => {
      const fleet = clone(VALID_FLEET);
      fleet.companions[0].gardenPort = 10061;
      fleet.companions[1].gardenPort = 10061;
      expect(() => validateCompanionsConfig(fleet, 'companions.json'))
        .toThrow(/duplicate gardenPort 10061/);
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

  describe('resolveCompanionFleet (fail-closed both ways)', () => {
    it('returns undefined when flag off and file absent (default topology)', () => {
      const dataDir = makeDataDir();
      expect(resolveCompanionFleet({ dataDir, multiCompanion: false })).toBeUndefined();
    });

    it('refuses to start when flag on but file missing', () => {
      const dataDir = makeDataDir();
      expect(() => resolveCompanionFleet({ dataDir, multiCompanion: true }))
        .toThrow(/is enabled but the fleet manifest is missing/);
    });

    it('refuses to start when flag off but file present', () => {
      const dataDir = makeDataDir();
      writeCompanionsFile(dataDir, VALID_FLEET);
      expect(() => resolveCompanionFleet({ dataDir, multiCompanion: false }))
        .toThrow(/present at .* but PSFN_MULTI_COMPANION is not enabled/);
    });

    it('returns the validated fleet when flag on and file valid', () => {
      const dataDir = makeDataDir();
      writeCompanionsFile(dataDir, VALID_FLEET);
      expect(resolveCompanionFleet({ dataDir, multiCompanion: true })).toEqual(VALID_FLEET);
    });

    it('fails closed when flag on and file invalid', () => {
      const dataDir = makeDataDir();
      writeCompanionsFile(dataDir, { companions: [{ companionId: 'bad' }] });
      expect(() => resolveCompanionFleet({ dataDir, multiCompanion: true }))
        .toThrow(/Invalid companions config/);
    });
  });

  describe('resolved fleet paths and runtime identity', () => {
    it('resolves every manifest path beneath the canonical persistence root', () => {
      const root = makeDataDir();
      const resolved = resolveCompanionFleetPaths(VALID_FLEET, root);
      const canonicalRoot = realpathSync(root);

      expect(resolved.persistenceRoot).toBe(canonicalRoot);
      expect(resolved.companions[0]).toMatchObject({
        companionDataDir: join(canonicalRoot, 'companions/flagship'),
        characterCardPath: join(canonicalRoot, 'companions/flagship/character-card.json'),
      });
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

    it('binds one runtime to the complete selected fleet tuple', () => {
      const fleet = resolveCompanionFleetPaths(VALID_FLEET, makeDataDir());
      const expected = fleet.companions[0];

      expect(resolveCompanionRuntimeIdentity({
        fleet,
        companionId: expected.companionId,
        companionDataDir: expected.companionDataDir,
        characterCardPath: expected.characterCardPath,
        postgresSchema: expected.postgresSchema,
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
      };

      expect(() => resolveCompanionRuntimeIdentity({ ...valid, companionId: 'missing' }))
        .toThrow(/is not present in companions\.json/);
      expect(() => resolveCompanionRuntimeIdentity({ ...valid, companionDataDir: fleet.companions[1].companionDataDir }))
        .toThrow(/COMPANION_DATA_DIR/);
      expect(() => resolveCompanionRuntimeIdentity({ ...valid, characterCardPath: fleet.companions[1].characterCardPath }))
        .toThrow(/CHARACTER_CARD_PATH/);
      expect(() => resolveCompanionRuntimeIdentity({ ...valid, postgresSchema: fleet.companions[1].postgresSchema }))
        .toThrow(/COMPANION_PG_SCHEMA/);
    });
  });

  describe('isMultiCompanionEnabled', () => {
    it('defaults off when unset or empty', () => {
      expect(isMultiCompanionEnabled({})).toBe(false);
      expect(isMultiCompanionEnabled({ [MULTI_COMPANION_ENV_VAR]: '   ' })).toBe(false);
    });

    it('parses truthy and falsy flag values', () => {
      expect(isMultiCompanionEnabled({ [MULTI_COMPANION_ENV_VAR]: '1' })).toBe(true);
      expect(isMultiCompanionEnabled({ [MULTI_COMPANION_ENV_VAR]: 'true' })).toBe(true);
      expect(isMultiCompanionEnabled({ [MULTI_COMPANION_ENV_VAR]: 'on' })).toBe(true);
      expect(isMultiCompanionEnabled({ [MULTI_COMPANION_ENV_VAR]: '0' })).toBe(false);
      expect(isMultiCompanionEnabled({ [MULTI_COMPANION_ENV_VAR]: 'false' })).toBe(false);
    });

    it('fails closed on an unparseable flag value', () => {
      expect(() => isMultiCompanionEnabled({ [MULTI_COMPANION_ENV_VAR]: 'maybe' }))
        .toThrow(/Invalid PSFN_MULTI_COMPANION/);
    });
  });
});
