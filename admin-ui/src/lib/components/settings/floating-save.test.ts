import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  formatLastSavedAt,
  resolveFloatingSaveControlState,
} from './floating-save';

test('floating save control is neutral and disabled when settings are clean', () => {
  assert.deepEqual(
    resolveFloatingSaveControlState({ dirty: false, saveable: false, saving: false }),
    {
      ariaLabel: 'Settings are saved; no unsaved changes',
      disabled: true,
      label: 'Save Settings',
      tone: 'clean',
    },
  );
});

test('floating save control is prominent and enabled when settings are dirty', () => {
  assert.deepEqual(
    resolveFloatingSaveControlState({ dirty: true, saveable: true, saving: false }),
    {
      ariaLabel: 'Save settings with unsaved changes',
      disabled: false,
      label: 'Save Settings',
      tone: 'dirty',
    },
  );
});

test('floating save control shows raw-only dirty state without invoking the unified save', () => {
  assert.deepEqual(
    resolveFloatingSaveControlState({ dirty: true, saveable: false, saving: false }),
    {
      ariaLabel: 'Settings have unsaved changes that use their inline save controls',
      disabled: true,
      label: 'Save Settings',
      tone: 'dirty',
    },
  );
});

test('floating save control prevents duplicate activation while saving', () => {
  assert.deepEqual(
    resolveFloatingSaveControlState({ dirty: true, saveable: true, saving: true }),
    {
      ariaLabel: 'Saving settings',
      disabled: true,
      label: 'Saving...',
      tone: 'saving',
    },
  );
});

test('last-saved formatting covers empty, recent, minute, hour, and day states', () => {
  const now = Date.UTC(2026, 6, 20, 16, 0, 0);
  assert.equal(formatLastSavedAt(null, now), 'Not saved this session');
  assert.equal(formatLastSavedAt(now - 30_000, now), 'Last saved just now');
  assert.equal(formatLastSavedAt(now - 60_000, now), 'Last saved 1 minute ago');
  assert.equal(formatLastSavedAt(now - 12 * 60_000, now), 'Last saved 12 minutes ago');
  assert.equal(formatLastSavedAt(now - 60 * 60_000, now), 'Last saved 1 hour ago');
  assert.equal(formatLastSavedAt(now - 26 * 60 * 60_000, now), 'Last saved 1 day ago');
});

test('future timestamps are treated as just saved despite clock skew', () => {
  const now = Date.UTC(2026, 6, 20, 16, 0, 0);
  assert.equal(formatLastSavedAt(now + 10_000, now), 'Last saved just now');
});
