import {
  deriveMaskedToolObservationContextSummary,
  deriveToolObservationContextShape,
  type ToolObservationContextDisplayMode,
} from './tool-observation-context.js';

interface SessionMetadataEnvelope {
  toolObservation?: unknown;
  [key: string]: unknown;
}

export interface ToolObservationInput {
  toolName: string;
  content: string;
  toolCallId?: string;
  isError?: boolean;
}

export interface ToolObservationMetadata {
  schemaVersion: 1;
  toolName: string;
  toolCallId?: string;
  isError?: boolean;
  truncated: boolean;
  originalCharLength: number;
  contextSummary?: string;
  contextDisplayMode?: ToolObservationContextDisplayMode;
  maskedContextSummary?: string;
}

export interface NormalizedToolObservation {
  content: string;
  metadata: ToolObservationMetadata;
}

const TOOL_OBSERVATION_SCHEMA_VERSION = 1;
const DEFAULT_TOOL_OBSERVATION_CONTENT = '(no text tool output)';
const MAX_TOOL_OBSERVATION_CONTENT_CHARS = 4_000;
export const MASKED_TOOL_OBSERVATION_CONTENT = '__masked_tool_observation__';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseMetadataEnvelope(metadata: string | undefined): SessionMetadataEnvelope {
  if (!metadata) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(metadata);
  } catch {
    throw new Error('Session metadata is malformed JSON; refusing tool observation parsing');
  }

  if (!isRecord(parsed)) {
    throw new Error('Session metadata must be a JSON object for tool observation parsing');
  }

  return parsed as SessionMetadataEnvelope;
}

function parseOptionalStringField(value: unknown, fieldName: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`Tool observation field "${fieldName}" must be a string`);
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function parseRequiredStringField(value: unknown, fieldName: string): string {
  const normalized = parseOptionalStringField(value, fieldName);
  if (!normalized) {
    throw new Error(`Tool observation field "${fieldName}" cannot be empty`);
  }
  return normalized;
}

function parseOptionalBooleanField(value: unknown, fieldName: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new Error(`Tool observation field "${fieldName}" must be a boolean`);
  }
  return value;
}

function parseOptionalContextDisplayModeField(
  value: unknown,
  fieldName: string,
): ToolObservationContextDisplayMode | undefined {
  if (value === undefined) return undefined;
  if (value !== 'full' && value !== 'summary') {
    throw new Error(`Tool observation field "${fieldName}" must be "full" or "summary"`);
  }
  return value;
}

function parseRequiredBooleanField(value: unknown, fieldName: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`Tool observation field "${fieldName}" must be a boolean`);
  }
  return value;
}

function parseRequiredNonNegativeInteger(value: unknown, fieldName: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`Tool observation field "${fieldName}" must be a non-negative number`);
  }
  return Math.floor(value);
}

function truncateToolObservationContent(content: string): {
  content: string;
  truncated: boolean;
  originalCharLength: number;
} {
  const normalized = content.trim() || DEFAULT_TOOL_OBSERVATION_CONTENT;
  const originalCharLength = normalized.length;
  if (normalized.length <= MAX_TOOL_OBSERVATION_CONTENT_CHARS) {
    return {
      content: normalized,
      truncated: false,
      originalCharLength,
    };
  }

  return {
    content: `${normalized.slice(0, MAX_TOOL_OBSERVATION_CONTENT_CHARS - 3)}...`,
    truncated: true,
    originalCharLength,
  };
}

export function normalizeToolObservation(input: ToolObservationInput): NormalizedToolObservation {
  const toolName = input.toolName.trim();
  if (!toolName) {
    throw new Error('Tool observation requires a non-empty toolName');
  }

  const toolCallId = input.toolCallId?.trim();
  const normalizedContent = truncateToolObservationContent(input.content);
  const contextShape = deriveToolObservationContextShape(input.content);
  const maskedContextSummary = deriveMaskedToolObservationContextSummary(input.content);
  return {
    content: normalizedContent.content,
    metadata: {
      schemaVersion: TOOL_OBSERVATION_SCHEMA_VERSION,
      toolName,
      ...(toolCallId ? { toolCallId } : {}),
      ...(input.isError !== undefined ? { isError: input.isError } : {}),
      truncated: normalizedContent.truncated,
      originalCharLength: normalizedContent.originalCharLength,
      contextSummary: contextShape.summary,
      contextDisplayMode: contextShape.displayMode,
      maskedContextSummary,
    },
  };
}

export function buildToolObservationMetadata(
  existingMetadata: string | undefined,
  metadata: ToolObservationMetadata,
): string {
  const base = parseMetadataEnvelope(existingMetadata);
  return JSON.stringify({
    ...base,
    toolObservation: metadata,
  });
}

export function parseToolObservationMetadata(metadata: string | undefined): ToolObservationMetadata | null {
  const envelope = parseMetadataEnvelope(metadata);
  if (envelope.toolObservation === undefined) {
    return null;
  }

  if (!isRecord(envelope.toolObservation)) {
    throw new Error('Session metadata toolObservation field must be an object');
  }

  const toolObservation = envelope.toolObservation as Record<string, unknown>;
  const schemaVersion = parseRequiredNonNegativeInteger(
    toolObservation.schemaVersion,
    'toolObservation.schemaVersion',
  );
  if (schemaVersion !== TOOL_OBSERVATION_SCHEMA_VERSION) {
    throw new Error(`Unsupported tool observation schemaVersion "${schemaVersion}"`);
  }

  const toolName = parseRequiredStringField(toolObservation.toolName, 'toolObservation.toolName');
  const toolCallId = parseOptionalStringField(toolObservation.toolCallId, 'toolObservation.toolCallId');
  const isError = parseOptionalBooleanField(toolObservation.isError, 'toolObservation.isError');
  const truncated = parseRequiredBooleanField(toolObservation.truncated, 'toolObservation.truncated');
  const originalCharLength = parseRequiredNonNegativeInteger(
    toolObservation.originalCharLength,
    'toolObservation.originalCharLength',
  );
  const contextSummary = parseOptionalStringField(
    toolObservation.contextSummary,
    'toolObservation.contextSummary',
  );
  const contextDisplayMode = parseOptionalContextDisplayModeField(
    toolObservation.contextDisplayMode,
    'toolObservation.contextDisplayMode',
  );
  const maskedContextSummary = parseOptionalStringField(
    toolObservation.maskedContextSummary,
    'toolObservation.maskedContextSummary',
  );

  return {
    schemaVersion: TOOL_OBSERVATION_SCHEMA_VERSION,
    toolName,
    ...(toolCallId ? { toolCallId } : {}),
    ...(isError !== undefined ? { isError } : {}),
    truncated,
    originalCharLength,
    ...(contextSummary ? { contextSummary } : {}),
    ...(contextDisplayMode ? { contextDisplayMode } : {}),
    ...(maskedContextSummary ? { maskedContextSummary } : {}),
  };
}

export function formatToolObservationForContext(
  content: string,
  metadata: ToolObservationMetadata,
): string {
  const errorSuffix = metadata.isError ? ' (error)' : '';
  const contextText = metadata.contextSummary?.trim();
  const maskedContextText = metadata.maskedContextSummary?.trim();
  if (content === MASKED_TOOL_OBSERVATION_CONTENT) {
    const maskedSummary = maskedContextText || (metadata.contextDisplayMode === 'summary' ? contextText : undefined);
    if (maskedSummary) {
      return `[Tool result: ${metadata.toolName}${errorSuffix}] ${maskedSummary}`;
    }
    return `[Tool result: ${metadata.toolName}${errorSuffix} — see earlier context]`;
  }
  if (metadata.contextDisplayMode === 'summary' && contextText) {
    return `[Tool result: ${metadata.toolName}${errorSuffix}] ${contextText}`;
  }
  return `[Tool result: ${metadata.toolName}${errorSuffix}] ${content}`;
}
