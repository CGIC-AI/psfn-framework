import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useComposerController } from './composer-controller.js';

describe('draft ownership', () => {
  it('restores a draft only when returning to its exact companion and shard', () => {
    const { result, rerender } = renderHook(({ owner }) => useComposerController(owner), {
      initialProps: { owner: 'companion-one:parent' },
    });
    act(() => result.current.setInput('For the first companion'));
    rerender({ owner: 'companion-two:parent' });
    expect(result.current.input).toBe('');
    act(() => result.current.setInput('For the second companion'));
    rerender({ owner: 'companion-one:shard-one' });
    expect(result.current.input).toBe('');
    rerender({ owner: 'companion-one:parent' });
    expect(result.current.input).toBe('For the first companion');
    act(() => result.current.clearHumanScopedState());
    rerender({ owner: 'companion-two:parent' });
    expect(result.current.input).toBe('');
  });
});
