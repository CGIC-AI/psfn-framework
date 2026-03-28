import type {
  MemoryScopeKind,
  MemoryScopeRef,
  PurrMemory,
} from '../../../faculties/memory/types.js';
import {
  normalizeMemoryScopeRef,
  normalizeMemoryScopeTags,
} from '../../../faculties/memory/types.js';

export type AdminMemoryManagedScopeKind = Extract<MemoryScopeKind, 'project' | 'north_star'>;

export interface AdminMemoryScopeDescriptor {
  kind: AdminMemoryManagedScopeKind;
  id: string;
  label?: string;
  canonicalTag: string;
}

export interface AdminMemoryScopeEvidenceItem {
  type:
    | 'scope_ref'
    | 'canonical_scope_tag'
    | 'related_scope_tag'
    | 'provenance_ref'
    | 'source_ref'
    | 'repair_note';
  value: string;
  detail: string;
}

export interface AdminMemoryScopeRepairPreview {
  scopeRef?: MemoryScopeRef;
  scopeTags: string[];
  needsRepair: boolean;
  notes: string[];
}

const MANAGED_SCOPE_KINDS = new Set<AdminMemoryManagedScopeKind>(['project', 'north_star']);

function isManagedScopeKind(value: string | undefined): value is AdminMemoryManagedScopeKind {
  return value === 'project' || value === 'north_star';
}

function normalizeManagedScopeId(value: string | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function parseManagedScopeTag(tag: string): AdminMemoryScopeDescriptor | null {
  const normalized = tag.trim().toLowerCase();
  const separator = normalized.indexOf(':');
  if (separator <= 0 || separator === normalized.length - 1) {
    return null;
  }
  const kind = normalized.slice(0, separator);
  const id = normalized.slice(separator + 1).trim();
  if (!isManagedScopeKind(kind) || id.length === 0) {
    return null;
  }
  return {
    kind,
    id,
    canonicalTag: `${kind}:${id}`,
  };
}

export function toManagedScopeDescriptor(
  value: MemoryScopeRef | AdminMemoryScopeDescriptor | undefined,
): AdminMemoryScopeDescriptor | null {
  const normalized = normalizeMemoryScopeRef(value);
  if (!normalized || !MANAGED_SCOPE_KINDS.has(normalized.kind as AdminMemoryManagedScopeKind)) {
    return null;
  }
  return {
    kind: normalized.kind as AdminMemoryManagedScopeKind,
    id: normalized.id,
    ...(normalized.label ? { label: normalized.label } : {}),
    canonicalTag: `${normalized.kind}:${normalized.id}`,
  };
}

export function collectManagedScopeDescriptors(memory: Pick<PurrMemory, 'scopeRef' | 'scopeTags'>): AdminMemoryScopeDescriptor[] {
  const byKey = new Map<string, AdminMemoryScopeDescriptor>();
  const fromRef = toManagedScopeDescriptor(memory.scopeRef);
  if (fromRef) {
    byKey.set(`${fromRef.kind}:${fromRef.id}`, fromRef);
  }
  for (const tag of normalizeMemoryScopeTags(memory.scopeTags)) {
    const parsed = parseManagedScopeTag(tag);
    if (!parsed) continue;
    const key = `${parsed.kind}:${parsed.id}`;
    const existing = byKey.get(key);
    byKey.set(
      key,
      existing
        ? { ...existing, canonicalTag: parsed.canonicalTag }
        : parsed,
    );
  }
  return [...byKey.values()];
}

export function buildManagedScopeRepairPreview(
  memory: Pick<PurrMemory, 'scopeRef' | 'scopeTags'>,
): AdminMemoryScopeRepairPreview {
  const notes: string[] = [];
  const normalizedScopeTags = normalizeMemoryScopeTags(memory.scopeTags);
  const normalizedScopeRef = normalizeMemoryScopeRef(memory.scopeRef);
  const managedScopeRef = toManagedScopeDescriptor(normalizedScopeRef);
  const parsedManagedTags = normalizedScopeTags
    .map(tag => ({ tag, parsed: parseManagedScopeTag(tag) }))
    .filter((entry): entry is { tag: string; parsed: AdminMemoryScopeDescriptor } => entry.parsed !== null);

  let repairedScopeRef = normalizedScopeRef;
  const repairedScopeTags = [...normalizedScopeTags];

  if (!managedScopeRef) {
    const uniqueManagedTags = new Map<string, AdminMemoryScopeDescriptor>();
    for (const entry of parsedManagedTags) {
      uniqueManagedTags.set(`${entry.parsed.kind}:${entry.parsed.id}`, entry.parsed);
    }
    if (uniqueManagedTags.size === 1) {
      const inferred = [...uniqueManagedTags.values()][0]!;
      repairedScopeRef = { kind: inferred.kind, id: inferred.id };
      notes.push(`Inferred ${inferred.kind} scopeRef from canonical scope tag ${inferred.canonicalTag}.`);
    } else if (uniqueManagedTags.size > 1) {
      notes.push('Multiple managed scope tags exist without a matching scopeRef; manual repair is required.');
    }
  }

  const repairedManagedScopeRef = toManagedScopeDescriptor(repairedScopeRef);
  if (repairedManagedScopeRef) {
    const conflictingTags = parsedManagedTags
      .filter(entry => entry.parsed.kind === repairedManagedScopeRef.kind && entry.parsed.id !== repairedManagedScopeRef.id)
      .map(entry => entry.tag);
    if (conflictingTags.length > 0) {
      for (const tag of conflictingTags) {
        const index = repairedScopeTags.indexOf(tag);
        if (index >= 0) repairedScopeTags.splice(index, 1);
      }
      notes.push(
        `Removed conflicting ${repairedManagedScopeRef.kind} scope tags: ${conflictingTags.join(', ')}.`,
      );
    }
    if (!repairedScopeTags.includes(repairedManagedScopeRef.canonicalTag)) {
      repairedScopeTags.push(repairedManagedScopeRef.canonicalTag);
      notes.push(`Added canonical scope tag ${repairedManagedScopeRef.canonicalTag}.`);
    }
  }

  const normalizedRepairedScopeTags = normalizeMemoryScopeTags(repairedScopeTags);
  const needsRepair = (
    normalizeMemoryScopeRef(memory.scopeRef)?.kind !== normalizeMemoryScopeRef(repairedScopeRef)?.kind
    || normalizeMemoryScopeRef(memory.scopeRef)?.id !== normalizeMemoryScopeRef(repairedScopeRef)?.id
    || normalizedScopeTags.length !== normalizedRepairedScopeTags.length
    || normalizedScopeTags.some((tag, index) => tag !== normalizedRepairedScopeTags[index])
  );

  return {
    ...(repairedScopeRef ? { scopeRef: repairedScopeRef } : {}),
    scopeTags: normalizedRepairedScopeTags,
    needsRepair,
    notes,
  };
}

export function buildManagedScopeEvidence(
  memory: Pick<PurrMemory, 'scopeRef' | 'scopeTags' | 'provenanceRefs' | 'sourceRef'>,
  scope: AdminMemoryScopeDescriptor,
): AdminMemoryScopeEvidenceItem[] {
  const evidence: AdminMemoryScopeEvidenceItem[] = [];
  const normalizedScopeTags = normalizeMemoryScopeTags(memory.scopeTags);
  if (memory.scopeRef?.kind === scope.kind && memory.scopeRef.id === scope.id) {
    evidence.push({
      type: 'scope_ref',
      value: `${scope.kind}:${scope.id}`,
      detail: memory.scopeRef.label
        ? `Stored explicit scopeRef with label "${memory.scopeRef.label}".`
        : 'Stored explicit scopeRef on the memory record.',
    });
  }
  if (normalizedScopeTags.includes(scope.canonicalTag)) {
    evidence.push({
      type: 'canonical_scope_tag',
      value: scope.canonicalTag,
      detail: 'Canonical scope tag matches this managed scope.',
    });
  }
  for (const tag of normalizedScopeTags) {
    if (tag === scope.canonicalTag) continue;
    const parsed = parseManagedScopeTag(tag);
    if (parsed && parsed.kind === scope.kind && parsed.id !== scope.id) {
      evidence.push({
        type: 'related_scope_tag',
        value: tag,
        detail: `Conflicting ${scope.kind} tag present on this memory.`,
      });
      continue;
    }
    if (!parsed) continue;
    if (parsed.kind === scope.kind && parsed.id === scope.id) {
      evidence.push({
        type: 'related_scope_tag',
        value: tag,
        detail: 'Additional matching scope tag was retained after normalization.',
      });
    }
  }
  for (const ref of memory.provenanceRefs ?? []) {
    evidence.push({
      type: 'provenance_ref',
      value: ref,
      detail: 'Provenance reference stored alongside the memory.',
    });
  }
  evidence.push({
    type: 'source_ref',
    value: memory.sourceRef,
    detail: 'Original memory source reference.',
  });

  const repairPreview = buildManagedScopeRepairPreview(memory);
  if (repairPreview.needsRepair) {
    for (const note of repairPreview.notes) {
      evidence.push({
        type: 'repair_note',
        value: scope.canonicalTag,
        detail: note,
      });
    }
  }
  return evidence;
}

export function parseManagedScopeParams(kind: string | undefined, id: string | undefined): AdminMemoryScopeDescriptor | null {
  const normalizedKind = typeof kind === 'string' ? kind.trim().toLowerCase() : '';
  const normalizedId = normalizeManagedScopeId(id);
  if (!isManagedScopeKind(normalizedKind) || normalizedId.length === 0) {
    return null;
  }
  return {
    kind: normalizedKind,
    id: normalizedId,
    canonicalTag: `${normalizedKind}:${normalizedId}`,
  };
}
