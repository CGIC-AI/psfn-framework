import { existsSync, readFileSync } from 'node:fs';
import { writeJsonAtomic } from '../utils/fs.js';

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

function normalizeReplaceContent(content: string, maxChars: number): string {
  return normalizeTruncateHead(content.trim(), maxChars);
}

function normalizeAppendContent(
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
  return normalizeTruncateTail(merged, maxChars);
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
  if (content.length > maxChars) {
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
    content,
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
      current.content,
      appendText,
      current.maxChars,
      options.separator ?? '\n',
    );
    return this.writeBlock(label, nextContent);
  }

  replace(label: CoreMemoryLabel, content: string): CoreMemoryBlock {
    const current = this.snapshot.blocks[label];
    const nextContent = normalizeReplaceContent(content, current.maxChars);
    return this.writeBlock(label, nextContent);
  }

  rethink(input: CoreMemoryRethinkInput): CoreMemorySnapshot {
    const nextBlocks = {} as Record<CoreMemoryLabel, CoreMemoryBlock>;
    for (const label of CORE_MEMORY_LABELS) {
      const current = this.snapshot.blocks[label];
      const replacement = normalizeReplaceContent(input[label], current.maxChars);
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
    const lines = [
      '[Core Memory]',
    ];

    for (const label of CORE_MEMORY_LABELS) {
      const block = this.snapshot.blocks[label];
      lines.push(`${label}:`);
      lines.push(block.content.length > 0 ? block.content : '(empty)');
      lines.push('');
    }

    return lines.join('\n').trimEnd();
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
