import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSpriteManifest } from '../lib/sprites/manifest.js';
import { FPS } from '../lib/sprites/taxonomy.js';
import { CompanionSprite } from './companion-sprite.js';

const manifest = buildSpriteManifest();
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('companion sprite headpats', () => {
  it('reacts locally and reports the tap immediately', () => {
    const onHeadpat = vi.fn();
    const { getByRole } = render(
      <CompanionSprite
        animated
        label="Companion"
        onHeadpat={onHeadpat}
        petted
        state="attentive"
      />,
    );

    const sprite = getByRole('button', { name: /give Companion a headpat/i });
    expect(sprite.className).toContain('petted');
    expect(sprite.querySelectorAll('.sprite-heart')).toHaveLength(3);
    fireEvent.click(sprite);
    expect(onHeadpat).toHaveBeenCalledTimes(1);
  });
});

describe('companion sprite rendering path', () => {
  it('pauses frame advancement when the page is hidden and resumes on return', () => {
    vi.useFakeTimers();
    const { container } = render(
      <CompanionSprite animated label="P" onHeadpat={vi.fn()} petted={false} state="thinking" manifest={manifest} />,
    );
    const sprite = container.querySelector<HTMLElement>('.sprite-image')!;
    const first = sprite.style.backgroundPosition;
    act(() => { vi.advanceTimersByTime(1000 / FPS.expression); });
    expect(sprite.style.backgroundPosition).not.toBe(first);
    const position = sprite.style.backgroundPosition;
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    fireEvent(document, new Event('visibilitychange'));
    act(() => { vi.advanceTimersByTime(1000); });
    expect(sprite.style.backgroundPosition).toBe(position);
    visibility.mockReturnValue('visible');
    fireEvent(document, new Event('visibilitychange'));
    act(() => { vi.advanceTimersByTime(1000 / FPS.expression); });
    expect(sprite.style.backgroundPosition).not.toBe(position);
    visibility.mockRestore();
  });

  it('keeps artwork still when reduced motion is requested', () => {
    vi.useFakeTimers();
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    const { container } = render(
      <CompanionSprite animated label="P" onHeadpat={vi.fn()} petted={false} state="thinking" manifest={manifest} />,
    );
    const sprite = container.querySelector<HTMLElement>('.sprite-image')!;
    const position = sprite.style.backgroundPosition;
    act(() => { vi.advanceTimersByTime(150); });
    expect(sprite.style.backgroundPosition).toBe(position);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shows the built-in face when a sheet cannot load', () => {
    const { container, getByRole } = render(
      <CompanionSprite animated label="Companion" onHeadpat={vi.fn()} petted={false} state="attentive" manifest={manifest} />,
    );
    const image = container.querySelector('img');
    if (!image) throw new Error('Sprite image probe is missing');
    fireEvent.error(image);
    expect(getByRole('button').className).toContain('sprite-css');
    expect(container.querySelector('.sprite-face')).not.toBeNull();
  });

  it('rejects a sheet whose pixel dimensions disagree with its frame grid', () => {
    const { container } = render(
      <CompanionSprite animated label="Companion" onHeadpat={vi.fn()} petted={false} state="attentive" manifest={manifest} />,
    );
    const image = container.querySelector('img');
    if (!image) throw new Error('Sprite image probe is missing');
    Object.defineProperties(image, { naturalWidth: { value: 1 }, naturalHeight: { value: 1 } });
    fireEvent.load(image);
    expect(container.querySelector('.sprite-face')).not.toBeNull();
    expect(container.querySelector('.sprite-image')).toBeNull();
  });

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
    expect(sprite.querySelector('.sprite-art-mouth')?.getAttribute('data-mouth-state')).toBe('closed');
  });

  it('makes amplitude mouth state visible over manifest-driven sprite art', () => {
    const { getByRole } = render(
      <CompanionSprite
        animated
        label="P"
        mouthOpen
        onHeadpat={vi.fn()}
        petted={false}
        state="speaking"
        manifest={manifest}
      />,
    );
    const sprite = getByRole('button');
    expect(sprite.className).toContain('sprite-art');
    expect(sprite.className).toContain('mouth-open');
    expect(sprite.querySelector('.sprite-art-mouth')?.getAttribute('data-mouth-state')).toBe('open');
    expect(sprite.querySelector('.sprite-mouth')).toBeNull();
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
