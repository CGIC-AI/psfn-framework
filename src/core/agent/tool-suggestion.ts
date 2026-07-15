import type { CapabilityAccess } from '../../system/capabilities/gate.js';
import type { CapabilityToken } from '../../system/capabilities/tokens.js';
import type { RuntimeToolCatalogEntry } from './tool-catalog.js';
import type { AdaptiveToolRuntimeState } from './adaptive-tools-telemetry.js';

export type ToolSuggestionAvailabilityStatus =
  | 'active'
  | 'capability_denied'
  | 'unavailable_this_turn';

export interface ToolSuggestionRecommendation {
  toolName: string;
  action?: string;
  confidence: number;
  reason: string;
  availabilityStatus: ToolSuggestionAvailabilityStatus;
  availabilityNote: string;
  missingTokens?: CapabilityToken[];
}

export interface ToolSuggestionResult {
  intent: string;
  limit: number;
  total: number;
  recommendations: ToolSuggestionRecommendation[];
  advisoryOnly: true;
  message?: string;
}

interface SuggestToolsInput {
  intent: string;
  limit?: number;
  catalog: readonly RuntimeToolCatalogEntry[];
  runtimeState: AdaptiveToolRuntimeState;
  access: CapabilityAccess;
}

interface CandidateScore {
  score: number;
  matchedTerms: string[];
}

interface RankedCandidate {
  entry: RuntimeToolCatalogEntry;
  action?: string;
  confidence: number;
  reason: string;
  matchScore: number;
  rankScore: number;
  availabilityStatus: ToolSuggestionAvailabilityStatus;
  availabilityNote: string;
  missingTokens?: CapabilityToken[];
}

const DEFAULT_TOOL_SUGGESTION_LIMIT = 5;
const MAX_TOOL_SUGGESTION_LIMIT = 12;
const MIN_CONFIDENT_MATCH_SCORE = 18;

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'before',
  'by',
  'can',
  'for',
  'from',
  'how',
  'i',
  'in',
  'into',
  'is',
  'it',
  'me',
  'my',
  'of',
  'on',
  'or',
  'our',
  'please',
  'that',
  'the',
  'this',
  'to',
  'use',
  'we',
  'what',
  'when',
  'where',
  'which',
  'with',
  'you',
]);

const TOOL_HINTS: Readonly<Partial<Record<string, {
  terms?: readonly string[];
  actions?: Readonly<Record<string, readonly string[]>>;
}>>> = {
  session: {
    terms: [
      'session',
      'transcript',
      'conversation',
      'chat history',
      'previous conversation',
      'prior conversation',
      'earlier message',
      'what we said',
      'focus',
    ],
    actions: {
      search: ['search transcript', 'search conversation', 'find previous', 'recall prior', 'look up previous'],
      grep: ['grep transcript', 'regex transcript', 'literal pattern'],
      list: ['list sessions', 'recent sessions'],
      new: ['new session', 'start session'],
      resume: ['resume session'],
      start_focus: ['start focus'],
      complete_focus: ['complete focus'],
    },
  },
  web: {
    terms: [
      'web',
      'internet',
      'online',
      'site',
      'website',
      'url',
      'page',
      'current information',
      'latest',
    ],
    actions: {
      search: ['web search', 'search web', 'internet search', 'current information', 'latest'],
      fetch: ['fetch url', 'read url', 'open url', 'read page'],
      browse: ['browse', 'crawler', 'crawl page'],
    },
  },
  fs: {
    terms: [
      'file',
      'files',
      'folder',
      'directory',
      'filesystem',
      'local file',
      'path',
      'workspace',
      'personal files',
    ],
    actions: {
      read: ['read file', 'open file', 'show file', 'cat file'],
      list: ['list files', 'list folder', 'directory listing'],
      search: ['search files', 'find in files', 'grep files'],
      write: ['write file', 'create file'],
      edit: ['edit file', 'patch file'],
    },
  },
  memory: {
    terms: ['memory', 'remember', 'recall', 'long term', 'stored memory'],
    actions: {
      search: ['search memory', 'recall memory'],
      write: ['write memory', 'remember this'],
    },
  },
  wiki: {
    terms: ['wiki', 'reference', 'durable knowledge', 'internal knowledge'],
    actions: {
      search: ['search wiki', 'reference search'],
      read: ['read wiki', 'read reference'],
    },
  },
  repo: {
    terms: ['repo', 'repository', 'git', 'codebase', 'diff', 'commit', 'branch'],
    actions: {
      inspect: ['repo status', 'repo diff', 'inspect repo'],
      patch: ['apply patch', 'edit code'],
      commit: ['commit changes'],
    },
  },
  beads: {
    terms: ['bead', 'beads', 'issue', 'ticket', 'tracked work'],
    actions: {
      ready: ['ready issues', 'available work'],
      show: ['show issue', 'read bead'],
      create: ['create issue', 'create bead'],
      update: ['update issue', 'claim issue'],
      close: ['close issue', 'close bead'],
    },
  },
  generate_image: {
    terms: ['image', 'media', 'picture', 'photo', 'visual', 'draw'],
    actions: {
      generate: ['generate image', 'create image', 'make picture'],
      edit: ['edit image', 'modify image'],
      analyze: ['analyze image', 'inspect image'],
    },
  },
  notify: {
    terms: ['notify', 'notification', 'send message', 'operator brief', 'approval'],
    actions: {
      brief: ['brief operator'],
      send: ['send notification', 'send message'],
      approval_request: ['approval request', 'ask approval'],
    },
  },
};

const ACTION_HINTS: Readonly<Partial<Record<string, readonly string[]>>> = {
  search: ['search', 'find', 'look up', 'lookup', 'discover'],
  read: ['read', 'open', 'show', 'inspect'],
  list: ['list', 'recent', 'show all'],
  fetch: ['fetch', 'open', 'read'],
  browse: ['browse', 'crawl'],
  write: ['write', 'save', 'create'],
  edit: ['edit', 'modify', 'patch'],
  generate: ['generate', 'create', 'make'],
  analyze: ['analyze', 'inspect'],
};

const AVAILABILITY_RANK_WEIGHT: Readonly<Record<ToolSuggestionAvailabilityStatus, number>> = {
  active: 18,
  capability_denied: -8,
  unavailable_this_turn: -16,
};

function normalizeLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_TOOL_SUGGESTION_LIMIT;
  }
  return Math.max(1, Math.min(MAX_TOOL_SUGGESTION_LIMIT, Math.floor(value)));
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/[_-]+/gu, ' ');
}

function tokenize(value: string): string[] {
  return [...new Set(
    normalizeText(value)
      .split(/[^a-z0-9]+/u)
      .map(token => token.trim())
      .filter(token => token.length > 1 && !STOP_WORDS.has(token)),
  )];
}

function uniqueStrings(values: Iterable<string>): string[] {
  return [...new Set([...values].map(value => value.trim()).filter(Boolean))];
}

function scoreTerms(
  normalizedIntent: string,
  intentTokens: ReadonlySet<string>,
  terms: readonly string[],
  phraseWeight: number,
  tokenWeight: number,
): CandidateScore {
  let score = 0;
  const matchedTerms: string[] = [];
  for (const term of uniqueStrings(terms.map(normalizeText))) {
    if (!term) continue;
    if (term.includes(' ')) {
      if (normalizedIntent.includes(term)) {
        score += phraseWeight;
        matchedTerms.push(term);
      }
      continue;
    }
    if (intentTokens.has(term)) {
      score += tokenWeight;
      matchedTerms.push(term);
    }
  }
  return {
    score,
    matchedTerms,
  };
}

function collectToolTerms(entry: RuntimeToolCatalogEntry): string[] {
  const terms = [
    entry.name,
    ...entry.name.split(/[_-]+/u),
    ...tokenize(entry.description),
    entry.schema?.canonical?.domain ?? '',
    ...(entry.schema?.canonical?.domain.split(/[_-]+/u) ?? []),
    ...(TOOL_HINTS[entry.name]?.terms ?? []),
  ];
  return uniqueStrings(terms);
}

function collectActionTerms(toolName: string, action: string): string[] {
  return uniqueStrings([
    action,
    ...action.split(/[_-]+/u),
    ...(ACTION_HINTS[action] ?? []),
    ...(TOOL_HINTS[toolName]?.actions?.[action] ?? []),
  ]);
}

function scoreTool(
  entry: RuntimeToolCatalogEntry,
  normalizedIntent: string,
  intentTokens: ReadonlySet<string>,
): CandidateScore {
  const exactName = normalizeText(entry.name);
  const terms = collectToolTerms(entry);
  const scoredTerms = scoreTerms(normalizedIntent, intentTokens, terms, 14, 5);
  const exactNameScore = exactName && normalizedIntent.includes(exactName) ? 18 : 0;
  return {
    score: exactNameScore + scoredTerms.score,
    matchedTerms: uniqueStrings([
      ...(exactNameScore > 0 ? [exactName] : []),
      ...scoredTerms.matchedTerms,
    ]),
  };
}

function scoreAction(
  toolName: string,
  action: string,
  normalizedIntent: string,
  intentTokens: ReadonlySet<string>,
): CandidateScore {
  const terms = collectActionTerms(toolName, action);
  const scoredTerms = scoreTerms(normalizedIntent, intentTokens, terms, 16, 7);
  const exactAction = normalizeText(action);
  const exactActionScore = exactAction && normalizedIntent.includes(exactAction) ? 10 : 0;
  return {
    score: exactActionScore + scoredTerms.score,
    matchedTerms: uniqueStrings([
      ...(exactActionScore > 0 ? [exactAction] : []),
      ...scoredTerms.matchedTerms,
    ]),
  };
}

function confidenceFromScore(score: number): number {
  const raw = Math.max(0, Math.min(0.99, score / 75));
  return Math.round(raw * 100) / 100;
}

function resolveActionCapabilities(
  entry: RuntimeToolCatalogEntry,
  action: string | undefined,
): CapabilityToken[] {
  if (!entry.schema) return [];
  if (!action) return entry.schema.requiredCapabilities;
  const actionEntry = entry.schema.actions.find(candidate => candidate.name === action);
  return actionEntry?.requiredCapabilities ?? entry.schema.requiredCapabilities;
}

function resolveAvailability(input: {
  entry: RuntimeToolCatalogEntry;
  action: string | undefined;
  runtimeState: AdaptiveToolRuntimeState;
  access: CapabilityAccess;
}): Pick<RankedCandidate, 'availabilityStatus' | 'availabilityNote' | 'missingTokens'> {
  const missingTokens = resolveActionCapabilities(input.entry, input.action)
    .filter(token => !input.access.has(token));
  if (missingTokens.length > 0) {
    return {
      availabilityStatus: 'capability_denied',
      availabilityNote: `Blocked by current capability tier (missing: ${missingTokens.join(', ')}).`,
      missingTokens,
    };
  }

  const isActive = input.runtimeState.activeTools.some(entry => entry.toolName === input.entry.name);
  if (isActive) {
    return {
      availabilityStatus: 'active',
      availabilityNote: 'Active in the current toolset.',
    };
  }

  return {
    availabilityStatus: 'unavailable_this_turn',
    availabilityNote: 'Registered tool is unavailable in this turn because a turn policy or runtime dependency removed it.',
  };
}

function bestActionForEntry(
  entry: RuntimeToolCatalogEntry,
  normalizedIntent: string,
  intentTokens: ReadonlySet<string>,
): {
  action?: string;
  actionScore: number;
  matchedTerms: string[];
} {
  const actions = entry.schema?.actions ?? [];
  let best: { action?: string; actionScore: number; matchedTerms: string[] } = {
    actionScore: 0,
    matchedTerms: [],
  };
  for (const action of actions) {
    const scored = scoreAction(entry.name, action.name, normalizedIntent, intentTokens);
    if (
      scored.score > best.actionScore
      || (scored.score === best.actionScore && action.name.localeCompare(best.action ?? '') < 0)
    ) {
      best = {
        action: action.name,
        actionScore: scored.score,
        matchedTerms: scored.matchedTerms,
      };
    }
  }
  if (best.actionScore <= 0) {
    return {
      actionScore: 0,
      matchedTerms: [],
    };
  }
  return best;
}

function buildReason(input: {
  toolName: string;
  action?: string;
  toolMatches: readonly string[];
  actionMatches: readonly string[];
}): string {
  const matched = uniqueStrings([
    ...input.toolMatches,
    ...input.actionMatches,
  ]).slice(0, 4);
  const target = input.action
    ? `${input.toolName} action="${input.action}"`
    : input.toolName;
  const matchText = matched.length > 0
    ? `matched ${matched.map(term => `"${term}"`).join(', ')}`
    : 'matched catalog metadata';
  return `${target} ${matchText}.`;
}

export function suggestToolsForIntent(input: SuggestToolsInput): ToolSuggestionResult {
  const intent = input.intent.trim();
  const limit = normalizeLimit(input.limit);
  if (!intent) {
    return {
      intent,
      limit,
      total: 0,
      recommendations: [],
      advisoryOnly: true,
      message: 'No confident tool suggestion: provide a non-empty natural-language intent.',
    };
  }

  const normalizedIntent = normalizeText(intent);
  const intentTokens = new Set(tokenize(intent));
  const candidates: RankedCandidate[] = [];
  for (const entry of input.catalog) {
    const toolScore = scoreTool(entry, normalizedIntent, intentTokens);
    const bestAction = bestActionForEntry(entry, normalizedIntent, intentTokens);
    const matchScore = toolScore.score + bestAction.actionScore;
    if (matchScore < MIN_CONFIDENT_MATCH_SCORE) continue;

    const availability = resolveAvailability({
      entry,
      action: bestAction.action,
      runtimeState: input.runtimeState,
      access: input.access,
    });
    const confidence = confidenceFromScore(matchScore);
    candidates.push({
      entry,
      ...(bestAction.action ? { action: bestAction.action } : {}),
      confidence,
      reason: buildReason({
        toolName: entry.name,
        action: bestAction.action,
        toolMatches: toolScore.matchedTerms,
        actionMatches: bestAction.matchedTerms,
      }),
      matchScore,
      rankScore: matchScore + AVAILABILITY_RANK_WEIGHT[availability.availabilityStatus],
      ...availability,
    });
  }

  const recommendations = candidates
    .sort((left, right) => {
      if (right.rankScore !== left.rankScore) return right.rankScore - left.rankScore;
      if (right.confidence !== left.confidence) return right.confidence - left.confidence;
      return left.entry.name.localeCompare(right.entry.name);
    })
    .slice(0, limit)
    .map((candidate): ToolSuggestionRecommendation => ({
      toolName: candidate.entry.name,
      ...(candidate.action ? { action: candidate.action } : {}),
      confidence: candidate.confidence,
      reason: candidate.reason,
      availabilityStatus: candidate.availabilityStatus,
      availabilityNote: candidate.availabilityNote,
      ...(candidate.missingTokens ? { missingTokens: candidate.missingTokens } : {}),
    }));

  return {
    intent,
    limit,
    total: candidates.length,
    recommendations,
    advisoryOnly: true,
    ...(recommendations.length === 0
      ? { message: 'No confident tool suggestion. Use toolset action="describe" to inspect available tool schemas.' }
      : {}),
  };
}
