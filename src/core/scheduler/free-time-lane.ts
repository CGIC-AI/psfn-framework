/**
 * The two free-time trigger lanes. Extracted to a leaf module so the chooser
 * and the free-time runtime can both reference the lane type without forming
 * an import cycle (the lane is a trigger reason, not an identity — bible §10.4).
 */
export type FreeTimeLane = 'quiet_hours' | 'idle';
