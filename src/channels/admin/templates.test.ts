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
import type { ConfirmationQueueEntry } from '../../gateway/protocol.js';
import { EventBus } from '../../event-bus.js';
import { AdminHandlers } from './handlers.js';
import {
  confirmationQueueFragment,
  contactEditForm,
  contactRow,
  confirmationsPage,
  layout,
  loginPage,
  memoryDetailPage,
  memoryRow,
  promptLayersFragment,
  promptDetailPage,
  sessionListPage,
} from './templates.js';

describe('admin templates', () => {
  it('renders layout with external stylesheet', () => {
    const html = layout('Dashboard', '<div>body</div>', 'dashboard');
    expect(html).toContain('<link rel="stylesheet" href="/static/admin.css">');
    expect(html).toContain('<script src="/static/htmx.min.js"></script>');
    expect(html).toContain('<script src="/static/sse.js"></script>');
    expect(html).toContain('href="/skills"');
    expect(html).toContain('href="/confirmations"');
  });

  it('renders confirmation queue fragments with review controls', () => {
    const entry: ConfirmationQueueEntry = {
      id: 'confirm-1',
      method: 'fs.write',
      action: 'write',
      scope: '/tmp/target.txt',
      params: { path: '/tmp/target.txt', content: 'hello' },
      companionReason: 'Store output',
      requestedAt: 1_700_000_000_000,
      expiresAt: 1_700_000_060_000,
    };
    const fragment = confirmationQueueFragment({
      entries: [entry],
      available: true,
    });
    const page = confirmationsPage(fragment);

    expect(page).toContain('Actions requiring approval are queued here');
    expect(fragment).toContain('name="decision" value="approve"');
    expect(fragment).toContain('name="decision" value="deny"');
    expect(fragment).toContain('name="decision" value="modify"');
    expect(fragment).toContain('name="modifiedParamsJson"');
    expect(fragment).toContain('/api/confirmations/resolve');
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

  it('renders session list with readable channel label and linked contact', () => {
    const html = sessionListPage([{
      channelId: 'api:session-42',
      messageCount: 12,
      linkedContactId: 'contact-1',
      linkedContactName: 'Vega',
    }]);

    expect(html).toContain('API · session-42');
    expect(html).toContain('Contact:');
    expect(html).toContain('/contacts#contact-row-contact-1');
    expect(html).toContain('/api/contacts/contact-1/edit');
  });

  it('renders relational memory contact links and sensitivity cues', () => {
    const memory: PurrMemory = {
      id: 'rel-memory-1',
      text: 'The operator feels safer with concise check-ins.',
      type: 'relational',
      importance: 0.9,
      confidence: 0.88,
      emotionalValence: 0.52,
      salience: 0.81,
      sourceRef: 'source:shard:shard-77|session:shard:shard-77|lines:41-42|visibility:private|operation:extract',
      extractedAt: Date.now(),
      lastAccessed: Date.now(),
      accessCount: 2,
      tags: ['relationship'],
      sensitivity: 'confidential',
      consentFlags: {
        allowRecall: false,
        deleteOnRequest: true,
      },
      contactId: 'contact-1',
    };

    const rowHtml = memoryRow(memory, {
      id: 'contact-1',
      displayName: 'Vega',
    });
    expect(rowHtml).toContain('/contacts#contact-row-contact-1');
    expect(rowHtml).toContain('/api/contacts/contact-1/edit');
    expect(rowHtml).toContain('Vega');
    expect(rowHtml).toContain('memory-sensitivity-confidential');
    expect(rowHtml).toContain('recall denied');
    expect(rowHtml).toContain('delete on request');

    const detailHtml = memoryDetailPage(memory, {
      id: 'contact-1',
      displayName: 'Vega',
    });
    expect(detailHtml).toContain('Related Contact');
    expect(detailHtml).toContain('/api/contacts/contact-1/edit');
    expect(detailHtml).toContain('Consent Flags');
    expect(detailHtml).toContain('Provenance');
    expect(detailHtml).toContain('source shard:shard-77');
    expect(detailHtml).toContain('session shard:shard-77');
    expect(detailHtml).toContain('lines 41-42');
    expect(detailHtml).toContain('visibility private');
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

  it('renders structured prompt editor fields for legacy prompt content', () => {
    const layer: PromptLayer = {
      id: 'layer-legacy',
      type: 'base',
      name: 'Legacy Foundation',
      content: 'Legacy prompt body',
      enabled: true,
      priority: 0,
      updatedAt: new Date().toISOString(),
      updatedBy: 'system',
      checksum: 'legacy123',
      version: 3,
    };

    const html = promptDetailPage(layer, []);
    expect(html).toContain('name="description"');
    expect(html).toContain('name="personality"');
    expect(html).toContain('name="system_prompt"');
    expect(html).toContain('name="post_history_instructions"');
    expect(html).toContain('name="scenario"');
    expect(html).toContain('name="mes_example"');
    expect(html).toContain('name="first_mes"');
    expect(html).toContain('name="prompt_format" value="ccv3_sections_v1"');
    expect(html).toContain('Legacy prompt body');
  });

  it('falls back to raw editor when structured prompt content is malformed', () => {
    const layer: PromptLayer = {
      id: 'layer-malformed',
      type: 'base',
      name: 'Malformed Foundation',
      content: ['### description', 'Good section', '', '### unknown_section', 'Oops'].join('\n'),
      enabled: true,
      priority: 0,
      updatedAt: new Date().toISOString(),
      updatedBy: 'system',
      checksum: 'malformed123',
      version: 4,
    };

    const html = promptDetailPage(layer, []);
    expect(html).toContain('Malformed structured prompt content detected');
    expect(html).toContain('name="content"');
    expect(html).toContain('unknown structured section &quot;unknown_section&quot;');
  });

  it('renders contact row with stable name, nickname, and merged linked identities', () => {
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
      channelIdentities: [
        { channel: 'discord', userId: 'alice-user' },
        { channel: 'telegram', userId: 'alice-tg' },
      ],
      notes: 'prefers concise updates',
    } as Contact & { nickname?: string };

    const html = contactRow(contact, undefined, [{
      channel: 'discord',
      channelId: '1234567890',
      lastSeen: '2024-01-03T12:00:00.000Z',
    }]);

    expect(html).toContain('Alice Example');
    expect(html).toContain('Nickname: Ace');
    expect(html).toContain('Linked identities');
    expect(html).toContain('discord:alice-user');
    expect((html.match(/discord:alice-user/g) ?? []).length).toBe(1);
    expect(html).toContain('semi_private');
    expect(html).toContain('telegram:alice-tg');
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
    expect(html).toContain('+ Add channel');
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
    expect(html).toContain('Nickname: Captain');
  });

  it('does not fail no-op save when add-channel fields are untouched', () => {
    const contact = {
      id: 'contact-noop',
      displayName: 'No Op',
      trustLevel: 'regular',
      relationshipType: 'friend',
      firstSeen: '2024-01-01T00:00:00.000Z',
      lastSeen: '2024-01-02T00:00:00.000Z',
      channels: [{
        channel: 'discord',
        userId: 'noop-user',
        privacyLevel: 'semi_private',
        firstSeen: '2024-01-01T00:00:00.000Z',
        lastSeen: '2024-01-02T00:00:00.000Z',
      }],
      notes: 'steady',
    } as Contact;

    const mockContactStore = {
      getById: vi.fn((id: string) => (id === contact.id ? contact : undefined)),
      setTrustLevel: vi.fn(() => true),
      updateRelationshipType: vi.fn(() => true),
      updateNotes: vi.fn(() => true),
      setChannelPrivacy: vi.fn(() => true),
      linkChannelIdentity: vi.fn(() => 'linked'),
      upsert: vi.fn(() => contact),
      updateIdentityProfile: vi.fn(() => true),
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
      displayName: 'No Op',
      trustLevel: 'regular',
      relationshipType: 'friend',
      notes: 'steady',
      channelCount: '1',
      channel_0: 'discord',
      channelUserId_0: 'noop-user',
      channelPrivacy_0: 'semi_private',
      newChannel: '',
      newChannelUserId: '',
      newChannelPrivacy: 'semi_private',
    }).toString();

    const html = handlers.handleContactUpdate(contact.id, body);

    expect(html).toContain('No Op');
    expect(html).not.toContain('To link a new channel, both channel and channel user ID are required');
    expect(mockContactStore.linkChannelIdentity).not.toHaveBeenCalled();
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

  it('renders linked contact names in session list when identity mappings exist', () => {
    const contact = {
      id: 'contact-operator',
      displayName: 'Operator One',
      trustLevel: 'trusted',
      relationshipType: 'friend',
      firstSeen: '2024-01-01T00:00:00.000Z',
      lastSeen: '2024-01-02T00:00:00.000Z',
      channels: [{
        channel: 'api',
        userId: 'operator-1',
        privacyLevel: 'private',
      }],
    } as Contact;

    const handlers = new AdminHandlers({
      memoryStore: {
        listContactProfiles: vi.fn(() => []),
        getContactProfile: vi.fn(() => undefined),
      } as unknown as MemoryStore,
      sessionStore: {
        listChannels: vi.fn(() => [{
          channelId: 'api:session-1',
          messageCount: 4,
        }]),
        getLastEntry: vi.fn(() => ({
          id: 1,
          channelId: 'api:session-1',
          role: 'user',
          content: 'hello',
          authorId: 'operator-1',
          timestamp: Date.now(),
        })),
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
        getByChannelIdentity: vi.fn((channel: string, userId: string) => (
          channel === 'api' && userId === 'operator-1' ? contact : undefined
        )),
      } as unknown as ContactStore,
    });

    const html = handlers.sessionList();
    expect(html).toContain('API · session-1');
    expect(html).toContain('Contact:');
    expect(html).toContain('Operator One');
    expect(html).toContain('/contacts#contact-row-contact-operator');
  });
});
