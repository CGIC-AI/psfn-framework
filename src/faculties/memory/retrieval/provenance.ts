import type { ContactProfileArtifact } from '../memory-store-port.js';

export function collectContactProfileProvenanceRefs(profile: ContactProfileArtifact | undefined): string[] {
  if (!profile) return [];
  const refs = new Set<string>();
  const contactId = profile.contactId.trim();
  if (contactId) {
    refs.add(`contact_profile:${contactId}`);
  }
  for (const sourceMemoryId of profile.sourceMemoryIds) {
    const normalized = sourceMemoryId.trim();
    if (normalized) {
      refs.add(`contact_profile_source_memory:${normalized}`);
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
