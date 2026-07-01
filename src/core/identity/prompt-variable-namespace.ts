// ── Turn prompt variable namespace ──
// Single, fail-closed construction path for the prompt template variables used by
// one turn. Replaces the previous three-phase build (buildPromptTemplateVariables,
// an ad-hoc post-construction mutation in prompt assembly, and
// buildDynamicPromptTemplateVariables) that merged records with no conflict rules.
//
// Rules (all fail closed):
// - every variable key must resolve in the prompt macro manifest
//   (PROMPT_RUNTIME_MACRO_HINTS / PROMPT_MACRO_PREFIX_RULES in prompt-runtime.ts);
// - writing a key that already exists throws, regardless of phase or value;
// - phases are ordered ('session' before 'turn'); assigning to an earlier phase
//   after a later phase has started throws;
// - after freeze() every further write throws, and the returned records are
//   Object.frozen so accidental property writes throw too.
//
// SEAM NOTE (E2 epic): a later bead introduces a ConversationScope object and a
// Context Envelope. When those land, they become the inputs that feed the
// 'session' and 'turn' phases respectively — keep this class's phase-oriented
// assign/freeze shape so scope/envelope inputs can slot in without reworking the
// call sites in turn-execution/prompt-assembly.ts.

import { resolvePromptMacroManifestEntry } from './prompt-runtime.js';

export type TurnPromptVariablePhase = 'session' | 'turn';

const PHASE_ORDER: Record<TurnPromptVariablePhase, number> = {
  session: 0,
  turn: 1,
};

interface TurnPromptVariableRecord {
  key: string;
  value: string;
  phase: TurnPromptVariablePhase;
  producer: string;
}

export interface FrozenTurnPromptVariables {
  /** Full merged namespace (session + turn phases), frozen. */
  variables: Readonly<Record<string, string>>;
  /**
   * Session-phase subset, frozen. This is the variable set that participates in
   * the static prompt prefix render and the static settings hash.
   */
  sessionVariables: Readonly<Record<string, string>>;
}

export class TurnPromptVariableNamespaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TurnPromptVariableNamespaceError';
  }
}

export class TurnPromptVariableNamespace {
  private readonly records = new Map<string, TurnPromptVariableRecord>();
  private frozen = false;
  private highestPhaseStarted = PHASE_ORDER.session;

  assign(phase: TurnPromptVariablePhase, key: string, value: string, producer: string): void {
    if (this.frozen) {
      throw new TurnPromptVariableNamespaceError(
        `Prompt variable namespace is frozen; refusing write of "${key}" by ${producer}. `
        + 'All variables must be assigned before the namespace freezes for rendering.',
      );
    }
    const phaseOrder = PHASE_ORDER[phase];
    if (phaseOrder < this.highestPhaseStarted) {
      throw new TurnPromptVariableNamespaceError(
        `Prompt variable phase "${phase}" cannot be written after a later phase has started `
        + `(write of "${key}" by ${producer}).`,
      );
    }
    this.highestPhaseStarted = phaseOrder;

    const trimmedKey = key.trim();
    if (!trimmedKey) {
      throw new TurnPromptVariableNamespaceError(
        `Prompt variable key must be a non-empty string (producer ${producer}).`,
      );
    }
    const normalized = trimmedKey.toLowerCase();
    const existing = this.records.get(normalized);
    if (existing) {
      throw new TurnPromptVariableNamespaceError(
        `Duplicate prompt variable write: "${trimmedKey}" was already set by ${existing.producer} `
        + `(phase ${existing.phase}); refusing later write by ${producer} (phase ${phase}). `
        + 'Each variable has exactly one producer — remove the duplicate production.',
      );
    }
    if (!resolvePromptMacroManifestEntry(trimmedKey)) {
      throw new TurnPromptVariableNamespaceError(
        `Unregistered prompt variable "${trimmedKey}" written by ${producer}. `
        + 'Every prompt template variable must be registered in PROMPT_RUNTIME_MACRO_HINTS '
        + '(src/core/identity/prompt-runtime.ts) with a volatility class and producer. '
        + 'See docs/prompt-macros.md.',
      );
    }
    this.records.set(normalized, {
      key: trimmedKey,
      value,
      phase,
      producer,
    });
  }

  assignRecord(
    phase: TurnPromptVariablePhase,
    record: Record<string, string>,
    producer: string,
  ): void {
    for (const [key, value] of Object.entries(record)) {
      this.assign(phase, key, value, producer);
    }
  }

  /** Frozen snapshot of the variables assigned in one phase. */
  snapshotPhase(phase: TurnPromptVariablePhase): Readonly<Record<string, string>> {
    const snapshot: Record<string, string> = {};
    for (const record of this.records.values()) {
      if (record.phase === phase) {
        snapshot[record.key] = record.value;
      }
    }
    return Object.freeze(snapshot);
  }

  /**
   * Freeze the namespace and return the merged variable set. After this call every
   * further assign throws, and the returned records are frozen.
   */
  freeze(): FrozenTurnPromptVariables {
    if (this.frozen) {
      throw new TurnPromptVariableNamespaceError('Prompt variable namespace is already frozen.');
    }
    this.frozen = true;
    const variables: Record<string, string> = {};
    for (const record of this.records.values()) {
      variables[record.key] = record.value;
    }
    return {
      variables: Object.freeze(variables),
      sessionVariables: this.snapshotPhase('session'),
    };
  }

  isFrozen(): boolean {
    return this.frozen;
  }
}
