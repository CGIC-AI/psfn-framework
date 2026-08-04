import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import EffectiveChatModelCard from './EffectiveChatModelCard.svelte';

describe('EffectiveChatModelCard', () => {
  it('shows the companion overlay selection separately from the fleet default', () => {
    const rendered = render(EffectiveChatModelCard, {
      props: {
        effectiveChat: {
          purpose: 'chat',
          source: 'companion_selection',
          slotKey: 'purrsephone-chat',
          provider: 'openrouter',
          model: 'z-ai/glm-5.2',
        },
        fleetDefault: {
          slotKey: 'primary',
          provider: 'openrouter',
          model: 'moonshotai/kimi-k3',
        },
      },
    });

    expect(rendered.body).toContain('Effective chat model');
    expect(rendered.body).toContain('z-ai/glm-5.2');
    expect(rendered.body).toContain('purrsephone-chat');
    expect(rendered.body).toContain('Companion selection');
    expect(rendered.body).toContain('Fleet catalog default');
    expect(rendered.body).toContain('moonshotai/kimi-k3');
    expect(rendered.body).toContain('unchanged');
  });
});
