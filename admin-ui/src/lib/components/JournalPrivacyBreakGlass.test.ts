import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import JournalPrivacyBreakGlass from './JournalPrivacyBreakGlass.svelte';

describe('JournalPrivacyBreakGlass', () => {
  it('renders the reason-bearing two-step ceremony for one exact journal stream', () => {
    const rendered = render(JournalPrivacyBreakGlass, {
      props: {
        stream: 'reflection-metacognition',
        streamLabel: 'Metacognition journal',
        onDisclosure: vi.fn(),
      },
    });

    expect(rendered.body).toContain('Privacy break-glass required');
    expect(rendered.body).toContain('Metacognition journal');
    expect(rendered.body).toContain('Safety intervention');
    expect(rendered.body).toContain('Incident response');
    expect(rendered.body).toContain('Request audited confirmation');
    expect(rendered.body).toContain('privacy-break-glass-reason');
    expect(rendered.body).not.toContain('confirmToken');
  });
});
