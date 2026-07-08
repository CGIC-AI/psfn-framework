import { createHash } from 'node:crypto';
import type { SubstrateMessage } from '../../../shared/contracts/runtime.js';
import type { AppCache } from '../../../shared/cache/types.js';
import type { PromptComposer } from '../../identity/prompt-composer.js';
import type { ComposeContext, ComposedDynamicSection } from '../../identity/prompt-types.js';
import {
  getVolatileClockPromptMacroNames,
  isStaticVolatilityPromptVariable,
  normalizePromptMacroName,
  renderFinalPromptSection,
} from '../../identity/prompt-runtime.js';
import type {
  PromptCacheBreaker,
  PromptCacheabilityClass,
  PromptSectionCacheability,
  TurnPromptSnapshot,
} from '../../turns/snapshot.js';
import { buildSnapshotVersionPointer } from '../../turns/snapshot.js';

export interface PromptSections {
  staticPrefix: string;
  dynamicSuffix: string;
  /** Per-layer dynamic sections with render policy (E2.5). */
  dynamicSections: ComposedDynamicSection[];
  staticHash: string;
  sectionCacheability: PromptSectionCacheability[];
}

export interface FrozenPromptPrefix {
  renderedPrefix: string;
  staticHash: string;
  settingsHash: string;
}

export interface StaticPromptPrefixCacheEvent {
  event: 'hit' | 'miss' | 'stored' | 'invalid_record';
  backend: AppCache['backend'];
  cacheKeyHash: string;
  staticHash: string;
  settingsHash: string;
}

interface FrozenPromptPrefixCacheRecord extends FrozenPromptPrefix {
  schemaVersion: 1;
}

export const STATIC_PROMPT_PREFIX_CACHE_KEY_PREFIX = 'prompt:static-prefix:v1:';
const PROMPT_HASH_LENGTH = 16;
const PROMPT_MACRO_PATTERN = /\{\{\s*([a-zA-Z0-9_.-]+(?:\(\))?)\s*\}\}/g;
// {{#if var}} guard variables are referenced variables too: a guard-only
// variable change alters the rendered output, so it must invalidate the
// static-prefix cache and participate in macro cacheability classification.
const PROMPT_MACRO_GUARD_PATTERN = /\{\{#if\s+([a-zA-Z0-9_.-]+(?:\(\))?)\s*\}\}/g;
// Derived from the prompt macro manifest (PROMPT_RUNTIME_MACRO_HINTS): the clock
// alias macros are the only tokens that re-render from the wall clock inside an
// otherwise cached static prefix render. Other turn-volatile macros are rejected
// from static-class layers by assertStaticPromptLayerMacroVolatility instead.
const VOLATILE_MACRO_TOKENS = new Set(getVolatileClockPromptMacroNames());
const CHANNEL_MACRO_TOKENS = new Set(['channel_id', 'channel_type']);

interface TemplateSectionConfig {
  section: 'staticPrefixTemplate' | 'dynamicSuffixTemplate';
  content: string;
  baseCacheability: PromptCacheabilityClass;
  baseBreakers: PromptCacheBreaker[];
  baseReason: string;
}

export function hashPromptText(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, PROMPT_HASH_LENGTH);
}

function normalizePromptMacroToken(token: string): string {
  return normalizePromptMacroName(token);
}

function collectPromptMacroTokens(text: string): string[] {
  const tokens = new Set<string>();
  text.replace(PROMPT_MACRO_PATTERN, (_match, rawToken: string) => {
    tokens.add(normalizePromptMacroToken(rawToken));
    return '';
  });
  text.replace(PROMPT_MACRO_GUARD_PATTERN, (_match, rawToken: string) => {
    tokens.add(normalizePromptMacroToken(rawToken));
    return '';
  });
  return [...tokens];
}

function uniqueBreakers(breakers: readonly PromptCacheBreaker[]): PromptCacheBreaker[] {
  return [...new Set(breakers)];
}

function buildTemplateSectionCacheability(config: TemplateSectionConfig): PromptSectionCacheability {
  const macroTokens = collectPromptMacroTokens(config.content);
  const hasMacroTokens = macroTokens.length > 0;
  const hasVolatileMacro = macroTokens.some(token => VOLATILE_MACRO_TOKENS.has(token));
  const hasChannelMacro = macroTokens.some(token => CHANNEL_MACRO_TOKENS.has(token));
  const cacheability = hasVolatileMacro
    ? 'volatile'
    : (hasMacroTokens && config.baseCacheability === 'static' ? 'session_stable' : config.baseCacheability);
  const cacheBreakers = uniqueBreakers([
    ...config.baseBreakers,
    ...(hasMacroTokens ? ['macro', 'runtime'] satisfies PromptCacheBreaker[] : []),
    ...(hasChannelMacro ? ['channel'] satisfies PromptCacheBreaker[] : []),
  ]);
  const reason = hasMacroTokens
    ? hasVolatileMacro
      ? `${config.baseReason} Runtime macros in this section re-render on each turn.`
      : `${config.baseReason} Runtime macros make the rendered output session-bound instead of globally static.`
    : config.baseReason;
  return {
    section: config.section,
    cacheability,
    cacheBreakers,
    reason,
  };
}

export function buildPromptTemplateSectionCacheability(input: {
  staticPrefix: string;
  dynamicSuffix: string;
}): PromptSectionCacheability[] {
  const sections: PromptSectionCacheability[] = [];
  if (input.staticPrefix.trim().length > 0) {
    sections.push(buildTemplateSectionCacheability({
      section: 'staticPrefixTemplate',
      content: input.staticPrefix,
      baseCacheability: 'static',
      baseBreakers: ['prompt_layer'],
      baseReason: 'Frozen base/operator prompt layers only change when the prompt stack is edited.',
    }));
  }
  if (input.dynamicSuffix.trim().length > 0) {
    sections.push(buildTemplateSectionCacheability({
      section: 'dynamicSuffixTemplate',
      content: input.dynamicSuffix,
      baseCacheability: 'session_stable',
      baseBreakers: ['prompt_layer', 'runtime', 'channel', 'task'],
      baseReason: 'Runtime/channel/task overlays stay stable until compose context or prompt layers change.',
    }));
  }
  return sections;
}

function cloneSectionCacheability(
  section: PromptSectionCacheability | null | undefined,
  overrides: Partial<PromptSectionCacheability> = {},
): PromptSectionCacheability | null {
  if (!section) return null;
  return {
    ...section,
    ...overrides,
    cacheBreakers: overrides.cacheBreakers ? [...overrides.cacheBreakers] : [...section.cacheBreakers],
  };
}

function getSectionCacheability(
  sections: readonly PromptSectionCacheability[] | undefined,
  key: PromptSectionCacheability['section'],
): PromptSectionCacheability | null {
  return sections?.find(section => section.section === key) ?? null;
}

export function buildPromptContextSectionCacheability(input: {
  promptSnapshot?: Pick<TurnPromptSnapshot, 'sectionCacheability'> | null;
  renderedStaticPrefix: string;
  renderedDynamicSuffix: string;
  runtimeContext: string;
  memoryContextBlock: string;
  scratchpadContext: string;
  assembledPrompt: string;
  finalSystemPrompt: string;
  messageCount: number;
}): PromptSectionCacheability[] {
  const sections: PromptSectionCacheability[] = [];
  const staticTemplate = cloneSectionCacheability(
    getSectionCacheability(input.promptSnapshot?.sectionCacheability, 'staticPrefixTemplate'),
    { section: 'renderedStaticPrefix' },
  );
  if (staticTemplate && input.renderedStaticPrefix.trim().length > 0) {
    sections.push(staticTemplate);
  }

  if (input.renderedDynamicSuffix.trim().length > 0) {
    sections.push({
      section: 'renderedDynamicSuffix',
      cacheability: 'volatile',
      cacheBreakers: ['runtime', 'channel', 'task', 'macro'],
      reason: 'The rendered dynamic suffix includes runtime overlays, macro expansion, and persona adaptation for this turn.',
    });
  }

  if (input.runtimeContext.trim().length > 0) {
    sections.push({
      section: 'runtimeContext',
      cacheability: 'volatile',
      cacheBreakers: ['runtime', 'channel', 'tool'],
      reason: 'Runtime context is rebuilt from live channel state, trust, and active tool guidance each turn.',
    });
  }

  if (input.memoryContextBlock.trim().length > 0) {
    sections.push({
      section: 'memoryContextBlock',
      cacheability: 'volatile',
      cacheBreakers: ['retrieval'],
      reason: 'Memory context depends on retrieval results and proactive recall selected for this turn.',
    });
  }

  if (input.scratchpadContext.trim().length > 0) {
    sections.push({
      section: 'scratchpadContext',
      cacheability: 'volatile',
      cacheBreakers: ['scratchpad'],
      reason: 'Scratchpad context reflects per-turn working state and cannot be reused safely.',
    });
  }

  if (input.assembledPrompt.trim().length > 0) {
    sections.push({
      section: 'assembledPrompt',
      cacheability: 'volatile',
      cacheBreakers: ['runtime', 'channel', 'tool', 'scratchpad'],
      reason: 'The assembled prompt combines live runtime context with scratchpad state before session context is added.',
    });
  }

  if (input.finalSystemPrompt.trim().length > 0) {
    sections.push({
      section: 'finalSystemPrompt',
      cacheability: 'volatile',
      cacheBreakers: uniqueBreakers([
        'runtime',
        'channel',
        'tool',
        ...(input.memoryContextBlock.trim().length > 0 ? ['retrieval'] satisfies PromptCacheBreaker[] : []),
        ...(input.scratchpadContext.trim().length > 0 ? ['scratchpad'] satisfies PromptCacheBreaker[] : []),
        ...(input.messageCount > 0 ? ['session_history'] satisfies PromptCacheBreaker[] : []),
      ]),
      reason: 'The final system prompt is rebuilt from runtime context, session history, and any live retrieval or scratchpad blocks.',
    });
  }

  if (input.messageCount > 0) {
    sections.push({
      section: 'messages',
      cacheability: 'append_only',
      cacheBreakers: ['session_history'],
      reason: 'Model context messages grow with session history and compaction rather than staying byte-for-byte static.',
    });
  }

  return sections;
}

export function composePromptSections(input: {
  promptComposer: PromptComposer | null | undefined;
  composeContext: ComposeContext;
  systemPrompt: string;
}): PromptSections {
  const { promptComposer, composeContext, systemPrompt } = input;
  if (!promptComposer) {
    return {
      staticPrefix: systemPrompt,
      dynamicSuffix: '',
      dynamicSections: [],
      staticHash: hashPromptText(systemPrompt),
      sectionCacheability: buildPromptTemplateSectionCacheability({
        staticPrefix: systemPrompt,
        dynamicSuffix: '',
      }),
    };
  }

  // Single composer entrypoint (E2.2): composeSplit's static/dynamic split is
  // the source of the PromptPlan volatility boundaries. No unsplit fallback.
  const split = promptComposer.composeSplit(composeContext);
  // Boundary guard: injected composer doubles (tests) may predate the E2.5
  // dynamicSections contract; downstream falls back to the joined template.
  const composedDynamicSections = (split.dynamicSections as ComposedDynamicSection[] | undefined) ?? [];
  return {
    staticPrefix: split.staticPrefix,
    dynamicSuffix: split.dynamicSuffix,
    dynamicSections: composedDynamicSections.map(section => ({ ...section })),
    staticHash: split.staticHash,
    sectionCacheability: buildPromptTemplateSectionCacheability({
      staticPrefix: split.staticPrefix,
      dynamicSuffix: split.dynamicSuffix,
    }),
  };
}

export function captureTurnPromptSnapshot(input: {
  promptComposer: PromptComposer | null | undefined;
  composeContext: ComposeContext;
  systemPrompt: string;
}): TurnPromptSnapshot {
  const sections = composePromptSections(input);
  return {
    staticPrefixTemplate: sections.staticPrefix,
    dynamicSuffixTemplate: sections.dynamicSuffix,
    dynamicSuffixSections: sections.dynamicSections,
    staticHash: sections.staticHash,
    versionPointer: buildSnapshotVersionPointer([
      sections.staticHash,
      hashPromptText(sections.dynamicSuffix),
    ]),
    sectionCacheability: sections.sectionCacheability,
  };
}

export function buildPromptPrefixCacheKey(
  message: SubstrateMessage,
  channelType: string | undefined,
  canonicalContactKey: string | undefined,
  subjectIdentityKey?: string,
): string {
  return [
    message.channelId,
    channelType ?? 'unknown',
    subjectIdentityKey ?? canonicalContactKey ?? message.authorId,
  ].join('::');
}

// Derived from the prompt macro manifest: only 'static'-volatility variables
// (character card fields, config-owned identifiers) participate in the static
// settings hash. Unknown keys fail closed to non-stable.
function isStaticPromptStableVariable(key: string): boolean {
  return isStaticVolatilityPromptVariable(key);
}

export function buildStaticPromptSettingsHash(
  templateVariables: Record<string, string>,
  staticPrefixTemplate?: string,
): string {
  const referencedTokens = staticPrefixTemplate
    ? new Set(collectPromptMacroTokens(staticPrefixTemplate))
    : null;
  const stableEntries = Object.entries(templateVariables)
    .filter(([key]) => (
      isStaticPromptStableVariable(key)
      && (
        referencedTokens === null
        || referencedTokens.has(normalizePromptMacroToken(key))
      )
    ))
    .sort(([left], [right]) => left.localeCompare(right));
  return hashPromptText(JSON.stringify(stableEntries));
}

export function resolveStaticPromptPrefix(input: {
  cache: Map<string, FrozenPromptPrefix>;
  cacheKey: string;
  staticPrefixTemplate: string;
  staticHash: string;
  settingsHash: string;
  now: Date;
  variables: Record<string, string>;
}): string {
  const cached = input.cache.get(input.cacheKey);
  if (cached && cached.staticHash === input.staticHash && cached.settingsHash === input.settingsHash) {
    return cached.renderedPrefix;
  }

  // The static prefix is a required render unit (E2.5): an unresolved macro
  // here fails the turn loudly instead of leaking template syntax into the
  // cached prompt prefix.
  const renderedPrefix = renderFinalPromptSection(input.staticPrefixTemplate, {
    now: input.now,
    variables: input.variables,
    sectionLabel: 'static prompt prefix',
    required: true,
  });
  input.cache.set(input.cacheKey, {
    renderedPrefix,
    staticHash: input.staticHash,
    settingsHash: input.settingsHash,
  });
  return renderedPrefix;
}

function buildStaticPromptPrefixCacheKey(input: {
  cacheKey: string;
  staticHash: string;
  settingsHash: string;
}): { key: string; cacheKeyHash: string } {
  const cacheKeyHash = hashPromptText(input.cacheKey);
  return {
    cacheKeyHash,
    key: [
      STATIC_PROMPT_PREFIX_CACHE_KEY_PREFIX,
      cacheKeyHash,
      ':',
      input.staticHash,
      ':',
      input.settingsHash,
    ].join(''),
  };
}

function parseFrozenPromptPrefixCacheRecord(raw: string): FrozenPromptPrefixCacheRecord | null {
  try {
    const parsed = JSON.parse(raw) as Partial<FrozenPromptPrefixCacheRecord>;
    if (parsed.schemaVersion !== 1) return null;
    if (typeof parsed.renderedPrefix !== 'string') return null;
    if (typeof parsed.staticHash !== 'string') return null;
    if (typeof parsed.settingsHash !== 'string') return null;
    return {
      schemaVersion: 1,
      renderedPrefix: parsed.renderedPrefix,
      staticHash: parsed.staticHash,
      settingsHash: parsed.settingsHash,
    };
  } catch {
    return null;
  }
}

export async function resolveStaticPromptPrefixFromAppCache(input: {
  cache: AppCache;
  cacheKey: string;
  staticPrefixTemplate: string;
  staticHash: string;
  settingsHash: string;
  now: Date;
  variables: Record<string, string>;
  onCacheEvent?: (event: StaticPromptPrefixCacheEvent) => void;
}): Promise<string> {
  const { key, cacheKeyHash } = buildStaticPromptPrefixCacheKey(input);
  const eventBase = {
    backend: input.cache.backend,
    cacheKeyHash,
    staticHash: input.staticHash,
    settingsHash: input.settingsHash,
  } satisfies Omit<StaticPromptPrefixCacheEvent, 'event'>;

  const cached = await input.cache.get(key);
  if (cached !== null) {
    const parsed = parseFrozenPromptPrefixCacheRecord(cached);
    if (
      parsed
      && parsed.staticHash === input.staticHash
      && parsed.settingsHash === input.settingsHash
    ) {
      input.onCacheEvent?.({ ...eventBase, event: 'hit' });
      return parsed.renderedPrefix;
    }
    await input.cache.delete(key);
    input.onCacheEvent?.({ ...eventBase, event: 'invalid_record' });
  } else {
    input.onCacheEvent?.({ ...eventBase, event: 'miss' });
  }

  const renderedPrefix = renderFinalPromptSection(input.staticPrefixTemplate, {
    now: input.now,
    variables: input.variables,
    sectionLabel: 'static prompt prefix',
    required: true,
  });
  const record: FrozenPromptPrefixCacheRecord = {
    schemaVersion: 1,
    renderedPrefix,
    staticHash: input.staticHash,
    settingsHash: input.settingsHash,
  };
  await input.cache.set(key, JSON.stringify(record));
  input.onCacheEvent?.({ ...eventBase, event: 'stored' });
  return renderedPrefix;
}
