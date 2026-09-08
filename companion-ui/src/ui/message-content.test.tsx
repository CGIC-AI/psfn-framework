import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MessageContent } from './message-content.js';

afterEach(cleanup);

describe('safe readable messages', () => {
  it('renders paragraphs, emphasis, inline code and incomplete streaming code fences', () => {
    const { container, getByLabelText } = render(<MessageContent content={'**Hello** with `code`\n\nSecond paragraph.\n\n```ts\nconst value = "<b>literal</b>";'} />);
    expect(container.querySelector('strong')?.textContent).toBe('Hello');
    expect(container.querySelector('p code')?.textContent).toBe('code');
    expect(container.querySelectorAll('p')).toHaveLength(2);
    expect(getByLabelText('ts code').textContent).toContain('<b>literal</b>');
    expect(container.querySelector('b')).toBeNull();
  });

  it('opens only absolute HTTP(S) links and leaves unsafe text uninterpreted', () => {
    const { container, getAllByRole } = render(<MessageContent content={'[Docs](https://example.com/docs) and https://example.org/help.\n[Bad](javascript:alert(1)) <img src=x onerror=alert(1)>\nhttps://name:password@example.com/'} />);
    const links = getAllByRole('link');
    expect(links.map(link => link.getAttribute('href'))).toEqual(['https://example.com/docs', 'https://example.org/help']);
    expect(links.every(link => link.getAttribute('rel') === 'noopener noreferrer')).toBe(true);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('[Bad](javascript:alert(1))');
    expect(container.textContent).toContain('https://name:password@example.com/');
  });

  it('does not link or interpret formatting inside code blocks', () => {
    const { container } = render(<MessageContent content={'```\nhttps://example.com **raw**\n```'} />);
    expect(container.querySelector('a')).toBeNull();
    expect(container.querySelector('strong')).toBeNull();
    expect(container.querySelector('code')?.textContent).toBe('https://example.com **raw**');
  });
});
