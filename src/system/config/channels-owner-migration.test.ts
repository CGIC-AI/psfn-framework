import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadRuntimeChannelsConfig } from '../../channels/backplane/config.js';
import { migrateRetiredChannelPluginSections } from './channels-owner-migration.js';

let root: string | null = null;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
});

function prepareOwner(value: unknown): { dataDir: string; filePath: string; bytes: string } {
  root = mkdtempSync(join(tmpdir(), 'channels-owner-migration-'));
  const filePath = join(root, 'channels.json');
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(filePath, bytes);
  chmodSync(filePath, 0o644);
  return { dataDir: root, filePath, bytes };
}

const LIVE_SHAPE = {
  discord: { heartbeatChannelId: '123456789012345678' },
  telegram: { enabled: false },
  api: {},
  multica: {
    enabled: true,
    baseUrl: 'https://multica.example.test',
    tokenRef: { kind: 'env', envName: 'MULTICA_GATEWAY_TOKEN' },
  },
  buzz: {
    enabled: true,
    relayUrl: 'wss://relay.example.test',
    accounts: [{ privateKeyRef: { kind: 'env', envName: 'BUZZ_EXAMPLE_PRIVATE_KEY' } }],
  },
};

describe('migrateRetiredChannelPluginSections', () => {
  it('reports the retired sections on dry-run without writing', () => {
    const { dataDir, filePath, bytes } = prepareOwner(LIVE_SHAPE);

    expect(migrateRetiredChannelPluginSections({ dataDir })).toEqual({
      mode: 'dry-run',
      status: 'planned',
      filePath,
      removedPaths: ['buzz', 'multica'],
    });
    expect(readFileSync(filePath, 'utf8')).toBe(bytes);
  });

  it('strips exactly the retired sections on apply, then is idempotent', () => {
    const { dataDir, filePath } = prepareOwner(LIVE_SHAPE);
    expect(() => loadRuntimeChannelsConfig(dataDir, {})).toThrow(
      'Channel plugin "multica" was removed',
    );

    expect(migrateRetiredChannelPluginSections({ dataDir, apply: true })).toEqual({
      mode: 'apply',
      status: 'applied',
      filePath,
      removedPaths: ['buzz', 'multica'],
    });
    const migrated = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    expect(migrated).toEqual({
      discord: LIVE_SHAPE.discord,
      telegram: LIVE_SHAPE.telegram,
      api: LIVE_SHAPE.api,
    });
    expect(statSync(filePath).mode & 0o777).toBe(0o644);
    expect(() => loadRuntimeChannelsConfig(dataDir, {})).not.toThrow();

    const afterBytes = readFileSync(filePath, 'utf8');
    expect(migrateRetiredChannelPluginSections({ dataDir, apply: true })).toEqual({
      mode: 'apply',
      status: 'not_needed',
      filePath,
    });
    expect(readFileSync(filePath, 'utf8')).toBe(afterBytes);
  });

  it('strips retired sections nested under the channels key', () => {
    const { dataDir, filePath } = prepareOwner({
      channels: { api: {}, buzz: { enabled: false } },
    });

    expect(migrateRetiredChannelPluginSections({ dataDir, apply: true })).toMatchObject({
      status: 'applied',
      removedPaths: ['channels.buzz'],
    });
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual({
      channels: { api: {} },
    });
  });

  it('keeps failing closed on any other unknown plugin key without writing', () => {
    const { dataDir, filePath, bytes } = prepareOwner({ ...LIVE_SHAPE, slack: { enabled: true } });

    expect(() => migrateRetiredChannelPluginSections({ dataDir, apply: true })).toThrow(
      'Unknown channel plugin "slack"',
    );
    expect(readFileSync(filePath, 'utf8')).toBe(bytes);
  });

  it('is not needed when the owner file is absent', () => {
    root = mkdtempSync(join(tmpdir(), 'channels-owner-migration-'));
    expect(migrateRetiredChannelPluginSections({ dataDir: root, apply: true })).toEqual({
      mode: 'apply',
      status: 'not_needed',
      filePath: join(root, 'channels.json'),
    });
  });
});
