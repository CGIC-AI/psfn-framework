import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import ContactIntroductionProvenance from './ContactIntroductionProvenance.svelte';

describe('ContactIntroductionProvenance', () => {
  it('renders the recorded first-introduction evidence', () => {
    const rendered = render(ContactIntroductionProvenance, {
      props: {
        link: {
          channel: 'eidoverse',
          userId: 'participant-aid1-visitor',
          privacyLevel: 'invite_only',
          introducedAtPlaceId: 'place.central-plaza',
          introducedAtWorld: 'anima-research/eidoverse',
          introducedVia: 'eidoverse',
        },
      },
    });

    expect(rendered.body).toContain('Introduced via eidoverse');
    expect(rendered.body).toContain('World anima-research/eidoverse');
    expect(rendered.body).toContain('Place place.central-plaza');
  });

  it('renders nothing for byte-compatible links with no introduction evidence', () => {
    const rendered = render(ContactIntroductionProvenance, {
      props: {
        link: {
          channel: 'discord',
          userId: 'existing-user',
          privacyLevel: 'invite_only',
        },
      },
    });

    expect(rendered.body).not.toContain('data-contact-introduction-provenance');
  });
});
