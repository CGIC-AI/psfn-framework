import type {
  CompanionUiAudioOutputBinding,
  CompanionUiAudioOutputFrame,
} from '../../shared/contracts/companion-ui-audio-output.js';
import { companionUiAudioOutputBindingKey } from '../../shared/contracts/companion-ui-audio-output.js';

export interface CompanionUiAudioOutputSubscription {
  readonly binding: CompanionUiAudioOutputBinding;
  readonly onFrame: (frame: CompanionUiAudioOutputFrame) => void;
}

/**
 * Process-local, session-exact Hub-to-browser audio fan-out. It deliberately
 * carries no replay buffer: a browser receives only frames emitted while its
 * current authenticated socket is attached and capable.
 */
export class CompanionUiAudioOutputRelay {
  private readonly listeners = new Map<string, Set<(frame: CompanionUiAudioOutputFrame) => void>>();

  constructor(private readonly frameBytesLimit: number) {
    if (!Number.isSafeInteger(frameBytesLimit) || frameBytesLimit < 1) {
      throw new Error('Companion UI audio output frame limit must be a positive integer');
    }
  }

  maxFrameBytes(): number {
    return this.frameBytesLimit;
  }

  subscribe(subscription: CompanionUiAudioOutputSubscription): () => void {
    const key = companionUiAudioOutputBindingKey(subscription.binding);
    let listeners = this.listeners.get(key);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(key, listeners);
    }
    const activeListeners = listeners;
    activeListeners.add(subscription.onFrame);
    return () => {
      activeListeners.delete(subscription.onFrame);
      if (activeListeners.size === 0) this.listeners.delete(key);
    };
  }

  publish(
    binding: CompanionUiAudioOutputBinding,
    frame: CompanionUiAudioOutputFrame,
  ): number {
    const listeners = this.listeners.get(companionUiAudioOutputBindingKey(binding));
    if (!listeners) return 0;
    for (const listener of [...listeners]) listener(frame);
    return listeners.size;
  }
}
