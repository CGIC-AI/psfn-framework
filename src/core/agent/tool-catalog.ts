import type { ToolWiringMeta } from './tool-wiring-validator.js';

export type RuntimeToolScope = 'core' | 'extended';

export interface RuntimeToolCatalogEntry {
  name: string;
  description: string;
  scope: RuntimeToolScope;
  wiringMeta?: ToolWiringMeta;
}

export interface RuntimeToolCatalogSnapshot {
  generatedAt: number;
  tools: RuntimeToolCatalogEntry[];
}
