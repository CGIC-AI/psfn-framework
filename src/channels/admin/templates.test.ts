import { describe, expect, it, vi } from 'vitest';
import type { PurrMemory } from '../../memory/types.js';
import type { PromptLayer } from '../../identity/prompt-types.js';
import type { Contact } from '../../contacts/types.js';
import type { ContactStore } from '../../contacts/store.js';
import type { MemoryStore } from '../../memory/store.js';
import type { SessionStore } from '../../session/store.js';
import type { SessionManager } from '../../session/manager.js';
import type { Scheduler } from '../../scheduler/scheduler.js';
import type { ShardManager } from '../../shards/manager.js';
import type { CharacterCardV2 } from '../../identity/types.js';
import type { SubstrateConfig } from '../../types.js';
import { EventBus } from '../../event-bus.js';
import { AdminHandlers } from './handlers.js';
import { contactEditForm, contactRow, layout, loginPage, memoryRow, promptLayersFragment } from './templates.js';

describe('admin templates', () => {
  it('renders layout with external stylesheet', () => {
    const html = layout('Dashboard', '<div>body</div>', 'dashboard');
    expect(html).toContain('<link rel="stylesheet" href="/static/admin.css">');
    expect(html).toContain('<script src="/static/htmx.min.js"></script>');
    expect(html).toContain('<script src="/static/sse.js"></script>');
  });

  it('escapes login errors', () => {
    const html = loginPage('<invalid>"token"');
    expect(html).toContain('&lt;invalid&gt;&quot;token&quot;');
  });

  it('escapes memory row text and encodes ids', () => {
    const memory: PurrMemory = {
      id: 'id with spaces/and/slash',
      text: '<script>alert("x")</script>',
      type: 'semantic',
      importance: 0.5,
      confidence: 0.6,
      emotionalValence: 0.1,
      salience: 0.7,
      sourceRef: 'test:1',
      extractedAt: Date.now(),
      lastAccessed: Date.now(),
      accessCount: 1,
      tags: [],
      sensitivity: 'public',
    };

    const html = memoryRow(memory);
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    expect(html).toContain('/memory/id%20with%20spaces%2Fand%2Fslash');
    expect(html).toContain('/api/memory/id%20with%20spaces%2Fand%2Fslash/supersede');
  });

  it('sorts prompt layers by type order then priority', () => {
    const baseLayer: PromptLayer = {
      id: 'base-1',
      type: 'base',
      name: 'Base',
      content: 'base content',
      enabled: true,
      priority: 10,
      updatedAt: new Date().toISOString(),
      updatedBy: 'system',
      checksum: 'abc123',
      version: 1,
    };

    const runtimeLayer: PromptLayer = {
      id: 'runtime-1',
      type: 'runtime',
      name: 'Runtime',
      content: 'runtime content',
      enabled: true,
      priority: 1,
      updatedAt: new Date().toISOString(),
      updatedBy: 'system',
      checksum: 'def456',
      version: 1,
    };

    const operatorLayer: PromptLayer = {
      id: 'operator-1',
      type: 'operator',
      name: 'Operator',
      content: 'operator content',
      enabled: true,
      priority: 5,
      updatedAt: new Date().toISOString(),
      updatedBy: 'system',
      checksum: 'ghi789',
      version: 1,
    };

    const html = promptLayersFragment([runtimeLayer, operatorLayer, baseLayer]);
    const basePos = html.indexOf('/prompts/base-1');
    const operatorPos = html.indexOf('/prompts/operator-1');
    const runtimePos = html.indexOf('/prompts/runtime-1');

    expect(basePos).toBeGreaterThanOrEqual(0);
    expect(operatorPos).toBeGreaterThan(basePos);
    expect(runtimePos).toBeGreaterThan(operatorPos);
  });

  it('renders contact row with nickname, linked identities, and related channels', () => {
    const contact = {
      id: 'contact-1',
      displayName: 'Alice Example',
      nickname: 'Ace',
      trustLevel: 'trusted',
      relationshipType: 'friend',
      firstSeen: '2024-01-01T00:00:00.000Z',
      lastSeen: '2024-01-02T00:00:00.000Z',
      channels: [{
        channel: 'discord',
        userId: 'alice-user',
        privacyLevel: 'semi_private',
        firstSeen: '2024-01-01T00:00:00.000Z',
        lastSeen: '2024-01-02T00:00:00.000Z',
      }],
      notes: 'prefers concise updates',
    } as Contact & { nickname?: string };

    const html = contactRow(contact, undefined, [{
      channel: 'discord',
      channelId: '1234567890',
      lastSeen: '2024-01-03T12:00:00.000Z',
    }]);

    expect(html).toContain('Alice Example');
    expect(html).toContain('aka: Ace');
    expect(html).toContain('Linked identities');
    expect(html).toContain('discord:alice-user');
    expect(html).toContain('semi_private');
    expect(html).toContain('Related channels');
    expect(html).toContain('discord:1234567890');
    expect(html).toContain('Last seen:');
  });

  it('renders contact edit form with required display name and optional nickname inputs', () => {
    const contact = {
      id: 'contact-2',
      displayName: 'Bob Example',
      nickname: 'Bobby',
      trustLevel: 'regular',
      relationshipType: 'acquaintance',
      firstSeen: '2024-01-01T00:00:00.000Z',
      lastSeen: '2024-01-02T00:00:00.000Z',
      channels: [{
        channel: 'api',
        userId: 'bob-api',
        privacyLevel: 'private',
        firstSeen: '2024-01-01T00:00:00.000Z',
        lastSeen: '2024-01-02T00:00:00.000Z',
      }],
    } as Contact & { nickname?: string };

    const html = contactEditForm(contact);
    expect(html).toContain('name="displayName"');
    expect(html).toContain('name="displayName" value="Bob Example" required');
    expect(html).toContain('name="nickname"');
    expect(html).toContain('name="nickname" value="Bobby"');
    expect(html).toContain('name="newChannel"');
    expect(html).toContain('name="newChannelUserId"');
    expect(html).toContain('name="newChannelPrivacy"');
  });

  it('wires contact update form fields to identity profile and existing trust/privacy handlers', () => {
    const contact = {
      id: 'contact-3',
      displayName: 'Carol',
      nickname: 'C',
      trustLevel: 'regular',
      relationshipType: 'stranger',
      firstSeen: '2024-01-01T00:00:00.000Z',
      lastSeen: '2024-01-02T00:00:00.000Z',
      channels: [{
        channel: 'discord',
        userId: 'carol-discord',
        privacyLevel: 'semi_private',
        firstSeen: '2024-01-01T00:00:00.000Z',
        lastSeen: '2024-01-02T00:00:00.000Z',
      }],
      notes: '',
    } as Contact & { nickname?: string };

    const updateIdentityProfile = vi.fn((id: string, displayName: string, nickname?: string) => {
      if (id !== contact.id) return false;
      contact.displayName = displayName;
      contact.nickname = nickname;
      return true;
    });

    const mockContactStore = {
      getById: vi.fn((id: string) => (id === contact.id ? contact : undefined)),
      setTrustLevel: vi.fn((id: string, trustLevel: Contact['trustLevel']) => {
        if (id !== contact.id) return false;
        contact.trustLevel = trustLevel;
        return true;
      }),
      updateRelationshipType: vi.fn((id: string, relationshipType: Contact['relationshipType']) => {
        if (id !== contact.id) return false;
        contact.relationshipType = relationshipType;
        return true;
      }),
      updateNotes: vi.fn((id: string, notes: string) => {
        if (id !== contact.id) return false;
        contact.notes = notes;
        return true;
      }),
      linkChannelIdentity: vi.fn(() => 'linked'),
      setChannelPrivacy: vi.fn(() => true),
      upsert: vi.fn(() => contact),
      updateIdentityProfile,
    } as unknown as ContactStore;

    const handlers = new AdminHandlers({
      memoryStore: {
        listContactProfiles: vi.fn(() => []),
        getContactProfile: vi.fn(() => undefined),
      } as unknown as MemoryStore,
      sessionStore: {
        listChannels: vi.fn(() => []),
        getLastEntry: vi.fn(() => undefined),
      } as unknown as SessionStore,
      sessionManager: {} as SessionManager,
      scheduler: { taskCount: 0 } as Scheduler,
      shardManager: {} as ShardManager,
      eventBus: new EventBus(),
      embeddingService: null,
      characterCard: {} as CharacterCardV2,
      config: { dataDir: '/tmp' } as SubstrateConfig,
      contactStore: mockContactStore,
    });

    const body = new URLSearchParams({
      displayName: 'Carol Danvers',
      nickname: 'Captain',
      trustLevel: 'trusted',
      relationshipType: 'friend',
      notes: 'Reliable operator',
      channelCount: '1',
      channel_0: 'discord',
      channelUserId_0: 'carol-discord',
      channelPrivacy_0: 'public',
      newChannel: 'telegram',
      newChannelUserId: 'vega-telegram-id',
      newChannelPrivacy: 'private',
    }).toString();

    const html = handlers.handleContactUpdate(contact.id, body);

    expect(updateIdentityProfile).toHaveBeenCalledWith(contact.id, 'Carol Danvers', 'Captain');
    expect(mockContactStore.setTrustLevel).toHaveBeenCalledWith(contact.id, 'trusted');
    expect(mockContactStore.updateRelationshipType).toHaveBeenCalledWith(contact.id, 'friend');
    expect(mockContactStore.updateNotes).toHaveBeenCalledWith(contact.id, 'Reliable operator');
    expect(mockContactStore.setChannelPrivacy).toHaveBeenCalledWith(
      contact.id,
      'discord',
      'carol-discord',
      'public',
    );
    expect(mockContactStore.linkChannelIdentity).toHaveBeenCalledWith(
      contact.id,
      'telegram',
      'vega-telegram-id',
      { privacyLevel: 'private' },
    );
    expect(html).toContain('Carol Danvers');
    expect(html).toContain('aka: Captain');
  });

  it('prefers persisted contact conversation channels in contacts list rendering', () => {
    const contact = {
      id: 'contact-4',
      displayName: 'Dana',
      trustLevel: 'regular',
      relationshipType: 'friend',
      firstSeen: '2024-01-01T00:00:00.000Z',
      lastSeen: '2024-01-02T00:00:00.000Z',
      channels: [{
        channel: 'discord',
        userId: 'dana-discord-user',
        privacyLevel: 'semi_private',
        firstSeen: '2024-01-01T00:00:00.000Z',
        lastSeen: '2024-01-02T00:00:00.000Z',
      }],
      conversationChannels: [{
        channel: 'discord',
        channelId: '1310672143113130108',
        firstSeen: '2024-01-01T00:00:00.000Z',
        lastSeen: '2024-01-03T00:00:00.000Z',
      }],
    } as Contact;

    const handlers = new AdminHandlers({
      memoryStore: {
        listContactProfiles: vi.fn(() => []),
        getContactProfile: vi.fn(() => undefined),
      } as unknown as MemoryStore,
      sessionStore: {
        listChannels: vi.fn(() => [{
          channelId: 'discord:some-other-channel:dana-discord-user',
          messageCount: 2,
          firstTimestamp: Date.now(),
          lastTimestamp: Date.now(),
        }]),
        getLastEntry: vi.fn(() => undefined),
      } as unknown as SessionStore,
      sessionManager: {} as SessionManager,
      scheduler: { taskCount: 0 } as Scheduler,
      shardManager: {} as ShardManager,
      eventBus: new EventBus(),
      embeddingService: null,
      characterCard: {} as CharacterCardV2,
      config: { dataDir: '/tmp' } as SubstrateConfig,
      contactStore: {
        listAll: vi.fn(() => [contact]),
      } as unknown as ContactStore,
    });

    const html = handlers.contactsListFragment();
    expect(html).toContain('discord:1310672143113130108');
  });
});
