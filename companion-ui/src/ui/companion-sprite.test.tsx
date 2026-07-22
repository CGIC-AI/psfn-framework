import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { buildSpriteManifest } from '../lib/sprites/manifest.js';
import { CompanionSprite } from './companion-sprite.js';

const manifest = buildSpriteManifest();

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

describe('companion sprite rendering path', () => {
  it('falls back to the CSS face when no manifest is loaded (fail-visible)', () => {
    const { getByRole } = render(
      <CompanionSprite animated label="P" onHeadpat={vi.fn()} petted={false} state="attentive" />,
    );
    const sprite = getByRole('button');
    expect(sprite.className).toContain('sprite-css');
    expect(sprite.querySelector('.sprite-face')).not.toBeNull();
    expect(sprite.querySelector('.sprite-image')).toBeNull();
  });

  it('renders manifest-driven sprite art when the manifest is available', () => {
    const { getByRole } = render(
      <CompanionSprite animated label="P" onHeadpat={vi.fn()} petted={false} state="attentive" manifest={manifest} />,
    );
    const sprite = getByRole('button');
    expect(sprite.className).toContain('sprite-art');
    const image = sprite.querySelector<HTMLElement>('.sprite-image');
    expect(image).not.toBeNull();
    // The expression sheet is the background source for the neutral base.
    expect(image!.style.backgroundImage).toContain('expr-mini.png');
    expect(sprite.querySelector('.sprite-face')).toBeNull();
  });

  it('switches to the touch reaction sheet while a headpat reaction is in flight', () => {
    const { getByRole } = render(
      <CompanionSprite
        animated
        label="P"
        onHeadpat={vi.fn()}
        petted
        state="attentive"
        manifest={manifest}
        touch="headpat-happy"
      />,
    );
    const image = getByRole('button').querySelector<HTMLElement>('.sprite-image');
    expect(image!.style.backgroundImage).toContain('touch.png');
  });

  it('keeps the CSS face when the resolved entry id is absent from the manifest', () => {
    const emptyManifest = { ...manifest, entries: {} };
    const { getByRole } = render(
      <CompanionSprite animated label="P" onHeadpat={vi.fn()} petted={false} state="attentive" manifest={emptyManifest} />,
    );
    const sprite = getByRole('button');
    expect(sprite.className).toContain('sprite-css');
    expect(sprite.querySelector('.sprite-face')).not.toBeNull();
  });
});
