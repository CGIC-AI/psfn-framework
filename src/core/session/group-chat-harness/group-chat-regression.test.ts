/**
 * Group-chat prompt-shape regression harness.
 *
 * Purpose: make upcoming group-chat and prompt-pipeline changes PROVABLE.
 * Every group-chat bug so far was found by eyeballing live prompts; this suite
 * encodes those defects against synthetic, live-shaped fixtures so they cannot
 * silently regress and so a later fix wave can flip them to passing.
 *
 * This harness targets PROMPT SHAPE, not retrieval quality.
 *
 * Known defects are encoded with `it.fails(...)`: the suite is GREEN today, and
 * each `it.fails` becomes a real failure (forcing conversion to `it`) the moment
 * the underlying behavior is fixed. Genuine `it(...)` cases assert behavior that
 * is already correct on this base (group history attribution, room-scoped core
 * memory, conversation_state, and room-visibility memory gating) and guard it
 * against regression.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { injectPromptRuntimeTokens } from '../../identity/prompt-runtime.js';
import { hydrateStartupActiveCoreMemoryBlocks } from '../../../faculties/core-memory/startup-hydration.js';
import type { ContactStorePort } from '../../contacts/contact-store-port.js';
import { MemoryRetriever } from '../../../faculties/memory/retrieval.js';
import type { MemoryScopeQuery } from '../../../faculties/memory/types.js';
import {
  expectAttributedHistory,
  expectBlock,
  expectBlockScope,
  expectMemoryPresent,
  expectNoBlock,
  expectNoMemoryFrom,
  expectParticipantContextBinding,
  expectUnattributedHistory,
} from './assertions.js';
import {
  ALICE,
  BOB,
  CAROL,
  DANA,
  GROUP_ROOM_ID,
  MEMORY_SENTINELS,
  NOVA,
  OTHER_ROOM_ID,
  buildDmWithGuestSession,
  buildGroupChatSession,
  restartGroupChatSession,
  conversationScope,
  dmChannelId,
  makeDmTurnMessage,
  makeEmbeddingProvider,
  makeGroupRoomRecentEntries,
  makeGroupTurnMessage,
  makeLeakProbeContactStore,
  makeLeakProbeMemories,
  makeLeakProbeStore,
  renderTurnRuntimePrompt,
  stableAttributionId,
} from './fixtures.js';

function newRetriever(withContacts = false) {
  return new MemoryRetriever(
    makeLeakProbeStore(makeLeakProbeMemories()),
    makeEmbeddingProvider(),
    { retrievalLimit: 20 },
    undefined,
    withContacts ? (makeLeakProbeContactStore() as unknown as ContactStorePort) : undefined,
  );
}

const ROOM_ONLY_SCOPE: MemoryScopeQuery = {
  refs: [conversationScope(GROUP_ROOM_ID)],
  mode: 'only',
};

describe('group-chat regression harness', () => {
  // -------------------------------------------------------------------------
  // speaking_with scope. On this base the canonical seed template
  // (config/runtime-prompt-layers.seed.json) no longer contains a
  // <speaking_with> block -- conversation_state replaced it. The residual
  // KNOWN BUG is that runtime_speaking_with_* tokens still populate on group
  // turns (buildDynamicPromptTemplateVariables gates them only on internal
  // turns), so any persisted or custom prompt layer that still references
  // those tokens re-renders a one-on-one binding inside a multi-human room.
  // -------------------------------------------------------------------------
  const LEGACY_SPEAKING_WITH_LAYER = '<speaking_with>\n<name>{{runtime_speaking_with_name}}</name>\n<trust_level>{{runtime_speaking_with_trust_level}}</trust_level>\n</speaking_with>';

  describe('speaking_with block scope', () => {
    it('does not render a speaking_with block from the default template (replaced by conversation_state)', () => {
      const dm = renderTurnRuntimePrompt(makeDmTurnMessage(ALICE), ALICE, 'api');
      expectNoBlock(dm.prompt, 'speaking_with');
      // The one-on-one identity now surfaces via conversation_state instead.
      expect(dm.prompt).toContain(`name="${ALICE.name}"`);
      expect(dm.prompt).toContain('trust="trusted"');

      const group = renderTurnRuntimePrompt(
        makeGroupTurnMessage(CAROL),
        CAROL,
        'api',
        { recentChannelEntries: makeGroupRoomRecentEntries() },
      );
      expectNoBlock(group.prompt, 'speaking_with');
    });

    // KNOWN BUG: flip to `it(...)` once group turns blank the speaking_with
    // tokens (as internal turns already do), so persisted legacy layers prune.
    it.fails('leaves speaking_with tokens empty on multi-human group turns', () => {
      const { variables } = renderTurnRuntimePrompt(
        makeGroupTurnMessage(CAROL),
        CAROL,
        'api',
        { recentChannelEntries: makeGroupRoomRecentEntries() },
      );
      expect(variables.runtime_speaking_with_name).toBe('');
      expect(variables.runtime_speaking_with_trust_level).toBe('');
    });

    // KNOWN BUG (same root cause, prompt-shape manifestation): a persisted
    // legacy prompt layer that still carries the speaking_with section renders
    // it on group turns bound to the most-recent speaker.
    it.fails('prunes a legacy speaking_with prompt layer on multi-human group turns', () => {
      const { variables } = renderTurnRuntimePrompt(
        makeGroupTurnMessage(CAROL),
        CAROL,
        'api',
        { recentChannelEntries: makeGroupRoomRecentEntries() },
      );
      const rendered = injectPromptRuntimeTokens(LEGACY_SPEAKING_WITH_LAYER, { variables });
      expectNoBlock(rendered, 'speaking_with');
    });

    it('keeps speaking_with tokens populated for genuine one-on-one DM turns (correct)', () => {
      const { variables } = renderTurnRuntimePrompt(makeDmTurnMessage(ALICE), ALICE, 'api');
      expect(variables.runtime_speaking_with_name).toBe(ALICE.name);
      expect(variables.runtime_speaking_with_trust_level).toBe(ALICE.trustLevel);
    });

    it('renders group-aware conversation_state on group turns (correct)', () => {
      const { prompt, variables } = renderTurnRuntimePrompt(
        makeGroupTurnMessage(CAROL),
        CAROL,
        'api',
        { recentChannelEntries: makeGroupRoomRecentEntries() },
      );
      expectBlock(prompt, 'conversation_state');
      expect(variables.runtime_chat_type).toBe('group');
      expect(variables.runtime_room_id).toBe(GROUP_ROOM_ID);
      expect(variables.runtime_current_message_author_name).toBe(CAROL.name);
      // All room members (including the peer companion) appear in the
      // recent-active-participants roster; the non-member never does.
      for (const member of [ALICE, BOB, CAROL, NOVA]) {
        expect(variables.runtime_recent_active_participants_xml).toContain(`id="${member.authorId}"`);
      }
      expect(variables.runtime_recent_active_participants_xml).not.toContain(DANA.name);
      expect(variables.runtime_recent_active_participants_xml).not.toContain(DANA.authorId);
    });

    it('renders direct_message conversation_state without a participant roster on DM turns (correct)', () => {
      const { variables } = renderTurnRuntimePrompt(makeDmTurnMessage(ALICE), ALICE, 'api');
      expect(variables.runtime_chat_type).toBe('direct_message');
      expect(variables.runtime_recent_active_participants_xml).toBe('');
    });
  });

  // -------------------------------------------------------------------------
  // Core memory participant binding, via the REAL path:
  // SessionManager.buildContext -> buildCoreMemoryFormatContext -> scoped
  // CoreMemoryStore.formatForContext.
  // -------------------------------------------------------------------------
  describe('core memory scope and participant binding', () => {
    let dir: string;
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'psfn-group-harness-core-')); });
    afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

    it('renders room-scoped core memory (room_context, no single-human binding) on group rooms (correct)', async () => {
      const { manager } = buildGroupChatSession(dir);
      const context = await manager.buildContext(
        GROUP_ROOM_ID,
        'System prompt',
        '',
        undefined,
        CAROL.authorId,
        { isDirectMessage: false },
      );
      expectBlock(context.systemPrompt, 'core_memory');
      expectBlockScope(context.systemPrompt, 'core_memory', GROUP_ROOM_ID);
      expectBlock(context.systemPrompt, 'room_context');
      expectNoBlock(context.systemPrompt, 'participant_context');
    });

    it('binds DM core memory participant_context to the DM partner on a clean DM (correct)', async () => {
      const { manager } = buildGroupChatSession(dir);
      const context = await manager.buildContext(
        dmChannelId(ALICE),
        'System prompt',
        '',
        undefined,
        ALICE.authorId,
        { isDirectMessage: true },
      );
      expectBlockScope(context.systemPrompt, 'core_memory', dmChannelId(ALICE));
      expectParticipantContextBinding(context.systemPrompt, {
        name: ALICE.name,
        id: ALICE.authorId,
      });
    });

    // FIXED (E1.2): buildCoreMemoryFormatContext now binds the DM
    // participant_context to the canonical contact from the resolved
    // ConversationScope, not to recentParticipants[0]. A relayed guest line
    // landing first in the DM window no longer flips the subject binding.
    it('binds DM core memory to the canonical partner even when a guest line appears in the window', async () => {
      const { manager } = buildDmWithGuestSession(dir);
      const context = await manager.buildContext(
        dmChannelId(ALICE),
        'System prompt',
        '',
        undefined,
        ALICE.authorId,
        { isDirectMessage: true },
      );
      expectParticipantContextBinding(context.systemPrompt, { name: ALICE.name, id: ALICE.authorId });
    });

    // AC1 (E1.2): in the 3-human room fixture, the core-memory subject binding
    // stays stable as the speaker changes across consecutive turns. Content may
    // evolve, but the binding (room-scoped, never a single-person block) must
    // not flip to follow whoever spoke last.
    it('keeps the group core-memory binding stable across speaker changes on 3 consecutive turns', async () => {
      const { manager } = buildGroupChatSession(dir);
      const openTags: string[] = [];
      for (const speaker of [ALICE, BOB, CAROL]) {
        const context = await manager.buildContext(
          GROUP_ROOM_ID,
          'System prompt',
          '',
          undefined,
          speaker.authorId,
          { isDirectMessage: false },
        );
        expectBlockScope(context.systemPrompt, 'core_memory', GROUP_ROOM_ID);
        expectBlock(context.systemPrompt, 'room_context');
        // Never a single-person binding, regardless of who spoke this turn.
        expectNoBlock(context.systemPrompt, 'participant_context');
        const match = /<room_context[^>]*>/u.exec(context.systemPrompt);
        expect(match).not.toBeNull();
        openTags.push(match?.[0] ?? '');
        // The room-summary binding never carries the current speaker's identity.
        expect(match?.[0]).not.toContain(speaker.authorId);
      }
      // The subject binding is byte-identical across all three speaker turns.
      expect(openTags[0]).toBe(openTags[1]);
      expect(openTags[1]).toBe(openTags[2]);
    });

    // AC4 (E1.2): after a simulated cold restart (fresh SessionManager +
    // CoreMemoryStore over the same on-disk companion-data, no async memory yet)
    // startup hydration warms the recently active channels, and the first
    // post-restart context build carries the persisted scoped block.
    it('hydrates scoped core-memory blocks for recently active channels after a restart', async () => {
      // Seed activity + persist scoped core memory to disk, then discard.
      buildGroupChatSession(dir);

      const { manager } = restartGroupChatSession(dir);
      const result = hydrateStartupActiveCoreMemoryBlocks({ sessionManager: manager });
      expect(result.hydrated).toBeGreaterThan(0);
      expect(result.channels.some(channel => channel.channelId === GROUP_ROOM_ID && channel.hasContent))
        .toBe(true);

      const context = await manager.buildContext(
        GROUP_ROOM_ID,
        'System prompt',
        '',
        undefined,
        CAROL.authorId,
        { isDirectMessage: false },
      );
      expectBlock(context.systemPrompt, 'core_memory');
      expectBlock(context.systemPrompt, 'room_context');
      expect(context.systemPrompt).toContain('coordinating an offsite');
    });
  });

  // -------------------------------------------------------------------------
  // Group history attribution: on this base group user turns are rendered
  // with "Name (source:id):" prefixes (entry-attribution.ts
  // formatGroupUserMessageContent). These are regression guards.
  // -------------------------------------------------------------------------
  describe('group history attribution', () => {
    let dir: string;
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'psfn-group-harness-hist-')); });
    afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

    it('attributes every human and peer-companion turn in group history with a "Name (id):" prefix', async () => {
      const { manager } = buildGroupChatSession(dir);
      const context = await manager.buildContext(
        GROUP_ROOM_ID,
        'System prompt',
        '',
        undefined,
        CAROL.authorId,
        { isDirectMessage: false },
      );
      expectAttributedHistory(context.messages, [ALICE, BOB, CAROL, NOVA].map(member => ({
        name: member.name,
        id: stableAttributionId(GROUP_ROOM_ID, member.authorId),
      })));
    });

    it('keeps one-on-one DM history unattributed (correct)', async () => {
      const { manager } = buildGroupChatSession(dir);
      const context = await manager.buildContext(
        dmChannelId(ALICE),
        'System prompt',
        '',
        undefined,
        ALICE.authorId,
        { isDirectMessage: true },
      );
      expectUnattributedHistory(context.messages, [{
        name: ALICE.name,
        id: stableAttributionId(dmChannelId(ALICE), ALICE.authorId),
      }]);
    });
  });

  // -------------------------------------------------------------------------
  // Leak probes: real MemoryRetriever.retrieve path (no mocked prompt output).
  // The room-visibility gate (evaluateRoomVisibilityDecision) runs inside the
  // real retrieval pipeline; canonicalContactRoomIds membership comes from the
  // synthetic contact fixtures. If any of these FAIL, that is a live memory
  // leak in the retrieval path -- treat it as P0, do not weaken the test.
  // -------------------------------------------------------------------------
  describe('cross-scope memory leak probes (real retrieval path)', () => {
    it('DM -> room: DM-only memory does not appear in a room prompt', async () => {
      const output = await newRetriever().retrieve(
        'What is the plan for the townsquare offsite?',
        GROUP_ROOM_ID,
        'trusted',
        { isDirectMessage: false },
      );
      expectNoMemoryFrom(output, dmChannelId(ALICE), [MEMORY_SENTINELS.dmAlice]);
      expectMemoryPresent(output, [MEMORY_SENTINELS.roomTownsquare]);
    });

    it('room -> other-room: room-B memory does not appear in a room-A prompt', async () => {
      const output = await newRetriever().retrieve(
        'What is the plan for the townsquare offsite?',
        GROUP_ROOM_ID,
        'trusted',
        { isDirectMessage: false },
      );
      expectNoMemoryFrom(output, OTHER_ROOM_ID, [MEMORY_SENTINELS.roomBackchannel]);
    });

    it('room -> DM of non-member: room memory does not appear in the non-member\'s DM', async () => {
      const output = await newRetriever(true).retrieve(
        'Catch me up before my one-on-one.',
        dmChannelId(DANA),
        'trusted',
        { isDirectMessage: true },
        DANA.id,
      );
      expectNoMemoryFrom(output, GROUP_ROOM_ID, [MEMORY_SENTINELS.roomTownsquare]);
      expectNoMemoryFrom(output, OTHER_ROOM_ID, [MEMORY_SENTINELS.roomBackchannel]);
      expectMemoryPresent(output, [MEMORY_SENTINELS.dmDanaNonMember]);
    });

    it('room -> DM of member: shared-room memory remains recallable in a member\'s DM (correct)', async () => {
      const output = await newRetriever(true).retrieve(
        'What did the group decide about the offsite?',
        dmChannelId(ALICE),
        'trusted',
        { isDirectMessage: true },
        ALICE.id,
      );
      expectMemoryPresent(output, [MEMORY_SENTINELS.roomTownsquare]);
      expectNoMemoryFrom(output, OTHER_ROOM_ID, [MEMORY_SENTINELS.roomBackchannel]);
      expectNoMemoryFrom(output, dmChannelId(DANA), [MEMORY_SENTINELS.dmDanaNonMember]);
    });
  });

  // -------------------------------------------------------------------------
  // Mechanism proof: retrieval scoped to the room (mode: 'only') isolates on
  // the scope-query axis as well.
  // -------------------------------------------------------------------------
  describe('cross-scope isolation when retrieval is room-scoped (mode: only)', () => {
    it('keeps in-room memory and drops all foreign-scope memory', async () => {
      const output = await newRetriever().retrieve(
        'What is the plan for the townsquare offsite?',
        GROUP_ROOM_ID,
        'trusted',
        { isDirectMessage: false },
        undefined,
        undefined,
        undefined,
        undefined,
        ROOM_ONLY_SCOPE,
      );
      expectMemoryPresent(output, [MEMORY_SENTINELS.roomTownsquare]);
      expectNoMemoryFrom(output, dmChannelId(ALICE), [MEMORY_SENTINELS.dmAlice]);
      expectNoMemoryFrom(output, OTHER_ROOM_ID, [MEMORY_SENTINELS.roomBackchannel]);
      expectNoMemoryFrom(output, dmChannelId(DANA), [MEMORY_SENTINELS.dmDanaNonMember]);
    });
  });
});
