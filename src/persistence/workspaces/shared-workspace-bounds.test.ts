import { describe, expect, it } from 'vitest';
import { compareSharedWorkspaceArtifactPaths } from './shared-workspace-bounds.js';

describe('compareSharedWorkspaceArtifactPaths (psfn-framework-emz0r)', () => {
  it('orders by pinned root collation, independent of the process locale', () => {
    const paths = ['notes/b.md', 'notes/B.md', 'notes/a.md', 'notes/ä.md', 'Notes/z.md'];
    const expected = [...paths].sort(new Intl.Collator('und').compare)
      .sort((left, right) => compareSharedWorkspaceArtifactPaths(left, right));
    expect([...paths].sort(compareSharedWorkspaceArtifactPaths)).toEqual(expected);
    // Root collation is not code-unit order: a lowercase path sorts before its
    // uppercase twin instead of after every uppercase path.
    expect(compareSharedWorkspaceArtifactPaths('notes/a.md', 'notes/B.md')).toBeLessThan(0);
  });

  it('is a strict total order even where the collator ties', () => {
    const composed = 'café.md';
    const decomposed = 'café.md';
    expect(new Intl.Collator('und').compare(composed, decomposed)).toBe(0);
    expect(compareSharedWorkspaceArtifactPaths(composed, decomposed)).not.toBe(0);
    expect(Math.sign(compareSharedWorkspaceArtifactPaths(composed, decomposed)))
      .toBe(-Math.sign(compareSharedWorkspaceArtifactPaths(decomposed, composed)));
    expect(compareSharedWorkspaceArtifactPaths(composed, composed)).toBe(0);
  });
});
