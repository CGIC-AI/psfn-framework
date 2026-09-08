import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AvatarPlayerHandle } from '../lib/avatar/renderer.js';
import { LocalAvatarError } from '../lib/avatar/local-model.js';
import { VrmAvatarPlayer } from './vrm-avatar-player.js';

const engine = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('../lib/avatar/renderer.js', () => ({ createAvatarPlayer: engine.create }));

function player(): AvatarPlayerHandle {
  return { format: 'VRM 1', update: vi.fn(), reset: vi.fn(), dispose: vi.fn() };
}
const file = new File(['first model'], 'first.vrm');
const props = { file, active: true, animated: true, mouthOpen: false, label: 'Nova' };

beforeEach(() => {
  engine.create.mockReset();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('VRM avatar player lifecycle', () => {
  it('exposes loading, model controls and current speech/emotion inputs', async () => {
    const handle = player();
    engine.create.mockResolvedValue(handle);
    const view = render(<VrmAvatarPlayer {...props} />);
    expect(view.getByRole('status').textContent).toContain('Loading');
    await waitFor(() => expect(view.getByText('VRM 1')).toBeTruthy());
    fireEvent.click(view.getByRole('button', { name: 'Reset view' }));
    expect(handle.reset).toHaveBeenCalledOnce();
    view.rerender(<VrmAvatarPlayer {...props} mouthOpen emotionalBase="happy" />);
    expect(handle.update).toHaveBeenLastCalledWith({ active: true, animated: true, mouthOpen: true, emotionalBase: 'happy' });
    view.unmount();
    expect(handle.dispose).toHaveBeenCalledOnce();
  });

  it('suspends a hidden document and resumes with current inputs', async () => {
    const handle = player();
    engine.create.mockResolvedValue(handle);
    render(<VrmAvatarPlayer {...props} />);
    await waitFor(() => expect(handle.update).toHaveBeenCalled());
    act(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(handle.update).toHaveBeenLastCalledWith(expect.objectContaining({ active: false }));
    act(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(handle.update).toHaveBeenLastCalledWith(expect.objectContaining({ active: true }));
  });

  it('honors the device reduced-motion preference', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    const handle = player();
    engine.create.mockResolvedValue(handle);
    render(<VrmAvatarPlayer {...props} />);
    await waitFor(() => expect(handle.update).toHaveBeenCalledWith(expect.objectContaining({ animated: false })));
  });

  it('disposes a late model when the selected file changes, without replacing the new model', async () => {
    const first = player();
    const next = player();
    let resolveFirst: (handle: AvatarPlayerHandle) => void = () => { throw new Error('request not started'); };
    engine.create.mockImplementationOnce(() => new Promise<AvatarPlayerHandle>((resolve) => { resolveFirst = resolve; }));
    engine.create.mockResolvedValueOnce(next);
    const view = render(<VrmAvatarPlayer {...props} />);
    await waitFor(() => expect(engine.create).toHaveBeenCalledOnce());
    const firstCanvas = view.getByRole('img');
    view.rerender(<VrmAvatarPlayer {...props} file={new File(['next model'], 'next.glb')} />);
    await waitFor(() => expect(next.update).toHaveBeenCalled());
    expect(view.getByRole('img')).not.toBe(firstCanvas);
    await act(async () => { resolveFirst(first); });
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(first.update).not.toHaveBeenCalled();
    expect(next.dispose).not.toHaveBeenCalled();
  });

  it('offers a retry after a recoverable loader error', async () => {
    engine.create.mockRejectedValueOnce(new LocalAvatarError('Choose an embedded model.'));
    const handle = player();
    engine.create.mockResolvedValueOnce(handle);
    const view = render(<VrmAvatarPlayer {...props} />);
    await waitFor(() => expect(view.getByRole('alert').textContent).toContain('Choose an embedded model.'));
    fireEvent.click(view.getByRole('button', { name: 'Reload model' }));
    await waitFor(() => expect(handle.update).toHaveBeenCalled());
    expect(view.queryByRole('alert')).toBeNull();
  });

  it('disposes a player that finishes after unmount', async () => {
    const handle = player();
    let resolve: (handle: AvatarPlayerHandle) => void = () => { throw new Error('request not started'); };
    engine.create.mockImplementationOnce(() => new Promise<AvatarPlayerHandle>((complete) => { resolve = complete; }));
    const view = render(<VrmAvatarPlayer {...props} />);
    await waitFor(() => expect(engine.create).toHaveBeenCalledOnce());
    view.unmount();
    await act(async () => { resolve(handle); });
    expect(handle.dispose).toHaveBeenCalledOnce();
    expect(handle.update).not.toHaveBeenCalled();
  });
});
