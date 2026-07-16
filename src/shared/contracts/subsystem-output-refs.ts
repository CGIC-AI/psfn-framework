import { createHash } from 'node:crypto';

export const SUBSYSTEM_OUTPUT_KINDS = ['memory', 'concern', 'contact'] as const;

export type SubsystemOutputKind = typeof SUBSYSTEM_OUTPUT_KINDS[number];

export interface ParsedSubsystemOutputRef {
  schemaVersion: 1;
  kind: SubsystemOutputKind;
  targetId: string;
}

export interface TurnSubsystemProjectionBinding {
  logicalSessionId: string;
  sourceChannelId: string;
  sourceTurnId: string;
  sourceRequestId: string;
}

export interface ParsedTurnSubsystemProjectionRef {
  schemaVersion: 1;
  kind: SubsystemOutputKind;
  bindingSha256: string;
}

const REF_PATTERN = /^loom-output:v1:(memory|concern|contact):([A-Za-z0-9_-]+)$/u;
const PROJECTION_REF_PATTERN = /^loom-projection:v1:(memory|concern|contact):([a-f0-9]{64})$/u;

function invalidRef(): never {
  throw new Error('Invalid Loom subsystem output ref');
}

function normalizeTargetId(targetId: string): string {
  if (typeof targetId !== 'string' || targetId.trim().length === 0) {
    throw new Error('Subsystem output targetId must be a non-empty string');
  }
  const normalized = targetId.trim();
  if (normalized.length > 512 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error('Subsystem output targetId is invalid');
  }
  return normalized;
}

export function buildSubsystemOutputRef(
  kind: SubsystemOutputKind,
  targetId: string,
): string {
  if (!SUBSYSTEM_OUTPUT_KINDS.includes(kind)) invalidRef();
  const normalized = normalizeTargetId(targetId);
  return `loom-output:v1:${kind}:${Buffer.from(normalized, 'utf8').toString('base64url')}`;
}

export function parseSubsystemOutputRef(ref: string): ParsedSubsystemOutputRef {
  if (typeof ref !== 'string' || ref.length > 1024) invalidRef();
  const match = REF_PATTERN.exec(ref);
  if (!match) invalidRef();
  const kind = match[1] as SubsystemOutputKind;
  const encodedTargetId = match[2]!;
  let targetId: string;
  try {
    targetId = Buffer.from(encodedTargetId, 'base64url').toString('utf8');
  } catch {
    invalidRef();
  }
  let normalizedTargetId: string;
  try {
    normalizedTargetId = normalizeTargetId(targetId);
  } catch {
    invalidRef();
  }
  if (buildSubsystemOutputRef(kind, normalizedTargetId) !== ref) invalidRef();
  return { schemaVersion: 1, kind, targetId: normalizedTargetId };
}

function normalizeProjectionBinding(
  binding: TurnSubsystemProjectionBinding,
): TurnSubsystemProjectionBinding {
  const normalized = Object.fromEntries(Object.entries(binding).map(([key, value]) => {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`Subsystem output projection ${key} must be a non-empty string`);
    }
    return [key, value.trim()];
  })) as unknown as TurnSubsystemProjectionBinding;
  return normalized;
}

function hashProjectionBinding(binding: TurnSubsystemProjectionBinding): string {
  const normalized = normalizeProjectionBinding(binding);
  return createHash('sha256').update(JSON.stringify([
    normalized.logicalSessionId,
    normalized.sourceChannelId,
    normalized.sourceTurnId,
    normalized.sourceRequestId,
  ])).digest('hex');
}

export function buildTurnSubsystemProjectionRef(
  kind: SubsystemOutputKind,
  binding: TurnSubsystemProjectionBinding,
): string {
  if (!SUBSYSTEM_OUTPUT_KINDS.includes(kind)) {
    throw new Error('Invalid Loom subsystem projection ref');
  }
  return `loom-projection:v1:${kind}:${hashProjectionBinding(binding)}`;
}

export function parseTurnSubsystemProjectionRef(
  ref: string,
  binding: TurnSubsystemProjectionBinding,
  expectedKind?: SubsystemOutputKind,
): ParsedTurnSubsystemProjectionRef {
  const match = typeof ref === 'string' ? PROJECTION_REF_PATTERN.exec(ref) : null;
  const kind = match?.[1] as SubsystemOutputKind | undefined;
  const bindingSha256 = match?.[2];
  if (!kind || !bindingSha256 || (expectedKind !== undefined && kind !== expectedKind)) {
    throw new Error('Invalid Loom subsystem projection ref');
  }
  if (buildTurnSubsystemProjectionRef(kind, binding) !== ref) {
    throw new Error('Invalid Loom subsystem projection ref');
  }
  return { schemaVersion: 1, kind, bindingSha256 };
}
