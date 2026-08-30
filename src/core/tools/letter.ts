import { Type, type Static } from '@sinclair/typebox';

import type { SubstrateAgentTool } from '../../boundary/pi-agent/index.js';
import { CANONICAL_TOOL_SURFACE_DESCRIPTIONS } from '../agent/tool-surface/descriptions.js';
import { LETTER_STATES } from '../letters/contracts.js';
import type { LetterService } from '../letters/service.js';
import { textResult, textResultFromError } from './results.js';

const LetterToolParameters = Type.Object({
  action: Type.Union([
    Type.Literal('compose'),
    Type.Literal('list'),
    Type.Literal('read'),
    Type.Literal('place'),
    Type.Literal('archive'),
  ]),
  letterId: Type.Optional(Type.String()),
  subject: Type.Optional(Type.String()),
  body: Type.Optional(Type.String()),
  draft: Type.Optional(Type.Boolean()),
  direction: Type.Optional(Type.Union([Type.Literal('inbox'), Type.Literal('outbox')])),
  states: Type.Optional(Type.Array(Type.Union(LETTER_STATES.map(state => Type.Literal(state))))),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});

type LetterToolInput = Static<typeof LetterToolParameters>;

function requireString(value: string | undefined, field: string): string {
  if (!value?.trim()) throw new Error(`letter action requires ${field}`);
  return value;
}

export function createLetterTool(service: LetterService): SubstrateAgentTool {
  return {
    name: 'letter',
    label: 'letter',
    description: CANONICAL_TOOL_SURFACE_DESCRIPTIONS.letter,
    parameters: LetterToolParameters,
    execute: async (_toolCallId, input: LetterToolInput) => {
      try {
        switch (input.action) {
          case 'compose':
            return textResult(JSON.stringify(await service.compose({
              author: 'companion',
              recipient: 'partner',
              subject: requireString(input.subject, 'subject'),
              body: requireString(input.body, 'body'),
              ...(input.draft === true ? { draft: true } : {}),
            }), null, 2));
          case 'list':
            return textResult(JSON.stringify(await service.list({
              party: 'companion',
              ...(input.direction ? { direction: input.direction } : {}),
              ...(input.states ? { states: input.states } : {}),
              ...(input.limit ? { limit: input.limit } : {}),
            }), null, 2));
          case 'read':
            return textResult(JSON.stringify(await service.read(
              requireString(input.letterId, 'letterId'), 'companion',
            ), null, 2));
          case 'place':
            return textResult(JSON.stringify(await service.place(
              requireString(input.letterId, 'letterId'), 'companion',
            ), null, 2));
          case 'archive':
            return textResult(JSON.stringify(await service.archive(
              requireString(input.letterId, 'letterId'), 'companion',
            ), null, 2));
        }
      } catch (error) {
        return textResultFromError('Letter action failed', error, {
          companionMessage: error instanceof Error ? error.message : 'Letter action failed',
        });
      }
    },
  };
}
