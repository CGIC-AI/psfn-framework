import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function routeSource(relativePath: string): string {
  return readFileSync(new URL(`../../routes/${relativePath}`, import.meta.url), 'utf8');
}

describe('Garden polling stability adoption', () => {
  it('keeps the active route outside a polling-sensitive key boundary', () => {
    const layout = routeSource('+layout.svelte');
    expect(layout).toContain('createVisibilityAwarePoller');
    expect(layout).not.toContain('window.setInterval(');
    expect(layout).not.toContain('{#key activeCompanionId');
    expect(layout).toContain('{@render children()}');
    expect(layout).toContain('shouldResetAttentionCounts');
    expect(layout).toContain('clearAttentionCounts');
  });

  it.each([
    'confirmations/+page.svelte',
    'contact-approvals/+page.svelte',
    'cognitive-security/approvals/+page.svelte',
    'graph-proposals/+page.svelte',
  ])('%s separates foreground loading from silent background revalidation', (path) => {
    const source = routeSource(path);
    expect(source).toContain('createSilentBackgroundRevalidation');
    expect(source).toContain('backgroundRefresh.refresh()');
    expect(source).toContain('backgroundRefresh.invalidate()');
    expect(source).toContain('backgroundRefresh.dispose()');
    expect(source).toContain('Background refresh failed: {backgroundError}');
    expect(source).toMatch(/#each[^\n]+\([^\n]+\.id\)/u);
  });
});
