import type { RecentContactShapeArtifact } from '../memory-store-port.js';

export function collectRecentContactShapeProvenanceRefs(
  shape: RecentContactShapeArtifact | undefined,
): string[] {
  if (!shape) return [];
  const refs = new Set<string>();
  const contactId = shape.contactId.trim();
  if (contactId) {
    refs.add(`recent_contact_shape:${contactId}`);
  }
  for (const sourceMemoryId of shape.sourceMemoryIds) {
    const normalized = sourceMemoryId.trim();
    if (normalized) {
      refs.add(`recent_contact_shape_source_memory:${normalized}`);
    }
  }
  return [...refs];
}

export function mergeProvenanceRefs(...groups: Array<readonly string[] | undefined>): string[] {
  const refs = new Set<string>();
  for (const group of groups) {
    for (const ref of group ?? []) {
      const normalized = ref.trim();
      if (normalized) refs.add(normalized);
    }
  }
  return [...refs];
}
