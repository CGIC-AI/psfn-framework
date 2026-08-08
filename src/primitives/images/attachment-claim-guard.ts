import type { AgentMessage } from '../../boundary/pi-agent/index.js';
import {
  hasSuccessfulToolCallOutcome,
  type ToolResultOutcomeProjection,
} from '../../shared/contracts/tool-call-outcome.js';
import { isRecord } from '../../shared/utils/types.js';

const IMAGE_ATTACHMENT_CLAIM_PATTERNS = [
  {
    pattern: /(?:^|\n)\s*(?:\*{1,3}|_{1,3})\s*(?:image|photo|selfie)\s+(?:is\s+)?attached\s*(?:\*{1,3}|_{1,3})(?=\s|$)/iu,
    healing: 'marker',
  },
  {
    pattern: /(?:^|\n)\s*\[(?:image|photo|selfie)\s+(?:is\s+)?attached\](?=\s|$)/iu,
    healing: 'marker',
  },
  {
    pattern: /(?:^|[.!?]\s+)\s*here(?:'s| is)\s+(?:(?:(?:the|your|my|an?)\s+)?attached\s+(?:image|photo|selfie)(?!\s+(?:prompt|description|instructions?|caption|concept|idea|brief|analysis|text)\b)|(?:(?:the|your|my|an?)\s+)?(?:image|photo|selfie)(?=\s*(?:[.!?]|$)|\s+(?:below|here|for you)\b))/iu,
    healing: 'sentence',
  },
  {
    pattern: /(?:^|[.!?]\s+)\s*attached\s+is\s+(?:(?:the|your|my|an?)\s+)?(?:image|photo|selfie)(?!\s+(?:prompt|description|instructions?|caption|concept|idea|brief|analysis|text)\b)/iu,
    healing: 'sentence',
  },
  {
    pattern: /(?:^|[.!?]\s+)\s*(?:your|the|my|an?)\s+(?:image|photo|selfie)\s+is\s+attached(?:\s+(?:below|here))?\b/iu,
    healing: 'sentence',
  },
  {
    pattern: /(?:^|[.!?]\s+)\s*(?:please\s+)?(?:see|find|view|open)\s+(?:(?:the|your|my|an?)\s+)?attached\s+(?:image|photo|selfie)(?!\s+(?:prompt|description|instructions?|caption|concept|idea|brief|analysis|text)\b)/iu,
    healing: 'sentence',
  },
  {
    pattern: /(?:^|[.!?]\s+)\s*(?:(?:the|your|my|an?)\s+)?attached\s+(?:image|photo|selfie)(?!\s+(?:prompt|description|instructions?|caption|concept|idea|brief|analysis|text)\b)(?:\s+is)?\s+(?:below|here)\b/iu,
    healing: 'sentence',
  },
  {
    pattern: /(?:^|[.!?]\s+)\s*i(?:'ve| have)?\s+(?:attached|included|added)\s+(?:(?:an?|the|your|my)\s+)?(?:image|photo|selfie)(?!\s+(?:prompt|description|instructions?|caption|concept|idea|brief|analysis|text|yesterday|earlier|last\s+(?:night|week|month|year)|in\s+(?:my|the)\s+(?:previous|prior|last)\s+message))(?:\s+(?:below|here|with this message))?\b/iu,
    healing: 'sentence',
  },
] as const;

const IMAGE_ATTACHMENT_MARKER_REMOVAL_PATTERNS = [
  /[\t ]?(?:\*{1,3}|_{1,3})\s*(?:image|photo|selfie)\s+(?:is\s+)?attached\s*(?:\*{1,3}|_{1,3})(?=\s|$)/giu,
  /[\t ]?\[(?:image|photo|selfie)\s+(?:is\s+)?attached\](?=\s|$)/giu,
] as const;

export const MISSING_IMAGE_ATTACHMENT_CORRECTION =
  'I could not attach an image because no image tool completed successfully this turn. '
  + 'I need to call selfie_create or generate_image before saying an image is attached.';

const IMAGE_EDIT_TOOL_NAMES = new Set([
  'generate_image',
  'media',
  'image_edit',
]);

const IMAGE_EDIT_ACTION = String.raw`(?:edit|modify|retouch|crop|resize|remove|replace|change|adjust|make)`;
const IMAGE_EDIT_REQUEST_MARKER = new RegExp(
  String.raw`(?:\b(?:please|can you|could you|would you|will you|i (?:want|need|would like) you to)\b|^\s*${IMAGE_EDIT_ACTION}\b)`,
  'iu',
);
const IMAGE_EDIT_ACTION_PATTERN = new RegExp(String.raw`\b${IMAGE_EDIT_ACTION}\b`, 'iu');
const NEGATED_IMAGE_EDIT_PATTERN = new RegExp(
  String.raw`\b(?:do not|don't|not asking you to|no need to)\s+(?:\w+\s+){0,2}${IMAGE_EDIT_ACTION}\b`,
  'iu',
);
const IMAGE_EDIT_INSTRUCTION_REQUEST_PATTERN =
  /\b(?:tell|explain|show)\s+me\s+how\s+to\b/iu;
const IMAGE_SUBJECT_PATTERN = /\b(?:image|photo|picture|selfie)\b/iu;

export const UNFULFILLED_IMAGE_EDIT_REQUEST_CORRECTION =
  'image_edit_execution_unconfirmed: I could not confirm that the requested image edit completed '
  + 'because no successful generate_image action="edit" result was recorded this turn.';

function isSuccessfulImageEditResult(result: ToolResultOutcomeProjection): boolean {
  if (!IMAGE_EDIT_TOOL_NAMES.has(result.toolName) || !isRecord(result.details)) {
    return false;
  }
  const imageResult = isRecord(result.details.mediaResult)
    ? result.details.mediaResult
    : isRecord(result.details.imageResult)
      ? result.details.imageResult
      : null;
  return imageResult?.mode === 'edit';
}

export function rejectsUnfulfilledImageEditRequest(input: {
  requestText: string;
  requestHasImageInput: boolean;
  turnMessages: readonly AgentMessage[];
}): boolean {
  const requestText = input.requestText.trim();
  const isWellFormedEditRequest = (
    IMAGE_EDIT_REQUEST_MARKER.test(requestText)
    && IMAGE_EDIT_ACTION_PATTERN.test(requestText)
    && (input.requestHasImageInput || IMAGE_SUBJECT_PATTERN.test(requestText))
    && !NEGATED_IMAGE_EDIT_PATTERN.test(requestText)
    && !IMAGE_EDIT_INSTRUCTION_REQUEST_PATTERN.test(requestText)
  );
  if (!isWellFormedEditRequest) return false;

  return !hasSuccessfulToolCallOutcome(
    input.turnMessages,
    isSuccessfulImageEditResult,
  );
}

export function rejectsMissingImageAttachmentClaim(input: {
  responseText: string;
  attachmentCount: number;
}): boolean {
  if (input.attachmentCount > 0) return false;
  return hasImageAttachmentClaim(input.responseText);
}

export function healMissingImageAttachmentClaim(responseText: string): string {
  const units = splitSentenceUnits(responseText);
  const healedUnits = units.map((unit) => {
    let healedUnit = unit;
    let removedClaim = false;

    while (hasImageAttachmentClaim(healedUnit)) {
      const sentenceClaim = IMAGE_ATTACHMENT_CLAIM_PATTERNS.some(
        claim => claim.healing === 'sentence' && claim.pattern.test(healedUnit),
      );
      if (sentenceClaim) {
        healedUnit = '';
        removedClaim = true;
        break;
      }

      const markerClaim = IMAGE_ATTACHMENT_CLAIM_PATTERNS.find(
        claim => claim.healing === 'marker' && claim.pattern.test(healedUnit),
      );
      if (!markerClaim) break;
      healedUnit = IMAGE_ATTACHMENT_MARKER_REMOVAL_PATTERNS.reduce(
        (text, pattern) => text.replace(pattern, ''),
        healedUnit,
      ).replace(/^[\t ]+/u, '');
      removedClaim = true;
    }

    if (removedClaim && healedUnit.trim().length === 0) {
      healedUnit = '';
    }
    return {
      responseText: healedUnit,
      removedEntireUnit: removedClaim && healedUnit.length === 0,
    };
  });

  const healedResponse = healedUnits.map(unit => unit.responseText).join('');
  if (hasImageAttachmentClaim(healedResponse)) return '';
  if (healedResponse.trim().length === 0) return '';
  const lastHealedUnit = healedUnits.at(-1);
  return lastHealedUnit?.removedEntireUnit === true ? healedResponse.trimEnd() : healedResponse;
}

function hasImageAttachmentClaim(responseText: string): boolean {
  return IMAGE_ATTACHMENT_CLAIM_PATTERNS.some(claim => claim.pattern.test(responseText));
}

function splitSentenceUnits(responseText: string): string[] {
  const units: string[] = [];
  let unitStart = 0;

  for (let index = 0; index < responseText.length; index += 1) {
    const character = responseText[index]!;
    const nextCharacter = responseText[index + 1] ?? '';
    const endsSentence = (
      (character === '.' || character === '!' || character === '?')
      && (index === responseText.length - 1 || /\s/u.test(nextCharacter))
    );
    const endsLine = character === '\n';
    if (!endsSentence && !endsLine) continue;

    let unitEnd = index + 1;
    if (endsSentence) {
      while (unitEnd < responseText.length && /\s/u.test(responseText[unitEnd] ?? '')) {
        unitEnd += 1;
      }
    }
    units.push(responseText.slice(unitStart, unitEnd));
    unitStart = unitEnd;
    index = unitEnd - 1;
  }

  if (unitStart < responseText.length) {
    units.push(responseText.slice(unitStart));
  }
  return units;
}
