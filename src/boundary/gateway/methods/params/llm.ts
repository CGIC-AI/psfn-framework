import { Type } from '@sinclair/typebox';

import {
  correlationProperties,
  correlatedParams,
  emptyParams,
  enumSchema,
  gatewayDecoder,
  optionalBoolean,
  optionalCanonicalUuid,
  optionalNumber,
  optionalString,
  strictObject,
  unknownRecord,
} from './schema.js';

const gatewayLLMContentBlock = Type.Union([
  strictObject({
    type: Type.Literal('text'),
    text: Type.String(),
    textSignature: optionalString,
  }),
  strictObject({
    type: Type.Literal('image'),
    data: Type.String(),
    mimeType: Type.String(),
  }),
  strictObject({
    type: Type.Literal('thinking'),
    thinking: Type.String(),
    thinkingSignature: optionalString,
    redacted: optionalBoolean,
  }),
  strictObject({
    type: Type.Literal('toolCall'),
    id: Type.String(),
    name: Type.String(),
    arguments: unknownRecord,
    thoughtSignature: optionalString,
  }),
  strictObject({
    type: Type.Literal('gateway_image_ref'),
    handle: Type.String(),
  }),
]);
const messageContent = Type.Union([
  Type.String(),
  Type.Array(gatewayLLMContentBlock),
]);
const gatewayConversationMessage = strictObject({
  role: enumSchema(['user', 'assistant', 'system']),
  content: messageContent,
  provenance: Type.Optional(unknownRecord),
});
const gatewayToolResultMessage = strictObject({
  role: Type.Literal('toolResult'),
  toolCallId: Type.String(),
  toolName: Type.String(),
  content: Type.Array(Type.Union([
    strictObject({
      type: Type.Literal('text'),
      text: Type.String(),
      textSignature: optionalString,
    }),
    strictObject({
      type: Type.Literal('image'),
      data: Type.String(),
      mimeType: Type.String(),
    }),
    strictObject({
      type: Type.Literal('gateway_image_ref'),
      handle: Type.String(),
    }),
  ])),
  isError: Type.Boolean(),
  provenance: Type.Optional(unknownRecord),
});
const gatewayMessage = Type.Union([
  gatewayConversationMessage,
  gatewayToolResultMessage,
]);
const toolSchema = strictObject({
  name: Type.String(),
  description: Type.String(),
  inputSchema: unknownRecord,
});
const accounting = strictObject({
  logicalCallId: Type.String(),
  attempt: Type.Integer(),
  retryOwner: Type.Optional(Type.Literal('caller')),
});
const llmCommon = {
  ...correlationProperties,
  cancellationId: optionalCanonicalUuid(),
  // The gateway deliberately tolerates omitted routing hints and resolves its
  // configured defaults. Several in-process and older wire callers rely on
  // that behavior even though the public protocol still declares both fields.
  model: optionalString,
  provider: optionalString,
  pin: optionalBoolean,
  slotKey: optionalString,
  messages: Type.Array(gatewayMessage),
  systemPrompt: Type.String(),
  promptCacheBoundaries: Type.Optional(unknownRecord),
  maxTokens: optionalNumber,
  contextWindow: optionalNumber,
  thinkingEnabled: optionalBoolean,
  thinkingEffort: Type.Optional(enumSchema(['minimal', 'low', 'medium', 'high', 'xhigh'])),
  temperature: optionalNumber,
  topP: optionalNumber,
  topK: optionalNumber,
  repetitionPenalty: optionalNumber,
  frequencyPenalty: optionalNumber,
  accounting: Type.Optional(accounting),
  workSpec: Type.Optional(unknownRecord),
};

export const llmMethodParamDecoders = {
  'llm.chat': gatewayDecoder('llm.chat', strictObject({
    ...llmCommon,
    stream: optionalBoolean,
    tools: Type.Optional(Type.Array(toolSchema)),
    mcpOutboundSensitivity: Type.Optional(enumSchema([
      'public', 'personal', 'intimate', 'confidential',
    ])),
  })),
  'llm.complete': gatewayDecoder('llm.complete', strictObject({
    ...llmCommon,
    purpose: enumSchema([
      'chat', 'background', 'memory', 'context', 'extraction', 'summary', 'reasoning',
      'import_processing', 'vision',
    ]),
  })),
  'llm.embed': gatewayDecoder('llm.embed', correlatedParams({
    texts: Type.Array(Type.String()),
    cancellationId: optionalCanonicalUuid(),
  })),
  'llm.cancel': gatewayDecoder('llm.cancel', strictObject({
    cancellationId: Type.String(),
    companionId: optionalString,
  })),
  'llm.discover_models': gatewayDecoder('llm.discover_models', emptyParams),
  'llm.invalidate_model_discovery': gatewayDecoder('llm.invalidate_model_discovery', emptyParams),
} as const;
