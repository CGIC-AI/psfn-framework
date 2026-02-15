// ── Prompt Stack Types ──
// Layered prompt composition: base -> operator -> runtime -> channel -> task

export type LayerType = 'base' | 'operator' | 'runtime' | 'channel' | 'task';

export const LAYER_TYPE_ORDER: Record<LayerType, number> = {
  base: 0,
  operator: 1,
  runtime: 2,
  channel: 3,
  task: 4,
};

export interface PromptLayer {
  id: string;
  type: LayerType;
  name: string;
  content: string;
  enabled: boolean;
  priority: number;        // within same type, lower = first
  channelType?: string;    // 'discord_text', 'discord_voice', 'api', 'internal'
  taskKind?: string;       // 'reflection', 'planning', 'maintenance', 'heartbeat'
  updatedAt: string;       // ISO string
  updatedBy: string;       // 'system' | 'admin' | 'agent'
  checksum: string;        // SHA-256 prefix of content
  version: number;
}

export interface ComposeContext {
  channelType?: string;
  taskKind?: string;
}

export interface ComposeResult {
  text: string;
  hash: string;
  layerCount: number;
  layerIds: string[];
}

export interface PromptHistoryEntry {
  layerId: string;
  layerName: string;
  previousContent: string;
  previousChecksum: string;
  newContent: string;
  newChecksum: string;
  updatedBy: string;
  timestamp: string;
  version: number;
}
