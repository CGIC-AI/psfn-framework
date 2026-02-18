import { describe, it, expect } from 'vitest';
import { promptDiffFragment } from './templates.js';

describe('promptDiffFragment', () => {
  it('shows no changes message when content is identical', () => {
    const html = promptDiffFragment('same', 'same');
    expect(html).toContain('No changes detected');
  });

  it('renders removed and added lines', () => {
    const html = promptDiffFragment('line-a\nline-b', 'line-a\nline-c');
    expect(html).toContain('- line-b');
    expect(html).toContain('+ line-c');
  });
});
