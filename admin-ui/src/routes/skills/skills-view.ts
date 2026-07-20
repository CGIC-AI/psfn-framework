import type { SkillRootScan } from '$lib/types';

export interface SkillRootView {
  root: SkillRootScan;
  degradationMessage?: string;
}

export function formatMissingSkillRoot(root: SkillRootScan): string {
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
