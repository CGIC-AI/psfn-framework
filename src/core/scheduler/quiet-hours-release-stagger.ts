// ── Per-companion quiet-hours release stagger (psfn-framework-m7jf2) ──
//
// Every companion shares one operator-configured quiet window
// (scheduler.json `episodicProcessing`). Outreach, follow-ups, and impulses
// held during it all become eligible at the same instant when it ends, so a
// fleet releases its whole backlog together (the 09:00 burst) and contends for
// the shared model-call gate.
//
// This derives each companion's OUTWARD release: the configured window with
// only its end pushed back by the companion's fleet offset (manifest ordinal
// spread across `fleetStagger.windowMs`, the same offset the fixed wall-clock
// slots use). The start is unchanged, so no companion ever reaches out earlier
// than the operator allowed; one companion simply stays quiet a few minutes
// longer. Internal rest-window work (sleeptime, drift reviews, free time) keeps
// the configured window, and the operator-visible setting is not rewritten.

import { parseLocalMinute } from '../../shared/time/daily-window.js';
import type { ProactiveQuietHoursConfig } from '../intention/proactive-time-gate.js';
import { staggerFleetOrdinalWithinWindow } from './fleet-maintenance-coordinator.js';
import type { FleetSlotStagger } from './types.js';

const MINUTE_MS = 60_000;
const MINUTES_PER_DAY = 24 * 60;

function formatLocalMinute(minute: number): string {
  const hours = Math.floor(minute / 60);
  const minutes = minute % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/** Whole-minute offset of this companion's release after the configured end. */
export function quietHoursReleaseOffsetMinutes(stagger: FleetSlotStagger): number {
  return Math.floor(staggerFleetOrdinalWithinWindow({
    manifestOrdinal: stagger.manifestOrdinal,
    fleetSize: stagger.fleetSize,
    windowStartMs: 0,
    windowEndMs: stagger.windowMs,
  }) / MINUTE_MS);
}

/**
 * The quiet window this companion's outward lanes must honor. Returns the
 * input unchanged outside a fleet, when quiet hours are disabled, when the
 * configured window is all-day (equal endpoints), or for a zero offset. Fails
 * closed when the offset would make the window swallow the whole day.
 */
export function staggerQuietHoursRelease<T extends ProactiveQuietHoursConfig>(
  quietHours: T,
  stagger: FleetSlotStagger | undefined,
): T {
  if (!stagger || !quietHours.enabled) return quietHours;
  const offsetMinutes = quietHoursReleaseOffsetMinutes(stagger);
  if (offsetMinutes === 0) return quietHours;
  const startMinute = parseLocalMinute(quietHours.startLocalTime);
  const endMinute = parseLocalMinute(quietHours.endLocalTime);
  if (startMinute === endMinute) return quietHours;
  const windowMinutes = (endMinute - startMinute + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  if (windowMinutes + offsetMinutes >= MINUTES_PER_DAY) {
    throw new Error(
      `fleetStagger offset (${offsetMinutes} min) would extend the ${windowMinutes}-minute quiet window `
      + 'across the whole day; shorten scheduler.json fleetStagger.windowMs or the quiet window',
    );
  }
  return {
    ...quietHours,
    endLocalTime: formatLocalMinute((endMinute + offsetMinutes) % MINUTES_PER_DAY),
  };
}

/**
 * Gateway-side counterpart: resolve any fleet companion's outward quiet window
 * from the fleet manifest order, so a gateway decision about a companion uses
 * the same release offset that companion's own lanes apply. A companion absent
 * from the manifest has no fleet position and keeps the configured window.
 */
export function createFleetOutwardQuietHoursResolver<T extends ProactiveQuietHoursConfig>(input: {
  quietHours: T;
  fleetCompanionIds: readonly string[];
  windowMs: number;
}): (companionId: string) => T {
  const byCompanion = new Map(input.fleetCompanionIds.map((companionId, manifestOrdinal) => [
    companionId,
    staggerQuietHoursRelease(input.quietHours, {
      manifestOrdinal,
      fleetSize: input.fleetCompanionIds.length,
      windowMs: input.windowMs,
    }),
  ]));
  return companionId => byCompanion.get(companionId) ?? input.quietHours;
}
