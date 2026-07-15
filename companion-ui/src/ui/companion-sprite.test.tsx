import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CompanionSprite } from './companion-sprite.js';

describe('companion sprite headpats', () => {
  it('reacts locally and reports the tap immediately', () => {
    const onHeadpat = vi.fn();
    const { getByRole } = render(
      <CompanionSprite
        animated
        label="Purrsephone"
        onHeadpat={onHeadpat}
        petted
        state="attentive"
      />,
    );

    const sprite = getByRole('button', { name: /give Purrsephone a headpat/i });
    expect(sprite.className).toContain('petted');
    expect(sprite.querySelectorAll('.sprite-heart')).toHaveLength(3);
    fireEvent.click(sprite);
    expect(onHeadpat).toHaveBeenCalledTimes(1);
  });
});
