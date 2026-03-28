import { createHash } from 'node:crypto';
import type { SubstrateMessage } from '../../shared/contracts/runtime.js';
import type { PromptComposer } from '../../identity/prompt-composer.js';
import type { ComposeContext, ComposeSplitResult } from '../../identity/prompt-types.js';
import { injectPromptRuntimeTokens } from '../../identity/prompt-runtime.js';
import type { TurnPromptSnapshot } from '../../turns/snapshot.js';
import { buildSnapshotVersionPointer } from '../../turns/snapshot.js';

export interface PromptSections {
  staticPrefix: string;
  dynamicSuffix: string;
  staticHash: string;
}

export interface FrozenPromptPrefix {
  renderedPrefix: string;
  staticHash: string;
  settingsHash: string;
}

const PROMPT_HASH_LENGTH = 16;

export function hashPromptText(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, PROMPT_HASH_LENGTH);
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
    };
  }

  const composed = promptComposer.compose(composeContext);
  return {
    staticPrefix: composed.text,
    dynamicSuffix: '',
    staticHash: composed.hash,
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
