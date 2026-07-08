import { describe, expect, it } from 'vitest';
import { clipSnippet, normalizeWhitespace } from './snippets.js';

describe('snippet utils', () => {
  it('normalizes whitespace', () => {
    expect(normalizeWhitespace('  alpha\n\t beta   gamma  ')).toBe('alpha beta gamma');
  });

  it('clips normalized snippets with an ellipsis', () => {
    expect(clipSnippet('  alpha\n beta gamma  ', 12)).toBe('alpha bet...');
  });

  it('leaves short normalized snippets unchanged', () => {
    expect(clipSnippet('  alpha\n beta  ', 20)).toBe('alpha beta');
  });
});
