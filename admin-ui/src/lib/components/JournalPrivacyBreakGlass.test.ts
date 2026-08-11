import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import JournalPrivacyBreakGlass from './JournalPrivacyBreakGlass.svelte';

describe('JournalPrivacyBreakGlass', () => {
  it('renders one reason-bearing ceremony for all still-locked journal streams', () => {
    const rendered = render(JournalPrivacyBreakGlass, {
      props: {
        targets: [
          { stream: 'reflection-metacognition', label: 'Metacognition journal' },
          { stream: 'reflection-daily', label: 'Daily reflection journal' },
        ],
        onDisclosure: vi.fn(),
      },
    });

    expect(rendered.body).toContain('Privacy break-glass required');
    expect(rendered.body).toContain('Metacognition journal');
    expect(rendered.body).toContain('Research check');
    expect(rendered.body).toContain('Safety intervention');
    expect(rendered.body).toContain('Incident response');
    expect(rendered.body).not.toContain('Legal emergency');
    expect(rendered.body).toContain('Unlock all journal views');
    expect(rendered.body).toContain('separately audited');
    expect(rendered.body).toContain('privacy-break-glass-reason');
    expect(rendered.body).not.toContain('confirmToken');
  });
});
