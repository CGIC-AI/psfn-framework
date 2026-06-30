import { isRecord } from '../../shared/utils/types.js';
import { existsSync, readFileSync } from 'node:fs';
import { writeJsonAtomic } from '../../shared/utils/fs.js';

export const CORE_MEMORY_LABELS = ['persona', 'human', 'goals'] as const;
export type CoreMemoryLabel = (typeof CORE_MEMORY_LABELS)[number];

export interface CoreMemoryBlock {
  label: CoreMemoryLabel;
  content: string;
  maxChars: number;
  trustLevel?: string;
}

export interface CoreMemorySnapshot {
  version: number;
  updatedAt: string;
  scope?: CoreMemoryScopeDescriptor;
  blocks: Record<CoreMemoryLabel, CoreMemoryBlock>;
}

export interface CoreMemoryRethinkInput {
  persona: string;
  human: string;
  goals: string;
}

export interface CoreMemoryScopeDescriptor {
  kind: 'channel' | 'legacy_global';
  key: string;
  channelId?: string;
  isDirectMessage?: boolean;
  participantId?: string;
  participantName?: string;
  roomName?: string;
  participantCount?: number;
  activeParticipantNames?: string[];
}

export interface CoreMemoryScopeOptions {
  scope?: CoreMemoryScopeDescriptor | string;
}

export interface CoreMemoryAppendOptions {
  separator?: string;
  scope?: CoreMemoryScopeDescriptor | string;
}

export interface CoreMemoryMutationOptions extends CoreMemoryScopeOptions {}

export interface CoreMemoryFormatContext extends CoreMemoryScopeOptions {
  channelId?: string;
  isDirectMessage?: boolean;
  participantId?: string;
  participantName?: string;
  roomName?: string;
  participantCount?: number;
  activeParticipantNames?: string[];
}

export interface CoreMemoryStoreOptions {
  now?: () => Date;
}

const CORE_MEMORY_BLOCK_VERSION = 1 as const;
const CORE_MEMORY_FILE_VERSION = 2 as const;
const DEFAULT_SCOPE_KEY = 'channel:default';
const GOALS_TIMESTAMP_SOURCE = String.raw`(?:\d{4}-\d{2}-\d{2}[T\s]\d{2}[:-]\d{2}[:-]\d{2}(?:[.:\s-]\d{3})?(?:Z|[+-]\d{2}:?\d{2})?|\d{8}T\d{6}(?:\.\d+)?Z?)`;
const GOALS_TIMESTAMP_PATTERN = new RegExp(String.raw`\b${GOALS_TIMESTAMP_SOURCE}\b`, 'i');
const GOALS_ORIENT_LOG_LINE_PATTERN = new RegExp(
  String.raw`^\s*(?:[-*]\s*)?(?:matrix(?:[\s/_-]+orient)?|orient(?:ation)?(?:\s+(?:log|shakedown))?)\s*[:#-]?\s*(?:at\s*)?${GOALS_TIMESTAMP_SOURCE}\b`,
  'i',
);
const GOALS_BARE_TIMESTAMP_PATTERN = new RegExp(
  String.raw`^\s*(?:[-*]\s*)?(?:timestamp\s*)?${GOALS_TIMESTAMP_SOURCE}\s*$`,
  'i',
);
const GOALS_SEMANTIC_WORD_PATTERN = /[a-z][a-z-]{2,}/i;

const DEFAULT_BLOCKS: Record<CoreMemoryLabel, Omit<CoreMemoryBlock, 'content'>> = {
  persona: {
    label: 'persona',
    maxChars: 2400,
  },
  human: {
    label: 'human',
    maxChars: 2400,
    trustLevel: 'trusted',
  },
  goals: {
    label: 'goals',
    maxChars: 1600,
  },
};


export function isCoreMemoryLabel(value: string): value is CoreMemoryLabel {
  return (CORE_MEMORY_LABELS as readonly string[]).includes(value);
}

function cloneBlock(block: CoreMemoryBlock): CoreMemoryBlock {
  return {
    ...block,
  };
}

function cloneSnapshot(snapshot: CoreMemorySnapshot): CoreMemorySnapshot {
  const blocks = {} as Record<CoreMemoryLabel, CoreMemoryBlock>;
  for (const label of CORE_MEMORY_LABELS) {
    blocks[label] = cloneBlock(snapshot.blocks[label]);
  }
  return {
    version: snapshot.version,
    updatedAt: snapshot.updatedAt,
    ...(snapshot.scope ? { scope: cloneScopeDescriptor(snapshot.scope) } : {}),
    blocks,
  };
}

function cloneScopeDescriptor(scope: CoreMemoryScopeDescriptor): CoreMemoryScopeDescriptor {
  return {
    ...scope,
    ...(scope.activeParticipantNames ? { activeParticipantNames: [...scope.activeParticipantNames] } : {}),
  };
}

function buildDefaultSnapshot(now: Date, scope?: CoreMemoryScopeDescriptor): CoreMemorySnapshot {
  const blocks = {} as Record<CoreMemoryLabel, CoreMemoryBlock>;
  for (const label of CORE_MEMORY_LABELS) {
    blocks[label] = {
      ...DEFAULT_BLOCKS[label],
      content: '',
    };
  }

  return {
    version: CORE_MEMORY_BLOCK_VERSION,
    updatedAt: now.toISOString(),
    ...(scope ? { scope: cloneScopeDescriptor(scope) } : {}),
    blocks,
  };
}

function normalizeTruncateHead(input: string, maxChars: number): string {
  if (input.length <= maxChars) return input;
  return input.slice(0, maxChars).trimEnd();
}

function normalizeTruncateTail(input: string, maxChars: number): string {
  if (input.length <= maxChars) return input;
  return input.slice(input.length - maxChars).trimStart();
}

function stripOrientLogTimestampPrefix(line: string): string {
  const timestamp = line.match(GOALS_TIMESTAMP_PATTERN);
  if (!timestamp || timestamp.index === undefined) return line.trim();
  return line
    .slice(timestamp.index + timestamp[0].length)
    .replace(/^\s*[-:;,.#]*\s*/, '')
    .trim();
}

function normalizeDurableGoalLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  if (GOALS_BARE_TIMESTAMP_PATTERN.test(trimmed)) {
    return null;
  }

  if (!GOALS_ORIENT_LOG_LINE_PATTERN.test(trimmed)) {
    return trimmed;
  }

  const semanticTail = stripOrientLogTimestampPrefix(trimmed);
  if (!GOALS_SEMANTIC_WORD_PATTERN.test(semanticTail)) {
    return null;
  }
  return semanticTail;
}

function normalizeDurableGoalsContent(content: string): string {
  const trimmed = content.trim();
  if (
    !GOALS_TIMESTAMP_PATTERN.test(trimmed)
    || !trimmed.split(/\r?\n/u).some(line => GOALS_ORIENT_LOG_LINE_PATTERN.test(line))
  ) {
    return trimmed;
  }

  const acceptedLines: string[] = [];
  const seen = new Set<string>();
  for (const line of trimmed.split(/\r?\n/u)) {
    const normalized = normalizeDurableGoalLine(line);
    if (!normalized) continue;
    const dedupeKey = normalized.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    acceptedLines.push(normalized);
  }

  return acceptedLines.join('\n');
}

function normalizeBlockContent(
  label: CoreMemoryLabel,
  content: string,
  maxChars: number,
  truncate: (input: string, maxChars: number) => string,
): string {
  const normalized = label === 'goals'
    ? normalizeDurableGoalsContent(content)
    : content.trim();
  return truncate(normalized, maxChars);
}

function normalizePersistedBlockContent(label: CoreMemoryLabel, content: string): string {
  return label === 'goals' ? normalizeDurableGoalsContent(content) : content;
}

function normalizeAppendContent(
  label: CoreMemoryLabel,
  existing: string,
  appendText: string,
  maxChars: number,
  separator: string,
): string {
  const normalizedAppend = appendText.trim();
  if (normalizedAppend.length === 0) {
    throw new Error('core memory append text must be non-empty');
  }
  const normalizedExisting = existing.trim();
  const normalizedSeparator = separator.length > 0 ? separator : '\n';
  const merged = normalizedExisting.length > 0
    ? `${normalizedExisting}${normalizedSeparator}${normalizedAppend}`
    : normalizedAppend;
  return normalizeBlockContent(label, merged, maxChars, normalizeTruncateTail);
}

function parseBlock(raw: unknown, expectedLabel: CoreMemoryLabel): CoreMemoryBlock {
  if (!isRecord(raw)) {
    throw new Error(`core memory block "${expectedLabel}" must be an object`);
  }

  const { label, content, maxChars, trustLevel } = raw;
  if (label !== expectedLabel) {
    throw new Error(`core memory block label mismatch: expected "${expectedLabel}"`);
  }
  if (typeof content !== 'string') {
    throw new Error(`core memory block "${expectedLabel}" content must be a string`);
  }
  if (typeof maxChars !== 'number' || !Number.isInteger(maxChars) || maxChars < 1) {
    throw new Error(`core memory block "${expectedLabel}" maxChars must be a positive integer`);
  }
  const normalizedContent = normalizePersistedBlockContent(expectedLabel, content);

  if (normalizedContent.length > maxChars) {
    throw new Error(`core memory block "${expectedLabel}" content exceeds maxChars`);
  }
  if (trustLevel !== undefined && typeof trustLevel !== 'string') {
    throw new Error(`core memory block "${expectedLabel}" trustLevel must be a string`);
  }

  const normalizedTrustLevel = typeof trustLevel === 'string' && trustLevel.trim().length > 0
    ? trustLevel.trim()
    : undefined;

  return {
    label: expectedLabel,
    content: normalizedContent,
    maxChars,
    ...(normalizedTrustLevel ? { trustLevel: normalizedTrustLevel } : {}),
  };
}

function parseSnapshot(raw: unknown): CoreMemorySnapshot {
  if (!isRecord(raw)) {
    throw new Error('core memory snapshot must be an object');
  }

  const version = raw.version;
  const updatedAt = raw.updatedAt;
  const blocksRaw = raw.blocks;

  if (version !== CORE_MEMORY_BLOCK_VERSION) {
    throw new Error(`unsupported core memory version: ${String(version)}`);
  }
  if (typeof updatedAt !== 'string' || updatedAt.trim().length === 0) {
    throw new Error('core memory updatedAt must be a non-empty string');
  }
  if (!isRecord(blocksRaw)) {
    throw new Error('core memory blocks must be an object');
  }

  for (const key of Object.keys(blocksRaw)) {
    if (!isCoreMemoryLabel(key)) {
      throw new Error(`unknown core memory block "${key}"`);
    }
  }

  const blocks = {} as Record<CoreMemoryLabel, CoreMemoryBlock>;
  for (const label of CORE_MEMORY_LABELS) {
    blocks[label] = parseBlock(blocksRaw[label], label);
  }

  return {
    version: CORE_MEMORY_BLOCK_VERSION,
    updatedAt,
    blocks,
  };
}

interface ScopedCoreMemoryRecord {
  scope: CoreMemoryScopeDescriptor;
  updatedAt: string;
  blocks: Record<CoreMemoryLabel, CoreMemoryBlock>;
}

interface ArchivedLegacyCoreMemory {
  archivedAt: string;
  snapshot: CoreMemorySnapshot;
}

interface ScopedCoreMemoryFile {
  version: typeof CORE_MEMORY_FILE_VERSION;
  updatedAt: string;
  scopes: Partial<Record<string, ScopedCoreMemoryRecord>>;
  legacyGlobal?: ArchivedLegacyCoreMemory;
}

function normalizeScopeKeyPart(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function sanitizeActiveParticipantNames(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    if (typeof value !== 'string') continue;
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= 5) break;
  }
  return out.length > 0 ? out : undefined;
}

function normalizeOptionalString(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : undefined;
}

function normalizeOptionalBoolean(raw: unknown): boolean | undefined {
  return typeof raw === 'boolean' ? raw : undefined;
}

function normalizeOptionalCount(raw: unknown): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  const normalized = Math.floor(raw);
  return normalized >= 0 ? normalized : undefined;
}

function buildChannelScope(input: {
  channelId: string;
  isDirectMessage?: boolean;
  participantId?: string;
  participantName?: string;
  roomName?: string;
  participantCount?: number;
  activeParticipantNames?: string[];
}): CoreMemoryScopeDescriptor {
  const channelId = normalizeScopeKeyPart(input.channelId);
  if (!channelId) {
    throw new Error('core memory channel scope requires channelId');
  }
  return {
    kind: 'channel',
    key: `channel:${channelId}`,
    channelId,
    ...(input.isDirectMessage !== undefined ? { isDirectMessage: input.isDirectMessage } : {}),
    ...(input.participantId ? { participantId: input.participantId } : {}),
    ...(input.participantName ? { participantName: input.participantName } : {}),
    ...(input.roomName ? { roomName: input.roomName } : {}),
    ...(input.participantCount !== undefined ? { participantCount: input.participantCount } : {}),
    ...(input.activeParticipantNames?.length ? { activeParticipantNames: input.activeParticipantNames.slice(0, 5) } : {}),
  };
}

export function coreMemoryChannelScope(input: {
  channelId: string;
  isDirectMessage?: boolean;
  participantId?: string;
  participantName?: string;
  roomName?: string;
  participantCount?: number;
  activeParticipantNames?: string[];
}): CoreMemoryScopeDescriptor {
  return buildChannelScope(input);
}

function defaultScope(): CoreMemoryScopeDescriptor {
  return {
    kind: 'channel',
    key: DEFAULT_SCOPE_KEY,
    channelId: 'default',
  };
}

function resolveScopeDescriptor(input?: CoreMemoryScopeDescriptor | string): CoreMemoryScopeDescriptor {
  if (typeof input === 'string') {
    return buildChannelScope({ channelId: input });
  }
  if (!input) {
    return defaultScope();
  }
  if (input.kind === 'channel') {
    const channelId = input.channelId ?? input.key.replace(/^channel:/, '');
    return buildChannelScope({
      channelId,
      isDirectMessage: input.isDirectMessage,
      participantId: input.participantId,
      participantName: input.participantName,
      roomName: input.roomName,
      participantCount: input.participantCount,
      activeParticipantNames: input.activeParticipantNames,
    });
  }
  return {
    kind: 'legacy_global',
    key: 'legacy:global',
  };
}

function resolveFormatScope(context?: CoreMemoryFormatContext): CoreMemoryScopeDescriptor {
  if (context?.scope) {
    const scope = resolveScopeDescriptor(context.scope);
    if (scope.kind === 'channel') {
      return {
        ...scope,
        ...(context.isDirectMessage !== undefined ? { isDirectMessage: context.isDirectMessage } : {}),
        ...(context.participantId ? { participantId: context.participantId } : {}),
        ...(context.participantName ? { participantName: context.participantName } : {}),
        ...(context.roomName ? { roomName: context.roomName } : {}),
        ...(context.participantCount !== undefined ? { participantCount: context.participantCount } : {}),
        ...(context.activeParticipantNames?.length
          ? { activeParticipantNames: context.activeParticipantNames.slice(0, 5) }
          : {}),
      };
    }
    return scope;
  }
  if (context?.channelId) {
    return buildChannelScope({
      channelId: context.channelId,
      isDirectMessage: context.isDirectMessage,
      participantId: context.participantId,
      participantName: context.participantName,
      roomName: context.roomName,
      participantCount: context.participantCount,
      activeParticipantNames: context.activeParticipantNames,
    });
  }
  return defaultScope();
}

function parseScopeDescriptor(raw: unknown): CoreMemoryScopeDescriptor {
  if (!isRecord(raw)) {
    throw new Error('core memory scope must be an object');
  }
  const kind = raw.kind;
  if (kind !== 'channel' && kind !== 'legacy_global') {
    throw new Error('core memory scope kind must be channel or legacy_global');
  }
  if (kind === 'legacy_global') {
    return { kind, key: 'legacy:global' };
  }
  const key = normalizeOptionalString(raw.key);
  const channelId = normalizeOptionalString(raw.channelId) ?? key?.replace(/^channel:/, '');
  if (!channelId) {
    throw new Error('core memory channel scope requires channelId');
  }
  return buildChannelScope({
    channelId,
    isDirectMessage: normalizeOptionalBoolean(raw.isDirectMessage),
    participantId: normalizeOptionalString(raw.participantId),
    participantName: normalizeOptionalString(raw.participantName),
    roomName: normalizeOptionalString(raw.roomName),
    participantCount: normalizeOptionalCount(raw.participantCount),
    activeParticipantNames: sanitizeActiveParticipantNames(raw.activeParticipantNames),
  });
}

function parseScopedRecord(raw: unknown, expectedKey: string): ScopedCoreMemoryRecord {
  if (!isRecord(raw)) {
    throw new Error(`core memory scoped record "${expectedKey}" must be an object`);
  }
  const scope = parseScopeDescriptor(raw.scope);
  if (scope.key !== expectedKey) {
    throw new Error(`core memory scope key mismatch: expected "${expectedKey}"`);
  }
  const updatedAt = normalizeOptionalString(raw.updatedAt);
  if (!updatedAt) {
    throw new Error(`core memory scoped record "${expectedKey}" updatedAt must be non-empty`);
  }
  if (!isRecord(raw.blocks)) {
    throw new Error(`core memory scoped record "${expectedKey}" blocks must be an object`);
  }
  const blocks = {} as Record<CoreMemoryLabel, CoreMemoryBlock>;
  for (const label of CORE_MEMORY_LABELS) {
    blocks[label] = parseBlock(raw.blocks[label], label);
  }
  return {
    scope,
    updatedAt,
    blocks,
  };
}

function parseScopedFile(raw: unknown): ScopedCoreMemoryFile {
  if (!isRecord(raw)) {
    throw new Error('core memory file must be an object');
  }
  if (raw.version !== CORE_MEMORY_FILE_VERSION) {
    throw new Error(`unsupported core memory file version: ${String(raw.version)}`);
  }
  const updatedAt = normalizeOptionalString(raw.updatedAt);
  if (!updatedAt) {
    throw new Error('core memory file updatedAt must be non-empty');
  }
  if (!isRecord(raw.scopes)) {
    throw new Error('core memory file scopes must be an object');
  }
  const scopes: Record<string, ScopedCoreMemoryRecord> = {};
  for (const [key, value] of Object.entries(raw.scopes)) {
    scopes[key] = parseScopedRecord(value, key);
  }
  let legacyGlobal: ArchivedLegacyCoreMemory | undefined;
  if (raw.legacyGlobal !== undefined) {
    if (!isRecord(raw.legacyGlobal)) {
      throw new Error('core memory legacyGlobal must be an object');
    }
    const archivedAt = normalizeOptionalString(raw.legacyGlobal.archivedAt);
    if (!archivedAt) {
      throw new Error('core memory legacyGlobal archivedAt must be non-empty');
    }
    legacyGlobal = {
      archivedAt,
      snapshot: parseSnapshot(raw.legacyGlobal.snapshot),
    };
  }
  return {
    version: CORE_MEMORY_FILE_VERSION,
    updatedAt,
    scopes,
    ...(legacyGlobal ? { legacyGlobal } : {}),
  };
}

function snapshotFromRecord(record: ScopedCoreMemoryRecord): CoreMemorySnapshot {
  return cloneSnapshot({
    version: CORE_MEMORY_BLOCK_VERSION,
    updatedAt: record.updatedAt,
    scope: record.scope,
    blocks: record.blocks,
  });
}

function recordFromSnapshot(snapshot: CoreMemorySnapshot, scope: CoreMemoryScopeDescriptor): ScopedCoreMemoryRecord {
  return {
    scope: cloneScopeDescriptor(scope),
    updatedAt: snapshot.updatedAt,
    blocks: cloneSnapshot(snapshot).blocks,
  };
}

function hasAnyBlockContent(snapshot: CoreMemorySnapshot): boolean {
  return CORE_MEMORY_LABELS.some(label => snapshot.blocks[label].content.trim().length > 0);
}

function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatAttributes(attrs: Record<string, string | number | boolean | undefined>): string {
  const rendered = Object.entries(attrs)
    .filter(([, value]) => value !== undefined && String(value).length > 0)
    .map(([key, value]) => `${key}="${escapeXmlAttribute(String(value))}"`);
  return rendered.length > 0 ? ` ${rendered.join(' ')}` : '';
}

export class CoreMemoryStore {
  private readonly filePath: string;
  private readonly now: () => Date;
  private state: ScopedCoreMemoryFile;

  constructor(filePath: string, options: CoreMemoryStoreOptions = {}) {
    this.filePath = filePath;
    this.now = options.now ?? (() => new Date());
    this.state = this.loadOrInitialize();
  }

  getSnapshot(options: CoreMemoryScopeOptions = {}): CoreMemorySnapshot {
    return this.getOrCreateScopedSnapshot(resolveScopeDescriptor(options.scope));
  }

  getBlock(label: CoreMemoryLabel, options: CoreMemoryScopeOptions = {}): CoreMemoryBlock {
    return cloneBlock(this.getOrCreateScopedSnapshot(resolveScopeDescriptor(options.scope)).blocks[label]);
  }

  append(
    label: CoreMemoryLabel,
    appendText: string,
    options: CoreMemoryAppendOptions = {},
  ): CoreMemoryBlock {
    const scope = resolveScopeDescriptor(options.scope);
    const snapshot = this.getOrCreateScopedSnapshot(scope);
    const current = snapshot.blocks[label];
    const nextContent = normalizeAppendContent(
      label,
      current.content,
      appendText,
      current.maxChars,
      options.separator ?? '\n',
    );
    return this.writeBlock(label, nextContent, scope);
  }

  replace(
    label: CoreMemoryLabel,
    content: string,
    options: CoreMemoryMutationOptions = {},
  ): CoreMemoryBlock {
    const scope = resolveScopeDescriptor(options.scope);
    const current = this.getOrCreateScopedSnapshot(scope).blocks[label];
    const nextContent = normalizeBlockContent(
      label,
      content,
      current.maxChars,
      normalizeTruncateHead,
    );
    return this.writeBlock(label, nextContent, scope);
  }

  rethink(
    input: CoreMemoryRethinkInput,
    options: CoreMemoryMutationOptions = {},
  ): CoreMemorySnapshot {
    const scope = resolveScopeDescriptor(options.scope);
    const snapshot = this.getOrCreateScopedSnapshot(scope);
    const nextBlocks = {} as Record<CoreMemoryLabel, CoreMemoryBlock>;
    for (const label of CORE_MEMORY_LABELS) {
      const current = snapshot.blocks[label];
      const replacement = normalizeBlockContent(
        label,
        input[label],
        current.maxChars,
        normalizeTruncateHead,
      );
      nextBlocks[label] = {
        ...current,
        content: replacement,
      };
    }

    const nextSnapshot: CoreMemorySnapshot = {
      version: CORE_MEMORY_BLOCK_VERSION,
      updatedAt: this.now().toISOString(),
      scope,
      blocks: nextBlocks,
    };
    this.writeSnapshot(scope, nextSnapshot);
    return this.getSnapshot({ scope });
  }

  formatForContext(context: CoreMemoryFormatContext = {}): string {
    const scope = resolveFormatScope(context);
    const record = this.state.scopes[scope.key];
    if (!record) return '';
    const snapshot = snapshotFromRecord({
      ...record,
      scope: {
        ...record.scope,
        ...(scope.isDirectMessage !== undefined ? { isDirectMessage: scope.isDirectMessage } : {}),
        ...(scope.participantId ? { participantId: scope.participantId } : {}),
        ...(scope.participantName ? { participantName: scope.participantName } : {}),
        ...(scope.roomName ? { roomName: scope.roomName } : {}),
        ...(scope.participantCount !== undefined ? { participantCount: scope.participantCount } : {}),
        ...(scope.activeParticipantNames?.length ? { activeParticipantNames: scope.activeParticipantNames } : {}),
      },
    });
    if (!hasAnyBlockContent(snapshot)) return '';

    const lines = [
      `<core_memory${formatAttributes({
        scope_kind: scope.kind,
        scope_key: scope.key,
        channel_id: scope.channelId,
      })}>`,
    ];

    const participantNames = scope.activeParticipantNames?.slice(0, 5);
    if (scope.kind === 'channel' && scope.isDirectMessage === true) {
      lines.push(`<participant_context${formatAttributes({
        name: scope.participantName,
        id: scope.participantId,
      })}>`);
      lines.push(snapshot.blocks.human.content.trim() || '(empty)');
      lines.push('</participant_context>');
    } else if (scope.kind === 'channel') {
      lines.push(`<room_context${formatAttributes({
        name: scope.roomName,
        participant_count: scope.participantCount,
        active_participants: participantNames?.join(', '),
      })}>`);
      lines.push(snapshot.blocks.human.content.trim() || '(empty)');
      lines.push('</room_context>');
    }

    const persona = snapshot.blocks.persona.content.trim();
    if (persona) {
      lines.push('<local_continuity>');
      lines.push(persona);
      lines.push('</local_continuity>');
    }
    const goals = snapshot.blocks.goals.content.trim();
    if (goals) {
      lines.push('<continuity_goals>');
      lines.push(goals);
      lines.push('</continuity_goals>');
    }

    lines.push('</core_memory>');
    return lines.join('\n');
  }

  private writeBlock(label: CoreMemoryLabel, content: string, scope: CoreMemoryScopeDescriptor): CoreMemoryBlock {
    const snapshot = this.getOrCreateScopedSnapshot(scope);
    const nextSnapshot: CoreMemorySnapshot = {
      version: CORE_MEMORY_BLOCK_VERSION,
      updatedAt: this.now().toISOString(),
      scope,
      blocks: {
        ...snapshot.blocks,
        [label]: {
          ...snapshot.blocks[label],
          content,
        },
      },
    };
    this.writeSnapshot(scope, nextSnapshot);
    return this.getBlock(label, { scope });
  }

  private getOrCreateScopedSnapshot(scope: CoreMemoryScopeDescriptor): CoreMemorySnapshot {
    const existing = this.state.scopes[scope.key];
    if (existing) {
      return snapshotFromRecord(existing);
    }
    const snapshot = buildDefaultSnapshot(this.now(), scope);
    this.writeSnapshot(scope, snapshot);
    return snapshot;
  }

  private writeSnapshot(scope: CoreMemoryScopeDescriptor, snapshot: CoreMemorySnapshot): void {
    const nextState: ScopedCoreMemoryFile = {
      ...this.state,
      version: CORE_MEMORY_FILE_VERSION,
      updatedAt: snapshot.updatedAt,
      scopes: {
        ...this.state.scopes,
        [scope.key]: recordFromSnapshot(snapshot, scope),
      },
    };
    this.persist(nextState);
    this.state = nextState;
  }

  private loadOrInitialize(): ScopedCoreMemoryFile {
    if (!existsSync(this.filePath)) {
      const now = this.now().toISOString();
      const defaults: ScopedCoreMemoryFile = {
        version: CORE_MEMORY_FILE_VERSION,
        updatedAt: now,
        scopes: {},
      };
      this.persist(defaults);
      return defaults;
    }

    const raw = readFileSync(this.filePath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (isRecord(parsed) && parsed.version === CORE_MEMORY_BLOCK_VERSION && isRecord(parsed.blocks)) {
      const legacySnapshot = parseSnapshot(parsed);
      const migrated: ScopedCoreMemoryFile = {
        version: CORE_MEMORY_FILE_VERSION,
        updatedAt: this.now().toISOString(),
        scopes: {},
        legacyGlobal: {
          archivedAt: this.now().toISOString(),
          snapshot: legacySnapshot,
        },
      };
      this.persist(migrated);
      return migrated;
    }
    return parseScopedFile(parsed);
  }

  private persist(snapshot: ScopedCoreMemoryFile): void {
    writeJsonAtomic(this.filePath, snapshot);
  }
}
