import type { ToolRegistrar } from '../../../core/agent/tool-registrar.js';
import { JournalOps, type JournalOperations } from './ops.js';
import { createJournalTool } from './tools.js';

export interface JournalRuntimeTarget {
  registerTool: ToolRegistrar;
}

export function registerJournalTools(
  target: JournalRuntimeTarget,
  journalOps: JournalOperations,
): void {
  target.registerTool(createJournalTool(journalOps), 'extended');
}

export function wireJournalRuntime(
  target: JournalRuntimeTarget,
  journalRoot: string,
): JournalOps {
  const journalOps = new JournalOps(journalRoot);
  registerJournalTools(target, journalOps);
  return journalOps;
}
