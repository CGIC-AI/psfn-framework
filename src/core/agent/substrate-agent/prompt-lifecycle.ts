import { createHash } from 'node:crypto';
import type { SubstrateMessage } from '../../../shared/contracts/runtime.js';
import type { PromptComposer } from '../../identity/prompt-composer.js';
import type { ComposeContext, ComposeSplitResult } from '../../identity/prompt-types.js';
import { injectPromptRuntimeTokens } from '../../identity/prompt-runtime.js';
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
  staticHash: string;
  sectionCacheability: PromptSectionCacheability[];
}

export interface FrozenPromptPrefix {
  renderedPrefix: string;
  staticHash: string;
  settingsHash: string;
}

const PROMPT_HASH_LENGTH = 16;
const PROMPT_MACRO_PATTERN = /\{\{\s*([a-zA-Z0-9_.-]+(?:\(\))?)\s*\}\}/g;
const VOLATILE_MACRO_TOKENS = new Set([
  'current_datetime',
  'current_datetime_iso',
  'now',
  'now()',
  'current_date',
  'date',
  'date()',
  'current_time',
  'time',
  'time()',
  'current_timestamp',
  'unix_timestamp',
  'timestamp',
  'timestamp()',
]);
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
  return token.trim().toLowerCase();
}

function collectPromptMacroTokens(text: string): string[] {
  const tokens = new Set<string>();
  text.replace(PROMPT_MACRO_PATTERN, (_match, rawToken: string) => {
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
      staticHash: hashPromptText(systemPrompt),
      sectionCacheability: buildPromptTemplateSectionCacheability({
        staticPrefix: systemPrompt,
        dynamicSuffix: '',
      }),
    };
  }

  const splitComposer = promptComposer as PromptComposer & {
    composeSplit?: (ctx?: ComposeContext) => ComposeSplitResult;
  };
  if (typeof splitComposer.composeSplit === 'function') {
    const split = splitComposer.composeSplit(composeContext);
    return {
      staticPrefix: split.staticPrefix,
      dynamicSuffix: split.dynamicSuffix,
      staticHash: split.staticHash,
      sectionCacheability: buildPromptTemplateSectionCacheability({
        staticPrefix: split.staticPrefix,
        dynamicSuffix: split.dynamicSuffix,
      }),
    };
  }

  const composed = promptComposer.compose(composeContext);
  return {
    staticPrefix: composed.text,
    dynamicSuffix: '',
    staticHash: composed.hash,
    sectionCacheability: buildPromptTemplateSectionCacheability({
      staticPrefix: composed.text,
      dynamicSuffix: '',
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

export function buildStaticPromptSettingsHash(templateVariables: Record<string, string>): string {
  const stableEntries = Object.entries(templateVariables)
    .filter(([key]) => key !== 'now_iso')
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

  const renderedPrefix = injectPromptRuntimeTokens(input.staticPrefixTemplate, {
    now: input.now,
    variables: input.variables,
  });
  input.cache.set(input.cacheKey, {
    renderedPrefix,
    staticHash: input.staticHash,
    settingsHash: input.settingsHash,
  });
  return renderedPrefix;
}
