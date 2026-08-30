// ── Free-time lanes (E8.1) ──
// Self-directed time, extracted from agent/main.ts (charter 12.1 god-file
// split, emh3p.1). Two entry lanes (quiet-hours inside the rest window; idle
// after a long partner gap) share one bounded, budget-capped, multi-turn
// agent-loop block on an INTERNAL channel. The ordinary default prompt stack
// supplies identity and policy; her normal tools apply and outputs are
// durable only. Deterministic gates run before any spend; the block runs
// inside a 'background' charge context and ends gracefully when the per-block
// turn/charge budget is exhausted. After a block WITH activity, a "while you
// were away" note is placed on the partner session via the shared summarizer;
// empty "loafed" blocks surface nothing.

import type { SubstrateAgent } from '../../../core/agent/substrate-agent.js';
import type { LLMProviderPort } from '../../../core/agent/contracts.js';
import type { ContactStorePort } from '../../../core/contacts/contact-store-port.js';
import type { Contact } from '../../../core/contacts/types.js';
import type { DisclosureLineage } from '../../../core/cogsec/disclosure/index.js';
import { deriveConversationScopeEnvelope } from '../../../core/session/conversation-scope.js';
import type { SessionEntry } from '../../../core/session/types.js';
import { summarizeRecentSessionEntries } from '../../../core/session/manager/compaction-service.js';
import {
  freeTimeWorkspaceChannelId,
  registerFreeTimeTasks,
  type FreeTimeRuntimeOptions,
} from '../../../core/scheduler/free-time.js';
import {
  FreeTimeWorkspaceResolver,
  type FreeTimeProjectRecord,
  type FreeTimeWorkspaceContext,
  type FreeTimeWorkspace,
} from '../../../core/scheduler/free-time-workspace-resolver.js';
import {
  FreeTimeChooser,
  createFreeTimeRoomChannelResolver,
  type FreeTimeProjectSummary,
} from '../../../core/scheduler/free-time-chooser.js';
import { InMemoryRestWindowPolicy } from '../../../core/scheduler/rest-window-policy.js';
import type { PromptRegistryStatePort } from '../../../core/identity/prompt-state-port.js';
import type { PersonalProjectLibrary, PersonalProjectWorkContext } from '../../../faculties/wiki/personal-projects.js';
import type { EventBus } from '../../../shared/event-bus.js';
import { createComponentLogger } from '../../../shared/logger.js';
import type { ChargePolicyConfig } from '../../../shared/contracts/charge-policy.js';
import { getRunChargeSnapshot, runWithChargeContext } from '../../../shared/telemetry/run-charge.js';
import { getRequestContext } from '../../../primitives/llm/request-context.js';
import { getVisibilityDisclosureCeiling } from '../../../system/trust/policy.js';
import type { SchedulerRuntimeConfig as SchedulerConfig } from '../../../system/config/scheduler-config.js';

export interface FreeTimeLaneDeps {
  scheduler: FreeTimeRuntimeOptions['scheduler'];
  sessionManager: FreeTimeRuntimeOptions['sessionManager'];
  config: FreeTimeRuntimeOptions['config'];
  restWindow: FreeTimeRuntimeOptions['restWindow'];
  chooserSettings: SchedulerConfig['socialAutonomy']['freeTimeChooser'];
  eventBus: EventBus;
  agentLoop: SubstrateAgent;
  llmProvider: LLMProviderPort;
  promptRegistry: PromptRegistryStatePort | null;
  companionName: string;
  companionId: string | undefined;
  chargePolicy: ChargePolicyConfig | undefined;
  personalProjects: PersonalProjectLibrary;
  contactStore: Pick<ContactStorePort, 'getById'>;
}

const log = createComponentLogger('FreeTimeLane');

function sessionEntryLineageKey(entry: Pick<SessionEntry, 'channelId' | 'id'>): string {
  return `${entry.channelId}:${entry.id}`;
}

function mostRecentPrivateConversationChannel(contact: Contact | undefined): string | null {
  if (!contact || contact.archivedAt) return null;
  const candidates = (contact.conversationChannels ?? [])
    .filter(channel => channel.privacyLevel === 'private' && channel.channelId.trim().length > 0)
    .map(channel => ({
      channelId: channel.channelId.trim(),
      lastSeenMs: Date.parse(channel.lastSeen),
    }))
    .filter(channel => Number.isFinite(channel.lastSeenMs))
    .sort((left, right) => (
      right.lastSeenMs - left.lastSeenMs || left.channelId.localeCompare(right.channelId)
    ));
  return candidates[0]?.channelId ?? null;
}

async function resolveWorkspaceContactDmSession(
  workspace: FreeTimeWorkspace,
  contactStore: Pick<ContactStorePort, 'getById'>,
): Promise<{ contactId: string; sessionId: string } | null> {
  if (workspace.returnPolicy.kind !== 'contact_dm') return null;
  const contactId = workspace.returnPolicy.contactId;
  const sessionId = mostRecentPrivateConversationChannel(await contactStore.getById(contactId));
  return sessionId ? { contactId, sessionId } : null;
}

export function registerFreeTimeLane(deps: FreeTimeLaneDeps): void {
  const {
    scheduler,
    sessionManager,
    config,
    restWindow,
    chooserSettings,
    eventBus,
    agentLoop,
    llmProvider,
    promptRegistry,
    companionName,
    companionId,
    chargePolicy,
    personalProjects,
    contactStore,
  } = deps;

  let selectedWorkspace: FreeTimeWorkspace | undefined;
  let selectedContactDmSession: { contactId: string; sessionId: string } | null = null;
  const entryDisclosureLineage = new Map<string, DisclosureLineage>();

  // Companion free-time chooser (jp36.2.1.2): supersedes the LRU auto-select.
  // The companion picks rest / private wander / resume / create through ONE
  // cheap background call; rest ends the block with no free-time turn and
  // persists silence so she is not re-prompted this quiet period. The
  // roomChannelResolver sources its disclosure ceiling from
  // getVisibilityDisclosureCeiling (the resolver's documented port obligation),
  // and public_room retrieval is clamped to 'public' inside the resolver. v1
  // personal projects are private-only, so today's live menu is rest / private
  // wander / resume(private); the manifest-v2 room/publication binding and the
  // lane→continuity-session merge are jp36.2.4 / jp36.2.2.
  const freeTimeRoomChannelResolver = createFreeTimeRoomChannelResolver(
    (channelId) => deriveConversationScopeEnvelope({
      channelId,
      kind: 'group',
      // Fail-closed roster: a project-bound room resolved outside a live
      // conversation has no roster snapshot; the conservative envelope holds
      // until jp36.2.4 supplies the manifest-v2 room binding.
      recentSpeakerCount: 0,
    }),
    getVisibilityDisclosureCeiling,
  );
  // Map a manifest-v2 durable work context (faculties/wiki) onto the resolver's
  // structurally-identical FreeTimeWorkspaceContext (jp36.2.4 seam). Explicit
  // per-kind reconstruction keeps optional fields honest under
  // exactOptionalPropertyTypes and localizes the cross-module shape coupling.
  const toFreeTimeWorkspaceContext = (
    workContext: PersonalProjectWorkContext,
  ): FreeTimeWorkspaceContext => {
    switch (workContext.kind) {
      case 'private':
        return workContext.returnTarget
          ? { kind: 'private', returnTarget: workContext.returnTarget }
          : { kind: 'private' };
      case 'room':
        return { kind: 'room', channelId: workContext.channelId };
      case 'publication':
        return workContext.surfaceRef
          ? { kind: 'publication', mode: workContext.mode, surfaceRef: workContext.surfaceRef }
          : { kind: 'publication', mode: workContext.mode };
      default: {
        const unknown = workContext as { kind?: unknown };
        throw new Error(`unknown personal-project work-context kind: ${String(unknown.kind)}`);
      }
    }
  };
  const workContextLabel = (workContext: PersonalProjectWorkContext): string => {
    switch (workContext.kind) {
      case 'private':
        return 'private';
      case 'room':
        return 'room';
      case 'publication':
        return workContext.mode === 'public_clean' ? 'publication' : 'publication review draft';
      default:
        return 'private';
    }
  };
  const freeTimeResolver = new FreeTimeWorkspaceResolver({
    projectDirectory: (projectRef: string): FreeTimeProjectRecord | null => {
      const normalizedRef = projectRef.startsWith('project:') ? projectRef : `project:${projectRef}`;
      const match = personalProjects.listProjects().find(project => project.ref === normalizedRef);
      // Unknown ref → null so the resolver fails closed on it. A known project
      // serves its durable manifest-v2 work context (jp36.2.4); v1 manifests were
      // upgraded to a private context on read, so resume inherits without a
      // reclassification prompt (bible §10.1/§10.5).
      return match
        ? { projectRef: match.ref, workspace: toFreeTimeWorkspaceContext(match.workContext) }
        : null;
    },
    roomChannelResolver: freeTimeRoomChannelResolver,
  });
  const freeTimeRestWindowPolicy = new InMemoryRestWindowPolicy();
  const freeTimeChooser = new FreeTimeChooser({
    llmProvider,
    resolver: freeTimeResolver,
    restWindowPolicy: freeTimeRestWindowPolicy,
    listResumableProjects: (): FreeTimeProjectSummary[] => personalProjects.listProjects()
      .filter(project => project.status === 'active')
      .map(project => ({
        projectRef: project.ref,
        title: project.title,
        workContextLabel: workContextLabel(project.workContext),
        focusHint: project.nextStep,
      })),
    companionName,
    // Free-time chooser tunables (incl. the rest / silence-persistence window)
    // are owned by scheduler.json socialAutonomy.freeTimeChooser (jp36.8.2).
    settings: chooserSettings,
    ...(companionId ? { companionId } : {}),
  });
  registerFreeTimeTasks({
    scheduler,
    sessionManager,
    config,
    restWindow,
    eventBus,
    // The whole block runs inside a 'background' charge context so per-turn LLM
    // spend accumulates against the background lane; getRunChargeSnapshot lets
    // the runner read cumulative spend before each turn for the hard cap.
    runBlock: ({ run }) => {
      if (!chargePolicy) {
        // No charge policy → run with a zero reader; the turn cap still bounds.
        return run(() => 0);
      }
      return runWithChargeContext({
        chargePolicy,
        eventBus,
        lane: 'background',
        correlation: getRequestContext(),
      }, () => run(() => getRunChargeSnapshot()?.spentByLane.background ?? 0));
    },
    // One free-time turn through the ordinary agent loop on the internal
    // channel. Internal channelId => isInternalSessionId() true => the loop
    // cannot dispatch outward to a partner channel. The default identity stack
    // and her normal tools apply (no restricted reflection policy). A "silent"
    // reply ends the block; staying quiet / loafing is a valid outcome.
    invokeTurn: async ({ lane, channelId, turnIndex, content }) => {
      if (turnIndex === 0) entryDisclosureLineage.clear();
      const messageId = `free-time-${lane}-${turnIndex}-${Date.now()}`;
      let completedDisclosureLineage: DisclosureLineage | undefined;
      const response = await agentLoop.handleMessage(
        {
          id: messageId,
          channelId,
          channelType: 'terminal',
          authorId: 'scheduler',
          authorName: 'Free Time',
          content,
          timestamp: new Date(),
        },
        undefined,
        undefined,
        lineage => { completedDisclosureLineage = lineage; },
      );
      if (completedDisclosureLineage) {
        const recentEntries = sessionManager.getRecentSessionEntries
          ? sessionManager.getRecentSessionEntries(channelId, 8)
          : sessionManager.getRecentMessages(channelId, 8);
        const assistantEntry = [...recentEntries]
          .reverse()
          .find(entry => entry.role === 'assistant');
        if (assistantEntry) {
          entryDisclosureLineage.set(
            sessionEntryLineageKey(assistantEntry),
            completedDisclosureLineage,
          );
        }
      }
      return { content: response.content };
    },
    // Shared summarizer, free-time lane identity: distinct purpose/originStage
    // ('free_time_return') and a freeTime-owned token budget — never borrowed
    // from the morning-wake catch-up lane.
    summarizeActivity: async ({ channelId, entries }) => summarizeRecentSessionEntries({
      channelId,
      entries,
      characterName: companionName,
      llmProvider,
      promptRegistry,
      maxTokens: config.returnNote.summaryMaxTokens,
      purpose: 'free_time_return',
    }),
    loadProjectContext: async () => (
      await personalProjects.resumeNextActiveProject()
    )?.context ?? null,
    // Companion chooser drives rest / workspace selection; rest persists silence
    // for the quiet period (fails closed to rest, never a forced workspace).
    chooseWorkspace: async ({ lane, nowMs }) => {
      selectedWorkspace = undefined;
      selectedContactDmSession = null;
      const outcome = await freeTimeChooser.chooseWorkspace({ lane, nowMs });
      if (outcome.kind === 'workspace') {
        selectedWorkspace = outcome.workspace;
        try {
          selectedContactDmSession = await resolveWorkspaceContactDmSession(
            outcome.workspace,
            contactStore,
          );
        } catch (error) {
          log.warn('Free-time contact-DM resolution failed closed', {
            error: String(error),
          });
        }
      }
      return outcome;
    },
    resolveWorkspaceChannelId: () => selectedWorkspace?.sessionId ?? freeTimeWorkspaceChannelId(),
    resolveContactDmSessionId: (contactId) => (
      selectedContactDmSession?.contactId === contactId
        ? selectedContactDmSession.sessionId
        : null
    ),
    resolveEntryDisclosureLineage: (entry) => entryDisclosureLineage.get(sessionEntryLineageKey(entry)),
  });
}
