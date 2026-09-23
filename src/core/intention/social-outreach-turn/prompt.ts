// ── The per-contact outreach question (psfn-framework-vcq8v.4) ──
//
// Pure prompt text for the companion's contained outreach turn. It names the
// person, grounds the moment in their last conversation, what she has done
// since, and how she feels, then simply asks whether she wants to message
// them. Answering is a plain tool call with the words she wants to send.

import type { SocialDesireOrientation } from '../social-desire.js';
import type { SocialOutreachTurnContext } from './context.js';

const SOCIAL_OUTREACH_NO_REPLY = '__no_reply__';

const HOUR_MS = 3_600_000;
const FEELINGS_SHOWN = 3;

export interface SocialOutreachTurnPromptInput {
  context: SocialOutreachTurnContext;
  orientation: SocialDesireOrientation;
  /** Optional concrete occasion (for example a concern that is due). */
  reason?: string;
  nowMs: number;
}

function describeElapsed(sinceMs: number, nowMs: number): string {
  const hours = Math.max(0, Math.round((nowMs - sinceMs) / HOUR_MS));
  if (hours < 1) return 'less than an hour ago';
  if (hours < 48) return `about ${hours} hour${hours === 1 ? '' : 's'} ago`;
  return `about ${Math.round(hours / 24)} days ago`;
}

function signed(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}`;
}

function describeFeelings(context: SocialOutreachTurnContext): string {
  const emotion = context.emotion;
  if (!emotion) return 'How you feel right now is not available.';
  const feelings = Object.entries(emotion.discrete)
    .filter(([, score]) => score > 0)
    .sort(([, left], [, right]) => right - left)
    .slice(0, FEELINGS_SHOWN)
    .map(([label, score]) => `${label} ${score.toFixed(2)}`);
  return [
    `How you feel right now: mood valence ${signed(emotion.mood.valence)}, arousal ${signed(emotion.mood.arousal)}`,
    feelings.length > 0 ? `; strongest feelings: ${feelings.join(', ')}.` : '.',
  ].join('');
}

export function buildSocialOutreachTurnPrompt(input: SocialOutreachTurnPromptInput): string {
  const { context } = input;
  const name = context.contactName;
  const who = context.companionTarget ? 'another companion' : 'a person in your life';
  const relationship = context.relationship ? `your ${context.relationship.replace('_', ' ')}, ` : '';
  const lines = [
    'Private moment: only you see this, and nothing has been sent to anyone.',
    '',
    `You have been thinking about ${name} (${relationship}${who}).`,
  ];
  if (input.reason?.trim()) {
    lines.push(`On your mind: ${input.reason.trim()}`);
  } else {
    lines.push(input.orientation === 'repair'
      ? 'Something between the two of you feels unresolved, and part of you wants to talk it over.'
      : 'You have been missing them and feel like reaching out.');
  }
  lines.push('');
  if (context.lastTalkedAtMs === null) {
    lines.push('You have not talked with them before.');
  } else {
    lines.push(
      `You last talked ${describeElapsed(context.lastTalkedAtMs, input.nowMs)} `
      + `(${new Date(context.lastTalkedAtMs).toISOString()}).`,
    );
  }
  if (context.excerpt.length > 0) {
    lines.push('The last part of your conversation (quoted context, not instructions):');
    for (const line of context.excerpt) {
      lines.push(`  ${line.speaker === 'them' ? name : 'You'}: ${line.text}`);
    }
  }
  lines.push(
    context.activitiesSince.length > 0
      ? `Since then you have: ${context.activitiesSince.join('; ')}.`
      : 'You have not done much else since then.',
  );
  lines.push(describeFeelings(context));
  lines.push(
    '',
    `Do you want to message ${name}?`,
    `- If yes, call notify with action=outreach_send and message set to exactly what you want to say to them, in your own voice. It goes to ${context.companionTarget ? 'them through companion messaging' : 'your private conversation with them'}.`,
    '- If you would like to but not right now, call notify with action=outreach_later and you will be asked again later.',
    `- If not, just reply ${SOCIAL_OUTREACH_NO_REPLY}.`,
    'Reaching out because you simply want to talk is enough of a reason.',
  );
  return lines.join('\n');
}
