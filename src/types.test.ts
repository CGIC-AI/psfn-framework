import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from './types.js';

const ORIGINAL_ENV = { ...process.env };

function restoreEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) {
      delete process.env[key];
    }
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    process.env[key] = value;
  }
}

function clearRuntimePathEnv(): void {
  delete process.env.DATA_DIR;
  delete process.env.SYSTEM_DATA_DIR;
  delete process.env.COMPANION_DATA_DIR;
  delete process.env.DATABASE_PATH;
  delete process.env.DATABASE_BASENAME;
  delete process.env.CHARACTER_CARD_PATH;
}

afterEach(() => {
  restoreEnv();
});

describe('loadConfig path defaults', () => {
  it('uses data-dir-relative defaults when explicit paths are not set', () => {
    clearRuntimePathEnv();

    const config = loadConfig();
    expect(config.systemDataDir).toBe('./data');
    expect(config.companionDataDir).toBe('./data');
    expect(config.dataDir).toBe('./data');
    expect(config.characterCardPath).toBe('./data/character.json');
    expect(config.databasePath).toBe('./data/companion.db');
  });

  it('derives card/database paths from DATA_DIR when only DATA_DIR is set', () => {
    clearRuntimePathEnv();
    process.env.DATA_DIR = './sandbox-data';

    const config = loadConfig();
    expect(config.systemDataDir).toBe('./sandbox-data');
    expect(config.companionDataDir).toBe('./sandbox-data');
    expect(config.dataDir).toBe('./sandbox-data');
    expect(config.characterCardPath).toBe('./sandbox-data/character.json');
    expect(config.databasePath).toBe('./sandbox-data/companion.db');
  });

  it('respects explicit CHARACTER_CARD_PATH and DATABASE_PATH overrides', () => {
    clearRuntimePathEnv();
    process.env.DATA_DIR = './sandbox-data';
    process.env.CHARACTER_CARD_PATH = './cards/main.json';
    process.env.DATABASE_PATH = './db/main.db';

    const config = loadConfig();
    expect(config.systemDataDir).toBe('./sandbox-data');
    expect(config.companionDataDir).toBe('./sandbox-data');
    expect(config.dataDir).toBe('./sandbox-data');
    expect(config.characterCardPath).toBe('./cards/main.json');
    expect(config.databasePath).toBe('./db/main.db');
  });

  it('derives database path from DATABASE_BASENAME when DATABASE_PATH is not set', () => {
    clearRuntimePathEnv();
    process.env.DATA_DIR = './sandbox-data';
    process.env.DATABASE_BASENAME = 'Companion Prime';

    const config = loadConfig();
    expect(config.databasePath).toBe('./sandbox-data/companion-prime.db');
  });

  it('supports explicit split system and companion roots', () => {
    clearRuntimePathEnv();
    process.env.SYSTEM_DATA_DIR = './system-data';
    process.env.COMPANION_DATA_DIR = './companion-data';

    const config = loadConfig();
    expect(config.systemDataDir).toBe('./system-data');
    expect(config.companionDataDir).toBe('./companion-data');
    expect(config.dataDir).toBe('./system-data');
    expect(config.characterCardPath).toBe('./companion-data/character.json');
    expect(config.databasePath).toBe('./companion-data/companion.db');
  });

  it('rejects partial split-root configuration', () => {
    clearRuntimePathEnv();
    process.env.SYSTEM_DATA_DIR = './system-data';

    expect(() => loadConfig()).toThrow(
      'SYSTEM_DATA_DIR and COMPANION_DATA_DIR must both be set together',
    );
  });
});
