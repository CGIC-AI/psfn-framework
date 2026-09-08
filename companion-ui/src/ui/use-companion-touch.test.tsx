import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HubStreamStore } from '../lib/stream/hub-stream.js';
import { CompanionGatewayClient } from '../lib/api/gateway-client.js';
import { useCompanionTouch } from './use-companion-touch.js';

function store() {
  return new HubStreamStore(new CompanionGatewayClient({ url: 'wss://companion.invalid/companion-ui/' }));
}

afterEach(() => vi.useRealTimers());

describe('touch routing', () => {
  it('cancels queued affection when the selected companion changes', () => {
    vi.useFakeTimers();
    const first = store();
    const second = store();
    const sendFirst = vi.spyOn(first, 'sendTouchInteraction').mockImplementation(() => {});
    const sendSecond = vi.spyOn(second, 'sendTouchInteraction').mockImplementation(() => {});
    const { result, rerender } = renderHook(({ target }) => useCompanionTouch(target, true), {
      initialProps: { target: first },
    });
    act(() => result.current.headpat());
    rerender({ target: second });
    act(() => vi.advanceTimersByTime(3000));
    expect(sendFirst).not.toHaveBeenCalled();
    expect(sendSecond).not.toHaveBeenCalled();
    act(() => result.current.headpat());
    act(() => vi.advanceTimersByTime(3000));
    expect(sendSecond).toHaveBeenCalledWith({ kind: 'headpat', region: 'head', count: 1, durationMs: 0 });
  });

  it('drops pending gestures immediately on authority reset', () => {
    vi.useFakeTimers();
    const target = store();
    const send = vi.spyOn(target, 'sendTouchInteraction').mockImplementation(() => {});
    const { result } = renderHook(() => useCompanionTouch(target, true));
    act(() => result.current.headpat());
    act(() => result.current.reset());
    act(() => vi.advanceTimersByTime(3000));
    expect(send).not.toHaveBeenCalled();
    expect(result.current.petted).toBe(false);
  });
});
