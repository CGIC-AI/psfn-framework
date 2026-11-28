import type { ModelThinkingEffort } from '../../../shared/contracts/runtime.js';
import type { ReasoningEffortLane } from '../../../system/config/reasoning-effort-config.js';

/**
 * How long a companion-chosen reasoning level lasts:
 * - `turn`: the rest of the current turn (every remaining model call of it);
 * - `session`: this conversation or own-time channel until changed;
 * - `lane`: every call on this lane (chat, free time, reflection, …) until changed.
 * The narrowest scope wins when several are set.
 */
export const REASONING_OVERRIDE_SCOPES = ['turn', 'session', 'lane'] as const;
export type ReasoningOverrideScope = typeof REASONING_OVERRIDE_SCOPES[number];

export interface ReasoningEffortOverride {
  level: ModelThinkingEffort;
  scope: ReasoningOverrideScope;
  lane: ReasoningEffortLane;
  setAtMs: number;
  /** Logical session (falling back to the channel) the choice was made in. */
  sessionKey?: string;
  turnId?: string;
}

export interface ReasoningOverrideKey {
  lane: ReasoningEffortLane;
  sessionKey?: string;
  turnId?: string;
}

/**
 * The companion's own reasoning choices, held in this agent process. They are
 * companion state, never written into an owner file, and they do not survive
 * a restart: after one, the owner's lane baseline applies again until the
 * companion chooses otherwise. A turn choice is kept for the most recent turn
 * only (the agent runs one turn at a time).
 */
export class ReasoningEffortOverrideStore {
  private turnOverride: ReasoningEffortOverride | null = null;
  private readonly sessionOverrides = new Map<string, ReasoningEffortOverride>();
  private readonly laneOverrides = new Map<ReasoningEffortLane, ReasoningEffortOverride>();

  set(override: ReasoningEffortOverride): void {
    switch (override.scope) {
      case 'turn':
        if (!override.turnId) throw new Error('A turn reasoning override requires the current turn id');
        this.turnOverride = override;
        return;
      case 'session':
        if (!override.sessionKey) throw new Error('A session reasoning override requires the current session');
        this.sessionOverrides.set(override.sessionKey, override);
        return;
      case 'lane':
        this.laneOverrides.set(override.lane, override);
        return;
    }
  }

  /** Remove the choice at one scope; returns the removed choice, if any. */
  clear(scope: ReasoningOverrideScope, key: ReasoningOverrideKey): ReasoningEffortOverride | undefined {
    const existing = this.get(scope, key);
    if (!existing) return undefined;
    if (scope === 'turn') this.turnOverride = null;
    else if (scope === 'session' && key.sessionKey) this.sessionOverrides.delete(key.sessionKey);
    else if (scope === 'lane') this.laneOverrides.delete(key.lane);
    return existing;
  }

  get(scope: ReasoningOverrideScope, key: ReasoningOverrideKey): ReasoningEffortOverride | undefined {
    switch (scope) {
      case 'turn':
        return this.turnOverride && key.turnId && this.turnOverride.turnId === key.turnId
          ? this.turnOverride
          : undefined;
      case 'session': {
        const override = key.sessionKey ? this.sessionOverrides.get(key.sessionKey) : undefined;
        return override?.lane === key.lane ? override : undefined;
      }
      case 'lane':
        return this.laneOverrides.get(key.lane);
    }
  }

  /** The narrowest choice in force for this call, if the companion made one. */
  resolve(key: ReasoningOverrideKey): ReasoningEffortOverride | undefined {
    for (const scope of REASONING_OVERRIDE_SCOPES) {
      const override = this.get(scope, key);
      if (override) return override;
    }
    return undefined;
  }
}
