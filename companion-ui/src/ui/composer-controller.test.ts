import { describe, expect, it } from 'vitest';
import { buildVoiceNotice } from './composer-controller.js';

describe('buildVoiceNotice', () => {
  it('reports capture as pending and text as canonical when nothing is wired', () => {
    const notice = buildVoiceNotice('dictation', { captureReady: false, playbackReady: false });
    expect(notice).toMatch(/Dictation capture is not wired/);
    expect(notice).toMatch(/text remains the source of truth/);
    expect(notice).not.toMatch(/play back/);
  });

  it('mentions spoken-reply playback when the session advertises streamed audio', () => {
    const notice = buildVoiceNotice('voice', { captureReady: false, playbackReady: true });
    expect(notice).toMatch(/Voice chat capture is not wired/);
    expect(notice).toMatch(/play back with mouth movement/);
  });

  it('reports capture as active once the capture pipeline is ready', () => {
    expect(buildVoiceNotice('voice', { captureReady: true, playbackReady: true }))
      .toBe('Voice chat capture is active.');
  });
});
