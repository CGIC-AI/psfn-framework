import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function routeSource(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), 'src/routes', relativePath), 'utf8');
}

describe('visibility-aware page adoption', () => {
  it.each([
    'confirmations/+page.svelte',
    'contact-approvals/+page.svelte',
    'graph-proposals/+page.svelte',
    'cognitive-security/approvals/+page.svelte',
  ])('%s uses the shared Garden queue refresh controller', (relativePath) => {
    const source = routeSource(relativePath);
    expect(source).toContain("from '$lib/polling/garden-queue-refresh'");
    expect(source).not.toContain('setInterval(');
  });

  it.each([
    'cognitive-security/drift/+page.svelte',
    'scheduler/+page.svelte',
    'chat/+page.svelte',
    'subsystem-health/+page.svelte',
  ])('%s uses visibility-aware network polling', (relativePath) => {
    const source = routeSource(relativePath);
    expect(source).toContain("from '$lib/polling/visibility-aware-poller'");
    expect(source).not.toContain('setInterval(');
  });

  it('leaves local-only relative-time ticks in place', () => {
    expect(routeSource('shards/+page.svelte')).toContain('tickInterval = setInterval(');
    expect(routeSource('telemetry/LazyPageContent.svelte')).toContain('uptimeInterval = setInterval(');
  });

  it('renders owner-backed scheduler tasks as read-only instead of runtime-mutable', () => {
    const source = routeSource('scheduler/+page.svelte');
    expect(source).toContain('{#if task.scheduleSource}');
    expect(source).toContain('Read-only · restart after Settings edits');
    expect(source).toContain('{#if !task.scheduleSource && !isProtected(task.id)}');
  });
});
