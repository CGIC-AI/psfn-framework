import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Contact } from '../../../contacts/types.js';
import type { ContactStore } from '../../../contacts/store.js';
import type { SubstrateConfig } from '../../../types.js';
import { AdminChatBootstrapService } from './bootstrap.js';

let tempDir: string | null = null;

function makeTempDir(): string {
  tempDir = mkdtempSync(join(tmpdir(), 'psfn-chat-bootstrap-'));
  return tempDir;
}

function makeRuntimeConfig(characterCardPath: string, overrides: Partial<SubstrateConfig> = {}): SubstrateConfig {
  const baseConfig: SubstrateConfig = {
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
    extractionThresholdPct: 30,
    compactionThresholdPct: 70,
    characterName: 'Test Companion',
    modelRoster: {
      chat: {
        model: 'test-primary',
        provider: 'test-provider',
        maxTokens: 1024,
        contextWindow: 8_192,
      },
    },
    modelCatalog: {
      primary: {
        model: 'test-model-room',
        provider: 'openai',
        defaults: {
          description: 'Test Model Room',
        },
      },
    },
    modelRoleAssignments: {
      chat: 'primary',
    },
  };
  return {
    ...baseConfig,
    ...overrides,
    modelRoster: {
      ...baseConfig.modelRoster,
      ...(overrides.modelRoster ?? {}),
    },
    modelCatalog: {
      ...baseConfig.modelCatalog,
      ...(overrides.modelCatalog ?? {}),
    },
    modelRoleAssignments: {
      ...baseConfig.modelRoleAssignments,
      ...(overrides.modelRoleAssignments ?? {}),
    },
  };
}

function makeContact(id: string, displayName: string): Contact {
  const now = new Date().toISOString();
  return {
    id,
    displayName,
    trustLevel: 'regular',
    relationshipType: 'friend',
    firstSeen: now,
    lastSeen: now,
    channels: [{
      channel: 'api',
      userId: 'admin-user',
      privacyLevel: 'private',
    }],
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
    const contactStore = {
      listAll: () => [makeContact('contact-primary', 'Primary Contact')],
    } as unknown as ContactStore;
    const service = new AdminChatBootstrapService(contactStore, {
      config: makeRuntimeConfig('/tmp/unused-card.json'),
      resolveGlobalDefaultSessionId: () => '123456789012345678',
    });

    const payload = service.buildBootstrap();

    expect(payload.defaultSessionId).toBe('123456789012345678');
    expect(payload.runtime.transportHeaders['X-Session-ID']).toBe('123456789012345678');
    expect(payload.runtime.transportHeaders['X-Channel-Privacy']).toBe('private');
    // Global default should not force a Garden contact remap by itself.
    expect(payload.selectedTarget.channel).toBe('api');
    expect(payload.selectedTarget.userId).toBe('admin-user');
    expect(payload.assistantName).toBe('Test Companion');
    expect(payload.onboarding.required).toBe(false);
  });

  it('falls back to selected identity session id when no global default exists', () => {
    const contactStore = {
      listAll: () => [makeContact('contact-primary', 'Primary Contact')],
    } as unknown as ContactStore;
    const service = new AdminChatBootstrapService(contactStore, {
      config: makeRuntimeConfig('/tmp/unused-card.json'),
      resolveGlobalDefaultSessionId: () => null,
    });

    const payload = service.buildBootstrap();

    expect(payload.defaultSessionId).toBe('api:admin-user');
    expect(payload.runtime.transportHeaders['X-Session-ID']).toBe('api:admin-user');
    expect(payload.runtime.transportHeaders['X-Channel-Privacy']).toBe('private');
  });

  it('keeps explicit operator-selected identity as default session', () => {
    const linkChannelIdentity = vi.fn(() => 'linked');
    const operatorContact = makeContact('contact-operator', 'Operator Contact');
    operatorContact.channels = [{
      channel: 'api',
      userId: 'operator-7',
      privacyLevel: 'private',
    }];
    const contactStore = {
      listAll: () => [operatorContact],
      linkChannelIdentity,
      setChannelPrivacy: vi.fn(() => true),
      setConversationChannelPrivacy: vi.fn(() => true),
    } as unknown as ContactStore;
    const service = new AdminChatBootstrapService(contactStore, {
      config: makeRuntimeConfig('/tmp/unused-card.json'),
      resolveGlobalDefaultSessionId: () => '123456789012345678',
    });

    const payload = service.updateSelection({
      channel: 'api',
      userId: 'operator-7',
    });

    expect(payload.defaultSessionId).toBe('api:operator-7');
    expect(payload.runtime.transportHeaders['X-Session-ID']).toBe('api:operator-7');
    expect(payload.runtime.transportHeaders['X-Channel-Privacy']).toBe('private');
  });

  it('switches to conversation-channel targets without forcing identity links', () => {
    const contact = makeContact('contact-dm', 'DM Contact');
    contact.conversationChannels = [{
      channel: 'discord',
      channelId: '1313001762793197678',
      firstSeen: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      privacyLevel: 'semi_private',
    }];

    const setConversationChannelPrivacy = vi.fn((
      _contactId: string,
      _channel: string,
      _channelId: string,
      privacyLevel: 'private' | 'semi_private' | 'public' | 'broadcast',
    ) => {
      if (contact.conversationChannels) {
        contact.conversationChannels[0].privacyLevel = privacyLevel;
      }
      return true;
    });
    const linkChannelIdentity = vi.fn(() => 'linked');
    const contactStore = {
      listAll: () => [contact],
      setConversationChannelPrivacy,
      linkChannelIdentity,
      setChannelPrivacy: vi.fn(() => true),
    } as unknown as ContactStore;

    const service = new AdminChatBootstrapService(contactStore, {
      config: makeRuntimeConfig('/tmp/unused-card.json'),
      resolveGlobalDefaultSessionId: () => null,
    });

    const payload = service.updateSelection({
      canonicalContactId: contact.id,
      channel: 'discord',
      channelId: '1313001762793197678',
      privacyLevel: 'private',
    });

    expect(payload.defaultSessionId).toBe('1313001762793197678');
    expect(payload.selectedTarget).toMatchObject({
      targetKind: 'conversation',
      channel: 'discord',
      channelId: '1313001762793197678',
      privacyLevel: 'private',
    });
    expect(payload.defaultAuthorId).toBe('admin-user');
    expect(setConversationChannelPrivacy).toHaveBeenCalledWith(
      contact.id,
      'discord',
      '1313001762793197678',
      'private',
      'admin:chat:bootstrap',
    );
    expect(linkChannelIdentity).not.toHaveBeenCalled();
  });

  it('does not expose raw api keys in bootstrap payloads', () => {
    const contactStore = {
      listAll: () => [makeContact('contact-primary', 'Primary Contact')],
    } as unknown as ContactStore;
    const service = new AdminChatBootstrapService(contactStore, {
      apiKey: 'bootstrap-test-secret',
      config: makeRuntimeConfig('/tmp/unused-card.json'),
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

  it('fails closed when no contacts are available for admin bootstrap', () => {
    const contactStore = {
      listAll: () => [],
    } as unknown as ContactStore;
    const service = new AdminChatBootstrapService(contactStore, {
      config: makeRuntimeConfig('/tmp/unused-card.json'),
      resolveGlobalDefaultSessionId: () => null,
    });

    expect(() => service.buildBootstrap()).toThrow('no contacts are available');
  });

  it('fails closed when model room bootstrap has no direct participants', () => {
    const service = new AdminChatBootstrapService(null, {
      config: makeRuntimeConfig('/tmp/unused-card.json'),
      resolveGlobalDefaultSessionId: () => null,
    });

    expect(() => service.buildModelRoomBootstrap(makeRuntimeConfig('/tmp/unused-card.json', {
      modelCatalog: {
        primary: {
          model: 'test-model-room',
          provider: 'openrouter',
        },
      },
    }))).toThrow('no direct model-room participants are configured');
  });

  it('resets default author identity when switching contacts without explicit overrides', () => {
    const contactStore = {
      listAll: () => [
        makeContact('contact-api-principal', 'API Principal'),
        makeContact('contact-v', 'V'),
      ],
    } as unknown as ContactStore;
    const service = new AdminChatBootstrapService(contactStore, {
      config: makeRuntimeConfig('/tmp/unused-card.json'),
      resolveGlobalDefaultSessionId: () => null,
    });

    const initial = service.buildBootstrap();
    expect(initial.defaultAuthorName).toBe('API Principal');

    const updated = service.updateSelection({
      canonicalContactId: 'contact-v',
      channel: 'api',
      userId: 'admin-user',
    });
    expect(updated.displayName).toBe('V');
    expect(updated.defaultAuthorName).toBe('V');
    expect(updated.defaultAuthorId).toBe('admin-user');
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

    const contactStore = {
      listAll: () => [makeContact('contact-primary', 'Primary Contact')],
    } as unknown as ContactStore;
    const service = new AdminChatBootstrapService(contactStore, {
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

    const contactStore = {
      listAll: () => [makeContact('contact-primary', 'Primary Contact')],
    } as unknown as ContactStore;
    const service = new AdminChatBootstrapService(contactStore, {
      config: makeRuntimeConfig(characterCardPath, { characterName: 'Configured Companion' }),
      resolveGlobalDefaultSessionId: () => null,
    });

    const payload = service.buildBootstrap();

    expect(payload.assistantName).toBe('Aimi');
  });
});
