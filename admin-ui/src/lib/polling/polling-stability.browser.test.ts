// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { createSilentBackgroundRevalidation } from './silent-background-revalidation';

describe('Garden polling browser-state regression', () => {
  it('preserves focus, selection, expansion, and scroll across unchanged polling intervals', async () => {
    document.body.innerHTML = `
      <main data-route>
        <span data-count="held-1">1</span>
        <span data-count="held-2">2</span>
        <details open><summary>Review held item</summary>
          <textarea>operator draft</textarea>
        </details>
      </main>
    `;
    const route = document.querySelector<HTMLElement>('[data-route]')!;
    const details = document.querySelector<HTMLDetailsElement>('details')!;
    const textarea = document.querySelector<HTMLTextAreaElement>('textarea')!;
    const stableBadge = document.querySelector<HTMLElement>('[data-count="held-2"]')!;
    route.scrollTop = 240;
    textarea.focus();
    textarea.setSelectionRange(3, 11);

    let snapshot = {
      entries: [
        { id: 'held-1', count: 1 },
        { id: 'held-2', count: 2 },
      ],
    };
    let incoming = structuredClone(snapshot);
    const write = vi.fn((next: typeof snapshot) => {
      const previous = snapshot;
      snapshot = next;
      next.entries.forEach((entry, index) => {
        if (entry === previous.entries[index]) return;
        const badge = route.querySelector<HTMLElement>(`[data-count="${entry.id}"]`);
        if (badge) badge.textContent = String(entry.count);
      });
    });
    const revalidation = createSilentBackgroundRevalidation({
      load: async publish => publish(structuredClone(incoming)),
      read: () => snapshot,
      write,
      reportError: vi.fn(),
      fallbackError: 'Refresh failed',
    });
    const mutations: MutationRecord[] = [];
    const observer = new MutationObserver(records => mutations.push(...records));
    observer.observe(route, { attributes: true, childList: true, subtree: true });

    await revalidation.refresh();
    await revalidation.refresh();
    await Promise.resolve();

    expect(write).not.toHaveBeenCalled();
    expect(mutations).toHaveLength(0);
    expect(document.activeElement).toBe(textarea);
    expect(textarea.selectionStart).toBe(3);
    expect(textarea.selectionEnd).toBe(11);
    expect(textarea.value).toBe('operator draft');
    expect(details.open).toBe(true);
    expect(route.scrollTop).toBe(240);

    incoming = {
      entries: [
        { id: 'held-1', count: 3 },
        { id: 'held-2', count: 2 },
      ],
    };
    await revalidation.refresh();
    await Promise.resolve();

    expect(route.querySelector('[data-count="held-1"]')?.textContent).toBe('3');
    expect(route.querySelector('[data-count="held-2"]')).toBe(stableBadge);
    expect(document.activeElement).toBe(textarea);
    expect(textarea.selectionStart).toBe(3);
    expect(textarea.selectionEnd).toBe(11);
    expect(textarea.value).toBe('operator draft');
    expect(details.open).toBe(true);
    expect(route.scrollTop).toBe(240);
    observer.disconnect();
  });
});
