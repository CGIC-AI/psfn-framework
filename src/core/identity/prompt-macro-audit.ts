// ── Persisted prompt macro audit (E2.5 safety valve, report-only) ──
// Pure scan over persisted operator-customized prompt content (prompt layers
// + prompt registry entries) for references to macros removed by the macro
// consolidation, plus macro names that no longer resolve in the manifest at
// all. The runtime fails closed at layer edit/compose time; this audit lets
// the operator find every affected layer up front with the canonical
// replacement for each removed name. It never rewrites anything.

import {
  collectRemovedPromptMacroReferences,
  resolvePromptMacroManifestEntry,
  type RemovedPromptMacroReference,
} from './prompt-runtime.js';

const TEMPLATE_TOKEN_PATTERN = /\{\{\s*([a-zA-Z0-9_.-]+(?:\(\))?)\s*\}\}/g;

export interface PromptMacroAuditFinding {
  source: 'prompt_layer' | 'prompt_registry';
  id: string;
  label: string;
  enabled?: boolean;
  removedMacros: RemovedPromptMacroReference[];
  unregisteredMacros: string[];
}

export interface PromptMacroAuditReport {
  scannedLayerCount: number;
  scannedRegistryEntryCount: number;
  findings: PromptMacroAuditFinding[];
  ok: boolean;
}

export interface PromptMacroAuditLayerInput {
  id: string;
  label: string;
  enabled?: boolean;
  content: string;
}

export interface PromptMacroAuditRegistryInput {
  key: string;
  text: string;
}

function collectUnregisteredMacroNames(content: string): string[] {
  const unregistered = new Set<string>();
  for (const match of content.matchAll(TEMPLATE_TOKEN_PATTERN)) {
    const name = match[1];
    if (!resolvePromptMacroManifestEntry(name)) {
      unregistered.add(name.toLowerCase().replace(/\(\)$/, ''));
    }
  }
  return [...unregistered];
}

/** Pure audit over already-loaded persisted prompt content (testable). */
export function auditPromptMacroUsage(input: {
  layers: readonly PromptMacroAuditLayerInput[];
  registryEntries: readonly PromptMacroAuditRegistryInput[];
}): PromptMacroAuditReport {
  const findings: PromptMacroAuditFinding[] = [];

  for (const layer of input.layers) {
    const removedMacros = collectRemovedPromptMacroReferences(layer.content);
    const unregisteredMacros = collectUnregisteredMacroNames(layer.content)
      .filter(name => !removedMacros.some(reference => reference.name === name));
    if (removedMacros.length === 0 && unregisteredMacros.length === 0) continue;
    findings.push({
      source: 'prompt_layer',
      id: layer.id,
      label: layer.label,
      ...(layer.enabled !== undefined ? { enabled: layer.enabled } : {}),
      removedMacros,
      unregisteredMacros,
    });
  }

  for (const entry of input.registryEntries) {
    const removedMacros = collectRemovedPromptMacroReferences(entry.text);
    const unregisteredMacros = collectUnregisteredMacroNames(entry.text)
      .filter(name => !removedMacros.some(reference => reference.name === name));
    if (removedMacros.length === 0 && unregisteredMacros.length === 0) continue;
    findings.push({
      source: 'prompt_registry',
      id: entry.key,
      label: entry.key,
      removedMacros,
      unregisteredMacros,
    });
  }

  return {
    scannedLayerCount: input.layers.length,
    scannedRegistryEntryCount: input.registryEntries.length,
    findings,
    ok: findings.length === 0,
  };
}
