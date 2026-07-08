import type { EmbeddingProviderPort } from '../../core/agent/contracts.js';
import type { EventBus } from '../../shared/event-bus.js';
import type { CorrelationMetadata } from '../../shared/contracts/runtime.js';
import { createComponentLogger } from '../../shared/logger.js';
import { countTokens } from '../../primitives/llm/tokens.js';
import type { WikiRetrievalSettings } from '../../shared/context-budget.js';
import type { WikiProjectionPort, WikiSemanticMatch } from './pgvector-projection.js';
import { resolveReadableWikiScopes, type WikiScope } from './scope.js';

const log = createComponentLogger('WikiRetrieval');

/** Default number of candidate documents to fetch from the projection. */
const DEFAULT_WIKI_SEARCH_LIMIT = 6;

/**
 * The wiki context block is a distinct, clearly-labeled section (charter 6.26:
 * wiki world-knowledge is not lived memory). The label ships verbatim so the
 * model never conflates reference notes with L2 memory.
 */
export const WIKI_CONTEXT_BLOCK_HEADER =
  '## Reference Wiki (supplemental world knowledge — NOT lived memory)';

export type WikiRetrievalContextClass = 'dm' | 'group' | 'focus';

export interface WikiRetrievalPlan {
  contextClass: WikiRetrievalContextClass;
  tokenCap: number;
  similarityThreshold: number;
  /**
   * W5b scope restriction for this turn. `undefined` means UNRESTRICTED —
   * single-companion / flag-off, byte-identical to pre-W5b retrieval. When set,
   * it is `personal` ALWAYS plus the current site's `shared_world:<siteId>` when
   * the companion is situated at a site.
   */
  allowedScopes?: readonly WikiScope[];
}

/**
 * Deterministic gate for supplemental wiki retrieval. Returns `null` when the
 * turn must not run wiki retrieval at all (disabled, or the context class has a
 * zero cap). This is a pure function of config + turn signals so it is fully
 * unit-testable and never fires on hidden heuristics:
 *
 * - focus/project-scoped turns win first and get the higher cap;
 * - group turns get the conservative cap + stricter similarity threshold so
 *   world-info never floods group context;
 * - direct-message turns get the normal (~1k) cap.
 */
export function resolveWikiRetrievalPlan(input: {
  settings: WikiRetrievalSettings;
  isDirectMessage: boolean | undefined;
  focusActive: boolean;
  /** W5b: multi-companion topology flag. Off (default) → unrestricted scope. */
  multiCompanion?: boolean;
  /** W5b: the companion's current site (from the situated place seam), if any. */
  currentSiteId?: string | undefined;
}): WikiRetrievalPlan | null {
  const { settings } = input;
  if (!settings.enabled) return null;
  // Under flag-off this is `undefined` → the plan carries no scope restriction
  // and retrieval is byte-identical to pre-W5b. Under the flag it is
  // personal + the current site's shared scope (or personal-only when unsited).
  const allowedScopes = resolveReadableWikiScopes({
    multiCompanion: input.multiCompanion === true,
    currentSiteId: input.currentSiteId,
  });
  const scopePart = allowedScopes ? { allowedScopes } : {};
  if (input.focusActive) {
    if (settings.focusTokenCap <= 0) return null;
    return {
      contextClass: 'focus',
      tokenCap: settings.focusTokenCap,
      similarityThreshold: settings.similarityThreshold,
      ...scopePart,
    };
  }
  if (input.isDirectMessage === false) {
    if (settings.groupTokenCap <= 0) return null;
    return {
      contextClass: 'group',
      tokenCap: settings.groupTokenCap,
      similarityThreshold: settings.groupSimilarityThreshold,
      ...scopePart,
    };
  }
  if (settings.chatTokenCap <= 0) return null;
  return {
    contextClass: 'dm',
    tokenCap: settings.chatTokenCap,
    similarityThreshold: settings.similarityThreshold,
    ...scopePart,
  };
}

export interface WikiContextBuildResult {
  block: string;
  tokenCount: number;
  selectedCount: number;
}

function renderMatchEntry(match: WikiSemanticMatch): string {
  const scorePct = Math.round(match.score * 100);
  return `- [${match.title}] (${match.sourceClass}, id=${match.documentId}, match=${scorePct}%)\n${match.chunkText.trim()}`;
}

/**
 * Assemble the labeled wiki context block within its own bounded token cap.
 * The wiki budget is allocated independently of (and after) the memory budget,
 * so wiki can never displace memory content: this function only ever fits
 * entries into the wiki-specific cap and, on overflow, is what shrinks. Returns
 * an empty block with `selectedCount: 0` when nothing fits.
 */
export function buildWikiContextBlock(
  matches: readonly WikiSemanticMatch[],
  tokenCap: number,
): WikiContextBuildResult {
  const cap = Math.max(0, Math.floor(tokenCap));
  if (cap <= 0 || matches.length === 0) {
    return { block: '', tokenCount: 0, selectedCount: 0 };
  }
  const headerTokens = countTokens(WIKI_CONTEXT_BLOCK_HEADER);
  const entries: string[] = [];
  let selectedCount = 0;
  for (const match of matches) {
    const entry = renderMatchEntry(match);
    const candidate = [WIKI_CONTEXT_BLOCK_HEADER, ...entries, entry].join('\n\n');
    if (countTokens(candidate) <= cap) {
      entries.push(entry);
      selectedCount += 1;
      continue;
    }
    if (selectedCount === 0) {
      // A single entry already exceeds the wiki cap: truncate it by characters
      // so the highest-scoring reference still contributes something bounded.
      const budgetForBody = Math.max(0, cap - headerTokens);
      if (budgetForBody <= 0) break;
      const truncated = truncateEntryToTokenBudget(entry, budgetForBody);
      if (truncated) {
        entries.push(truncated);
        selectedCount += 1;
      }
    }
    break;
  }
  if (selectedCount === 0) {
    return { block: '', tokenCount: 0, selectedCount: 0 };
  }
  const block = [WIKI_CONTEXT_BLOCK_HEADER, ...entries].join('\n\n');
  return { block, tokenCount: countTokens(block), selectedCount };
}

function truncateEntryToTokenBudget(entry: string, tokenBudget: number): string | null {
  if (countTokens(entry) <= tokenBudget) return entry;
  let low = 0;
  let high = entry.length;
  let best = '';
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = `${entry.slice(0, mid).trimEnd()}…`;
    if (countTokens(candidate) <= tokenBudget) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best.length > 1 ? best : null;
}

export interface WikiRetrievalServiceDeps {
  projection: WikiProjectionPort;
  embedding: EmbeddingProviderPort;
  eventBus?: Pick<EventBus, 'emit'>;
  getSettings: () => WikiRetrievalSettings;
  /**
   * W5b: live accessor for the multi-companion topology flag. Default off, so
   * absence keeps retrieval unrestricted (byte-identical to single-companion).
   */
  getMultiCompanion?: () => boolean;
  searchLimit?: number;
}

export interface WikiRetrievalRequest {
  channelId: string;
  queryText: string;
  isDirectMessage: boolean | undefined;
  focusActive: boolean;
  /**
   * W5b: the companion's current site resolved from the situated place seam
   * (satellite `placeId` → place → `siteId`). Absent when not situated; only
   * consulted under multi-companion mode.
   */
  currentSiteId?: string | undefined;
  correlation?: Partial<CorrelationMetadata>;
}

/**
 * Supplemental, gated, capped wiki RAG for chat turns. It is opt-in
 * (config-owned enable flag, default off), deterministically gated, and
 * fail-closed: any embedding/search failure degrades to an empty block and a
 * typed `wiki.retrieval` event rather than blocking the turn. The returned
 * block is always within its own token cap and is designed to be appended to
 * prompt assembly AFTER memory context.
 */
export class WikiRetrievalService {
  private readonly deps: WikiRetrievalServiceDeps;
  private readonly searchLimit: number;

  constructor(deps: WikiRetrievalServiceDeps) {
    this.deps = deps;
    this.searchLimit = deps.searchLimit ?? DEFAULT_WIKI_SEARCH_LIMIT;
  }

  private emit(payload: {
    channelId: string;
    outcome: 'ran' | 'skipped' | 'degraded';
    reason?: string;
    contextClass?: WikiRetrievalContextClass;
    candidateCount?: number;
    selectedCount?: number;
    tokenCap?: number;
    tokenCount?: number;
    error?: string;
    correlation?: Partial<CorrelationMetadata>;
  }): void {
    const { correlation, ...rest } = payload;
    void this.deps.eventBus?.emit('wiki.retrieval', {
      ...rest,
      ...(correlation ?? {}),
      timestamp: Date.now(),
    }).catch((emitError: unknown) => {
      log.debug('Failed to emit wiki retrieval event', { channelId: payload.channelId, error: String(emitError) });
    });
  }

  async retrieveContextBlock(request: WikiRetrievalRequest): Promise<string> {
    const settings = this.deps.getSettings();
    const plan = resolveWikiRetrievalPlan({
      settings,
      isDirectMessage: request.isDirectMessage,
      focusActive: request.focusActive,
      multiCompanion: this.deps.getMultiCompanion?.() === true,
      ...(request.currentSiteId ? { currentSiteId: request.currentSiteId } : {}),
    });
    if (!plan) {
      this.emit({ channelId: request.channelId, outcome: 'skipped', reason: 'disabled', correlation: request.correlation });
      return '';
    }
    const query = request.queryText.trim();
    if (!query) {
      this.emit({
        channelId: request.channelId,
        outcome: 'skipped',
        reason: 'empty_query',
        contextClass: plan.contextClass,
        tokenCap: plan.tokenCap,
        correlation: request.correlation,
      });
      return '';
    }
    let matches: WikiSemanticMatch[];
    try {
      const embedding = await this.deps.embedding.embed(query);
      // plan.allowedScopes is undefined under flag-off → unrestricted, byte-identical.
      matches = await this.deps.projection.search(
        embedding,
        plan.similarityThreshold,
        this.searchLimit,
        plan.allowedScopes,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn('Wiki retrieval failed closed; turn proceeds without wiki context', {
        channelId: request.channelId,
        error: message,
      });
      this.emit({
        channelId: request.channelId,
        outcome: 'degraded',
        reason: 'search_failed',
        contextClass: plan.contextClass,
        tokenCap: plan.tokenCap,
        error: message,
        correlation: request.correlation,
      });
      return '';
    }
    if (matches.length === 0) {
      this.emit({
        channelId: request.channelId,
        outcome: 'skipped',
        reason: 'below_threshold',
        contextClass: plan.contextClass,
        candidateCount: 0,
        tokenCap: plan.tokenCap,
        correlation: request.correlation,
      });
      return '';
    }
    const built = buildWikiContextBlock(matches, plan.tokenCap);
    if (built.selectedCount === 0) {
      this.emit({
        channelId: request.channelId,
        outcome: 'skipped',
        reason: 'budget_exhausted',
        contextClass: plan.contextClass,
        candidateCount: matches.length,
        tokenCap: plan.tokenCap,
        correlation: request.correlation,
      });
      return '';
    }
    this.emit({
      channelId: request.channelId,
      outcome: 'ran',
      contextClass: plan.contextClass,
      candidateCount: matches.length,
      selectedCount: built.selectedCount,
      tokenCap: plan.tokenCap,
      tokenCount: built.tokenCount,
      correlation: request.correlation,
    });
    return built.block;
  }
}
