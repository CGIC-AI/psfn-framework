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
  delete process.env.DATABASE_PATH;
  delete process.env.CHARACTER_CARD_PATH;
}

afterEach(() => {
  restoreEnv();
});

describe('loadConfig path defaults', () => {
  it('uses data-dir-relative defaults when explicit paths are not set', () => {
    clearRuntimePathEnv();

    const config = loadConfig();
    expect(config.dataDir).toBe('./data');
    expect(config.characterCardPath).toBe('./data/character.json');
    expect(config.databasePath).toBe('./data/purrsephone.db');
  });

  it('derives card/database paths from DATA_DIR when only DATA_DIR is set', () => {
    clearRuntimePathEnv();
    process.env.DATA_DIR = './sandbox-data';

    const config = loadConfig();
    expect(config.dataDir).toBe('./sandbox-data');
    expect(config.characterCardPath).toBe('./sandbox-data/character.json');
    expect(config.databasePath).toBe('./sandbox-data/purrsephone.db');
  });

  it('respects explicit CHARACTER_CARD_PATH and DATABASE_PATH overrides', () => {
    clearRuntimePathEnv();
    process.env.DATA_DIR = './sandbox-data';
    process.env.CHARACTER_CARD_PATH = './cards/main.json';
    process.env.DATABASE_PATH = './db/main.db';

    const config = loadConfig();
    expect(config.dataDir).toBe('./sandbox-data');
    expect(config.characterCardPath).toBe('./cards/main.json');
    expect(config.databasePath).toBe('./db/main.db');
  });
});

