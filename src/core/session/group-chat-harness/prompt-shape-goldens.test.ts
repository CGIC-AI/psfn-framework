/**
 * Prompt-shape goldens (E2.7): freeze the assembled system-prompt shape before
 * the PromptPlan refactor (E2.2) opens the assembly engine.
 *
 * WHAT IS FROZEN
 * Six golden artifacts under ./goldens/, each containing (1) the ordered list
 * of top-level prompt blocks and (2) the full rendered system prompt produced
 * by the REAL assembly drive path used by the group-chat harness:
 *   static prefix (PromptComposer.composeSplit -> resolveStaticPromptPrefix)
 *   + runtime prompt layers (renderTurnRuntimePrompt over the canonical seed)
 *   + SessionManager.buildContext (core memory, retrieved memory, session
 *     blocks, ordered by the prompt-runtime layout).
 * A prompt regression is a personality regression for a live companion; any
 * diff in these files must be explainable.
 *
 * DETERMINISM CONTRACT
 * - Clock: every render receives the injected FIXTURE_NOW
 *   (2026-07-01T12:00:00Z). No assembly input in this suite reads Date.now()
 *   into rendered text.
 * - Timezone: process.env.TZ is pinned to America/New_York (the runtime
 *   default) for the duration of the suite because active-timezone formatting
 *   reads TZ.
 * - Identity: all IDs are fixed synthetic fixture IDs (contact-alice,
 *   room:townsquare, ...). No randomness, no UUIDs.
 *
 * SCRUB RULES (see scrubGoldenText)
 * - The per-test mkdtemp companion-data directory is replaced with {{TMPDIR}}
 *   if it ever surfaces in prompt text (defensive; it should not).
 * - NOTHING ELSE is scrubbed. Timestamps and dates in the artifacts derive
 *   from the injected clock and are intentionally asserted: scrubbing them
 *   would hide exactly the class of should-be-deterministic regressions this
 *   suite exists to catch. The scrubber fails closed if a residual temp path
 *   survives.
 *
 * GOLDEN UPDATE PROCEDURE (Charter 12.5: goldens must not lock in accidents)
 * 1. Never blind re-record. A failing golden means the prompt shape changed;
 *    read the diff first and decide whether the change is intentional.
 * 2. For an INTENTIONAL shape change, regenerate with
 *      npx vitest run src/core/session/group-chat-harness/prompt-shape-goldens.test.ts -u
 *    then review the golden diff like code and explain it in the PR
 *    description (which block moved/appeared/disappeared and why).
 * 3. For an UNINTENTIONAL change, fix the regression instead of updating the
 *    golden.
 * Run `npm run test:prompt-goldens` twice before committing: the second run
 * must be green against the freshly written files (determinism proof).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PromptComposer } from '../../identity/prompt-composer.js';
import { PromptLayerStore } from '../../identity/prompt-store.js';
import { ensureTemporalRulesPromptLayer } from '../../identity/temporal-rules-layer.js';
import { extractWrappedPromptSections } from '../../identity/prompt-sections.js';
import {
  buildPromptPrefixCacheKey,
  buildStaticPromptSettingsHash,
  composePromptSections,
  resolveStaticPromptPrefix,
  type FrozenPromptPrefix,
} from '../../agent/substrate-agent/prompt-lifecycle.js';
import { resolveAuthorContext } from '../../agent/substrate-agent/runtime-context.js';
import { MemoryRetriever } from '../../../faculties/memory/retrieval.js';
import type { ContactStorePort } from '../../contacts/contact-store-port.js';
import type { SubstrateMessage } from '../../../shared/contracts/runtime.js';
import type { SessionEntry } from '../types.js';
import {
  ALICE,
  CAROL,
  COMPANION_SELF,
  FIXTURE_NOW,
  GROUP_ROOM_ID,
  HEARTBEAT_CHANNEL_ID,
  MEMORY_SENTINELS,
  REFLECTION_CHANNEL_ID,
  buildGroupChatSession,
  dmChannelId,
  makeDmTurnMessage,
  makeEmbeddingProvider,
  makeGroupRoomRecentEntries,
  makeGroupTurnMessage,
  makeInternalTurnMessage,
  makeLeakProbeContactStore,
  makeLeakProbeMemories,
  makeLeakProbeStore,
  renderTurnRuntimePrompt,
  buildTurnTemplateVariables,
  type GroupChatSessionFixture,
  type HarnessParticipant,
} from './fixtures.js';

const GOLDEN_TZ = 'America/New_York';

// ---------------------------------------------------------------------------
// Static prompt stack: a live-shaped base/operator layer set composed through
// the REAL PromptComposer (composeSplit) and rendered through the REAL frozen
// prefix path (resolveStaticPromptPrefix). Only static/session-stable macros
// are legal here; composeSplit fails closed on turn-volatile macros.
// ---------------------------------------------------------------------------

const BASE_FOUNDATION_LAYER_CONTENT = [
  '<character_foundation>',
  'You are {{char_name}}, a synthetic companion identity used only by the prompt-shape golden harness.',
  'Personality anchor: attentive, direct, protective of individual confidences.',
  'Active timezone: {{active_timezone}}.',
  '</character_foundation>',
].join('\n');

const OPERATOR_POLICY_LAYER_CONTENT = [
  '<operator_policy>',
  'Keep individual confidences out of shared rooms.',
  'Never present retrieved memory as partner-authored direct speech.',
  '</operator_policy>',
].join('\n');

function buildStaticPromptStack(dir: string): PromptComposer {
  const store = new PromptLayerStore(
    join(dir, 'prompt-layers.json'),
    join(dir, 'prompt-history.jsonl'),
  );
  store.create({
    type: 'base',
    name: 'Character Foundation',
    identifier: 'main',
    content: BASE_FOUNDATION_LAYER_CONTENT,
    promptOrder: 0,
  });
  store.create({
    type: 'operator',
    name: 'Operator Policy',
    identifier: 'operator.policy',
    content: OPERATOR_POLICY_LAYER_CONTENT,
    promptOrder: 20,
  });
  ensureTemporalRulesPromptLayer(store);
  return new PromptComposer(store, undefined, undefined, { persistLastKnownGood: false });
}

interface StaticPrefixRender {
  renderedPrefix: string;
  staticHash: string;
  settingsHash: string;
}

/**
 * Render the frozen static prefix for one turn through the real lifecycle
 * helpers. A FRESH cache map is used on every call so byte-stability is proven
 * for the render itself, not merely for a cache hit.
 */
function renderStaticPrefix(
  composer: PromptComposer,
  message: SubstrateMessage,
  speaker: HarnessParticipant,
  channelType: string,
  now: Date,
): StaticPrefixRender {
  const sections = composePromptSections({
    promptComposer: composer,
    composeContext: { channelType },
    systemPrompt: '',
  });
  const templateVariables = buildTurnTemplateVariables(message, speaker, channelType, { now });
  const settingsHash = buildStaticPromptSettingsHash(templateVariables, sections.staticPrefix);
  const renderedPrefix = resolveStaticPromptPrefix({
    cache: new Map<string, FrozenPromptPrefix>(),
    cacheKey: buildPromptPrefixCacheKey(message, channelType, speaker.id),
    staticPrefixTemplate: sections.staticPrefix,
    staticHash: sections.staticHash,
    settingsHash,
    now,
    variables: templateVariables,
  });
  return { renderedPrefix, staticHash: sections.staticHash, settingsHash };
}

// ---------------------------------------------------------------------------
// Scrubbing (rule 4): replace genuinely-variable content with stable
// placeholders; never scrub anything that is deterministic under the injected
// clock/IDs. Fails closed on residual temp paths so a golden can never be
// committed with per-run variability baked in.
// ---------------------------------------------------------------------------

function scrubGoldenText(text: string, volatilePaths: readonly string[]): string {
  let scrubbed = text;
  for (const volatilePath of volatilePaths) {
    if (!volatilePath) continue;
    scrubbed = scrubbed.split(volatilePath).join('{{TMPDIR}}');
  }
  const residualTempPath = /(?:\/tmp|\/var\/folders)\/[^\s"'<>]*psfn-[^\s"'<>]*/u.exec(scrubbed);
  if (residualTempPath) {
    throw new Error(
      `scrubGoldenText: residual per-run temp path survived scrubbing and would make the golden flaky: ${residualTempPath[0]}`,
    );
  }
  return scrubbed;
}

function formatGoldenArtifact(
  name: string,
  systemPrompt: string,
  volatilePaths: readonly string[],
): string {
  const scrubbed = scrubGoldenText(systemPrompt, volatilePaths);
  const blockIds = extractWrappedPromptSections(scrubbed).map(section => section.id);
  return [
    `PSFN prompt-shape golden: ${name}`,
    `clock: ${FIXTURE_NOW.toISOString()} (injected) | timezone: ${GOLDEN_TZ}`,
    '',
    '=== ordered prompt blocks ===',
    ...blockIds.map((id, index) => `${String(index + 1)}. ${id}`),
    '',
    '=== rendered system prompt ===',
    scrubbed,
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Scenario assembly: static prefix + runtime prompt layers -> buildContext.
// Mirrors the turn pipeline's [staticPrefix, dynamicSuffix] -> fullPrompt ->
// SessionManager.buildContext(fullPrompt, memoriesBlock) composition.
// ---------------------------------------------------------------------------

async function assembleScenarioSystemPrompt(input: {
  fixture: GroupChatSessionFixture;
  composer: PromptComposer;
  message: SubstrateMessage;
  speaker: HarnessParticipant;
  channelType: string;
  userId: string;
  channelMeta?: { isDirectMessage: boolean };
  memoriesBlock?: string;
  recentChannelEntries?: readonly SessionEntry[];
  taskKind?: string;
}): Promise<string> {
  const { prompt: dynamicPrompt } = renderTurnRuntimePrompt(
    input.message,
    input.speaker,
    input.channelType,
    {
      ...(input.taskKind ? { taskKind: input.taskKind } : {}),
      ...(input.recentChannelEntries ? { recentChannelEntries: input.recentChannelEntries } : {}),
    },
  );
  const staticRender = renderStaticPrefix(
    input.composer,
    input.message,
    input.speaker,
    input.channelType,
    FIXTURE_NOW,
  );
  const fullPrompt = [staticRender.renderedPrefix, dynamicPrompt]
    .map(section => section.trim())
    .filter(section => section.length > 0)
    .join('\n\n');
  const context = await input.fixture.manager.buildContext(
    input.message.channelId,
    fullPrompt,
    input.memoriesBlock ?? '',
    undefined,
    input.userId,
    input.channelMeta,
  );
  return context.systemPrompt;
}

function newLeakProbeRetriever(withContacts = false): MemoryRetriever {
  return new MemoryRetriever(
    makeLeakProbeStore(makeLeakProbeMemories()),
    makeEmbeddingProvider(),
    { retrievalLimit: 20 },
    undefined,
    withContacts ? (makeLeakProbeContactStore() as unknown as ContactStorePort) : undefined,
  );
}

describe('prompt-shape goldens (E2.7)', () => {
  let originalTz: string | undefined;
  let dir: string;
  let fixture: GroupChatSessionFixture;
  let composer: PromptComposer;

  beforeAll(() => {
    originalTz = process.env.TZ;
    process.env.TZ = GOLDEN_TZ;
  });

  afterAll(() => {
    if (originalTz === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = originalTz;
    }
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'psfn-prompt-goldens-'));
    fixture = buildGroupChatSession(dir);
    composer = buildStaticPromptStack(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('golden a: DM turn (Alice DM, trust=trusted)', async () => {
    const systemPrompt = await assembleScenarioSystemPrompt({
      fixture,
      composer,
      message: makeDmTurnMessage(ALICE),
      speaker: ALICE,
      channelType: 'api',
      userId: ALICE.authorId,
      channelMeta: { isDirectMessage: true },
    });
    expect(systemPrompt).not.toMatch(/\{\{(?!TMPDIR)/u);
    await expect(formatGoldenArtifact('dm-turn', systemPrompt, [dir])).toMatchFileSnapshot(
      './goldens/dm-turn.golden.txt',
    );
  });

  it('golden b: group turn (3 humans + peer companion in room:townsquare)', async () => {
    const systemPrompt = await assembleScenarioSystemPrompt({
      fixture,
      composer,
      message: makeGroupTurnMessage(CAROL),
      speaker: CAROL,
      channelType: 'api',
      userId: CAROL.authorId,
      channelMeta: { isDirectMessage: false },
      recentChannelEntries: makeGroupRoomRecentEntries(),
    });
    expect(systemPrompt).not.toMatch(/\{\{(?!TMPDIR)/u);
    await expect(formatGoldenArtifact('group-turn', systemPrompt, [dir])).toMatchFileSnapshot(
      './goldens/group-turn.golden.txt',
    );
  });

  it('golden c: heartbeat turn (internal:heartbeat)', async () => {
    const message = makeInternalTurnMessage(HEARTBEAT_CHANNEL_ID, {
      content: 'Scheduled heartbeat check-in.',
    });
    const authorContext = await resolveAuthorContext({
      message,
      contactStore: null,
      logger: { warn: () => undefined, debug: () => undefined, info: () => undefined },
      companionIdentityKey: COMPANION_SELF.id,
      companionDisplayName: COMPANION_SELF.name,
    });
    // Heartbeat turns are self-directed: companion subject, trust 'primary'.
    expect(authorContext.trustLevel).toBe('primary');
    expect(authorContext.subjectIdentityKey).toBe(COMPANION_SELF.id);

    const systemPrompt = await assembleScenarioSystemPrompt({
      fixture,
      composer,
      message,
      speaker: COMPANION_SELF,
      channelType: 'terminal',
      userId: COMPANION_SELF.authorId,
      taskKind: 'heartbeat',
    });
    expect(systemPrompt).not.toMatch(/\{\{(?!TMPDIR)/u);
    await expect(formatGoldenArtifact('heartbeat-turn', systemPrompt, [dir])).toMatchFileSnapshot(
      './goldens/heartbeat-turn.golden.txt',
    );
  });

  it('golden d: reflection turn (internal reflection, DM-scoped)', async () => {
    const message = makeInternalTurnMessage(REFLECTION_CHANNEL_ID, {
      content: 'Reflect on the recent conversation with Alice.',
      routing: {
        canonicalContactId: ALICE.id,
        reflectionScope: { kind: 'dm', contactId: ALICE.id, displayName: ALICE.name },
      } as SubstrateMessage['routing'],
    });
    const authorContext = await resolveAuthorContext({
      message,
      contactStore: null,
      logger: { warn: () => undefined, debug: () => undefined, info: () => undefined },
      companionIdentityKey: COMPANION_SELF.id,
      companionDisplayName: COMPANION_SELF.name,
    });
    // DM-scoped reflection binds the routed canonical contact hint while the
    // subject stays the companion (E1.7 scope-hint behavior).
    expect(authorContext.trustLevel).toBe('primary');
    expect(authorContext.canonicalContactKey).toBe(ALICE.id);
    expect(authorContext.subjectIdentityKey).toBe(COMPANION_SELF.id);

    const systemPrompt = await assembleScenarioSystemPrompt({
      fixture,
      composer,
      message,
      speaker: COMPANION_SELF,
      channelType: 'terminal',
      userId: COMPANION_SELF.authorId,
      taskKind: 'reflection',
    });
    expect(systemPrompt).not.toMatch(/\{\{(?!TMPDIR)/u);
    await expect(formatGoldenArtifact('reflection-dm-turn', systemPrompt, [dir])).toMatchFileSnapshot(
      './goldens/reflection-dm-turn.golden.txt',
    );
  });

  it('golden e: DM turn with retrieved memories present', async () => {
    const memoriesBlock = await newLeakProbeRetriever(true).retrieve(
      'What did the group decide about the offsite?',
      dmChannelId(ALICE),
      'trusted',
      { isDirectMessage: true },
      ALICE.id,
    );
    // The retrieved block must carry the in-scope sentinels before we freeze it.
    expect(memoriesBlock).toContain(MEMORY_SENTINELS.dmAlice);
    expect(memoriesBlock).toContain(MEMORY_SENTINELS.roomTownsquare);

    const systemPrompt = await assembleScenarioSystemPrompt({
      fixture,
      composer,
      message: makeDmTurnMessage(ALICE),
      speaker: ALICE,
      channelType: 'api',
      userId: ALICE.authorId,
      channelMeta: { isDirectMessage: true },
      memoriesBlock,
    });
    expect(systemPrompt).not.toMatch(/\{\{(?!TMPDIR)/u);
    await expect(
      formatGoldenArtifact('dm-turn-with-memories', systemPrompt, [dir]),
    ).toMatchFileSnapshot('./goldens/dm-turn-with-memories.golden.txt');
  });

  it('golden f: group turn with withheld memories (summary present, blocked content absent)', async () => {
    const memoriesBlock = await newLeakProbeRetriever().retrieve(
      'What is the plan for the townsquare offsite?',
      GROUP_ROOM_ID,
      'trusted',
      { isDirectMessage: false },
    );
    // Withheld summary present; every foreign-scope sentinel absent.
    expect(memoriesBlock).toContain('<memory_context_note>');
    expect(memoriesBlock).toContain(MEMORY_SENTINELS.roomTownsquare);
    expect(memoriesBlock).not.toContain(MEMORY_SENTINELS.dmAlice);
    expect(memoriesBlock).not.toContain(MEMORY_SENTINELS.dmDanaNonMember);
    expect(memoriesBlock).not.toContain(MEMORY_SENTINELS.roomBackchannel);

    const systemPrompt = await assembleScenarioSystemPrompt({
      fixture,
      composer,
      message: makeGroupTurnMessage(CAROL),
      speaker: CAROL,
      channelType: 'api',
      userId: CAROL.authorId,
      channelMeta: { isDirectMessage: false },
      memoriesBlock,
      recentChannelEntries: makeGroupRoomRecentEntries(),
    });
    expect(systemPrompt).not.toMatch(/\{\{(?!TMPDIR)/u);
    expect(systemPrompt).not.toContain(MEMORY_SENTINELS.dmAlice);
    await expect(
      formatGoldenArtifact('group-turn-with-withheld-memories', systemPrompt, [dir]),
    ).toMatchFileSnapshot('./goldens/group-turn-with-withheld-memories.golden.txt');
  });

  // -------------------------------------------------------------------------
  // Static-prefix byte-stability: two consecutive turns on the same fixture
  // (different user message, clock advanced a few seconds) must produce a
  // BYTE-EQUAL frozen prefix from a fresh render. A failure here is the
  // "should-be-static variables" contamination bug resurfacing: some
  // turn-varying value is reaching the static prefix render or its settings
  // hash.
  // -------------------------------------------------------------------------
  describe('static-prefix byte-stability across consecutive turns', () => {
    function renderTurnPair(
      firstMessage: SubstrateMessage,
      secondMessage: SubstrateMessage,
      speaker: HarnessParticipant,
    ): { first: StaticPrefixRender; second: StaticPrefixRender } {
      const first = renderStaticPrefix(composer, firstMessage, speaker, 'api', FIXTURE_NOW);
      const second = renderStaticPrefix(
        composer,
        secondMessage,
        speaker,
        'api',
        new Date(FIXTURE_NOW.getTime() + 4_000),
      );
      return { first, second };
    }

    it('DM pair: byte-equal static prefix with clock advanced and a different user message', () => {
      const { first, second } = renderTurnPair(
        { ...makeDmTurnMessage(ALICE), content: 'Quick question about tomorrow.' },
        { ...makeDmTurnMessage(ALICE), content: 'Actually, one more thing.' },
        ALICE,
      );
      expect(first.renderedPrefix).not.toMatch(/\{\{/u);
      expect(second.staticHash).toBe(first.staticHash);
      expect(second.settingsHash).toBe(first.settingsHash);
      expect(second.renderedPrefix).toBe(first.renderedPrefix);
    });

    it('quiet group pair: byte-equal static prefix with clock advanced and a different room message', () => {
      const { first, second } = renderTurnPair(
        { ...makeGroupTurnMessage(CAROL), content: 'Venue shortlist is ready.' },
        { ...makeGroupTurnMessage(CAROL), content: 'Adding the agenda draft now.' },
        CAROL,
      );
      expect(first.renderedPrefix).not.toMatch(/\{\{/u);
      expect(second.staticHash).toBe(first.staticHash);
      expect(second.settingsHash).toBe(first.settingsHash);
      expect(second.renderedPrefix).toBe(first.renderedPrefix);
    });
  });
});
