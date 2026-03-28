// ── Prompt Layer Store ──
// JSON file-backed storage for prompt layers with JSONL history.
// Atomic write via .tmp + rename (same pattern as settings.ts).

import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
} from 'node:fs';
import {
  LAYER_TYPE_ORDER,
  PROMPT_LAYER_ROLES,
  type PromptLayer,
  type LayerType,
  type PromptHistoryEntry,
  type PromptLayerRole,
} from './prompt-types.js';
import {
  FOUNDATION_SECTION_DEFINITIONS,
  composeFoundationSectionTemplate,
  decomposeFoundationSections,
  type FoundationSectionState,
} from './foundation-sections.js';
import {
  CANONICAL_CHARACTER_FOUNDATION_NAME,
  isCanonicalCharacterFoundationLayer,
} from './canonical-foundation.js';
import { createComponentLogger } from '../../shared/logger.js';
import { appendJsonLine } from '../../persistence/jsonl.js';
import { writeJsonAtomic } from '../../shared/utils/fs.js';

const log = createComponentLogger('PromptStore');
const HISTORY_SCAN_CHUNK_BYTES = 32 * 1024;
const HISTORY_CORRUPTION_DETAIL_LIMIT = 5;

interface HistoryCorruptionDetail {
  lineNumber: number;
  error: string;
  linePreview: string;
}

function contentChecksum(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

function normalizePromptIdentifier(identifier: string | undefined): string | undefined {
  if (identifier == null) return undefined;
  const trimmed = identifier.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeReason(reason: string | undefined): string | undefined {
  if (reason == null) return undefined;
  const trimmed = reason.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function validatePromptRole(role: unknown): PromptLayerRole | undefined {
  if (role == null) return undefined;
  if (typeof role !== 'string' || !PROMPT_LAYER_ROLES.includes(role as PromptLayerRole)) {
    throw new Error(`Invalid prompt role "${String(role)}". Expected one of: ${PROMPT_LAYER_ROLES.join(', ')}`);
  }
  return role as PromptLayerRole;
}

function validatePromptOrder(promptOrder: unknown): number | undefined {
  if (promptOrder == null) return undefined;
  if (typeof promptOrder !== 'number' || !Number.isInteger(promptOrder) || promptOrder < 0) {
    throw new Error('promptOrder must be an integer >= 0');
  }
  return promptOrder;
}

function validatePriority(priority: unknown): number {
  if (typeof priority !== 'number' || !Number.isInteger(priority)) {
    throw new Error('priority must be an integer');
  }
  return priority;
}

function historyLinePreview(line: string): string {
  const compact = line.trim().replace(/\s+/g, ' ');
  if (compact.length <= 120) return compact;
  return `${compact.slice(0, 117)}...`;
}

function isPromptHistoryEntry(value: unknown): value is PromptHistoryEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  if (typeof entry.layerId !== 'string') return false;
  if (typeof entry.layerName !== 'string') return false;
  if (typeof entry.previousContent !== 'string') return false;
  if (typeof entry.previousChecksum !== 'string') return false;
  if (typeof entry.newContent !== 'string') return false;
  if (typeof entry.newChecksum !== 'string') return false;
  if (typeof entry.updatedBy !== 'string') return false;
  if (typeof entry.timestamp !== 'string') return false;
  if (typeof entry.version !== 'number') return false;
  if (entry.reason !== undefined && typeof entry.reason !== 'string') return false;
  return true;
}

export interface PromptLayerMetadataUpdate {
  identifier?: string;
  role?: PromptLayerRole;
  promptOrder?: number;
}

export interface PromptLayerUpdatePatch {
  name?: string;
  content?: string;
  priority?: number;
  metadata?: PromptLayerMetadataUpdate;
}

export class PromptLayerStore {
  private filePath: string;
  private historyPath: string;
  private layers: PromptLayer[] = [];

  constructor(filePath: string, historyPath: string) {
    this.filePath = filePath;
    this.historyPath = historyPath;
    this.load();
  }

  private load(): void {
    try {
      if (existsSync(this.filePath)) {
        const raw = readFileSync(this.filePath, 'utf-8');
        this.layers = JSON.parse(raw);
      }
    } catch (err) {
      log.error('Failed to load prompt layers', { error: String(err) });
      this.layers = [];
    }
  }

  private save(): void {
    writeJsonAtomic(this.filePath, this.layers, { trailingNewline: false });
  }

  private appendHistory(entry: PromptHistoryEntry): void {
    try {
      appendJsonLine(this.historyPath, entry);
    } catch (err) {
      log.error('Failed to write prompt history', { error: String(err) });
    }
  }

  private scanHistoryLines(onLine: (line: string, lineNumber: number) => boolean | void): void {
    if (!existsSync(this.historyPath)) return;

    const fd = openSync(this.historyPath, 'r');
    try {
      const fileSize = fstatSync(fd).size;
      if (fileSize <= 0) return;

      const buffer = Buffer.allocUnsafe(HISTORY_SCAN_CHUNK_BYTES);
      let offset = 0;
      let remainder = Buffer.alloc(0);
      let lineNumber = 0;

      while (offset < fileSize) {
        const bytesToRead = Math.min(HISTORY_SCAN_CHUNK_BYTES, fileSize - offset);
        const bytesRead = readSync(fd, buffer, 0, bytesToRead, offset);
        if (bytesRead <= 0) break;
        offset += bytesRead;

        const chunk = buffer.subarray(0, bytesRead);
        const combined = remainder.length > 0 ? Buffer.concat([remainder, chunk]) : chunk;

        let start = 0;
        let newlineIndex = combined.indexOf(0x0A, start);
        while (newlineIndex !== -1) {
          let lineBuffer = combined.subarray(start, newlineIndex);
          if (lineBuffer.length > 0 && lineBuffer[lineBuffer.length - 1] === 0x0D) {
            lineBuffer = lineBuffer.subarray(0, lineBuffer.length - 1);
          }
          lineNumber += 1;
          if (onLine(lineBuffer.toString('utf8'), lineNumber)) return;
          start = newlineIndex + 1;
          newlineIndex = combined.indexOf(0x0A, start);
        }

        remainder = start < combined.length
          ? Buffer.from(combined.subarray(start))
          : Buffer.alloc(0);
      }

      if (remainder.length > 0) {
        lineNumber += 1;
        if (onLine(remainder.toString('utf8'), lineNumber)) return;
      }
    } finally {
      closeSync(fd);
    }
  }

  private tryParseHistoryEntry(
    line: string,
    lineNumber: number,
    corruptionDetails: HistoryCorruptionDetail[],
  ): PromptHistoryEntry | null {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!isPromptHistoryEntry(parsed)) {
        throw new Error('Invalid prompt history entry schema');
      }
      return parsed;
    } catch (error) {
      if (corruptionDetails.length < HISTORY_CORRUPTION_DETAIL_LIMIT) {
        corruptionDetails.push({
          lineNumber,
          error: String(error),
          linePreview: historyLinePreview(line),
        });
      }
      return null;
    }
  }

  private logHistoryRecoveryWarning(
    invalidLineCount: number,
    recoveredEntryCount: number,
    corruptionDetails: HistoryCorruptionDetail[],
    context: string,
  ): void {
    if (invalidLineCount <= 0) return;
    log.warn('Recovered prompt history with skipped corrupted lines', {
      historyPath: this.historyPath,
      context,
      invalidLineCount,
      recoveredEntryCount,
      corruptionDetails,
    });
  }

  private collectHistoryEntries(filter?: (entry: PromptHistoryEntry) => boolean): PromptHistoryEntry[] {
    const entries: PromptHistoryEntry[] = [];
    const corruptionDetails: HistoryCorruptionDetail[] = [];
    let invalidLineCount = 0;

    this.scanHistoryLines((line, lineNumber) => {
      if (line.trim().length === 0) return false;
      const entry = this.tryParseHistoryEntry(line, lineNumber, corruptionDetails);
      if (!entry) {
        invalidLineCount += 1;
        return false;
      }
      if (!filter || filter(entry)) {
        entries.push(entry);
      }
      return false;
    });

    this.logHistoryRecoveryWarning(
      invalidLineCount,
      entries.length,
      corruptionDetails,
      filter ? 'filtered-history-read' : 'history-read',
    );

    return entries;
  }

  private findHistoryEntry(layerId: string, version: number): PromptHistoryEntry | null {
    let found: PromptHistoryEntry | null = null;
    const corruptionDetails: HistoryCorruptionDetail[] = [];
    let invalidLineCount = 0;
    let recoveredEntryCount = 0;

    this.scanHistoryLines((line, lineNumber) => {
      if (line.trim().length === 0) return false;
      const entry = this.tryParseHistoryEntry(line, lineNumber, corruptionDetails);
      if (!entry) {
        invalidLineCount += 1;
        return false;
      }
      recoveredEntryCount += 1;
      if (entry.layerId === layerId && entry.version === version) {
        found = entry;
        return true;
      }
      return false;
    });

    this.logHistoryRecoveryWarning(
      invalidLineCount,
      recoveredEntryCount,
      corruptionDetails,
      'history-lookup',
    );

    return found;
  }

  getAll(): PromptLayer[] {
    return [...this.layers];
  }

  getById(id: string): PromptLayer | undefined {
    return this.layers.find(l => l.id === id);
  }

  getByType(type: LayerType): PromptLayer[] {
    return this.layers.filter(l => l.type === type);
  }

  create(params: {
    type: LayerType;
    name: string;
    content: string;
    enabled?: boolean;
    identifier?: string;
    role?: PromptLayerRole;
    promptOrder?: number;
    priority?: number;
    channelType?: string;
    taskKind?: string;
    updatedBy?: string;
  }): PromptLayer {
    const identifier = normalizePromptIdentifier(params.identifier);
    const role = validatePromptRole(params.role);
    const promptOrder = validatePromptOrder(params.promptOrder);

    const layer: PromptLayer = {
      id: randomUUID(),
      type: params.type,
      name: params.name,
      identifier,
      role,
      promptOrder,
      content: params.content,
      enabled: params.enabled ?? true,
      priority: params.priority ?? 0,
      channelType: params.channelType,
      taskKind: params.taskKind,
      updatedAt: new Date().toISOString(),
      updatedBy: params.updatedBy ?? 'system',
      checksum: contentChecksum(params.content),
      version: 1,
    };
    this.layers.push(layer);
    this.save();
    log.info(`Created prompt layer: ${layer.name} (${layer.type})`);
    return layer;
  }

  update(
    id: string,
    content: string,
    updatedBy: string,
    metadata?: PromptLayerMetadataUpdate,
    reason?: string,
  ): PromptLayer;
  update(
    id: string,
    patch: PromptLayerUpdatePatch,
    updatedBy: string,
    reason?: string,
  ): PromptLayer;
  update(
    id: string,
    contentOrPatch: string | PromptLayerUpdatePatch,
    updatedBy: string,
    metadataOrReason: PromptLayerMetadataUpdate | string = {},
    reasonArg?: string,
  ): PromptLayer {
    const layer = this.layers.find(l => l.id === id);
    if (!layer) throw new Error(`Prompt layer not found: ${id}`);

    let nextContent = layer.content;
    let nextName = layer.name;
    let hasContent = false;
    let hasName = false;
    let hasPriority = false;
    let nextPriority = layer.priority;
    let metadata: PromptLayerMetadataUpdate = {};
    let reason: string | undefined = reasonArg;

    if (typeof contentOrPatch === 'string') {
      nextContent = contentOrPatch;
      hasContent = true;
      if (typeof metadataOrReason === 'string') {
        reason = metadataOrReason;
      } else {
        metadata = metadataOrReason;
      }
    } else {
      const patch = contentOrPatch;
      if (Object.prototype.hasOwnProperty.call(patch, 'name')) {
        if (typeof patch.name !== 'string' || patch.name.trim().length === 0) {
          throw new Error('name must be a non-empty string');
        }
        nextName = patch.name.trim();
        hasName = true;
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'content')) {
        if (typeof patch.content !== 'string') {
          throw new Error('content must be a string');
        }
        nextContent = patch.content;
        hasContent = true;
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'priority')) {
        nextPriority = validatePriority(patch.priority);
        hasPriority = true;
      }
      metadata = patch.metadata ?? {};
      if (typeof metadataOrReason === 'string') {
        reason = metadataOrReason;
      }
    }

    const hasIdentifier = Object.prototype.hasOwnProperty.call(metadata, 'identifier');
    const hasRole = Object.prototype.hasOwnProperty.call(metadata, 'role');
    const hasPromptOrder = Object.prototype.hasOwnProperty.call(metadata, 'promptOrder');

    const identifier = hasIdentifier ? normalizePromptIdentifier(metadata.identifier) : undefined;
    const role = hasRole ? validatePromptRole(metadata.role) : undefined;
    const promptOrder = hasPromptOrder ? validatePromptOrder(metadata.promptOrder) : undefined;
    const normalizedReason = normalizeReason(reason);
    const hasAnyUpdate = hasName || hasContent || hasPriority || hasIdentifier || hasRole || hasPromptOrder;
    if (!hasAnyUpdate) {
      throw new Error('No prompt update fields provided');
    }
    const nextChecksum = contentChecksum(nextContent);

    // Record history before modifying
    this.appendHistory({
      layerId: layer.id,
      layerName: layer.name,
      previousContent: layer.content,
      previousChecksum: layer.checksum,
      newContent: nextContent,
      newChecksum: nextChecksum,
      updatedBy,
      ...(normalizedReason ? { reason: normalizedReason } : {}),
      timestamp: new Date().toISOString(),
      version: layer.version,
    });

    if (hasName) layer.name = nextName;
    if (hasContent) layer.content = nextContent;
    if (hasPriority) layer.priority = nextPriority;
    if (hasIdentifier) layer.identifier = identifier;
    if (hasRole) layer.role = role;
    if (hasPromptOrder) layer.promptOrder = promptOrder;
    layer.checksum = nextChecksum;
    layer.version += 1;
    layer.updatedAt = new Date().toISOString();
    layer.updatedBy = updatedBy;
    this.save();
    log.info(`Updated prompt layer: ${layer.name} v${layer.version}`);
    return layer;
  }

  reorderByLayerIds(
    layerIds: string[],
    updatedBy: string,
    reason?: string,
  ): PromptLayer[] {
    if (!Array.isArray(layerIds) || layerIds.length === 0) {
      throw new Error('layerIds must be a non-empty array');
    }
    if (layerIds.length !== this.layers.length) {
      throw new Error('layerIds must include every prompt layer exactly once');
    }

    const seen = new Set<string>();
    for (const rawId of layerIds) {
      if (typeof rawId !== 'string') {
        throw new Error('layerIds entries must be strings');
      }
      const layerId = rawId.trim();
      if (!layerId) {
        throw new Error('layerIds entries must be non-empty');
      }
      if (seen.has(layerId)) {
        throw new Error(`Duplicate layer id in reorder payload: ${layerId}`);
      }
      seen.add(layerId);
    }

    const layerById = new Map(this.layers.map(layer => [layer.id, layer]));
    const targetOrder: PromptLayer[] = [];
    const requestedIndexById = new Map<string, number>();
    for (const layerId of layerIds) {
      const layer = layerById.get(layerId);
      if (!layer) {
        throw new Error(`Prompt layer not found: ${layerId}`);
      }
      requestedIndexById.set(layerId, targetOrder.length);
      targetOrder.push(layer);
    }

    if (targetOrder.length !== this.layers.length) {
      throw new Error('layerIds must include every prompt layer exactly once');
    }

    const normalizedOrder = [...targetOrder].sort((left, right) => {
      const typeOrder = LAYER_TYPE_ORDER[left.type] - LAYER_TYPE_ORDER[right.type];
      if (typeOrder !== 0) return typeOrder;
      return (requestedIndexById.get(left.id) ?? 0) - (requestedIndexById.get(right.id) ?? 0);
    });

    const normalizedReason = normalizeReason(reason);
    const timestamp = new Date().toISOString();
    const touched: PromptLayer[] = [];

    for (let nextPriority = 0; nextPriority < normalizedOrder.length; nextPriority++) {
      const layer = normalizedOrder[nextPriority];
      const nextPromptOrder = nextPriority;
      if (layer.priority === nextPriority && layer.promptOrder === nextPromptOrder) continue;

      this.appendHistory({
        layerId: layer.id,
        layerName: layer.name,
        previousContent: layer.content,
        previousChecksum: layer.checksum,
        newContent: layer.content,
        newChecksum: layer.checksum,
        updatedBy,
        ...(normalizedReason ? { reason: normalizedReason } : {}),
        timestamp,
        version: layer.version,
      });

      layer.priority = nextPriority;
      layer.promptOrder = nextPromptOrder;
      layer.version += 1;
      layer.updatedAt = timestamp;
      layer.updatedBy = updatedBy;
      touched.push(layer);
    }

    if (touched.length > 0) {
      this.save();
      log.info(`Reordered prompt layers (${touched.length} touched)`);
    }

    return touched;
  }

  toggle(id: string): PromptLayer {
    const layer = this.layers.find(l => l.id === id);
    if (!layer) throw new Error(`Prompt layer not found: ${id}`);
    // Don't allow disabling the only base layer
    if (layer.type === 'base' && layer.enabled) {
      const otherBases = this.layers.filter(l => l.type === 'base' && l.id !== id && l.enabled);
      if (otherBases.length === 0) {
        throw new Error('Cannot disable the only enabled base layer');
      }
    }
    layer.enabled = !layer.enabled;
    layer.updatedAt = new Date().toISOString();
    this.save();
    log.info(`Toggled prompt layer: ${layer.name} -> ${layer.enabled ? 'enabled' : 'disabled'}`);
    return layer;
  }

  delete(id: string): void {
    const idx = this.layers.findIndex(l => l.id === id);
    if (idx === -1) throw new Error(`Prompt layer not found: ${id}`);
    const layer = this.layers[idx];
    // Don't allow deleting the only base layer
    if (layer.type === 'base') {
      const otherBases = this.layers.filter(l => l.type === 'base' && l.id !== id);
      if (otherBases.length === 0) {
        throw new Error('Cannot delete the only base layer');
      }
    }
    this.layers.splice(idx, 1);
    this.save();
    log.info(`Deleted prompt layer: ${layer.name}`);
  }

  getHistory(): PromptHistoryEntry[] {
    try {
      return this.collectHistoryEntries();
    } catch {
      return [];
    }
  }

  getLayerHistory(layerId: string): PromptHistoryEntry[] {
    try {
      return this.collectHistoryEntries(entry => entry.layerId === layerId);
    } catch {
      return [];
    }
  }

  rollback(layerId: string, version: number): PromptLayer {
    const entry = this.findHistoryEntry(layerId, version);
    if (!entry) throw new Error(`No history entry for layer ${layerId} version ${version}`);
    return this.update(
      layerId,
      entry.previousContent,
      'admin:rollback',
      {},
      `Rollback to version ${version}`,
    );
  }

  private buildFoundationLayers(
    sections: readonly FoundationSectionState[],
    updatedBy: string,
  ): PromptLayer[] {
    const now = new Date().toISOString();
    return sections.map(section => {
      const definition = FOUNDATION_SECTION_DEFINITIONS.find(entry => entry.id === section.id)!;
      const content = composeFoundationSectionTemplate(section);
      return {
        id: randomUUID(),
        type: 'base',
        name: definition.layerName,
        identifier: definition.identifier,
        role: 'system',
        promptOrder: definition.promptOrder,
        content,
        enabled: section.enabled,
        priority: definition.priority,
        updatedAt: now,
        updatedBy,
        checksum: contentChecksum(content),
        version: 1,
      };
    });
  }

  private normalizeFoundationMetadata(
    layer: PromptLayer,
    updatedBy: string,
    reason: string,
    definition: (typeof FOUNDATION_SECTION_DEFINITIONS)[number],
  ): boolean {
    const metadataPatch = {
      ...(layer.identifier !== definition.identifier ? { identifier: definition.identifier } : {}),
      ...(layer.role !== 'system' ? { role: 'system' as const } : {}),
      ...(layer.promptOrder !== definition.promptOrder ? { promptOrder: definition.promptOrder } : {}),
    };
    const nextPriority = layer.priority !== definition.priority ? definition.priority : undefined;
    const nextName = layer.name !== definition.layerName ? definition.layerName : undefined;
    if (Object.keys(metadataPatch).length === 0 && nextPriority === undefined && nextName === undefined) {
      return false;
    }
    this.update(layer.id, {
      ...(nextPriority !== undefined ? { priority: nextPriority } : {}),
      ...(Object.keys(metadataPatch).length > 0 ? { metadata: metadataPatch } : {}),
    }, updatedBy, reason);
    if (nextName !== undefined) {
      layer.name = nextName;
      layer.updatedAt = new Date().toISOString();
      layer.updatedBy = updatedBy;
      this.save();
    }
    return true;
  }

  private migrateLegacyCanonicalFoundation(systemPrompt: string): boolean {
    const baseLayers = this.layers.filter(layer => layer.type === 'base');
    if (baseLayers.length !== 1) return false;
    const legacy = baseLayers[0];
    if (!isCanonicalCharacterFoundationLayer(legacy)) return false;

    const sections = decomposeFoundationSections(legacy.content || systemPrompt);
    const replacementLayers = this.buildFoundationLayers(sections, 'system:foundation-migration');
    this.layers = this.layers
      .filter(layer => layer.id !== legacy.id)
      .concat(replacementLayers);
    this.save();
    log.info('Migrated legacy Character Foundation into per-section base layers');
    return true;
  }

  private ensureFoundationLayers(systemPrompt: string): boolean {
    const currentFoundationLayers = this.layers.filter(layer => isCanonicalCharacterFoundationLayer(layer));
    const legacyMonolith = currentFoundationLayers.length === 1
      && currentFoundationLayers[0]?.name === CANONICAL_CHARACTER_FOUNDATION_NAME
      && currentFoundationLayers[0]?.identifier === 'main';
    if (legacyMonolith) {
      return this.migrateLegacyCanonicalFoundation(systemPrompt);
    }
    if (currentFoundationLayers.length === 0) {
      if (this.layers.length === 0) {
        const layers = this.buildFoundationLayers(
          decomposeFoundationSections(systemPrompt),
          'system',
        );
        this.layers.push(...layers);
        this.save();
        log.info('Seeded prompt store from character card');
        return true;
      }
      return this.migrateLegacyCanonicalFoundation(systemPrompt);
    }

    let changed = false;
    const byIdentifier = new Map(
      currentFoundationLayers
        .map(layer => [layer.identifier, layer] as const)
        .filter((entry): entry is [string, PromptLayer] => Boolean(entry[0])),
    );
    for (const definition of FOUNDATION_SECTION_DEFINITIONS) {
      const existing = byIdentifier.get(definition.identifier);
      if (!existing) {
        this.create({
          type: 'base',
          name: definition.layerName,
          enabled: definition.defaultEnabled,
          identifier: definition.identifier,
          role: 'system',
          promptOrder: definition.promptOrder,
          content: composeFoundationSectionTemplate({
            id: definition.id,
            content: definition.defaultContent,
            enabled: definition.defaultEnabled,
            title: definition.title,
            defaultEnabled: definition.defaultEnabled,
          }),
          priority: definition.priority,
          updatedBy: 'system:foundation-seed',
        });
        changed = true;
        continue;
      }
      changed = this.normalizeFoundationMetadata(
        existing,
        'system:foundation-normalize',
        `Normalize Character Foundation layer ${definition.identifier}`,
        definition,
      ) || changed;
    }
    return changed;
  }

  /** Seed from character card if store is empty */
  seedFromCharacterCard(systemPrompt: string): boolean {
    if (this.ensureFoundationLayers(systemPrompt)) {
      return true;
    }

    if (this.layers.length === 0) {
      return false;
    }

    const baseLayers = this.layers.filter(layer => layer.type === 'base');
    if (baseLayers.length !== 1) return false;

    const base = baseLayers[0];
    let touched = false;

    if (!base.identifier) {
      base.identifier = 'main';
      touched = true;
    }
    if (!base.role || !PROMPT_LAYER_ROLES.includes(base.role)) {
      base.role = 'system';
      touched = true;
    }
    if (base.promptOrder == null || !Number.isInteger(base.promptOrder) || base.promptOrder < 0) {
      base.promptOrder = 0;
      touched = true;
    }

    const looksLikeUntouchedSystemSeed = (
      base.name === 'Character Foundation'
      && base.updatedBy === 'system'
      && base.version === 1
    );
    const hasFrozenLegacyUserToken = !base.content.includes('{{user}}')
      && /\bUser\b/.test(base.content);

    if (looksLikeUntouchedSystemSeed && base.content !== systemPrompt) {
      const syncActor = hasFrozenLegacyUserToken ? 'system:migrate-user-token' : 'system:seed-sync';
      const syncReason = hasFrozenLegacyUserToken
        ? 'Upgrade Character Foundation to runtime {{user}} token template'
        : 'Refresh untouched Character Foundation from current character card';
      this.appendHistory({
        layerId: base.id,
        layerName: base.name,
        previousContent: base.content,
        previousChecksum: base.checksum,
        newContent: systemPrompt,
        newChecksum: contentChecksum(systemPrompt),
        updatedBy: syncActor,
        reason: syncReason,
        timestamp: new Date().toISOString(),
        version: base.version,
      });
      base.content = systemPrompt;
      base.checksum = contentChecksum(systemPrompt);
      base.version += 1;
      base.updatedAt = new Date().toISOString();
      base.updatedBy = syncActor;
      touched = true;
      log.info('Refreshed untouched Character Foundation seed from current character card', {
        actor: syncActor,
      });
    }

    if (touched) {
      this.save();
    }
    return touched;
  }

  /** Get count of layers */
  get count(): number {
    return this.layers.length;
  }

  /** Location of the prompt layer JSON file. */
  get layerFilePath(): string {
    return this.filePath;
  }
}
