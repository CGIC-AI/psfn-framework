import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { createHash } from 'node:crypto';
import { requireUuid } from '../utils/uuid.js';

const text = Type.String({ minLength: 1 });
const session = { sessionId: text };
const event = { ...session, eventId: text };
const strict = { additionalProperties: false } as const;

export const EXTERNAL_MEMORY_TOOL_SCHEMAS = {
  context: Type.Object({ ...session, query: text }, strict),
  search: Type.Object({ ...session, query: text, limit: Type.Optional(Type.Integer({ minimum: 1 })) }, strict),
  get: Type.Object({ ...session, id: text }, strict),
  remember: Type.Object({ ...event, text }, strict),
  ingest: Type.Object({
    ...event,
    user: text,
    assistant: text,
    occurredAt: Type.Integer({ minimum: 0 }),
  }, strict),
} as const;

export type ExternalMemoryOperation = keyof typeof EXTERNAL_MEMORY_TOOL_SCHEMAS;
export type ExternalMemoryRequest = {
  [K in ExternalMemoryOperation]: { operation: K } & Static<typeof EXTERNAL_MEMORY_TOOL_SCHEMAS[K]>
}[ExternalMemoryOperation];

const bindingSchema = Type.Object({ bodyId: text, companionId: text, contactId: text }, strict);

/** Only gateway owner configuration supplies this identity; tool arguments never do. */
export type ExternalMemoryBinding = Static<typeof bindingSchema>;

export interface ExternalMemoryExecuteParams {
  binding: ExternalMemoryBinding;
  request: ExternalMemoryRequest;
}

export interface ExternalMemoryReceipt {
  receiptId: string;
  bodyId: string;
  companionId: string;
  sessionId: string;
  eventId: string;
  status: 'accepted';
}

export type ExternalMemoryExecuteResult =
  | { context: string }
  | { memories: Array<{ id: string; text: string; type: string }> }
  | { memory: { id: string; text: string; type: string } | null }
  | { receipt: ExternalMemoryReceipt };

export function parseExternalMemoryBinding(input: unknown): ExternalMemoryBinding {
  if (!Value.Check(bindingSchema, input)) throw new Error('Invalid external memory binding');
  requireUuid(input.companionId, 'external memory companionId');
  return input;
}

export function parseExternalMemoryRequest(
  operation: string,
  input: unknown,
): ExternalMemoryRequest {
  if (!Object.hasOwn(EXTERNAL_MEMORY_TOOL_SCHEMAS, operation)) {
    throw new Error('Unknown external memory operation');
  }
  const key = operation as ExternalMemoryOperation;
  if (!Value.Check(EXTERNAL_MEMORY_TOOL_SCHEMAS[key], input)) {
    throw new Error('Invalid external memory arguments');
  }
  return { ...input, operation: key } as ExternalMemoryRequest;
}

export function parseExternalMemoryExecuteParams(input: unknown): ExternalMemoryExecuteParams {
  const wrapper = Type.Object({ binding: bindingSchema, request: Type.Object({
    operation: text,
  }, { additionalProperties: true }) }, strict);
  if (!Value.Check(wrapper, input)) throw new Error('Invalid external memory request');
  const { operation, ...args } = input.request;
  return {
    binding: parseExternalMemoryBinding(input.binding),
    request: parseExternalMemoryRequest(operation, args),
  };
}

/** Hash components so foreign IDs cannot escape a path or inject namespace markers. */
export function externalMemorySessionId(binding: ExternalMemoryBinding, sessionId: string): string {
  const digest = createHash('sha256').update(JSON.stringify([
    binding.companionId, binding.bodyId, binding.contactId, sessionId,
  ])).digest('hex');
  return `api:hermes:${digest}`;
}
