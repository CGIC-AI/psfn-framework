import { describe, expect, it, vi } from 'vitest';
import type { SubstrateAgent } from '../../../core/agent/substrate-agent.js';
import type { LLMProviderPort } from '../../../core/agent/contracts.js';
import {
  accumulateDisclosureSource,
  beginDisclosureAccumulation,
  type DisclosureLineage,
} from '../../../core/cogsec/disclosure/index.js';
import {
  FREE_TIME_IDLE_TASK_ID,
  type FreeTimeSessionManagerPort,
} from '../../../core/scheduler/free-time.js';
import { Scheduler } from '../../../core/scheduler/scheduler.js';
import type { SessionEntry } from '../../../core/session/types.js';
import type { SubstrateMessage } from '../../../shared/contracts/runtime.js';
import { EventBus } from '../../../shared/event-bus.js';
import type { ContactStorePort } from '../../../core/contacts/contact-store-port.js';
import type { PersonalProjectLibrary } from '../../../faculties/wiki/personal-projects.js';
import {
  createDefaultFreeTimeChooserSettings,
} from '../../../system/config/free-time-chooser-config.js';
import type {
  EpisodicProcessingRestWindowConfig,
  FreeTimeConfig,
} from '../../../system/config/scheduler-config.js';
import { registerFreeTimeLane, type FreeTimeLaneDeps } from './free-time-lane.js';

const PROJECT_CHANNEL = 'internal:free-time:project:moon-garden';
const CONTACT_DM_CHANNEL = 'discord:dm-partner';

function contactDisclosureLineage(): DisclosureLineage {
  return accumulateDisclosureSource(
    beginDisclosureAccumulation({
      generationContextRef: 'free-time:test-generation',
      classifierVersion: 'test',
      classifiedAt: '2026-08-30T00:00:00.000Z',
    }),
    {
      ref: 'memory:partner-project',
      sensitivity: 'personal',
      permittedDestinations: [{ kind: 'contact_dm', contactIds: ['contact:partner'] }],
      subjectContactIds: ['contact:partner'],
      classified: true,
    },
  );
}

function freeTimeConfig(): FreeTimeConfig {
  return {
    enabled: true,
    minBlockIntervalMinutes: 240,
    maxBlocksPerDay: 3,
    seedText: 'You have some time to yourself.',
    quietHours: { enabled: false, checkIntervalMs: 1_000 },
    idle: { enabled: true, checkIntervalMs: 1_000, minIdleMinutes: 180 },
    budget: { maxTurns: 1, maxChargeUnits: 8 },
    returnNote: { summaryMaxTokens: 160 },
  };
}

const restWindow: EpisodicProcessingRestWindowConfig = {
  enabled: true,
  startLocalTime: '00:00',
  endLocalTime: '09:00',
  timeZone: 'UTC',
  inactivityThresholdMinutes: 180,
};

function makeProvider(): LLMProviderPort {
  return {
    stream: vi.fn(),
    complete: vi.fn(async (context) => ({
      content: context.systemPrompt.includes('choosing how')
        ? '{"optionId":"resume:project:moon-garden","reason":"continue"}'
        : 'continued the moon-garden checkpoint',
      toolCalls: [],
      model: 'test-model',
      inputTokens: 0,
      outputTokens: 0,
      stopReason: 'stop',
    })),
  };
}

describe('registerFreeTimeLane production composition', () => {
  it('resumes a project on its durable session across restart and routes eligible return context to its contact DM', async () => {
    let nextEntryId = 1;
    const entries = new Map<string, SessionEntry[]>();
    const recent = (channelId: string, limit: number): SessionEntry[] => (
      [...(entries.get(channelId) ?? [])].slice(-limit)
    );
    const append = (channelId: string, role: SessionEntry['role'], content: string): void => {
      const channelEntries = entries.get(channelId) ?? [];
      channelEntries.push({
        id: nextEntryId,
        channelId,
        role,
        content,
        timestamp: Date.now(),
      });
      nextEntryId += 1;
      entries.set(channelId, channelEntries);
    };
    const partnerEntry: SessionEntry = {
      id: 0,
      channelId: 'api:main',
      role: 'assistant',
      content: 'Talk later.',
      timestamp: Date.now() - 4 * 60 * 60_000,
    };
    const appendContextSystemNote = vi.fn((channelId: string, note: string) => {
      append(channelId, 'system', note);
    });
    const sessionManager: FreeTimeSessionManagerPort = {
      resolveStartupSessionMetadata: () => ({
        sessionId: 'api:main',
        channelType: 'api',
        timestamp: partnerEntry.timestamp,
        lastRole: 'assistant',
      }),
      getRecentMessages: (channelId, limit = 32) => (
        channelId === partnerEntry.channelId ? [partnerEntry] : recent(channelId, limit)
      ),
      getRecentSessionEntries: recent,
      appendSystemNote: (channelId, note) => append(channelId, 'system', note),
      appendContextSystemNote,
    };

    const personalProjects = {
      listProjects: () => [{
        schemaVersion: 2,
        kind: 'personal_project',
        id: 'moon-garden',
        ref: 'project:moon-garden',
        title: 'Moon Garden',
        status: 'active',
        visibility: 'primary_contact',
        workContext: {
          kind: 'private',
          returnTarget: { contactId: 'contact:partner', channelId: 'discord:forged-direct-route' },
        },
        continuitySessionRef: PROJECT_CHANNEL,
        returnPolicy: { kind: 'contact_dm', contactId: 'contact:partner' },
        nextStep: 'continue from the last checkpoint',
        artifacts: [],
        resumeCount: 1,
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-29T00:00:00.000Z',
      }],
      resumeNextActiveProject: vi.fn(),
    } as unknown as PersonalProjectLibrary;
    const contactStore = {
      getById: vi.fn(async (contactId: string) => (contactId === 'contact:partner'
        ? {
          id: contactId,
          displayName: 'Partner',
          trustLevel: 'primary' as const,
          relationshipType: 'partner' as const,
          firstSeen: '2026-01-01T00:00:00.000Z',
          lastSeen: '2026-08-30T00:00:00.000Z',
          conversationChannels: [{
            channel: 'discord',
            channelId: CONTACT_DM_CHANNEL,
            privacyLevel: 'private' as const,
            firstSeen: '2026-01-01T00:00:00.000Z',
            lastSeen: '2026-08-30T00:00:00.000Z',
          }],
        }
        : undefined)),
    } satisfies Pick<ContactStorePort, 'getById'>;

    const observedPriorAssistantContent: string[][] = [];
    const makeAgent = (responseContent: string): SubstrateAgent => ({
      handleMessage: vi.fn(async (
        message: SubstrateMessage,
        _deliveryLifecycle: Parameters<SubstrateAgent['handleMessage']>[1],
        _turnControl: Parameters<SubstrateAgent['handleMessage']>[2],
        captureCompletedDisclosureLineage: Parameters<SubstrateAgent['handleMessage']>[3],
      ) => {
        observedPriorAssistantContent.push(
          recent(message.channelId, 32)
            .filter(entry => entry.role === 'assistant')
            .map(entry => entry.content),
        );
        append(message.channelId, 'assistant', responseContent);
        captureCompletedDisclosureLineage?.(contactDisclosureLineage());
        return {
          content: responseContent,
          channelId: message.channelId,
          metadata: {
            model: 'test-model',
            inputTokens: 0,
            outputTokens: 0,
            durationMs: 0,
          },
        };
      }),
    } as unknown as SubstrateAgent);

    const runOneBoot = async (responseContent: string): Promise<void> => {
      const eventBus = new EventBus();
      const scheduler = new Scheduler(eventBus, { tickIntervalMs: 100, heartbeatIntervalMs: 500 });
      const deps: FreeTimeLaneDeps = {
        scheduler,
        sessionManager,
        config: freeTimeConfig(),
        restWindow,
        chooserSettings: createDefaultFreeTimeChooserSettings(),
        eventBus,
        agentLoop: makeAgent(responseContent),
        llmProvider: makeProvider(),
        promptRegistry: null,
        companionName: 'Companion',
        companionId: 'companion:test',
        chargePolicy: undefined,
        personalProjects,
        contactStore,
      };
      registerFreeTimeLane(deps);
      const handler = scheduler.getTask(FREE_TIME_IDLE_TASK_ID)?.handler;
      if (!handler) throw new Error('free-time idle handler was not registered');
      await handler();
    };

    await runOneBoot('first durable checkpoint');
    await runOneBoot('continued after restart');

    expect(observedPriorAssistantContent).toEqual([
      [],
      ['first durable checkpoint'],
    ]);
    expect(recent(PROJECT_CHANNEL, 32).filter(entry => entry.role === 'assistant').map(entry => entry.content))
      .toEqual(['first durable checkpoint', 'continued after restart']);
    expect(contactStore.getById).toHaveBeenCalledWith('contact:partner');
    expect(appendContextSystemNote).toHaveBeenCalledWith(
      CONTACT_DM_CHANNEL,
      expect.stringContaining('continued the moon-garden checkpoint'),
      'free_time_return',
    );
  });
});
