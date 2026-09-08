import { useEffect, useState } from 'react';
import { deriveSpriteInputs } from '../lib/sprites/emotion-mapping.js';
import type { EmotionSnapshotStreamEntry, ToolActivityStreamEntry } from '../lib/stream/hub-stream.js';

/** Keep both avatar sizes fresh even when no new telemetry frame arrives. */
export function useSpriteInputs(
  emotion: EmotionSnapshotStreamEntry | null,
  toolActivity: ToolActivityStreamEntry | null,
  active = true,
) {
  const [, tick] = useState(0);
  const inputs = deriveSpriteInputs({ emotion, toolActivity, nowMs: Date.now() });
  const decaying = inputs.base !== null || inputs.toolDomain !== null;
  useEffect(() => {
    if (!active || !decaying) return;
    const timer = setInterval(() => tick(value => value + 1), 1000);
    return () => clearInterval(timer);
  }, [active, decaying]);
  return inputs;
}
