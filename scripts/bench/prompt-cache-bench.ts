#!/usr/bin/env tsx
// ── Prompt-cache benchmark harness (mmo9.7.6) ──
//
// Measures the ONLY thing that determines provider prompt-cache value: how
// byte-stable the cacheable system-prompt PREFIX (PromptPlan blocks of
// volatility 'static' + 'session_stable') stays turn-over-turn, per lane, and
// what fraction of the per-turn system prompt that stable prefix represents.
//
// It drives the REAL runtime machinery — createPromptPlanBlock /
// buildPromptPlanCachePlan / computePromptPlanCachePrefixes /
// serializePromptPlanSystemPrompt and PromptCacheTurnRuntime.checkPrefixStability
// — over representative per-lane fixture prompt assemblies. It is OFFLINE: it
// makes no provider calls and spends nothing. Absolute prices are illustrative
// (documented Anthropic prompt-cache economics; the models.seed.json cost
// fields are empty in-repo), but the cache multipliers that drive the delta are
// provider policy, not guesses.
//
// A --live mode is documented but intentionally NOT implemented here: a live
// run measures real cache_read / cache_write tokens from LLMResponse
// usageDetails on one companion and requires operator approval (bead
// 9hyv). See printLiveInstructions().

import { countTokens, formatTokens } from '../../src/primitives/llm/tokens.js';
import {
  buildPromptPlanCachePlan,
  computePromptPlanCachePrefixes,
  createPromptPlanBlock,
  serializePromptPlanSystemPrompt,
  type PromptPlanBlock,
  type PromptPlanLayer,
  type PromptPlanVolatility,
} from '../../src/core/agent/substrate-agent/turn-execution/prompt-plan.js';
import { PromptCacheTurnRuntime } from '../../src/core/agent/substrate-agent/turn-execution/prompt-cache-runtime.js';

// ── Cost model (Anthropic prompt-cache economics; overridable) ──
interface CostModel {
  inputPer1MUsd: number;
  cacheReadMultiplier: number; // cache_read cost relative to base input
  cacheWriteMultiplier: number; // cache_write (first-write) cost relative to base input
}
const DEFAULT_COST: CostModel = {
  inputPer1MUsd: 3.0, // illustrative: Claude Sonnet-class input $/Mtok
  cacheReadMultiplier: 0.1, // cache read ≈ 0.1x input
  cacheWriteMultiplier: 1.25, // cache write ≈ 1.25x input
};

// ── Representative filler sized to a token target (cl100k via countTokens) ──
const LOREM = (
  'the companion remembers a quiet afternoon and the way light moved across '
  + 'the room while she considered what to say next about trust memory and care '
).split(/\s+/).filter(Boolean);
function filler(targetTokens: number, salt = ''): string {
  if (targetTokens <= 0) return '';
  const words: string[] = [];
  let i = 0;
  let text = salt ? `${salt} ` : '';
  // Grow until we hit the token target (cheap; fixtures are small).
  while (countTokens(text) < targetTokens) {
    words.push(LOREM[i % LOREM.length]);
    i += 1;
    if (i % 8 === 0) text = `${salt ? `${salt} ` : ''}${words.join(' ')}`;
    else text = `${salt ? `${salt} ` : ''}${words.join(' ')}`;
  }
  return text.trim();
}

function block(
  id: string,
  layer: PromptPlanLayer,
  volatility: PromptPlanVolatility,
  renderedText: string,
): PromptPlanBlock {
  return createPromptPlanBlock({ id, layer, volatility, producer: 'bench', renderedText });
}

// ── Lane fixtures ──
// Each lane returns the ordered blocks for a given turn. Blocks whose text is a
// pure function of `turn` are the volatile tail; blocks with turn-independent
// text are the cacheable prefix. Sizes approximate the production topology
// mapped for this bead (chat/reflection share assembleTurnPrompt; extraction &
// appraisal build ad-hoc string prompts with NO cachePlan today).

interface Lane {
  name: string;
  description: string;
  wiredToCachePlan: boolean; // does this lane register a cachePlan/cache directive in production today?
  note?: string;
  buildTurn: (turn: number) => PromptPlanBlock[];
}

// Stable text captured once so every turn re-uses the identical bytes.
const CHAT_STATIC = [
  '<character_foundation>',
  filler(2400, 'persona identity values skills temporal-rules'),
  '</character_foundation>',
].join('\n');
const CHAT_CANARY = '<cogsec_canary>session-marker-7f3a</cogsec_canary>';
const APPRAISAL_SYSTEM = [
  '<appraisal_task>',
  filler(480, 'appraise VAD discrete-emotions confidence schema instructions'),
  '</appraisal_task>',
].join('\n');
const EXTRACTION_TEMPLATE = [
  '<extraction_task>',
  filler(760, 'extract facts schema json existing-facts recent-messages instructions'),
  '</extraction_task>',
].join('\n');

function chatTurnBlocks(turn: number): PromptPlanBlock[] {
  return [
    block('static_prefix', 'prompt_stack', 'static', CHAT_STATIC),
    block('cogsec.canary', 'prompt_stack', 'session_stable', CHAT_CANARY),
    block('dynamic_suffix', 'prompt_stack', 'turn', filler(150, `suffix turn ${turn} mood`)),
    block('runtime.persona_adaptation', 'runtime', 'turn', filler(120, `adapt ${turn}`)),
    block('runtime.context', 'runtime', 'turn', filler(210, `ctx ${turn} mood curious`)),
    block('runtime.scratchpad', 'runtime', 'turn', filler(60, `pad ${turn}`)),
    block('memory.retrieval', 'session', 'turn', filler(620, `mem ${turn}`)),
    block('wiki.retrieval', 'session', 'turn', filler(180, `wiki ${turn}`)),
    block('session_context', 'provider', 'turn', filler(400, `session ${turn} recent`)),
    block(
      'runtime.current_datetime',
      'provider',
      'turn',
      `<runtime.current_datetime><iso>2026-07-15T2${turn % 10}:00:00Z</iso></runtime.current_datetime>`,
    ),
  ];
}

const LANES: Lane[] = [
  {
    name: 'chat',
    description: 'Main conversational reply (assembleTurnPrompt → PromptPlan).',
    wiredToCachePlan: true,
    buildTurn: chatTurnBlocks,
  },
  {
    name: 'reflection',
    description: 'Scheduler reflection/heartbeat — same assembleTurnPrompt path; '
      + 'reflection text rides in the user message, so the system prefix is identical to chat.',
    wiredToCachePlan: true,
    buildTurn: chatTurnBlocks,
  },
  {
    name: 'appraisal',
    description: 'Emotion appraisal — FIXED system-prompt constant; all volatile '
      + 'data (VAD, emotions, recent messages) rides in the user message.',
    wiredToCachePlan: false,
    note: 'System prompt is byte-stable across turns but NO cachePlan is registered today '
      + '(completeWithWorkSpec, ad-hoc string). Latent opportunity: wiring a static block would '
      + 'make the whole system prompt cacheable.',
    buildTurn: () => [
      // The constant system prompt modeled as a static block; volatile data is
      // NOT in the system prompt (it is in the user message), so the whole
      // system prefix is stable turn-over-turn.
      block('appraisal.system', 'prompt_stack', 'static', APPRAISAL_SYSTEM),
    ],
  },
  {
    name: 'extraction',
    description: 'Memory extraction — ad-hoc string system prompt with {existing_facts} '
      + 'and {recent_messages} interpolated INTO the system prompt.',
    wiredToCachePlan: false,
    note: 'Volatile data is interpolated into the system-prompt string, so even the fixed '
      + 'template is not held byte-stable → NO cacheable prefix as shipped. A refactor that '
      + 'moved the transcript/existing-facts into the user message would expose the ~template '
      + 'region as cacheable.',
    buildTurn: turn => [
      // The whole system prompt mutates each run: template + interpolated data
      // is one 'turn'-volatility block → staticBoundary collapses to 0.
      block(
        'extraction.system',
        'prompt_stack',
        'turn',
        `${EXTRACTION_TEMPLATE}\n<existing_facts>${filler(600, `facts ${turn}`)}</existing_facts>`
          + `\n<recent_messages>${filler(800, `msgs ${turn}`)}</recent_messages>`,
      ),
    ],
  },
];

interface LaneResult {
  name: string;
  description: string;
  wiredToCachePlan: boolean;
  note?: string;
  turns: number;
  systemTokens: number; // per-turn system prompt tokens (turn 1)
  staticTokens: number;
  sessionStableTokens: number;
  cacheablePrefixTokens: number;
  volatileTailTokens: number;
  cacheableFraction: number; // cacheable prefix / system prompt
  prefixStable: boolean; // static hash identical across all turns
  stableTurnPairs: number; // consecutive turn pairs with identical static hash
  firstInstabilityTurn?: number;
  estCacheHitTokens: number; // sum of cacheable tokens served as cache_read over the conversation
  baselineInputTokens: number; // sum of system-prompt input tokens with no cache
  cachedInputCostUnits: number; // in "base input token" equivalents
  savingsFraction: number; // fraction of system-prompt input cost saved
  savingsUsd: number;
  baselineUsd: number;
}

function analyzeLane(lane: Lane, turns: number, cost: CostModel): LaneResult {
  const runtime = new PromptCacheTurnRuntime();
  const scopeKey = `bench:${lane.name}`;
  let prefixStable = true;
  let stableTurnPairs = 0;
  let firstInstabilityTurn: number | undefined;

  let systemTokens = 0;
  let staticTokens = 0;
  let sessionStableTokens = 0;
  let cacheablePrefixTokens = 0;

  for (let turn = 1; turn <= turns; turn += 1) {
    const blocks = lane.buildTurn(turn);
    const cachePlan = buildPromptPlanCachePlan(blocks);
    const plan = { blocks, cachePlan };
    const systemPrompt = serializePromptPlanSystemPrompt(plan);
    const prefixes = computePromptPlanCachePrefixes(plan);

    if (turn === 1) {
      systemTokens = countTokens(systemPrompt);
      if (prefixes.ok) {
        staticTokens = countTokens(prefixes.staticPrefixText);
        cacheablePrefixTokens = countTokens(prefixes.sessionStablePrefixText);
        sessionStableTokens = cacheablePrefixTokens - staticTokens;
      }
    }

    const stability = runtime.checkPrefixStability({ scopeKey, turnId: `t${turn}`, plan });
    if (!stability.firstObservation) {
      if (stability.stable) stableTurnPairs += 1;
      else {
        prefixStable = false;
        firstInstabilityTurn ??= turn;
      }
    }
  }

  const volatileTailTokens = Math.max(0, systemTokens - cacheablePrefixTokens);
  const cacheableFraction = systemTokens > 0 ? cacheablePrefixTokens / systemTokens : 0;

  // Cache economics over `turns` consecutive turns on one scope, ASSUMING the
  // lane is (or were) wired to a cachePlan and the prefix stays stable:
  //   turn 1 writes the cacheable prefix (cacheWriteMultiplier)
  //   turns 2..T read it (cacheReadMultiplier) — only while stable
  //   the volatile tail is always full-price input every turn
  const P = cacheablePrefixTokens;
  const V = volatileTailTokens;
  const readableTurns = prefixStable ? turns - 1 : Math.min(stableTurnPairs, turns - 1);
  const estCacheHitTokens = P * readableTurns;
  const baselineInputTokens = (P + V) * turns;
  const cachedPrefixUnits = P * (cost.cacheWriteMultiplier + cost.cacheReadMultiplier * readableTurns)
    + P * Math.max(0, turns - 1 - readableTurns); // any non-stable turns re-pay full prefix
  const cachedInputCostUnits = cachedPrefixUnits + V * turns;
  const savingsUnits = baselineInputTokens - cachedInputCostUnits;
  const savingsFraction = baselineInputTokens > 0 ? savingsUnits / baselineInputTokens : 0;
  const perTokenUsd = cost.inputPer1MUsd / 1_000_000;
  const baselineUsd = baselineInputTokens * perTokenUsd;
  const savingsUsd = savingsUnits * perTokenUsd;

  return {
    name: lane.name,
    description: lane.description,
    wiredToCachePlan: lane.wiredToCachePlan,
    note: lane.note,
    turns,
    systemTokens,
    staticTokens,
    sessionStableTokens,
    cacheablePrefixTokens,
    volatileTailTokens,
    cacheableFraction,
    prefixStable,
    stableTurnPairs,
    firstInstabilityTurn,
    estCacheHitTokens,
    baselineInputTokens,
    cachedInputCostUnits,
    savingsFraction,
    savingsUsd,
    baselineUsd,
  };
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function printReport(results: LaneResult[], turns: number, cost: CostModel): void {
  const lines: string[] = [];
  lines.push(`# Prompt-cache offline benchmark (turns=${turns})`);
  lines.push('');
  lines.push(
    `Cost model: input $${cost.inputPer1MUsd}/Mtok, cache_read ${cost.cacheReadMultiplier}x, `
      + `cache_write ${cost.cacheWriteMultiplier}x (illustrative Anthropic economics).`,
  );
  lines.push('');
  lines.push('| lane | wired | sys tok | cacheable prefix tok | cacheable % | prefix stable | est cache-read tok | input$ saved / conv | savings % |');
  lines.push('|------|-------|--------:|---------------------:|------------:|:-------------:|-------------------:|--------------------:|----------:|');
  for (const r of results) {
    lines.push(
      `| ${r.name} | ${r.wiredToCachePlan ? 'yes' : 'no'} | ${formatTokens(r.systemTokens)} | `
        + `${formatTokens(r.cacheablePrefixTokens)} | ${pct(r.cacheableFraction)} | `
        + `${r.cacheablePrefixTokens === 0 ? 'n/a' : r.prefixStable ? 'stable' : `UNSTABLE@t${r.firstInstabilityTurn}`} | `
        + `${formatTokens(r.estCacheHitTokens)} | $${r.savingsUsd.toFixed(5)} | ${pct(r.savingsFraction)} |`,
    );
  }
  lines.push('');
  for (const r of results) {
    lines.push(`## ${r.name}`);
    lines.push(`- ${r.description}`);
    lines.push(
      `- static=${r.staticTokens} tok, session_stable=${r.sessionStableTokens} tok, `
        + `cacheable prefix=${r.cacheablePrefixTokens} tok, volatile tail=${r.volatileTailTokens} tok`,
    );
    lines.push(
      `- prefix stability over ${turns} turns: `
        + `${r.cacheablePrefixTokens === 0
          ? 'n/a — no cacheable prefix (staticBoundary=0)'
          : r.prefixStable
            ? 'STABLE (all pairs identical)'
            : `UNSTABLE from turn ${r.firstInstabilityTurn}`} `
        + `(${r.stableTurnPairs}/${turns - 1} stable turn pairs)`,
    );
    lines.push(
      `- est cache_read tokens/conv: ${r.estCacheHitTokens}; baseline input $${r.baselineUsd.toFixed(5)}; `
        + `saved $${r.savingsUsd.toFixed(5)} (${pct(r.savingsFraction)} of system-prompt input cost)`,
    );
    if (!r.wiredToCachePlan) {
      lines.push(`- NOT wired to a cachePlan today: figures are the POTENTIAL if wired. ${r.note ?? ''}`);
    }
    lines.push('');
  }
  process.stdout.write(lines.join('\n') + '\n');
}

function printLiveInstructions(): void {
  process.stdout.write(
    [
      '# Live prompt-cache validation (operator-run — NOT executed here)',
      '',
      'Live mode measures REAL cache_read / cache_write tokens and cost from the',
      'provider instead of the offline prefix model. It spends money and must run',
      'against one consenting companion only. Tracked as bead 9hyv.',
      '',
      'Procedure:',
      '1. On ONE companion, set models.json promptCaching.enabled=true (owner file,',
      '   NOT .env), retention="short", scope="channel". Confirm the seam is off',
      '   everywhere else.',
      '2. Pick an Anthropic (or OpenRouter→anthropic/*) chat model so',
      '   anthropic_cache_control / passthrough engages a content-hash cache.',
      '3. Drive N>=5 consecutive turns in ONE DM scope with a quiet static prefix.',
      '4. Read LLMResponse.usageDetails.cacheRead / cacheWrite (and cost.cacheRead/',
      '   cacheWrite) per turn; expect ~0 cacheRead on turn 1 (write) and',
      '   cacheRead ≈ cacheable-prefix tokens on turns 2..N.',
      '5. Confirm providerObservability.promptCaching.sessionId is companion-scoped',
      '   (psfnpc-*) and DIFFERS from a second companion on the same channel.',
      '6. Compare realized cache-hit fraction / $ delta against this offline model.',
      '',
    ].join('\n') + '\n',
  );
}

function main(): void {
  const argv = process.argv.slice(2);
  const turnsArg = argv.find(a => a.startsWith('--turns='));
  const turns = turnsArg ? Math.max(2, Number(turnsArg.split('=')[1]) || 10) : 10;
  const cost = { ...DEFAULT_COST };
  const priceArg = argv.find(a => a.startsWith('--input-usd='));
  if (priceArg) cost.inputPer1MUsd = Number(priceArg.split('=')[1]) || cost.inputPer1MUsd;

  if (argv.includes('--live')) {
    process.stderr.write(
      'Refusing to run live mode: live provider round-trips require operator approval '
        + '(bead 9hyv). Printing the documented procedure instead.\n',
    );
    printLiveInstructions();
    return;
  }

  const results = LANES.map(lane => analyzeLane(lane, turns, cost));

  if (argv.includes('--json')) {
    process.stdout.write(JSON.stringify({ turns, cost, lanes: results }, null, 2) + '\n');
    return;
  }

  printReport(results, turns, cost);
}

main();
