import { useEffect, useState } from 'react';
import { loadSpriteManifest, type SpriteManifest } from './manifest.js';

export type SpriteManifestStatus =
  | { readonly state: 'loading' }
  | { readonly state: 'ready'; readonly manifest: SpriteManifest }
  | { readonly state: 'fallback'; readonly reason: string };

/**
 * Load the sprite manifest once at mount. On any failure the status resolves to
 * `fallback` (never throws) so the sprite renderer keeps the CSS face —
 * fail-visible, not blank. Best-effort: a missing manifest is a normal state,
 * not an error the user must see.
 */
export function useSpriteManifest(enabled = true): SpriteManifestStatus {
  const [status, setStatus] = useState<SpriteManifestStatus>({ state: 'loading' });

  useEffect(() => {
    if (!enabled) return undefined;
    let active = true;
    setStatus({ state: 'loading' });
    loadSpriteManifest()
      .then((manifest) => {
        if (active) setStatus({ state: 'ready', manifest });
      })
      .catch((error: unknown) => {
        if (active) {
          setStatus({ state: 'fallback', reason: error instanceof Error ? error.message : 'sprite manifest unavailable' });
        }
      });
    return () => {
      active = false;
    };
  }, [enabled]);

  return status;
}
