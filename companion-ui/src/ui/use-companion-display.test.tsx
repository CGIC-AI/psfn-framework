import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { buildSpriteManifest } from '../lib/sprites/manifest.js';
import { useCompanionDisplay } from './use-companion-display.js';

describe('companion appearance ownership', () => {
  it('keeps models and display choices with their companion across switches', () => {
    const { result, rerender } = renderHook(({ id }) => useCompanionDisplay(id), {
      initialProps: { id: 'companion-one' },
    });
    const file = new File(['model'], 'one.vrm');
    act(() => result.current.selectFile(file));
    expect(result.current.file).toBe(file);
    rerender({ id: 'companion-two' });
    expect(result.current.mode).toBe('none');
    expect(result.current.file).toBeNull();
    act(() => result.current.choose('sprite'));
    rerender({ id: 'companion-one' });
    expect(result.current.mode).toBe('model');
    expect(result.current.file).toBe(file);
  });

  it('clears all files on logout and never assigns an asset without a companion', () => {
    const initialProps: { id: string | null } = { id: 'companion-one' };
    const { result, rerender } = renderHook(({ id }: { id: string | null }) => useCompanionDisplay(id), {
      initialProps,
    });
    act(() => result.current.selectFile(new File(['model'], 'one.vrm')));
    act(() => result.current.clear());
    expect(result.current.file).toBeNull();
    rerender({ id: null });
    act(() => result.current.selectFile(new File(['model'], 'unowned.vrm')));
    expect(result.current.available).toBe(false);
    expect(result.current.file).toBeNull();
  });

  it('releases the selected file when the model is removed', () => {
    const { result } = renderHook(() => useCompanionDisplay('companion-one'));
    act(() => result.current.selectFile(new File(['model'], 'one.glb')));
    act(() => result.current.removeFile());
    expect(result.current.file).toBeNull();
    expect(result.current.mode).toBe('none');
  });

  it('retains each companion’s sprite pack until replacement, logout or unmount', () => {
    const first = { manifest: buildSpriteManifest(), dispose: vi.fn() };
    const second = { manifest: buildSpriteManifest(), dispose: vi.fn() };
    const replacement = { manifest: buildSpriteManifest(), dispose: vi.fn() };
    const { result, rerender, unmount } = renderHook(({ id }) => useCompanionDisplay(id), {
      initialProps: { id: 'one' },
    });
    act(() => result.current.selectSpritePack(first));
    act(() => result.current.selectFile(new File(['model'], 'one.glb')));
    act(() => result.current.choose('sprite'));
    expect(result.current.spritePack).toBe(first);
    rerender({ id: 'two' });
    expect(result.current.spritePack).toBeNull();
    act(() => result.current.selectSpritePack(second));
    rerender({ id: 'one' });
    expect(result.current.spritePack).toBe(first);
    act(() => result.current.selectSpritePack(replacement));
    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(second.dispose).not.toHaveBeenCalled();
    act(() => result.current.clear());
    expect(second.dispose).toHaveBeenCalledTimes(1);
    expect(replacement.dispose).toHaveBeenCalledTimes(1);
    act(() => result.current.selectSpritePack(first));
    unmount();
    expect(first.dispose).toHaveBeenCalledTimes(2);
  });

  it('disposes removed and unowned packs without affecting another companion', () => {
    const pack = { manifest: buildSpriteManifest(), dispose: vi.fn() };
    const initialProps: { id: string | null } = { id: 'one' };
    const { result, rerender } = renderHook(({ id }) => useCompanionDisplay(id), { initialProps });
    act(() => result.current.selectSpritePack(pack));
    act(() => result.current.removeSpritePack());
    expect(pack.dispose).toHaveBeenCalledTimes(1);
    expect(result.current.mode).toBe('sprite');
    expect(result.current.spritePack).toBeNull();
    rerender({ id: null });
    act(() => result.current.selectSpritePack(pack));
    expect(pack.dispose).toHaveBeenCalledTimes(2);
    expect(result.current.spritePack).toBeNull();
  });
});
