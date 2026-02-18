import type { EventBus } from '../../event-bus.js';
import { attachVoiceLatencyObserver } from './latency.js';
import { attachVoiceTurnsObserver } from './turns.js';
import { attachVoiceErrorsObserver } from './errors.js';

export function attachVoiceObservers(eventBus: EventBus): () => void {
  const unsubs = [
    attachVoiceLatencyObserver(eventBus),
    attachVoiceTurnsObserver(eventBus),
    attachVoiceErrorsObserver(eventBus),
  ];

  return () => {
    for (const unsub of unsubs) {
      unsub();
    }
  };
}
