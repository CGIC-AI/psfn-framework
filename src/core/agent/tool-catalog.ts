import type { ToolWiringMeta } from './tool-wiring-validator.js';

export type RuntimeToolScope = 'core' | 'extended';

export const TOOLSET_CONTROL_TOOL_NAMES = ['tool_search', 'toolset'] as const;

export function isToolsetControlToolName(name: string): boolean {
  return TOOLSET_CONTROL_TOOL_NAMES.includes(name as typeof TOOLSET_CONTROL_TOOL_NAMES[number]);
}

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
