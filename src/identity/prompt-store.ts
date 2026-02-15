// ── Prompt Layer Store ──
// JSON file-backed storage for prompt layers with JSONL history.
// Atomic write via .tmp + rename (same pattern as settings.ts).

import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import type { PromptLayer, LayerType, PromptHistoryEntry } from './prompt-types.js';
import { createComponentLogger } from '../logger.js';

const log = createComponentLogger('PromptStore');

function contentChecksum(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
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
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmpPath = this.filePath + '.tmp';
    writeFileSync(tmpPath, JSON.stringify(this.layers, null, 2), 'utf-8');
    renameSync(tmpPath, this.filePath);
  }

  private appendHistory(entry: PromptHistoryEntry): void {
    try {
      mkdirSync(dirname(this.historyPath), { recursive: true });
      appendFileSync(this.historyPath, JSON.stringify(entry) + '\n', 'utf-8');
    } catch (err) {
      log.error('Failed to write prompt history', { error: String(err) });
    }
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
    priority?: number;
    channelType?: string;
    taskKind?: string;
    updatedBy?: string;
  }): PromptLayer {
    const layer: PromptLayer = {
      id: randomUUID(),
      type: params.type,
      name: params.name,
      content: params.content,
      enabled: true,
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

  update(id: string, content: string, updatedBy: string): PromptLayer {
    const layer = this.layers.find(l => l.id === id);
    if (!layer) throw new Error(`Prompt layer not found: ${id}`);

    // Record history before modifying
    this.appendHistory({
      layerId: layer.id,
      layerName: layer.name,
      previousContent: layer.content,
      previousChecksum: layer.checksum,
      newContent: content,
      newChecksum: contentChecksum(content),
      updatedBy,
      timestamp: new Date().toISOString(),
      version: layer.version,
    });

    layer.content = content;
    layer.checksum = contentChecksum(content);
    layer.version += 1;
    layer.updatedAt = new Date().toISOString();
    layer.updatedBy = updatedBy;
    this.save();
    log.info(`Updated prompt layer: ${layer.name} v${layer.version}`);
    return layer;
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
      if (!existsSync(this.historyPath)) return [];
      const raw = readFileSync(this.historyPath, 'utf-8');
      return raw.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    } catch {
      return [];
    }
  }

  getLayerHistory(layerId: string): PromptHistoryEntry[] {
    return this.getHistory().filter(h => h.layerId === layerId);
  }

  rollback(layerId: string, version: number): PromptLayer {
    const history = this.getLayerHistory(layerId);
    const entry = history.find(h => h.version === version);
    if (!entry) throw new Error(`No history entry for layer ${layerId} version ${version}`);
    return this.update(layerId, entry.previousContent, 'admin:rollback');
  }

  /** Seed from character card if store is empty */
  seedFromCharacterCard(systemPrompt: string): void {
    if (this.layers.length > 0) return;
    this.create({
      type: 'base',
      name: 'Character Foundation',
      content: systemPrompt,
      priority: 0,
      updatedBy: 'system',
    });
    log.info('Seeded prompt store from character card');
  }

  /** Get count of layers */
  get count(): number {
    return this.layers.length;
  }
}
