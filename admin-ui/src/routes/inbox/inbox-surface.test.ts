import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';

const { mockPage } = vi.hoisted(() => ({
  mockPage: { url: new URL('http://localhost/inbox') },
}));

vi.mock('$app/state', () => ({
  page: mockPage,
}));

vi.mock('$app/navigation', () => ({
  goto: vi.fn(),
}));

import InboxPage from './+page.svelte';
import ConfirmationsPage from '../confirmations/+page.svelte';
import EscalationsPage from '../escalations/+page.svelte';
import ContactApprovalsPage from '../contact-approvals/+page.svelte';
import GraphProposalsPage from '../graph-proposals/+page.svelte';
import CogSecApprovalsPage from '../cognitive-security/approvals/+page.svelte';
import CogSecRemediationPage from '../cognitive-security/remediation/+page.svelte';

describe('canonical Inbox surface', () => {
  it('renders all 6 unified approval and review tabs with canonical URLs', () => {
    mockPage.url = new URL('http://localhost/inbox');
    const body = render(InboxPage).body;

    expect(body).toContain('Inbox');
    expect(body).toContain('Confirmations');
    expect(body).toContain('Escalations');
    expect(body).toContain('Contacts');
    expect(body).toContain('Graph Proposals');
    expect(body).toContain('CogSec Quarantine');
    expect(body).toContain('Integrity Remediation');
  });

  it('embeds every queue surface without a second page heading and leaves standalone routes as redirect shells', () => {
    const surfaces = [
      { component: ConfirmationsPage, redirectText: 'Confirmations now live in the Inbox' },
      { component: EscalationsPage, redirectText: 'Escalations now live in the Inbox' },
      { component: ContactApprovalsPage, redirectText: 'Contact approvals now live in the Inbox' },
      { component: GraphProposalsPage, redirectText: 'Graph proposals now live in the Inbox' },
      { component: CogSecApprovalsPage, redirectText: 'Quarantine approvals now live in the Inbox' },
      { component: CogSecRemediationPage, redirectText: 'CogSec remediation now lives in the Inbox' },
    ];

    for (const surface of surfaces) {
      const embeddedBody = render(surface.component, { props: { embedded: true } }).body;
      expect(embeddedBody).not.toContain('<h1');

      const standaloneBody = render(surface.component).body;
      expect(standaloneBody).toContain(surface.redirectText);
    }
  });
});
