import {
  defaultCapabilitiesForProfile,
  frameworkCapabilitiesForSatelliteCapabilities,
  type PsfnSatelliteClaimConfig,
} from "./satellite-claim.js";

const DEFAULT_BODY_WALK_TIMEOUT_MS = 95_000;
const DEFAULT_BODY_MAX_PENDING_NOTES = 4;

/**
 * The complete Hub-side body allowlist. Locomotion (`walk_to`, `face`, `stop`),
 * expression (`emote`, `posture`, `set_avatar`) and the two creation verbs the
 * door exposes for props (`spawn`, `remove`) are the whole vocabulary. Raw
 * `world_verb`, `place`, moderation and terrain editing are deliberately
 * absent and the runtime parser below rejects every name outside this tuple,
 * so a request can never reach them through this runner. The framework's
 * capability tiers decide which of these a companion may invoke; this runner
 * only decides what is reachable at all.
 */
export const EIDOVERSE_BODY_ACTION_NAMES = [
  "walk_to",
  "face",
  "stop",
  "emote",
  "posture",
  "whisper",
  // Flight family and wing posture (psfn-framework-jbvwz): the door's own
  // bounded verbs, exposed with the same shape. Raw-bone `pose`/`animate`
  // stay out until a named library exists on the door side.
  "take_off",
  "climb_to",
  "glide_to",
  "land_at",
  "fold_wings",
  "unfold_wings",
  "flight_status",
  // Named clip library (psfn-framework-ae7c9): hold any library clip by
  // name; the roster itself rides the world map, not a verb.
  "play_clip",
  "spawn",
  "remove",
  "set_avatar",
] as const;

/** Bound on `climb_to`: the door clamps to its soft ceiling anyway; this keeps a model typo from asking for the stratosphere. */
export const EIDOVERSE_MAX_CLIMB_ALTITUDE_M = 500;
/** A clip name as the door's roster spells it (a .vrma file name without the suffix). */
export const EIDOVERSE_CLIP_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _.()-]{0,63}$/u;

export type EidoverseBodyActionName = (typeof EIDOVERSE_BODY_ACTION_NAMES)[number];

/** The verbs that create or delete things in the world (world-editing tier). */
export const EIDOVERSE_WORLD_EDIT_ACTION_NAMES: readonly EidoverseBodyActionName[] = [
  "spawn",
  "remove",
  "set_avatar",
];

export const EIDOVERSE_EMOTE_NAMES = ["wave", "cheer", "dance", "point", "salute", "clap", "talk", "flail"] as const;
export const EIDOVERSE_POSTURE_KINDS = ["sit", "sitchair", "lie", "stand"] as const;

export type EidoverseBodyAction =
  | { name: "walk_to"; x: number; z: number; run: boolean }
  | { name: "face"; target: string }
  | { name: "face"; x: number; z: number }
  | { name: "stop" }
  | { name: "emote"; emote: (typeof EIDOVERSE_EMOTE_NAMES)[number] }
  | { name: "posture"; kind: (typeof EIDOVERSE_POSTURE_KINDS)[number] }
  | { name: "whisper"; to: string; text: string }
  | { name: "take_off" }
  | { name: "climb_to"; altitude: number }
  | { name: "glide_to"; x: number; z: number }
  | { name: "land_at"; x: number; z: number }
  | { name: "fold_wings" }
  | { name: "unfold_wings" }
  | { name: "flight_status" }
  | { name: "play_clip"; clip: string }
  | { name: "spawn"; lib?: string; query?: string; x?: number; z?: number; yaw?: number; id?: string }
  | { name: "remove"; id: string }
  | { name: "set_avatar"; avatar: string };

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
  | "expressed"
  | "whispered"
  | "airborne"
  | "landed"
  | "reported"
  | "created"
  | "removed"
  | "failed";

/**
 * What one started action came to. `reply` is the door's own single-line
 * answer (`arrived at (3.0, 2.0)`, `spawned [ab12] bench at (1.0, 2.0)`); it
 * is returned to a caller that explicitly waits for it (the companion's own
 * `move`/`act`) and never folded into the content-free next-turn note.
 */
export interface EidoverseBodyRunResult {
  action: EidoverseBodyActionName;
  outcome: EidoverseBodyOutcome;
  reply: string | null;
  /** Parsed from an `arrived at (x, z)` reply when the door reports one. */
  position?: { x: number; z: number };
}

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
  /** Optional on a transport: absent ⇒ the verb is refused as unavailable. */
  faceAt?(x: number, z: number): Promise<string>;
  emote?(name: string): Promise<string>;
  posture?(kind: string): Promise<string>;
  whisper?(to: string, text: string): Promise<string>;
  spawn?(args: { lib?: string; query?: string; x?: number; z?: number; yaw?: number; id?: string }): Promise<string>;
  remove?(id: string): Promise<string>;
  setAvatar?(avatar: string): Promise<string>;
  /** Flight family (psfn-framework-jbvwz); absent on a transport ⇒ refused as unavailable. */
  takeOff?(): Promise<string>;
  climbTo?(altitude: number): Promise<string>;
  glideTo?(x: number, z: number): Promise<string>;
  landAt?(x: number, z: number): Promise<string>;
  foldWings?(): Promise<string>;
  unfoldWings?(): Promise<string>;
  flightStatus?(): Promise<string>;
  /** Named clip library (psfn-framework-ae7c9). */
  playClip?(name: string): Promise<string>;
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
  expressed: "A requested gesture or posture finished.",
  whispered: "A requested whisper was delivered privately.",
  airborne: "A requested flight verb finished; read your body's altitude and stamina before the next one.",
  landed: "A requested landing finished; your body is walking again.",
  reported: "A requested flight status was read.",
  created: "A requested prop was placed in the world.",
  removed: "A requested prop was removed from the world.",
  failed: "A requested body action could not be carried out.",
};

const ARRIVED_PATTERN = /^arrived at \((-?\d+(?:\.\d+)?), (-?\d+(?:\.\d+)?)\)/u;
const DOOR_REFUSAL_PATTERN = /^(?:no such|no model|no entity|unknown tool|pass x\+z|refused)/iu;

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
  if (name === "take_off" || name === "fold_wings" || name === "unfold_wings" || name === "flight_status") {
    return { name };
  }
  if (!isRecord(args)) {
    throw new EidoverseBodyActionRejectedError("Eidoverse body action arguments must be an object");
  }
  if (name === "face") {
    const target = typeof args.target === "string" ? args.target.trim() : "";
    if (target) return { name: "face", target };
    if (Number.isFinite(args.x) && Number.isFinite(args.z)) {
      return { name: "face", x: args.x as number, z: args.z as number };
    }
    throw new EidoverseBodyActionRejectedError("Eidoverse face action requires a target or x and z");
  }
  if (name === "emote") {
    const emote = typeof args.name === "string" ? args.name.trim() : typeof args.emote === "string" ? args.emote.trim() : "";
    if (!(EIDOVERSE_EMOTE_NAMES as readonly string[]).includes(emote)) {
      throw new EidoverseBodyActionRejectedError(
        `Eidoverse emote must be one of: ${EIDOVERSE_EMOTE_NAMES.join(", ")}`,
      );
    }
    return { name: "emote", emote: emote as (typeof EIDOVERSE_EMOTE_NAMES)[number] };
  }
  if (name === "posture") {
    const kind = typeof args.kind === "string" ? args.kind.trim() : "";
    if (!(EIDOVERSE_POSTURE_KINDS as readonly string[]).includes(kind)) {
      throw new EidoverseBodyActionRejectedError(
        `Eidoverse posture must be one of: ${EIDOVERSE_POSTURE_KINDS.join(", ")}`,
      );
    }
    return { name: "posture", kind: kind as (typeof EIDOVERSE_POSTURE_KINDS)[number] };
  }
  if (name === "play_clip") {
    const clip = typeof args.name === "string" ? args.name.trim() : "";
    if (!EIDOVERSE_CLIP_NAME_PATTERN.test(clip)) {
      throw new EidoverseBodyActionRejectedError("Eidoverse play_clip requires a clip name from the world's clip library");
    }
    return { name: "play_clip", clip };
  }
  if (name === "climb_to") {
    const altitude = args.altitude;
    if (!Number.isFinite(altitude) || (altitude as number) <= 0 || (altitude as number) > EIDOVERSE_MAX_CLIMB_ALTITUDE_M) {
      throw new EidoverseBodyActionRejectedError(
        `Eidoverse climb_to requires altitude between 0 and ${EIDOVERSE_MAX_CLIMB_ALTITUDE_M} metres`,
      );
    }
    return { name: "climb_to", altitude: altitude as number };
  }
  if (name === "glide_to" || name === "land_at") {
    if (!Number.isFinite(args.x) || !Number.isFinite(args.z)) {
      throw new EidoverseBodyActionRejectedError(`Eidoverse ${name} requires x and z`);
    }
    return { name, x: args.x as number, z: args.z as number };
  }
  if (name === "whisper") {
    const to = optionalToken(args.to, 64);
    const text = typeof args.text === "string" ? args.text.trim().slice(0, 4000) : "";
    if (!to || !text) throw new EidoverseBodyActionRejectedError("Eidoverse whisper requires to and text");
    return { name: "whisper", to, text };
  }
  if (name === "spawn") {
    const lib = optionalToken(args.lib, 200);
    const query = optionalToken(args.query, 200);
    if (!lib && !query) {
      throw new EidoverseBodyActionRejectedError("Eidoverse spawn requires lib or query");
    }
    for (const key of ["x", "z", "yaw"] as const) {
      if (args[key] !== undefined && !Number.isFinite(args[key])) {
        throw new EidoverseBodyActionRejectedError(`Eidoverse spawn ${key} must be a finite number`);
      }
    }
    const id = optionalToken(args.id, 64);
    return {
      name: "spawn",
      ...(lib ? { lib } : {}),
      ...(query ? { query } : {}),
      ...(args.x !== undefined ? { x: args.x as number } : {}),
      ...(args.z !== undefined ? { z: args.z as number } : {}),
      ...(args.yaw !== undefined ? { yaw: args.yaw as number } : {}),
      ...(id ? { id } : {}),
    };
  }
  if (name === "remove") {
    const id = optionalToken(args.id, 64);
    if (!id) throw new EidoverseBodyActionRejectedError("Eidoverse remove requires an entity id");
    return { name: "remove", id };
  }
  if (name === "set_avatar") {
    const avatar = optionalToken(args.avatar, 200);
    if (!avatar) throw new EidoverseBodyActionRejectedError("Eidoverse set_avatar requires an avatar");
    return { name: "set_avatar", avatar };
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
  private readonly pending = new Set<Promise<unknown>>();
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
    const started = this.start(action);
    const run = started
      .then((result) => { this.recordOutcome(result.outcome); })
      .catch(() => {
        // `start` never rejects on a door failure (it maps it to `failed`);
        // this guard only keeps a shutdown race from becoming an unhandled
        // rejection.
        this.logger.warn("Eidoverse body action failed");
      })
      .finally(() => {
        this.pending.delete(run);
      });
    this.pending.add(run);
  }

  /**
   * Start one action and resolve with its outcome. Unlike `submit`, no
   * next-turn note is recorded: the caller is awaiting the result itself and
   * will report it. A caller that stops waiting (bounded wait) should hand the
   * promise to `noteWhenDone` so the outcome still reaches a later turn.
   */
  start(action: EidoverseBodyAction): Promise<EidoverseBodyRunResult> {
    if (this.closed) {
      throw new EidoverseBodyActionRejectedError("Eidoverse body runner is closed");
    }
    const run = this.execute(action).finally(() => { this.pending.delete(run); });
    this.pending.add(run);
    return run;
  }

  /** Record a started action's outcome as a next-turn note once it settles. */
  noteWhenDone(run: Promise<EidoverseBodyRunResult>): void {
    void run.then((result) => { this.recordOutcome(result.outcome); }).catch(() => undefined);
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

  private async execute(action: EidoverseBodyAction): Promise<EidoverseBodyRunResult> {
    let result: EidoverseBodyRunResult;
    try {
      result = await this.callDoor(action);
    } catch {
      result = { action: action.name, outcome: "failed", reply: null };
    }
    if (result.outcome === "failed") {
      this.logger.warn(`Eidoverse body ${action.name} failed`);
    }
    return result;
  }

  private async callDoor(action: EidoverseBodyAction): Promise<EidoverseBodyRunResult> {
    const name = action.name;
    if (action.name === "walk_to") {
      const reply = await this.tools.walkTo(action.x, action.z, action.run, this.config.walkTimeoutMs);
      const arrived = ARRIVED_PATTERN.exec(reply);
      return {
        action: name,
        outcome: arrived ? "arrived" : "interrupted-or-timed-out",
        reply,
        ...(arrived ? { position: { x: Number(arrived[1]), z: Number(arrived[2]) } } : {}),
      };
    }
    if (action.name === "face") {
      const reply = "target" in action
        ? await this.tools.face(action.target)
        : await this.requireTool("faceAt")(action.x, action.z);
      return { action: name, outcome: reply === "facing" ? "facing" : "failed", reply };
    }
    if (action.name === "stop") {
      const reply = await this.tools.stop();
      return { action: name, outcome: reply === "stopped" ? "stopped" : "failed", reply };
    }
    if (action.name === "emote") {
      return settled(name, await this.requireTool("emote")(action.emote), "expressed");
    }
    if (action.name === "posture") {
      return settled(name, await this.requireTool("posture")(action.kind), "expressed");
    }
    if (action.name === "whisper") {
      return settled(name, await this.requireTool("whisper")(action.to, action.text), "whispered");
    }
    if (action.name === "take_off") {
      return settled(name, await this.requireTool("takeOff")(), "airborne");
    }
    if (action.name === "climb_to") {
      return settled(name, await this.requireTool("climbTo")(action.altitude), "airborne");
    }
    if (action.name === "glide_to") {
      return settled(name, await this.requireTool("glideTo")(action.x, action.z), "airborne");
    }
    if (action.name === "land_at") {
      return settled(name, await this.requireTool("landAt")(action.x, action.z), "landed");
    }
    if (action.name === "fold_wings") {
      return settled(name, await this.requireTool("foldWings")(), "expressed");
    }
    if (action.name === "unfold_wings") {
      return settled(name, await this.requireTool("unfoldWings")(), "expressed");
    }
    if (action.name === "flight_status") {
      return settled(name, await this.requireTool("flightStatus")(), "reported");
    }
    if (action.name === "play_clip") {
      return settled(name, await this.requireTool("playClip")(action.clip), "expressed");
    }
    if (action.name === "spawn") {
      const { name: _name, ...args } = action;
      return settled(name, await this.requireTool("spawn")(args), "created");
    }
    if (action.name === "remove") {
      return settled(name, await this.requireTool("remove")(action.id), "removed");
    }
    return settled(name, await this.requireTool("setAvatar")(action.avatar), "expressed");
  }

  private requireTool<K extends "faceAt" | "emote" | "posture" | "whisper" | "spawn" | "remove" | "setAvatar"
    | "takeOff" | "climbTo" | "glideTo" | "landAt" | "foldWings" | "unfoldWings" | "flightStatus" | "playClip">(
    key: K,
  ): NonNullable<EidoverseBodyTools[K]> {
    const tool = this.tools[key];
    if (!tool) throw new Error(`Eidoverse transport does not expose ${key}`);
    return tool.bind(this.tools) as NonNullable<EidoverseBodyTools[K]>;
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

/** True for the verbs that edit the world rather than move or express the body. */
export function isEidoverseWorldEditAction(name: string): boolean {
  return (EIDOVERSE_WORLD_EDIT_ACTION_NAMES as readonly string[]).includes(name);
}

function settled(
  action: EidoverseBodyActionName,
  reply: string,
  success: EidoverseBodyOutcome,
): EidoverseBodyRunResult {
  return { action, outcome: DOOR_REFUSAL_PATTERN.test(reply.trim()) ? "failed" : success, reply };
}

function optionalToken(value: unknown, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new EidoverseBodyActionRejectedError("Eidoverse body action string argument is invalid");
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength || /[\r\n]/u.test(trimmed)) {
    throw new EidoverseBodyActionRejectedError("Eidoverse body action string argument is invalid");
  }
  return trimmed;
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
