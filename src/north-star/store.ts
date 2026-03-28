import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createComponentLogger } from '../logger.js';
import { writeJsonAtomic } from '../shared/utils/fs.js';

const log = createComponentLogger('NorthStar');

export const MAX_NORTH_STAR_ITEMS = 3;
export const NORTH_STAR_LAYER_HEADER = '[North Star]';
export const NORTH_STAR_SCOPES = ['shared', 'companion'] as const;

export type NorthStarScope = (typeof NORTH_STAR_SCOPES)[number];

export interface NorthStarItem {
  id: string;
  title: string;
  content: string;
  scope: NorthStarScope;
  enabled: boolean;
  priority: number;
  updatedAt: string;
  updatedBy: string;
  checksum: string;
  version: number;
}

export interface NorthStarPromptLayerSnapshot {
  content: string;
  itemIds: string[];
}

export interface NorthStarCreateInput {
  title: string;
  content: string;
  scope?: NorthStarScope;
  enabled?: boolean;
  updatedBy?: string;
}

export interface NorthStarUpdatePatch {
  title?: string;
  content?: string;
  scope?: NorthStarScope;
  enabled?: boolean;
}

function normalizeNonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  return trimmed;
}

function normalizeScope(value: unknown): NorthStarScope {
  if (typeof value !== 'string' || !NORTH_STAR_SCOPES.includes(value as NorthStarScope)) {
    throw new Error(`scope must be one of: ${NORTH_STAR_SCOPES.join(', ')}`);
  }
  return value as NorthStarScope;
}

function normalizeBoolean(value: unknown, fieldName: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${fieldName} must be a boolean`);
  }
  return value;
}

function normalizePriority(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error('priority must be an integer >= 0');
  }
  return value;
}

function normalizeVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error('version must be an integer >= 1');
  }
  return value;
}

function computeChecksum(input: {
  title: string;
  content: string;
  scope: NorthStarScope;
  enabled: boolean;
}): string {
  return createHash('sha256')
    .update(JSON.stringify(input))
    .digest('hex')
    .slice(0, 16);
}

function toPromptItemBlock(item: NorthStarItem, index: number): string {
  return [
    `${String(index + 1)}. [${item.scope}] ${item.title}`,
    item.content.trim(),
  ].join('\n');
}

function normalizePersistedItem(raw: unknown): NorthStarItem {
  if (!raw || typeof raw !== 'object') {
    throw new Error('north star item must be an object');
  }

  const item = raw as Record<string, unknown>;
  const title = normalizeNonEmptyString(item.title, 'title');
  const content = normalizeNonEmptyString(item.content, 'content');
  const scope = normalizeScope(item.scope);
  const enabled = normalizeBoolean(item.enabled, 'enabled');
  const normalized: NorthStarItem = {
    id: normalizeNonEmptyString(item.id, 'id'),
    title,
    content,
    scope,
    enabled,
    priority: normalizePriority(item.priority),
    updatedAt: normalizeNonEmptyString(item.updatedAt, 'updatedAt'),
    updatedBy: normalizeNonEmptyString(item.updatedBy, 'updatedBy'),
    checksum: normalizeNonEmptyString(item.checksum, 'checksum'),
    version: normalizeVersion(item.version),
  };

  const expectedChecksum = computeChecksum({ title, content, scope, enabled });
  if (normalized.checksum !== expectedChecksum) {
    throw new Error(`north star item checksum mismatch: ${normalized.id}`);
  }

  return normalized;
}

export class NorthStarStore {
  private readonly filePath: string;
  private items: NorthStarItem[] = [];

  constructor(filePath: string) {
    this.filePath = filePath;
    this.load();
  }

  get count(): number {
    this.refresh();
    return this.items.length;
  }

  list(): NorthStarItem[] {
    this.refresh();
    return [...this.items].sort((left, right) => left.priority - right.priority);
  }

  getById(id: string): NorthStarItem | undefined {
    this.refresh();
    return this.findById(id);
  }

  create(params: NorthStarCreateInput): NorthStarItem {
    this.refresh();
    if (this.items.length >= MAX_NORTH_STAR_ITEMS) {
      throw new Error(`north star is limited to ${String(MAX_NORTH_STAR_ITEMS)} items`);
    }

    const title = normalizeNonEmptyString(params.title, 'title');
    const content = normalizeNonEmptyString(params.content, 'content');
    const scope = params.scope ?? 'shared';
    if (!NORTH_STAR_SCOPES.includes(scope)) {
      throw new Error(`scope must be one of: ${NORTH_STAR_SCOPES.join(', ')}`);
    }

    const enabled = params.enabled ?? true;
    if (typeof enabled !== 'boolean') {
      throw new Error('enabled must be a boolean');
    }

    const item: NorthStarItem = {
      id: randomUUID(),
      title,
      content,
      scope,
      enabled,
      priority: this.items.length,
      updatedAt: new Date().toISOString(),
      updatedBy: params.updatedBy ?? 'system',
      checksum: computeChecksum({ title, content, scope, enabled }),
      version: 1,
    };
    this.items.push(item);
    this.save();
    return item;
  }

  update(id: string, patch: NorthStarUpdatePatch, updatedBy: string): NorthStarItem {
    this.refresh();
    const item = this.findById(id);
    if (!item) {
      throw new Error(`North Star item not found: ${id}`);
    }

    const hasTitle = Object.prototype.hasOwnProperty.call(patch, 'title');
    const hasContent = Object.prototype.hasOwnProperty.call(patch, 'content');
    const hasScope = Object.prototype.hasOwnProperty.call(patch, 'scope');
    const hasEnabled = Object.prototype.hasOwnProperty.call(patch, 'enabled');
    if (!hasTitle && !hasContent && !hasScope && !hasEnabled) {
      throw new Error('No north star update fields provided');
    }

    const title = hasTitle ? normalizeNonEmptyString(patch.title, 'title') : item.title;
    const content = hasContent ? normalizeNonEmptyString(patch.content, 'content') : item.content;
    const scope = hasScope ? normalizeScope(patch.scope) : item.scope;
    const enabled = hasEnabled ? normalizeBoolean(patch.enabled, 'enabled') : item.enabled;

    item.title = title;
    item.content = content;
    item.scope = scope;
    item.enabled = enabled;
    item.updatedAt = new Date().toISOString();
    item.updatedBy = normalizeNonEmptyString(updatedBy, 'updatedBy');
    item.checksum = computeChecksum({ title, content, scope, enabled });
    item.version += 1;
    this.save();
    return item;
  }

  delete(id: string): void {
    this.refresh();
    const idx = this.items.findIndex(item => item.id === id);
    if (idx === -1) {
      throw new Error(`North Star item not found: ${id}`);
    }
    this.items.splice(idx, 1);
    this.items.forEach((item, index) => {
      item.priority = index;
    });
    this.save();
  }

  reorder(itemIds: string[], updatedBy: string): NorthStarItem[] {
    this.refresh();
    if (!Array.isArray(itemIds)) {
      throw new Error('itemIds must be an array');
    }
    if (itemIds.length !== this.items.length) {
      throw new Error('itemIds must include every North Star item exactly once');
    }

    const seen = new Set<string>();
    const nextOrder: NorthStarItem[] = [];
    for (const rawId of itemIds) {
      if (typeof rawId !== 'string' || rawId.trim().length === 0) {
        throw new Error('itemIds entries must be non-empty strings');
      }
      const itemId = rawId.trim();
      if (seen.has(itemId)) {
        throw new Error(`Duplicate North Star item id in reorder payload: ${itemId}`);
      }
      seen.add(itemId);
      const item = this.findById(itemId);
      if (!item) {
        throw new Error(`North Star item not found: ${itemId}`);
      }
      nextOrder.push(item);
    }

    const timestamp = new Date().toISOString();
    const actor = normalizeNonEmptyString(updatedBy, 'updatedBy');
    const touched: NorthStarItem[] = [];
    nextOrder.forEach((item, index) => {
      if (item.priority === index) return;
      item.priority = index;
      item.updatedAt = timestamp;
      item.updatedBy = actor;
      item.version += 1;
      touched.push(item);
    });

    if (touched.length > 0) {
      this.items = nextOrder;
      this.save();
    }

    return touched;
  }

  buildPromptLayer(): NorthStarPromptLayerSnapshot | null {
    const enabledItems = this.list().filter(item => item.enabled);
    if (enabledItems.length === 0) {
      return null;
    }

    const content = [
      NORTH_STAR_LAYER_HEADER,
      'Keep these long-term goals in view across planning, maintenance, and independent action.',
      '',
      ...enabledItems.flatMap((item, index) => (
        index === enabledItems.length - 1
          ? [toPromptItemBlock(item, index)]
          : [toPromptItemBlock(item, index), '']
      )),
    ].join('\n').trim();

    return {
      content,
      itemIds: enabledItems.map(item => item.id),
    };
  }

  private refresh(): void {
    this.load();
  }

  private findById(id: string): NorthStarItem | undefined {
    return this.items.find(item => item.id === id);
  }

  private load(): void {
    if (!existsSync(this.filePath)) {
      this.items = [];
      return;
    }

    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf-8')) as unknown;
      if (!Array.isArray(raw)) {
        throw new Error('north star file must contain an array');
      }
      if (raw.length > MAX_NORTH_STAR_ITEMS) {
        throw new Error(`north star file exceeds ${String(MAX_NORTH_STAR_ITEMS)} items`);
      }

      const normalized = raw.map(entry => normalizePersistedItem(entry));
      const seen = new Set<string>();
      for (const item of normalized) {
        if (seen.has(item.id)) {
          throw new Error(`duplicate north star item id: ${item.id}`);
        }
        seen.add(item.id);
      }

      this.items = normalized.sort((left, right) => left.priority - right.priority);
    } catch (error) {
      log.error('Failed to load north star items', {
        path: this.filePath,
        error: String(error),
      });
      this.items = [];
    }
  }

  private save(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeJsonAtomic(
      this.filePath,
      [...this.items].sort((left, right) => left.priority - right.priority),
      { trailingNewline: true },
    );
  }
}
