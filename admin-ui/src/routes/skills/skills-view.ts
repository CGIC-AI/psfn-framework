import type { ManagedSkill, SkillRootScan } from '$lib/types';

export interface SkillRootView {
  root: SkillRootScan;
  degradationMessage?: string;
}

export function findManagedSkillRecord(
  managedSkills: ManagedSkill[],
  name: string,
): ManagedSkill | undefined {
  return managedSkills.find(skill => skill.name.toLowerCase() === name.toLowerCase());
}

export function formatMissingSkillRoot(root: SkillRootScan): string {
  if (root.source === 'custom') {
    return `Managed skills directory will be created when needed: ${root.absolutePath}`;
  }
  return root.message
    ?? `Skills root is missing on disk and cannot contribute skills: ${root.absolutePath}`;
}

export function buildSkillRootViews(roots: SkillRootScan[]): SkillRootView[] {
  return roots.map(root => ({
    root,
    ...(!root.exists && root.source !== 'custom'
      ? { degradationMessage: formatMissingSkillRoot(root) }
      : {}),
  }));
}
