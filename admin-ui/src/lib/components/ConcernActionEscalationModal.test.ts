import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import ConcernActionEscalationModal from './ConcernActionEscalationModal.svelte';

describe('ConcernActionEscalationModal', () => {
  it('collects one mandatory justification before one exact-action click', () => {
    const rendered = render(ConcernActionEscalationModal, {
      props: {
        open: true,
        title: 'Resolve this concern?',
        context: 'Exact action: resolve.',
        reason: '',
      },
    });

    expect(rendered.body).toContain('concern-action-justification');
    expect(rendered.body).toContain('required');
    expect(rendered.body).toContain('maxlength="512"');
    expect(rendered.body).toContain('Run exact action');
    expect(rendered.body).toContain('mints and immediately spends one single-use grant');
    expect(rendered.body).toMatch(/<button[^>]*disabled[^>]*>Run exact action<\/button>/u);
  });

  it('preserves a failed-attempt reason for a fresh retry', () => {
    const reason = 'Verify remediation after a policy incident';
    const rendered = render(ConcernActionEscalationModal, {
      props: {
        open: true,
        title: 'Resolve this concern?',
        context: 'Exact action: resolve.',
        reason,
      },
    });

    expect(rendered.body).toContain(reason);
    expect(rendered.body).toContain('A retry mints a fresh grant');
  });
});
