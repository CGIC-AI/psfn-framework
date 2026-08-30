import { Type, type Static } from '@sinclair/typebox';

import type { SubstrateAgentTool } from '../../boundary/pi-agent/index.js';
import { CANONICAL_TOOL_SURFACE_DESCRIPTIONS } from '../agent/tool-surface/descriptions.js';
import { LETTER_STATES } from '../letters/contracts.js';
import type { LetterService } from '../letters/service.js';
import { DOING_MIRROR_ITEM_TYPES } from '../doing-mirror/contracts.js';
import type { DoingMirrorItemType } from '../doing-mirror/contracts.js';
import type { DoingMirrorService } from '../doing-mirror/service.js';
import { textResult, textResultFromError } from './results.js';

const LetterToolParameters = Type.Object({
  action: Type.Union([
    Type.Literal('compose'),
    Type.Literal('list'),
    Type.Literal('read'),
    Type.Literal('place'),
    Type.Literal('archive'),
    Type.Literal('disposition_list'),
    Type.Literal('disposition_read'),
  ]),
  letterId: Type.Optional(Type.String()),
  subject: Type.Optional(Type.String()),
  body: Type.Optional(Type.String()),
  draft: Type.Optional(Type.Boolean()),
  direction: Type.Optional(Type.Union([Type.Literal('inbox'), Type.Literal('outbox')])),
  states: Type.Optional(Type.Array(Type.Union(LETTER_STATES.map(state => Type.Literal(state))))),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  itemType: Type.Optional(Type.Union(DOING_MIRROR_ITEM_TYPES.map(type => Type.Literal(type)))),
  itemId: Type.Optional(Type.String()),
});

type LetterToolInput = Static<typeof LetterToolParameters>;

function requireString(value: string | undefined, field: string): string {
  if (!value?.trim()) throw new Error(`letter action requires ${field}`);
  return value;
}

function requireItemType(value: DoingMirrorItemType | undefined): DoingMirrorItemType {
  if (!value || !DOING_MIRROR_ITEM_TYPES.some(itemType => itemType === value)) {
    throw new Error('letter action requires itemType');
  }
  return value;
}

export function createLetterTool(
  service: LetterService,
  doingMirror?: Pick<DoingMirrorService, 'list' | 'get'>,
): SubstrateAgentTool {
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
          case 'disposition_list':
            if (!doingMirror) throw new Error('doing-mirror surface is unavailable');
            return textResult(JSON.stringify(await doingMirror.list(), null, 2));
          case 'disposition_read':
            if (!doingMirror) throw new Error('doing-mirror surface is unavailable');
            return textResult(JSON.stringify(await doingMirror.get(
              requireItemType(input.itemType),
              requireString(input.itemId, 'itemId'),
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
