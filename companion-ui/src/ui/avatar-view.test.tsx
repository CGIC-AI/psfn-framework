import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { buildSpriteManifest } from '../lib/sprites/manifest.js';
import { AvatarView } from './avatar-view.js';

function timeSource(...times: number[]) {
  let index = 0;
  return () => times[index++] ?? times.at(-1) ?? 0;
}

function renderAvatar(now: () => number, onInteraction = vi.fn()) {
  return {
    onInteraction,
    ...render(
      <AvatarView
        animated
        label="Companion"
        manifest={null}
        now={now}
        onInteraction={onInteraction}
        state="attentive"
      />,
    ),
  };
}

describe('avatar view interactions', () => {
  it('keeps voice available for a companion with no avatar and offers appearance selection', () => {
    const onChooseAppearance = vi.fn();
    const { getByRole, queryByLabelText, container } = render(
      <AvatarView animated label="Canopy" displayMode="none" manifest={null}
        handsFreeAvailable onChooseAppearance={onChooseAppearance} onInteraction={vi.fn()} state="attentive" />,
    );
    expect(container.querySelector('.avatar-character')).toBeNull();
    expect(queryByLabelText(/head: tap/)).toBeNull();
    expect(getByRole('button', { name: 'Start hands-free voice' }).hasAttribute('disabled')).toBe(false);
    fireEvent.click(getByRole('button', { name: 'Choose an appearance' }));
    expect(onChooseAppearance).toHaveBeenCalledOnce();
  });

  it('preserves model orbit controls and offers explicit affection buttons', () => {
    const onInteraction = vi.fn();
    const { getByRole, container } = render(
      <AvatarView animated label="Canopy" displayMode="model" model={<canvas aria-label="3D model" />}
        manifest={null} onInteraction={onInteraction} state="attentive" />,
    );
    expect(container.querySelector('.avatar-hit-regions')).toBeNull();
    expect(getByRole('button', { name: 'Headpat' })).toBeTruthy();
    fireEvent.click(getByRole('button', { name: 'Hug' }));
    expect(onInteraction).toHaveBeenCalledWith({ kind: 'hug', region: 'body', durationMs: 0 });
  });

  it('starts hands-free voice only from its explicit avatar control', () => {
    const onToggleHandsFree = vi.fn();
    const view = render(
      <AvatarView
        animated
        handsFreeAvailable
        label="Companion"
        manifest={null}
        onInteraction={vi.fn()}
        onToggleHandsFree={onToggleHandsFree}
        state="attentive"
      />,
    );

    expect(onToggleHandsFree).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole('button', { name: 'Start hands-free voice' }));
    expect(onToggleHandsFree).toHaveBeenCalledTimes(1);
  });

  it('turns a head tap into one immediate headpat reaction', () => {
    const view = renderAvatar(timeSource(1_000, 1_080));
    const head = view.getByRole('button', { name: /head: tap or drag/i });

    fireEvent.pointerDown(head, { pointerId: 1, clientX: 40, clientY: 40 });
    fireEvent.pointerUp(head, { pointerId: 1, clientX: 40, clientY: 40 });

    expect(view.onInteraction).toHaveBeenCalledTimes(1);
    expect(view.onInteraction).toHaveBeenCalledWith({
      kind: 'headpat', region: 'head', durationMs: 80,
    });
    expect(view.getByRole('status').dataset.reaction).toBe('headpat');
  });

  it('classifies a head drag as petting with a distinct local reaction', () => {
    const view = renderAvatar(timeSource(2_000, 2_180));
    const head = view.getByRole('button', { name: /head: tap or drag/i });

    fireEvent.pointerDown(head, { pointerId: 2, clientX: 20, clientY: 20 });
    fireEvent.pointerUp(head, { pointerId: 2, clientX: 38, clientY: 20 });

    expect(view.onInteraction).toHaveBeenCalledWith({
      kind: 'petting', region: 'head', durationMs: 180,
    });
    expect(view.getByRole('status').dataset.reaction).toBe('petting');
  });

  it('classifies a body long press as a hug', () => {
    const view = renderAvatar(timeSource(3_000, 3_550));
    const body = view.getByRole('button', { name: /body: long press/i });

    fireEvent.pointerDown(body, { pointerId: 3, clientX: 50, clientY: 90 });
    fireEvent.pointerUp(body, { pointerId: 3, clientX: 50, clientY: 90 });

    expect(view.onInteraction).toHaveBeenCalledWith({
      kind: 'hug', region: 'body', durationMs: 550,
    });
    expect(view.getByRole('status').dataset.reaction).toBe('hug');
  });

  it('waits for a second cheek tap before emitting one kiss', () => {
    const view = renderAvatar(timeSource(4_000, 4_060, 4_300, 4_360));
    const cheek = view.getByRole('button', { name: /cheek: double tap/i });

    fireEvent.pointerDown(cheek, { pointerId: 4, clientX: 46, clientY: 48 });
    fireEvent.pointerUp(cheek, { pointerId: 4, clientX: 46, clientY: 48 });
    expect(view.onInteraction).not.toHaveBeenCalled();

    fireEvent.pointerDown(cheek, { pointerId: 5, clientX: 46, clientY: 48 });
    fireEvent.pointerUp(cheek, { pointerId: 5, clientX: 46, clientY: 48 });

    expect(view.onInteraction).toHaveBeenCalledTimes(1);
    expect(view.onInteraction).toHaveBeenCalledWith({
      kind: 'kiss', region: 'cheek', durationMs: 60,
    });
    expect(view.getByRole('status').dataset.reaction).toBe('kiss');
  });

  it('uses the full-body avatar expression entry when sprite sheets are available', () => {
    const { container } = render(
      <AvatarView
        animated={false}
        label="Companion"
        manifest={buildSpriteManifest()}
        onInteraction={vi.fn()}
        state="attentive"
      />,
    );

    expect(container.querySelector<HTMLElement>('.avatar-character')?.dataset.spriteEntry)
      .toBe('expr.neutral.avatar');
    expect(container.querySelector<HTMLElement>('.sprite-image')?.style.backgroundImage)
      .toContain('expr-avatar.png');
  });
});
