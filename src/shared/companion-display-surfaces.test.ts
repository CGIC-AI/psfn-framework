import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

describe('companion display-name surface inventory', () => {
  it.each([
    {
      surface: 'startup and lifecycle notices',
      files: ['src/app/agent/control-plane.ts', 'src/system/lifecycle/notifications.ts'],
      markers: ['companionDisplayLabel', 'displayLabel', ' is back~'],
    },
    {
      surface: 'Fleet and Garden projections',
      files: [
        'src/boundary/gateway/fleet-portal-projection.ts',
        'admin-ui/src/routes/fleet/+page.svelte',
        'admin-ui/src/routes/shards/[shardId]/+page.svelte',
        'admin-ui/src/lib/components/fleet/FleetUsageSummary.svelte',
        'admin-ui/src/lib/components/fleet/FleetCostResults.svelte',
      ],
      markers: ['createCompanionDisplayIdentityResolver', 'Technical details', 'Companion ID'],
    },
    {
      surface: 'companion UI switcher and popups',
      files: [
        'src/boundary/gateway/fleet-portal-projection.ts',
        'companion-ui/src/ui/companion-selector.tsx',
      ],
      markers: ['displayLabel', 'companion.displayName', 'Talk to'],
    },
    {
      surface: 'approval attribution',
      files: [
        'src/boundary/gateway/privileged-core.ts',
        'src/boundary/gateway/approval-boundary.ts',
        'companion-ui/src/ui/context-layers.tsx',
      ],
      markers: ['approvalDisplayIdentity', 'createCompanionDisplayIdentityResolver', 'parentLabel'],
    },
    {
      surface: 'CogSec companion scope',
      files: [
        'src/operator/garden/services/session-service.ts',
        'admin-ui/src/routes/+layout.svelte',
      ],
      markers: ['assertGardenRequestCompanionScope', 'getCompanionName()'],
    },
    {
      surface: 'ICP and room events',
      files: [
        'admin-ui/src/routes/autonomy/LazyPageContent.svelte',
        'admin-ui/src/routes/room-arbiter/+page.svelte',
      ],
      markers: ['companionDisplayLabel', 'companionTechnicalLabel', 'Technical details'],
    },
    {
      surface: 'Bearer API settings',
      files: [
        'src/operator/garden/services/settings-service.ts',
        'admin-ui/src/routes/channels/+page.svelte',
      ],
      markers: [
        'createCompanionDisplayIdentityResolver',
        'selected.displayName',
        'companionDisplayLabel',
        'companionTechnicalLabel',
        'Technical details',
      ],
    },
    {
      surface: 'user-facing connection logs',
      files: ['src/boundary/gateway/server.ts'],
      markers: ['companionDisplayLabel(authenticatedCompanionId)', 'companionId: authenticatedCompanionId'],
    },
    {
      surface: 'onboarding-generated roster names',
      files: ['scripts/onboarding/config-generator.ts'],
      markers: ['displayName: plan.card?.data.name', 'DEFAULT_COMPANION_NAME'],
    },
  ])('keeps $surface on the canonical display-name path', ({ files, markers }) => {
    const combined = files.map(source).join('\n');
    for (const marker of markers) expect(combined).toContain(marker);
  });

  it('keeps raw companion ids out of CogSec event-page presentation', () => {
    const cogSecPages = [
      'admin-ui/src/routes/cognitive-security/firewall/+page.svelte',
      'admin-ui/src/routes/cognitive-security/remediation/+page.svelte',
    ].map(source).join('\n');

    expect(cogSecPages).not.toContain('companionId');
    expect(cogSecPages).toContain('getCompanionName()');
  });

  it('keeps Bearer API companion ids behind technical details', () => {
    const bearerPage = source('admin-ui/src/routes/channels/+page.svelte');

    expect(bearerPage).not.toContain("{requestBoundCompanionId() ?? 'companion scope unavailable'}");
    expect(bearerPage).not.toContain("{bearerPin.pinnedCompanionId ?? 'none (single-companion default)'}");
    expect(bearerPage).toContain(
      'companionDisplayLabel(bearerPin.companions, gardenCompanionId)',
    );
    expect(bearerPage).toContain(
      'companionDisplayLabel(bearerPin.companions, bearerPin.pinnedCompanionId)',
    );
  });

  it('keeps Cluster usage fallbacks on the explicit unknown-companion path', () => {
    const usageSurfaces = [
      'admin-ui/src/lib/components/fleet/FleetUsageSummary.svelte',
      'admin-ui/src/lib/components/fleet/FleetCostResults.svelte',
    ].map(source).join('\n');

    expect(usageSurfaces).not.toContain('shortId(companion.companionId)');
    expect(usageSurfaces).not.toContain('?? companion.companionId');
    expect(usageSurfaces).toContain('companionDisplayLabel');
    expect(usageSurfaces).toContain('companionTechnicalLabel');
  });

  it('keeps the Garden helper fallback explicit and exact ids technical', () => {
    const helper = source('admin-ui/src/lib/fleet/companion-display.ts');

    expect(helper).toContain("if (!companionId) return 'Unknown companion';");
    expect(helper).toContain('?? unknownDisplayIdentity.resolve(companionId).displayLabel');
    expect(helper).toContain('return unknownDisplayIdentity.resolve(companionId).technicalLabel;');
  });
});
