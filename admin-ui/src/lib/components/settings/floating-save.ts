export type FloatingSaveTone = 'clean' | 'dirty' | 'saving';

export interface FloatingSaveControlState {
  ariaLabel: string;
  disabled: boolean;
  label: string;
  tone: FloatingSaveTone;
}

export function resolveFloatingSaveControlState(input: {
  dirty: boolean;
  saveable: boolean;
  saving: boolean;
}): FloatingSaveControlState {
  if (input.saving) {
    return {
      ariaLabel: 'Saving settings',
      disabled: true,
      label: 'Saving...',
      tone: 'saving',
    };
  }
  if (input.dirty) {
    return {
      ariaLabel: input.saveable
        ? 'Save settings with unsaved changes'
        : 'Settings have unsaved changes that use their inline save controls',
      disabled: !input.saveable,
      label: 'Save Settings',
      tone: 'dirty',
    };
  }
  return {
    ariaLabel: 'Settings are saved; no unsaved changes',
    disabled: true,
    label: 'Save Settings',
    tone: 'clean',
  };
}

export function formatLastSavedAt(
  savedAtMs: number | null,
  nowMs: number,
): string {
  if (savedAtMs === null || !Number.isFinite(savedAtMs)) {
    return 'Not saved this session';
  }

  const elapsedSeconds = Math.max(0, Math.floor((nowMs - savedAtMs) / 1000));
  if (elapsedSeconds < 60) return 'Last saved just now';

  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) {
    return `Last saved ${elapsedMinutes} minute${elapsedMinutes === 1 ? '' : 's'} ago`;
  }

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) {
    return `Last saved ${elapsedHours} hour${elapsedHours === 1 ? '' : 's'} ago`;
  }

  const elapsedDays = Math.floor(elapsedHours / 24);
  return `Last saved ${elapsedDays} day${elapsedDays === 1 ? '' : 's'} ago`;
}

export function parseLastSavedAt(value: string | null): number | null {
  if (value === null || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function lastSavedStorageKey(companionScope: string): string {
  return `garden.settings.lastSavedAt:${companionScope}`;
}

export function restoreSettingsLastSavedAt(companionScope: string): number | null {
  if (typeof window === 'undefined') return null;
  try {
    return parseLastSavedAt(
      window.sessionStorage.getItem(lastSavedStorageKey(companionScope)),
    );
  } catch {
    return null;
  }
}

export function persistSettingsLastSavedAt(
  companionScope: string,
  savedAt: number,
): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(
      lastSavedStorageKey(companionScope),
      String(savedAt),
    );
  } catch {
    // Session storage can be unavailable; the caller's in-memory state remains authoritative.
  }
}
