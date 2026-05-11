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
  blocks: Record<CoreMemoryLabel, CoreMemoryBlock>;
}

export interface CoreMemoryRethinkInput {
  persona: string;
  human: string;
  goals: string;
}

export interface CoreMemoryAppendOptions {
  separator?: string;
}

export interface CoreMemoryStoreOptions {
  now?: () => Date;
}

const CORE_MEMORY_VERSION = 1 as const;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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
    blocks,
  };
}

function buildDefaultSnapshot(now: Date): CoreMemorySnapshot {
  const blocks = {} as Record<CoreMemoryLabel, CoreMemoryBlock>;
  for (const label of CORE_MEMORY_LABELS) {
    blocks[label] = {
      ...DEFAULT_BLOCKS[label],
      content: '',
    };
  }

  return {
    version: CORE_MEMORY_VERSION,
    updatedAt: now.toISOString(),
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

  if (version !== CORE_MEMORY_VERSION) {
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
    version: CORE_MEMORY_VERSION,
    updatedAt,
    blocks,
  };
}

export class CoreMemoryStore {
  private readonly filePath: string;
  private readonly now: () => Date;
  private snapshot: CoreMemorySnapshot;

  constructor(filePath: string, options: CoreMemoryStoreOptions = {}) {
    this.filePath = filePath;
    this.now = options.now ?? (() => new Date());
    this.snapshot = this.loadOrInitialize();
  }

  getSnapshot(): CoreMemorySnapshot {
    return cloneSnapshot(this.snapshot);
  }

  getBlock(label: CoreMemoryLabel): CoreMemoryBlock {
    return cloneBlock(this.snapshot.blocks[label]);
  }

  append(
    label: CoreMemoryLabel,
    appendText: string,
    options: CoreMemoryAppendOptions = {},
  ): CoreMemoryBlock {
    const current = this.snapshot.blocks[label];
    const nextContent = normalizeAppendContent(
      label,
      current.content,
      appendText,
      current.maxChars,
      options.separator ?? '\n',
    );
    return this.writeBlock(label, nextContent);
  }

  replace(label: CoreMemoryLabel, content: string): CoreMemoryBlock {
    const current = this.snapshot.blocks[label];
    const nextContent = normalizeBlockContent(
      label,
      content,
      current.maxChars,
      normalizeTruncateHead,
    );
    return this.writeBlock(label, nextContent);
  }

  rethink(input: CoreMemoryRethinkInput): CoreMemorySnapshot {
    const nextBlocks = {} as Record<CoreMemoryLabel, CoreMemoryBlock>;
    for (const label of CORE_MEMORY_LABELS) {
      const current = this.snapshot.blocks[label];
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
      version: CORE_MEMORY_VERSION,
      updatedAt: this.now().toISOString(),
      blocks: nextBlocks,
    };
    this.persist(nextSnapshot);
    this.snapshot = nextSnapshot;
    return cloneSnapshot(this.snapshot);
  }

  formatForContext(): string {
    const lines = ['<core_memory>'];

    for (const label of CORE_MEMORY_LABELS) {
      const block = this.snapshot.blocks[label];
      lines.push(`<${label}>`);
      lines.push(block.content.length > 0 ? block.content : '(empty)');
      lines.push(`</${label}>`);
    }

    lines.push('</core_memory>');
    return lines.join('\n');
  }

  private writeBlock(label: CoreMemoryLabel, content: string): CoreMemoryBlock {
    const nextSnapshot: CoreMemorySnapshot = {
      version: CORE_MEMORY_VERSION,
      updatedAt: this.now().toISOString(),
      blocks: {
        ...this.snapshot.blocks,
        [label]: {
          ...this.snapshot.blocks[label],
          content,
        },
      },
    };
    this.persist(nextSnapshot);
    this.snapshot = nextSnapshot;
    return this.getBlock(label);
  }

  private loadOrInitialize(): CoreMemorySnapshot {
    if (!existsSync(this.filePath)) {
      const defaults = buildDefaultSnapshot(this.now());
      this.persist(defaults);
      return defaults;
    }

    const raw = readFileSync(this.filePath, 'utf-8');
    return parseSnapshot(JSON.parse(raw) as unknown);
  }

  private persist(snapshot: CoreMemorySnapshot): void {
    writeJsonAtomic(this.filePath, snapshot);
  }
}
