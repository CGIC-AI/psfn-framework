import { describe, expect, it } from 'vitest';
import type { PendingClarification } from '../../boundary/gateway/protocol.js';
import { formatClarificationPrompt, parseClarificationReply } from './clarification.js';

const clarification: PendingClarification = {
  id: 'clar-1',
  question: 'Tea or coffee?',
  choices: ['Tea', 'Coffee', 'Water'],
};

describe('telegram clarification prompt', () => {
  it('renders the question with a 1-based numbered list and an instruction', () => {
    const prompt = formatClarificationPrompt(clarification);
    expect(prompt).toContain('Tea or coffee?');
    expect(prompt).toContain('1. Tea');
    expect(prompt).toContain('2. Coffee');
    expect(prompt).toContain('3. Water');
    expect(prompt).toContain('Reply with the number of your choice.');
  });
});

describe('parseClarificationReply', () => {
  it('parses a 1-based number to a 0-based index', () => {
    expect(parseClarificationReply(clarification, '1')).toBe(0);
    expect(parseClarificationReply(clarification, ' 2 ')).toBe(1);
    expect(parseClarificationReply(clarification, '3')).toBe(2);
  });

  it('parses the exact choice text (case-insensitive, trimmed)', () => {
    expect(parseClarificationReply(clarification, 'Coffee')).toBe(1);
    expect(parseClarificationReply(clarification, '  water ')).toBe(2);
    expect(parseClarificationReply(clarification, 'TEA')).toBe(0);
  });

  it('fails closed on ambiguous case-insensitive text while retaining numeric selection', () => {
    const ambiguous: PendingClarification = {
      ...clarification,
      choices: ['Tea', 'tea'],
    };

    expect(parseClarificationReply(ambiguous, 'tea')).toBeNull();
    expect(parseClarificationReply(ambiguous, '2')).toBe(1);
  });

  it('fails closed on an out-of-range number', () => {
    expect(parseClarificationReply(clarification, '0')).toBeNull();
    expect(parseClarificationReply(clarification, '4')).toBeNull();
    expect(parseClarificationReply(clarification, '99')).toBeNull();
  });

  it('fails closed on an unrecognized or empty reply', () => {
    expect(parseClarificationReply(clarification, 'banana')).toBeNull();
    expect(parseClarificationReply(clarification, '')).toBeNull();
    expect(parseClarificationReply(clarification, '   ')).toBeNull();
  });
});
