import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { buildVoiceNotice, useComposerController } from './composer-controller.js';

describe('draft ownership', () => {
  it('restores a draft only when returning to its exact companion and shard', () => {
    const { result, rerender } = renderHook(({ owner }) => useComposerController(undefined, owner), {
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

describe('buildVoiceNotice', () => {
  it('reports capture as pending and text as canonical when nothing is wired', () => {
    const notice = buildVoiceNotice('dictation', { captureReady: false, playbackReady: false });
    expect(notice).toMatch(/Dictation capture is unavailable/);
    expect(notice).toMatch(/text remains the source of truth/);
    expect(notice).not.toMatch(/play back/);
  });

  it('mentions spoken-reply playback when the session advertises streamed audio', () => {
    const notice = buildVoiceNotice('voice', { captureReady: false, playbackReady: true });
    expect(notice).toMatch(/Voice chat capture is unavailable/);
    expect(notice).toMatch(/play back with mouth movement/);
  });

  it('reports capture as active once the capture pipeline is ready', () => {
    expect(buildVoiceNotice('voice', { captureReady: true, playbackReady: true }))
      .toBe('Voice chat capture is active.');
  });
});
