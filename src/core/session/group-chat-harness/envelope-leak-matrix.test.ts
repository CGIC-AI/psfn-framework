/**
 * Envelope leak-rate test family (E3.6, bead psfn-framework-76rn.6).
 *
 * A documented corner MATRIX over the REAL retrieval path
 * (`MemoryRetriever.retrieve` -> `evaluateRetrievalAccessDecision` ->
 * `evaluateMemoryPolicy`, `src/faculties/memory/retrieval/access.ts` +
 * `src/system/trust/policy.ts`), not mocks and not a re-run of the unit-level
 * gate suite in `src/system/trust/envelope-gating.test.ts` (E3.3). Every
 * forbidden combination below asserts ZERO leak of the sentinel memory text
 * through the assembled prompt-block string AND the correct withheld reason
 * code (via the label `formatMemoryWithheldReasonLabel` emits, the same
 * function the real `<memory_context_note>` renderer uses). Every allowed
 * combination asserts presence. All fixtures are synthetic (see
 * `fixtures.ts`).
 *
 * Gating precedence under test (docs/context-envelope.md, policy.ts):
 *   operator approval > disclosure boundaries > consent flags >
 *   trust ceiling (4 tiers x 4 sensitivities) > envelope (privacy+broadcast)
 * ...with the high-intimacy contact-scope gate and the room-visibility gate
 * both evaluated even earlier, ahead of that policy chain
 * (`evaluateRetrievalAccessDecision`).
 *
 * ── Corner matrix ───────────────────────────────────────────────────────
 *
 * | # | Case                                                        | channel class            | sensitivity   | trust    | contact match | expect | reason tag                     |
 * |---|--------------------------------------------------------------|---------------------------|---------------|----------|----------------|--------|----------------------------------|
 * | 1 | room -> DM of non-member (Dana)                              | room:townsquare -> dm:dana| personal      | trusted  | n/a            | BLOCK  | room_visibility.blocked          |
 * | 2 | DM -> room (Alice's DM leaking into the room)                | dm:alice -> room:townsquare| personal     | trusted  | n/a            | BLOCK  | room_visibility.blocked          |
 * | 3 | room -> other room (townsquare -> backchannel)               | room:townsquare -> room:backchannel | personal | trusted | n/a       | BLOCK  | room_visibility.blocked          |
 * | 4 | room -> DM of member (Alice sees shared-room content)        | room:townsquare -> dm:alice| personal     | trusted  | n/a            | ALLOW  | -                                 |
 * | 5 | DM -> DM cross-member (Alice's DM leaking into Dana's DM)    | dm:alice -> dm:dana       | personal      | trusted  | n/a            | BLOCK  | room_visibility.blocked          |
 * | 6 | invite_only room, happy path (positive control)              | invite_only               | personal      | trusted  | n/a            | ALLOW  | -                                 |
 * | 7 | invite_only room blocks intimate even at primary trust       | invite_only               | intimate      | primary  | none passed    | BLOCK  | visibility.channel_restricted    |
 * | 8 | invite_only room blocks confidential even at primary trust   | invite_only               | confidential  | primary  | none passed    | BLOCK  | visibility.channel_restricted    |
 * | 9 | public channel blocks personal sensitivity (required corner)| public                    | personal      | trusted  | n/a            | BLOCK  | visibility.channel_restricted    |
 * | 10| public channel allows the public floor                       | public                    | public        | public   | n/a            | ALLOW  | -                                 |
 * | 11| broadcast channel blocks personal, no approval token         | public+broadcast          | personal      | primary  | n/a            | BLOCK  | visibility.broadcast_restricted  |
 * | 12| broadcast channel + valid approval token elevates            | public+broadcast          | personal      | primary  | n/a            | ALLOW  | operator.approval_override       |
 * | 13| broadcast channel allows the public floor unconditionally    | public+broadcast          | public        | public   | n/a            | ALLOW  | -                                 |
 * | 14| trust ceiling: public-trust speaker vs intimate memory       | private                   | intimate      | public   | matched        | BLOCK  | trust.ceiling_exceeded           |
 * | 15| trust ceiling: trusted-trust speaker vs intimate memory      | private                   | intimate      | trusted  | matched        | BLOCK  | trust.ceiling_exceeded           |
 * | 16| trust ceiling: primary-trust speaker allowed (positive control)| private                 | intimate      | primary  | matched        | ALLOW  | -                                 |
 * | 17| anonymous-audience group: derivation + gate unaffected       | invite_only (anonymous)   | personal      | trusted  | n/a            | ALLOW  | -                                 |
 * | 18| anonymous-audience group still enforces the channel ceiling  | invite_only (anonymous)   | intimate      | primary  | none passed    | BLOCK  | visibility.channel_restricted    |
 * | 19| consent allowRecall=false blocks regardless of trust         | private                   | personal      | trusted  | n/a            | BLOCK  | consent.allow_recall_denied      |
 * | 20| disclosure-boundary withhold blocks even at primary trust    | private                   | personal      | primary  | n/a            | BLOCK  | boundary.withhold                |
 * | 21| disclosure-boundary consent_required, not granted            | private                   | personal      | primary  | n/a            | BLOCK  | boundary.consent_required        |
 * | 22| disclosure-boundary consent_required, explicitly granted     | private                   | personal      | primary  | n/a            | ALLOW  | -                                 |
 * | 23| high-intimacy cross-contact block (required corner)          | invite_only               | intimate      | primary  | mismatched     | BLOCK  | contact_scope.high_intimacy      |
 * | 24| high-intimacy same-contact positive control (via member DM)  | private (member DM)       | intimate      | primary  | matched        | ALLOW  | -                                 |
 * | 25| personal sensitivity is NOT high-intimacy-gated on mismatch  | invite_only               | personal      | trusted  | mismatched     | ALLOW  | -                                 |
 * | 26| combined withheld-summary correctness (multi-reason, no leak)| invite_only               | mixed         | primary  | mixed          | MIXED  | room_visibility.blocked + contact_scope.high_intimacy |
 *
 * ~26 documented rows: the required corners from the bead scope, plus the
 * trust/sensitivity/envelope-class combinatorics needed to prove precedence
 * ordering and gate boundaries (e.g. that the high-intimacy contact-scope
 * gate never over-fires on plain `personal` memories).
 */
import { describe, expect, it } from 'vitest';
import type { ContactStorePort } from '../../contacts/contact-store-port.js';
import type { ChannelMeta } from '../../../system/trust/policy.js';
import type { TrustLevel } from '../../../system/trust/types.js';
import type { ConversationScope } from '../conversation-scope.js';
import { resolveConversationScopeFromMetadata } from '../conversation-scope.js';
import { MemoryRetriever } from '../../../faculties/memory/retrieval.js';
import {
  expectMemoryPresent,
  expectNoMemoryFrom,
  expectWithheldReason,
} from './assertions.js';
import {
  ALICE,
  ANONYMOUS_ROOM_ID,
  BOB,
  BROADCAST_ROOM_ID,
  CAROL,
  DANA,
  GROUP_ROOM_ID,
  LEAK_MATRIX_SENTINELS,
  MEMORY_SENTINELS,
  OTHER_ROOM_ID,
  PUBLIC_ROOM_ID,
  dmChannelId,
  makeEmbeddingProvider,
  makeLeakMatrixMemories,
  makeLeakProbeContactStore,
  makeLeakProbeMemories,
  makeLeakProbeStore,
} from './fixtures.js';

// A single combined store covering every leak-probe + leak-matrix sentinel.
// The double's `searchByEmbedding` always returns every fixture memory
// regardless of the query text (matching the documented leak-probe pattern),
// so every row below exercises the exact same REAL gating pipeline; only the
// call parameters (channel, trust, contact) change per row.
const ALL_MATRIX_MEMORIES = [...makeLeakProbeMemories(), ...makeLeakMatrixMemories()];

function newMatrixRetriever(): MemoryRetriever {
  return new MemoryRetriever(
    makeLeakProbeStore(ALL_MATRIX_MEMORIES),
    makeEmbeddingProvider(),
    { retrievalLimit: 20 },
    undefined,
    makeLeakProbeContactStore() as unknown as ContactStorePort,
  );
}

// Row #26 asserts an EXACT withheld-count string, so it uses a small curated
// store (rather than ALL_MATRIX_MEMORIES, whose other 12+ sentinels would
// also legitimately withhold under the same call and inflate the count) --
// still the REAL retrieval/gating pipeline, just a deliberately small
// candidate set so the count assertion stays precise and legible.
const COMBINED_ROW_TEXTS = new Set<string>([
  MEMORY_SENTINELS.dmAlice,
  MEMORY_SENTINELS.roomBackchannel,
  MEMORY_SENTINELS.dmDanaNonMember,
  MEMORY_SENTINELS.roomTownsquare,
  LEAK_MATRIX_SENTINELS.highIntimacyRoomAlice,
  LEAK_MATRIX_SENTINELS.personalScopeMismatch,
]);
const COMBINED_ROW_MEMORIES = ALL_MATRIX_MEMORIES.filter(memory => COMBINED_ROW_TEXTS.has(memory.text));

function newCombinedRowRetriever(): MemoryRetriever {
  return new MemoryRetriever(
    makeLeakProbeStore(COMBINED_ROW_MEMORIES),
    makeEmbeddingProvider(),
    { retrievalLimit: 20 },
    undefined,
    makeLeakProbeContactStore() as unknown as ContactStorePort,
  );
}

interface MatrixRetrieveOptions {
  text?: string;
  channelId: string;
  trustLevel: TrustLevel;
  channelMeta?: ChannelMeta;
  canonicalContactId?: string;
  conversationScope?: ConversationScope;
}

/**
 * Thin positional-argument wrapper around the REAL `MemoryRetriever.retrieve`
 * call (not a mock -- every call below still runs the genuine access-decision
 * pipeline). Exists only so each matrix row can name the fields it cares
 * about instead of a wall of positional `undefined`s.
 */
function retrieveMatrix(retriever: MemoryRetriever, options: MatrixRetrieveOptions): Promise<string> {
  return retriever.retrieve(
    options.text ?? 'What do you remember that is relevant here?',
    options.channelId,
    options.trustLevel,
    options.channelMeta,
    options.canonicalContactId,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    options.conversationScope,
  );
}

describe('envelope leak-rate matrix (E3.6, real retrieval path)', () => {
  // ---------------------------------------------------------------------
  // Rows 1-5: structural room-visibility leak probes.
  // ---------------------------------------------------------------------
  describe('room-visibility structural leaks', () => {
    it('#1 room -> DM of non-member: room memory never reaches Dana\'s DM', async () => {
      const output = await retrieveMatrix(newMatrixRetriever(), {
        channelId: dmChannelId(DANA),
        trustLevel: 'trusted',
        channelMeta: { isDirectMessage: true },
        canonicalContactId: DANA.id,
      });
      expectNoMemoryFrom(output, GROUP_ROOM_ID, [MEMORY_SENTINELS.roomTownsquare]);
      expectWithheldReason(output, 'room_visibility.blocked');
    });

    it('#2 DM -> room: Alice\'s private DM content never reaches the room', async () => {
      const output = await retrieveMatrix(newMatrixRetriever(), {
        channelId: GROUP_ROOM_ID,
        trustLevel: 'trusted',
        channelMeta: { isDirectMessage: false },
        canonicalContactId: CAROL.id,
      });
      expectNoMemoryFrom(output, dmChannelId(ALICE), [MEMORY_SENTINELS.dmAlice]);
      expectWithheldReason(output, 'room_visibility.blocked');
    });

    it('#3 room -> other room: backchannel content never reaches townsquare', async () => {
      const output = await retrieveMatrix(newMatrixRetriever(), {
        channelId: GROUP_ROOM_ID,
        trustLevel: 'trusted',
        channelMeta: { isDirectMessage: false },
      });
      expectNoMemoryFrom(output, OTHER_ROOM_ID, [MEMORY_SENTINELS.roomBackchannel]);
      expectWithheldReason(output, 'room_visibility.blocked');
    });

    it('#4 room -> DM of member (positive control): Alice recalls shared-room content in her own DM', async () => {
      const output = await retrieveMatrix(newMatrixRetriever(), {
        channelId: dmChannelId(ALICE),
        trustLevel: 'trusted',
        channelMeta: { isDirectMessage: true },
        canonicalContactId: ALICE.id,
      });
      expectMemoryPresent(output, [MEMORY_SENTINELS.roomTownsquare]);
    });

    it('#5 DM -> DM: Alice\'s private DM content never reaches Dana\'s unrelated DM', async () => {
      const output = await retrieveMatrix(newMatrixRetriever(), {
        channelId: dmChannelId(DANA),
        trustLevel: 'trusted',
        channelMeta: { isDirectMessage: true },
        canonicalContactId: DANA.id,
      });
      expectNoMemoryFrom(output, dmChannelId(ALICE), [MEMORY_SENTINELS.dmAlice]);
      expectWithheldReason(output, 'room_visibility.blocked');
    });
  });

  // ---------------------------------------------------------------------
  // Rows 6-10: envelope class (channelPrivacy) x sensitivity ceiling.
  // ---------------------------------------------------------------------
  describe('envelope class x sensitivity ceiling', () => {
    it('#6 invite_only room + personal + trusted: happy path (positive control)', async () => {
      const output = await retrieveMatrix(newMatrixRetriever(), {
        channelId: GROUP_ROOM_ID,
        trustLevel: 'trusted',
        channelMeta: { isDirectMessage: false },
      });
      expectMemoryPresent(output, [MEMORY_SENTINELS.roomTownsquare]);
    });

    it('#7 invite_only room blocks intimate sensitivity even at primary trust', async () => {
      const output = await retrieveMatrix(newMatrixRetriever(), {
        channelId: GROUP_ROOM_ID,
        trustLevel: 'primary',
        channelMeta: { isDirectMessage: false },
        // No canonicalContactId: isolates the channel-ceiling axis from the
        // high-intimacy contact-scope gate (row #23 covers that axis).
      });
      expectNoMemoryFrom(output, GROUP_ROOM_ID, [LEAK_MATRIX_SENTINELS.intimateRoomDetail]);
      expectWithheldReason(output, 'visibility.channel_restricted');
    });

    it('#8 invite_only room blocks confidential sensitivity even at primary trust', async () => {
      const output = await retrieveMatrix(newMatrixRetriever(), {
        channelId: GROUP_ROOM_ID,
        trustLevel: 'primary',
        channelMeta: { isDirectMessage: false },
      });
      expectNoMemoryFrom(output, GROUP_ROOM_ID, [LEAK_MATRIX_SENTINELS.confidentialRoomDetail]);
      expectWithheldReason(output, 'visibility.channel_restricted');
    });

    it('#9 public channel blocks personal sensitivity (required corner)', async () => {
      const output = await retrieveMatrix(newMatrixRetriever(), {
        channelId: PUBLIC_ROOM_ID,
        trustLevel: 'trusted',
        channelMeta: { isDirectMessage: false, privacyLevel: 'public' },
      });
      expectNoMemoryFrom(output, PUBLIC_ROOM_ID, [LEAK_MATRIX_SENTINELS.personalInPublicRoom]);
      expectWithheldReason(output, 'visibility.channel_restricted');
    });

    it('#10 public channel allows the public sensitivity floor', async () => {
      const output = await retrieveMatrix(newMatrixRetriever(), {
        channelId: PUBLIC_ROOM_ID,
        trustLevel: 'public',
        channelMeta: { isDirectMessage: false, privacyLevel: 'public' },
      });
      expectMemoryPresent(output, [LEAK_MATRIX_SENTINELS.publicFloorInPublicRoom]);
    });
  });

  // ---------------------------------------------------------------------
  // Rows 11-13: broadcast flag + approval-token elevation (broadcast-safety.ts).
  // ---------------------------------------------------------------------
  describe('broadcast flag: public-only ceiling and approval-token elevation', () => {
    it('#11 broadcast channel blocks personal sensitivity with no approval token', async () => {
      const output = await retrieveMatrix(newMatrixRetriever(), {
        channelId: BROADCAST_ROOM_ID,
        trustLevel: 'primary',
        channelMeta: { isDirectMessage: false },
      });
      expectNoMemoryFrom(output, BROADCAST_ROOM_ID, [LEAK_MATRIX_SENTINELS.personalOnBroadcast]);
      expectWithheldReason(output, 'visibility.broadcast_restricted');
    });

    it('#12 broadcast channel + valid approval token elevates via operator approval', async () => {
      const output = await retrieveMatrix(newMatrixRetriever(), {
        channelId: BROADCAST_ROOM_ID,
        trustLevel: 'primary',
        channelMeta: {
          isDirectMessage: false,
          broadcastApprovalToken: 'approve:operator-12345678',
        },
      });
      expectMemoryPresent(output, [LEAK_MATRIX_SENTINELS.personalOnBroadcast]);
    });

    it('#13 broadcast channel allows the public sensitivity floor unconditionally', async () => {
      const output = await retrieveMatrix(newMatrixRetriever(), {
        channelId: BROADCAST_ROOM_ID,
        trustLevel: 'public',
        channelMeta: { isDirectMessage: false },
      });
      expectMemoryPresent(output, [LEAK_MATRIX_SENTINELS.publicFloorOnBroadcast]);
    });
  });

  // ---------------------------------------------------------------------
  // Rows 14-16: trust-ceiling corners (public-trust speaker vs intimate
  // memory in a channel that structurally allows intimate content).
  // ---------------------------------------------------------------------
  describe('trust-ceiling corners: public-trust speaker vs intimate memory', () => {
    it('#14 private DM blocks intimate sensitivity at public trust (required corner)', async () => {
      const output = await retrieveMatrix(newMatrixRetriever(), {
        channelId: dmChannelId(ALICE),
        trustLevel: 'public',
        channelMeta: { isDirectMessage: true },
        canonicalContactId: ALICE.id,
      });
      expectNoMemoryFrom(output, dmChannelId(ALICE), [LEAK_MATRIX_SENTINELS.intimateDmDetail]);
      expectWithheldReason(output, 'trust.ceiling_exceeded');
    });

    it('#15 private DM blocks intimate sensitivity at trusted trust', async () => {
      const output = await retrieveMatrix(newMatrixRetriever(), {
        channelId: dmChannelId(ALICE),
        trustLevel: 'trusted',
        channelMeta: { isDirectMessage: true },
        canonicalContactId: ALICE.id,
      });
      expectNoMemoryFrom(output, dmChannelId(ALICE), [LEAK_MATRIX_SENTINELS.intimateDmDetail]);
      expectWithheldReason(output, 'trust.ceiling_exceeded');
    });

    it('#16 private DM allows intimate sensitivity at primary trust (positive control)', async () => {
      const output = await retrieveMatrix(newMatrixRetriever(), {
        channelId: dmChannelId(ALICE),
        trustLevel: 'primary',
        channelMeta: { isDirectMessage: true },
        canonicalContactId: ALICE.id,
      });
      expectMemoryPresent(output, [LEAK_MATRIX_SENTINELS.intimateDmDetail]);
    });
  });

  // ---------------------------------------------------------------------
  // Rows 17-18: anonymous-audience group behavior. audienceKnowledge is a
  // derived envelope dimension the memory-access gate does NOT consume
  // (only channelPrivacy + broadcast do, per policy.ts); these rows prove
  // that an anonymous audience neither loosens nor tightens the gate beyond
  // the channel's ordinary ceiling.
  // ---------------------------------------------------------------------
  describe('anonymous-audience group behavior', () => {
    it('#17 derives an anonymous-audience envelope and still allows personal at trusted trust', async () => {
      const scope = resolveConversationScopeFromMetadata({
        channelId: ANONYMOUS_ROOM_ID,
        isDirectMessage: false,
        // No recentSpeakers supplied: fail-closed derivation -> anonymous.
      });
      expect(scope.kind).toBe('group');
      expect(scope.envelope).toEqual({
        channelPrivacy: 'invite_only',
        audienceScope: 'few',
        audienceKnowledge: 'anonymous',
        broadcast: false,
      });

      const output = await retrieveMatrix(newMatrixRetriever(), {
        channelId: ANONYMOUS_ROOM_ID,
        trustLevel: 'trusted',
        channelMeta: { isDirectMessage: false },
        conversationScope: scope,
      });
      expectMemoryPresent(output, [LEAK_MATRIX_SENTINELS.anonymousRoomPersonal]);
    });

    it('#18 anonymous-audience group still enforces the invite_only ceiling against intimate content', async () => {
      const output = await retrieveMatrix(newMatrixRetriever(), {
        channelId: ANONYMOUS_ROOM_ID,
        trustLevel: 'primary',
        channelMeta: { isDirectMessage: false },
      });
      expectNoMemoryFrom(output, ANONYMOUS_ROOM_ID, [LEAK_MATRIX_SENTINELS.anonymousRoomIntimate]);
      expectWithheldReason(output, 'visibility.channel_restricted');
    });
  });

  // ---------------------------------------------------------------------
  // Rows 19-22: consent flags and disclosure boundaries (layers ABOVE trust
  // ceiling in precedence -- both deny even when trust/visibility would
  // otherwise allow).
  // ---------------------------------------------------------------------
  describe('consent flags and disclosure boundaries', () => {
    it('#19 consent allowRecall=false blocks regardless of trust (required corner)', async () => {
      const output = await retrieveMatrix(newMatrixRetriever(), {
        channelId: dmChannelId(ALICE),
        trustLevel: 'trusted',
        channelMeta: { isDirectMessage: true },
        canonicalContactId: ALICE.id,
      });
      expectNoMemoryFrom(output, dmChannelId(ALICE), [LEAK_MATRIX_SENTINELS.consentDenied]);
      expectWithheldReason(output, 'consent.allow_recall_denied');
    });

    it('#20 disclosure-boundary withhold blocks even at primary trust (required corner)', async () => {
      const output = await retrieveMatrix(newMatrixRetriever(), {
        channelId: dmChannelId(ALICE),
        trustLevel: 'primary',
        channelMeta: { isDirectMessage: true },
        canonicalContactId: ALICE.id,
      });
      expectNoMemoryFrom(output, dmChannelId(ALICE), [LEAK_MATRIX_SENTINELS.boundaryWithhold]);
      expectWithheldReason(output, 'boundary.withhold');
    });

    it('#21 disclosure-boundary consent_required blocks when consent is not granted', async () => {
      const output = await retrieveMatrix(newMatrixRetriever(), {
        channelId: dmChannelId(ALICE),
        trustLevel: 'primary',
        channelMeta: { isDirectMessage: true },
        canonicalContactId: ALICE.id,
      });
      expectNoMemoryFrom(output, dmChannelId(ALICE), [LEAK_MATRIX_SENTINELS.boundaryConsentRequired]);
      expectWithheldReason(output, 'boundary.consent_required');
    });

    it('#22 disclosure-boundary consent_required allows once consent is explicitly granted', async () => {
      const output = await retrieveMatrix(newMatrixRetriever(), {
        channelId: dmChannelId(ALICE),
        trustLevel: 'primary',
        channelMeta: { isDirectMessage: true, disclosureConsentGranted: true },
        canonicalContactId: ALICE.id,
      });
      expectMemoryPresent(output, [LEAK_MATRIX_SENTINELS.boundaryConsentRequired]);
    });
  });

  // ---------------------------------------------------------------------
  // Rows 23-25: high-intimacy contact-scope gate (violatesHighIntimacyContactScope).
  // ---------------------------------------------------------------------
  describe('high-intimacy contact-scope gate', () => {
    it('#23 high-intimacy room memory tied to Alice never reaches Bob\'s session (required corner)', async () => {
      const output = await retrieveMatrix(newMatrixRetriever(), {
        channelId: GROUP_ROOM_ID,
        trustLevel: 'primary',
        channelMeta: { isDirectMessage: false },
        canonicalContactId: BOB.id,
      });
      expectNoMemoryFrom(output, GROUP_ROOM_ID, [LEAK_MATRIX_SENTINELS.highIntimacyRoomAlice]);
      expectWithheldReason(output, 'contact_scope.high_intimacy');
    });

    it('#24 the same high-intimacy room memory is recallable via Alice\'s own member DM (positive control)', async () => {
      const output = await retrieveMatrix(newMatrixRetriever(), {
        channelId: dmChannelId(ALICE),
        trustLevel: 'primary',
        channelMeta: { isDirectMessage: true },
        canonicalContactId: ALICE.id,
      });
      expectMemoryPresent(output, [LEAK_MATRIX_SENTINELS.highIntimacyRoomAlice]);
    });

    it('#25 plain personal-sensitivity memories are NOT high-intimacy-gated on contact mismatch', async () => {
      const output = await retrieveMatrix(newMatrixRetriever(), {
        channelId: GROUP_ROOM_ID,
        trustLevel: 'trusted',
        channelMeta: { isDirectMessage: false },
        canonicalContactId: BOB.id,
      });
      // Tied to Alice's contact id but sensitivity is only 'personal': the
      // high-intimacy gate must not over-fire outside intimate/confidential.
      expectMemoryPresent(output, [LEAK_MATRIX_SENTINELS.personalScopeMismatch]);
    });
  });

  // ---------------------------------------------------------------------
  // Row 26: withheld-summary correctness under multiple simultaneous reasons
  // in a single retrieval call. Blocked memory must produce reason-coded
  // withheld entries and NEVER partial content: the forbidden sentinel texts
  // must be absent from the entire assembled output string (there is no
  // other output field -- `retrieve()` returns exactly one rendered string).
  // ---------------------------------------------------------------------
  describe('withheld-summary correctness (multi-reason, no partial leak)', () => {
    it('#26 stacks room_visibility.blocked and contact_scope.high_intimacy in one call, with zero leak and an accurate count', async () => {
      const output = await retrieveMatrix(newCombinedRowRetriever(), {
        channelId: GROUP_ROOM_ID,
        trustLevel: 'primary',
        channelMeta: { isDirectMessage: false },
        canonicalContactId: CAROL.id,
      });

      // Allowed content still surfaces alongside the withheld ones.
      expectMemoryPresent(output, [
        MEMORY_SENTINELS.roomTownsquare,
        LEAK_MATRIX_SENTINELS.personalScopeMismatch,
      ]);

      // Every forbidden text is absent from the ENTIRE output string -- there
      // is no other field to check; a partial/summarized leak would still be
      // caught here because these are the literal sentinel strings.
      expectNoMemoryFrom(output, dmChannelId(ALICE), [MEMORY_SENTINELS.dmAlice]);
      expectNoMemoryFrom(output, OTHER_ROOM_ID, [MEMORY_SENTINELS.roomBackchannel]);
      expectNoMemoryFrom(output, dmChannelId(DANA), [MEMORY_SENTINELS.dmDanaNonMember]);
      expectNoMemoryFrom(output, GROUP_ROOM_ID, [LEAK_MATRIX_SENTINELS.highIntimacyRoomAlice]);

      // Reason-coded withheld entries for both distinct gates that fired.
      expectWithheldReason(output, 'room_visibility.blocked');
      expectWithheldReason(output, 'contact_scope.high_intimacy');

      // Exact withheld count: dmAlice + roomBackchannel + dmDanaNonMember
      // (room_visibility.blocked, x3) + highIntimacyRoomAlice
      // (contact_scope.high_intimacy, x1) = 4 candidates kept out.
      expect(output).toContain('4 candidate memories were kept out of this turn\'s memory context.');
    });
  });
});
