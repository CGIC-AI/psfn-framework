import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROUTES_DIRECTORY = fileURLToPath(new URL('../../routes', import.meta.url));

interface RoutePageSource {
  route: string;
  source: string;
}

function collectRoutePageSources(directory: string = ROUTES_DIRECTORY): RoutePageSource[] {
  const entries = readdirSync(directory, { withFileTypes: true });
  const routeSources: RoutePageSource[] = [];
  const pagePath = join(directory, '+page.svelte');

  if (existsSync(pagePath)) {
    const localSvelteSources = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.svelte'))
      .map((entry) => readFileSync(join(directory, entry.name), 'utf8'));
    const routePath = relative(ROUTES_DIRECTORY, directory);
    routeSources.push({
      route: routePath ? `/${routePath}` : '/',
      source: localSvelteSources.join('\n'),
    });
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    routeSources.push(...collectRoutePageSources(join(directory, entry.name)));
  }

  return routeSources.sort((left, right) => left.route.localeCompare(right.route));
}

const routePageSources = collectRoutePageSources();

describe('Garden route design adoption', () => {
  it.each(routePageSources)('$route has an intentional page identity', ({ route, source }) => {
    expect(
      source,
      `${route} must use the shared header or an intentional dashboard, settings, or sign-in identity`,
    ).toMatch(/GardenPageHeader|DashboardHeader|SettingsPageChrome|page-kicker/);
  });

  it.each(routePageSources)('$route uses the current composition language', ({ route, source }) => {
    expect(
      source,
      `${route} must use the shared Garden composition instead of a legacy standalone card layout`,
    ).toMatch(/garden-page|console-page-frame|DashboardHeader|page-kicker/);
  });

  it('keeps the fatal-error surface in the same design language', () => {
    const source = readFileSync(join(ROUTES_DIRECTORY, '+error.svelte'), 'utf8');

    expect(source).toContain('page-kicker');
    expect(source).toContain('garden-action garden-action--primary');
    expect(source).toContain('border-line bg-surface');
  });

  it('keeps authenticated navigation inside the shared console frame', () => {
    const source = readFileSync(join(ROUTES_DIRECTORY, '+layout.svelte'), 'utf8');

    expect(source).toContain("import OperatorNavigation from '$lib/components/navigation/OperatorNavigation.svelte'");
    expect(source).toContain('console-page-frame');
    expect(source).toContain('garden-action');
  });

  it('discovers route files recursively instead of relying on a hand-maintained allowlist', () => {
    expect(routePageSources.some(({ route }) => basename(route) === '[shardId]')).toBe(true);
    expect(routePageSources.some(({ route }) => route === '/cognitive-security/approvals')).toBe(true);
  });
});
