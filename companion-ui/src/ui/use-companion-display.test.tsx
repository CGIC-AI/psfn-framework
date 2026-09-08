import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
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
});
