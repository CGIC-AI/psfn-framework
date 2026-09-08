import {
  defaultCapabilitiesForProfile,
  frameworkCapabilitiesForSatelliteCapabilities,
  type PsfnSatelliteClaimConfig,
} from "./satellite-claim.js";

const DEFAULT_BODY_WALK_TIMEOUT_MS = 95_000;
const DEFAULT_BODY_MAX_PENDING_NOTES = 4;

/**
 * The complete Hub-side locomotion allowlist. World-editing verbs (`spawn`,
 * `place`, `world_verb`, moderation) are deliberately absent and the runtime
 * parser below rejects every name outside this tuple, so an allowlisted action
 * request can never reach them through this runner.
 */
export const EIDOVERSE_BODY_ACTION_NAMES = ["walk_to", "face", "stop"] as const;

export type EidoverseBodyActionName = (typeof EIDOVERSE_BODY_ACTION_NAMES)[number];

export type EidoverseBodyAction =
  | { name: "walk_to"; x: number; z: number; run: boolean }
  | { name: "face"; target: string }
  | { name: "stop" };

/**
 * Content-free outcome vocabulary. The door's own reply text (`arrived at (x,
 * z)`) carries world coordinates, so it is mapped onto this fixed enum and
 * never forwarded verbatim into context notes, logs, or the model turn.
 */
export type EidoverseBodyOutcome =
  | "arrived"
  | "interrupted-or-timed-out"
  | "facing"
  | "stopped"
  | "failed";

export interface EidoverseBodyRunnerConfig {
  walkTimeoutMs: number;
  maxPendingNotes: number;
}

/**
 * The narrow slice of the Hub's MCP embodiment client this runner is allowed to
 * reach. `EidoverseMcpClient` satisfies it structurally; nothing else on that
 * client (and nothing world-editing anywhere) is visible from here.
 */
export interface EidoverseBodyTools {
  walkTo(x: number, z: number, run: boolean, timeoutMs: number): Promise<string>;
  face(target: string): Promise<string>;
  stop(): Promise<string>;
}

export interface EidoverseBodyRunnerLogger {
  warn(message: string): void;
}

export interface EidoverseBodyRunnerOptions {
  logger?: EidoverseBodyRunnerLogger;
}

export class EidoverseBodyActionRejectedError extends Error {
  override readonly name = "EidoverseBodyActionRejectedError";
}

/**
 * Neutral phrasing on purpose: a body action may be requested by something
 * other than the companion, so a note never asserts who asked for it.
 */
const OUTCOME_NOTES: Readonly<Record<EidoverseBodyOutcome, string>> = {
  arrived: "A requested walk finished; your body has arrived.",
  "interrupted-or-timed-out":
    "A requested walk did not finish; your body was interrupted or ran out of time.",
  facing: "A requested turn finished; your body is facing the target.",
  stopped: "A requested stop finished; your body is no longer walking.",
  failed: "A requested body action could not be carried out.",
};

/**
 * Rejects everything outside the locomotion allowlist at runtime, not merely in
 * the type system: an unknown or world-editing verb, or a malformed argument
 * set, fails closed before the MCP client is touched.
 */
export function parseEidoverseBodyAction(name: string, args: unknown): EidoverseBodyAction {
  if (!isBodyActionName(name)) {
    throw new EidoverseBodyActionRejectedError("Eidoverse body action is not allowlisted");
  }
  if (name === "stop") return { name: "stop" };
  if (!isRecord(args)) {
    throw new EidoverseBodyActionRejectedError("Eidoverse body action arguments must be an object");
  }
  if (name === "face") {
    const target = typeof args.target === "string" ? args.target.trim() : "";
    if (!target) {
      throw new EidoverseBodyActionRejectedError("Eidoverse face action requires a target");
    }
    return { name: "face", target };
  }
  const { x, z } = args;
  if (!Number.isFinite(x) || !Number.isFinite(z)) {
    throw new EidoverseBodyActionRejectedError("Eidoverse walk_to action requires finite x and z");
  }
  if (args.run !== undefined && typeof args.run !== "boolean") {
    throw new EidoverseBodyActionRejectedError("Eidoverse walk_to run flag must be a boolean");
  }
  return { name: "walk_to", x: x as number, z: z as number, run: args.run === true };
}

/**
 * Hub-side body runner for the Eidoverse world avatar.
 *
 * `walk_to` blocks door-side until arrival, interruption, or the door's own
 * ~90s walk timeout, so the runner never runs on a PSFN turn's critical path:
 * `submit` returns as soon as the action is accepted and the outcome surfaces
 * as a content-free context note on a later turn. No pose data crosses this
 * seam — the world's ~15Hz pose simulation lives entirely inside the door's own
 * world connection and never appears in an MCP tool result.
 */
export class EidoverseBodyRunner {
  private readonly logger: EidoverseBodyRunnerLogger;
  private readonly pending = new Set<Promise<void>>();
  private notes: string[] = [];
  private closed = false;

  constructor(
    private readonly config: EidoverseBodyRunnerConfig,
    private readonly tools: EidoverseBodyTools,
    options: EidoverseBodyRunnerOptions = {},
  ) {
    if (config.walkTimeoutMs <= 0 || config.maxPendingNotes <= 0) {
      throw new Error("Eidoverse body runner timeouts and note budget must be positive");
    }
    this.logger = options.logger ?? console;
  }

  /**
   * Accepts an allowlisted action and starts it off the turn's critical path.
   * The door cancels any walk already in flight when a new walk or stop
   * arrives, so requests are not queued; both outcomes are still recorded.
   */
  submit(action: EidoverseBodyAction): void {
    if (this.closed) {
      throw new EidoverseBodyActionRejectedError("Eidoverse body runner is closed");
    }
    const run = this.execute(action)
      .catch(() => {
        // `execute` already records the failed outcome; a rejection here would
        // otherwise become an unhandled rejection during shutdown.
        this.logger.warn("Eidoverse body action failed");
      })
      .finally(() => {
        this.pending.delete(run);
      });
    this.pending.add(run);
  }

  /** Returns and clears the outcome notes accumulated since the last turn. */
  drainNotes(): Array<{ key: string; text: string }> {
    const drained = this.notes;
    this.notes = [];
    return drained.map((text) => ({ key: "eidoverse.body", text }));
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.pending]);
  }

  private async execute(action: EidoverseBodyAction): Promise<void> {
    let outcome: EidoverseBodyOutcome;
    try {
      outcome = await this.callDoor(action);
    } catch {
      outcome = "failed";
    }
    this.recordOutcome(outcome);
    if (outcome === "failed") {
      this.logger.warn(`Eidoverse body ${action.name} failed`);
    }
  }

  private async callDoor(action: EidoverseBodyAction): Promise<EidoverseBodyOutcome> {
    if (action.name === "walk_to") {
      const reply = await this.tools.walkTo(
        action.x,
        action.z,
        action.run,
        this.config.walkTimeoutMs,
      );
      return reply.startsWith("arrived") ? "arrived" : "interrupted-or-timed-out";
    }
    if (action.name === "face") {
      const reply = await this.tools.face(action.target);
      return reply === "facing" ? "facing" : "failed";
    }
    const reply = await this.tools.stop();
    return reply === "stopped" ? "stopped" : "failed";
  }

  private recordOutcome(outcome: EidoverseBodyOutcome): void {
    this.notes = [...this.notes, OUTCOME_NOTES[outcome]].slice(-this.config.maxPendingNotes);
  }
}

/**
 * The `world-avatar` claim profile declares `output: action` plus the
 * `action_allowlist` safety token, which maps to the `avatar_action` framework
 * capability. A profile without it never gets a body runner.
 */
export function claimGrantsEidoverseBodyActions(claim: PsfnSatelliteClaimConfig): boolean {
  const capabilities = defaultCapabilitiesForProfile(claim.capabilityProfile);
  if (!capabilities.safety.includes("action_allowlist")) return false;
  return frameworkCapabilitiesForSatelliteCapabilities(capabilities, claim.capabilityProfile)
    .includes("avatar_action");
}

export function loadEidoverseBodyRunnerConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): EidoverseBodyRunnerConfig {
  return {
    walkTimeoutMs: positiveIntegerEnv(
      env,
      "EIDOVERSE_BODY_WALK_TIMEOUT_MS",
      DEFAULT_BODY_WALK_TIMEOUT_MS,
    ),
    maxPendingNotes: positiveIntegerEnv(
      env,
      "EIDOVERSE_BODY_MAX_PENDING_NOTES",
      DEFAULT_BODY_MAX_PENDING_NOTES,
    ),
  };
}

function isBodyActionName(value: string): value is EidoverseBodyActionName {
  return (EIDOVERSE_BODY_ACTION_NAMES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveIntegerEnv(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}
