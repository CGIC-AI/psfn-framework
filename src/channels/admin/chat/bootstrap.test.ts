import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SubstrateConfig } from '../../../types.js';
import { AdminChatBootstrapService } from './bootstrap.js';

let tempDir: string | null = null;

function makeTempDir(): string {
  tempDir = mkdtempSync(join(tmpdir(), 'psfn-chat-bootstrap-'));
  return tempDir;
}

function makeRuntimeConfig(characterCardPath: string, characterName = ''): SubstrateConfig {
  return {
    primaryModel: 'test-primary',
    primaryProvider: 'test-provider',
    extractionModel: 'test-extraction',
    extractionProvider: 'test-provider',
    primaryMaxTokens: 1024,
    extractionMaxTokens: 512,
    discordToken: '',
    discordBotId: '',
    characterCardPath,
    dataDir: characterCardPath,
    databasePath: `${characterCardPath}.db`,
    extractionInterval: 5,
    maintenanceIntervalMs: 60_000,
    defaultContextWindow: 8_192,
    memoryBudgetPct: 20,
    extractionThresholdPct: 30,
    compactionThresholdPct: 70,
    modelRoster: {},
    characterName,
  };
}

describe('AdminChatBootstrapService', () => {
  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it('uses global latest session id for default transport when available', () => {
    const service = new AdminChatBootstrapService(null, {
      resolveGlobalDefaultSessionId: () => '123456789012345678',
    });

    const payload = service.buildBootstrap();

    expect(payload.defaultSessionId).toBe('123456789012345678');
    expect(payload.runtime.transportHeaders['X-Session-ID']).toBe('123456789012345678');
    // Global default should not force a Garden contact remap by itself.
    expect(payload.selectedIdentity.channel).toBe('api');
    expect(payload.selectedIdentity.userId).toBe('admin-user');
    expect(payload.assistantName).toBe('Assistant');
    expect(payload.onboarding.required).toBe(false);
  });

  it('falls back to selected identity session id when no global default exists', () => {
    const service = new AdminChatBootstrapService(null, {
      resolveGlobalDefaultSessionId: () => null,
    });

    const payload = service.buildBootstrap();

    expect(payload.defaultSessionId).toBe('api:admin-user');
    expect(payload.runtime.transportHeaders['X-Session-ID']).toBe('api:admin-user');
  });

  it('keeps explicit operator-selected identity as default session', () => {
    const service = new AdminChatBootstrapService(null, {
      resolveGlobalDefaultSessionId: () => '123456789012345678',
    });

    const payload = service.updateSelection({
      channel: 'api',
      userId: 'operator-7',
    });

    expect(payload.defaultSessionId).toBe('api:operator-7');
    expect(payload.runtime.transportHeaders['X-Session-ID']).toBe('api:operator-7');
  });

  it('does not expose raw api keys in bootstrap payloads', () => {
    const service = new AdminChatBootstrapService(null, {
      apiKey: 'bootstrap-test-secret',
      resolveGlobalDefaultSessionId: () => null,
    });

    const payload = service.buildBootstrap();
    const modelRoomPayload = service.buildModelRoomBootstrap(makeRuntimeConfig('/tmp/unused-card.json'));

    expect(payload.api.apiKey).toBeUndefined();
    expect(payload.runtime.apiKey).toBeUndefined();
    expect(modelRoomPayload.api.apiKey).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain('bootstrap-test-secret');
    expect(JSON.stringify(modelRoomPayload)).not.toContain('bootstrap-test-secret');
  });

  it('reports onboarding required when starter bootstrap card is active', () => {
    const root = makeTempDir();
    const characterCardPath = join(root, 'character.json');
    writeFileSync(characterCardPath, JSON.stringify({
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: 'Companion',
        description: 'Starter identity',
        personality: 'Starter personality',
        scenario: '',
        first_mes: '',
        mes_example: '',
        system_prompt: '',
        post_history_instructions: '',
        tags: ['bootstrap'],
        creator: 'system',
      },
    }), 'utf-8');

    const service = new AdminChatBootstrapService(null, {
      config: makeRuntimeConfig(characterCardPath),
      resolveGlobalDefaultSessionId: () => null,
    });

    const payload = service.buildBootstrap();

    expect(payload.assistantName).toBe('Companion');
    expect(payload.onboarding.required).toBe(true);
    expect(payload.onboarding.message).toContain('Starter identity is active');
  });

  it('prefers character card name over configured characterName', () => {
    const root = makeTempDir();
    const characterCardPath = join(root, 'character.json');
    writeFileSync(characterCardPath, JSON.stringify({
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: 'Aimi',
        description: '',
        personality: 'Friendly and thoughtful.',
        scenario: '',
        first_mes: '',
        mes_example: '',
        system_prompt: '',
        post_history_instructions: '',
        tags: [],
        creator: 'operator',
      },
    }), 'utf-8');

    const service = new AdminChatBootstrapService(null, {
      config: makeRuntimeConfig(characterCardPath, 'Purrsephone'),
      resolveGlobalDefaultSessionId: () => null,
    });

    const payload = service.buildBootstrap();

    expect(payload.assistantName).toBe('Aimi');
  });
});
