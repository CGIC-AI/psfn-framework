import { describe, expect, it } from 'vitest';
import { truncateToolOutputContent } from './tool-output.js';

describe('tool output utils', () => {
  it('leaves short content unchanged', () => {
    expect(truncateToolOutputContent('short', 12)).toBe('short');
  });

  it('truncates long content with the shared tool-output suffix', () => {
    expect(truncateToolOutputContent('abcdef', 3)).toBe('abc\n... (truncated)');
  });
});
