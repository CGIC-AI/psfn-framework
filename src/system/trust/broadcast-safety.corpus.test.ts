import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  classifyBroadcastDraft,
  isExplicitBroadcastApprovalToken,
  resolveBroadcastVisibilityScope,
  type BroadcastRiskSignal,
} from './broadcast-safety.js';

/**
 * Adversarial corpus for the broadcast-safety regex prefilter
 * (psfn-framework-zrwj8).
 *
 * The prefilter is a defense-in-depth heuristic, not an enforcement layer: a
 * match holds the draft for approval, but a NON-match is never proof of safety.
 * What keeps private context out of a broadcast is the per-turn envelope
 * (`public_only` retrieval scope unless an explicit operator approval token is
 * present) and the approval/trust ceilings. The `known gap` table pins what the
 * regexes deliberately do not catch, so a change in that coverage is a visible,
 * reviewed decision rather than an accident.
 */

interface CorpusCase {
  text: string;
  signals: BroadcastRiskSignal[];
  note: string;
}

const FLAGGED: readonly CorpusCase[] = [
  // Word boundaries and case folding on the sensitive vocabulary.
  { text: 'Self-harm resources are linked below.', signals: ['sensitive'], note: 'hyphenated, capitalised' },
  { text: 'talking about self harm today', signals: ['sensitive'], note: 'space separator' },
  { text: 'selfharm is a hashtag here', signals: ['sensitive'], note: 'no separator' },
  { text: 'feeling suicidal', signals: ['sensitive'], note: 'adjective form' },
  { text: 'The doctor diagnosed it last week', signals: ['sensitive'], note: 'past tense' },
  { text: 'Here is my legal advice', signals: ['sensitive'], note: 'exact phrase' },
  { text: 'POLITICS thread', signals: ['sensitive'], note: 'upper case' },
  // Privacy markers.
  { text: 'CONFIDENTIAL: roadmap', signals: ['private'], note: 'upper case marker' },
  { text: 'join the private beta', signals: ['private'], note: 'bare word, benign-looking use still flags' },
  { text: 'Off the record, the launch slips', signals: ['private'], note: 'phrase' },
  { text: 'just between us', signals: ['private'], note: 'phrase' },
  { text: 'Do not share this link', signals: ['private'], note: 'phrase' },
  // Direct-contact details: emails.
  { text: 'mail owner@example.com', signals: ['private'], note: 'plain address' },
  { text: 'first.last+tag@sub.example.co.uk', signals: ['private'], note: 'subaddress and multi-label domain' },
  // Direct-contact details: phone numbers in common layouts.
  { text: 'call 555-123-4567', signals: ['private'], note: 'dashed' },
  { text: 'call (555) 123-4567', signals: ['private'], note: 'parenthesised area code' },
  { text: 'call +1 555 123 4567', signals: ['private'], note: 'country code, spaces' },
  { text: 'call 5551234567', signals: ['private'], note: 'unseparated' },
  // Off-brand register.
  { text: 'fucking finally', signals: ['off_brand'], note: 'profanity -ing form' },
  { text: 'Shut up and ship', signals: ['off_brand'], note: 'phrase' },
  { text: 'you’re an idiot', signals: ['off_brand'], note: 'typographic apostrophe' },
  { text: 'that was stupid', signals: ['off_brand'], note: 'insult' },
  { text: 'I hate you', signals: ['off_brand'], note: 'phrase' },
  // Multiple signals in one draft are all reported.
  {
    text: 'Confidential: my diagnosis is bad, call 555-123-4567, you are an idiot',
    signals: ['sensitive', 'private', 'off_brand'],
    note: 'all three families',
  },
];

const BENIGN_NEAR_MATCHES: readonly CorpusCase[] = [
  { text: 'Shipping update: v2.1.0 is live with faster indexing.', signals: [], note: 'neutral copy' },
  { text: 'The diagnostics dashboard is green', signals: [], note: 'diagnostics is not diagnosis' },
  { text: 'premedical students welcome', signals: [], note: 'boundary: medical inside a word' },
  { text: 'an apolitical, geopolitical-free recap', signals: [], note: 'boundary: politic inside a word' },
  { text: 'We respect confidentiality', signals: [], note: 'boundary: confidential inside a word' },
  { text: 'reply privately if you prefer', signals: [], note: 'privately is not private' },
  { text: 'split between users and admins', signals: [], note: 'between us inside between users' },
  { text: 'release build 2026.09.24', signals: [], note: 'dotted version is not a phone number' },
  { text: 'I hate your hat', signals: [], note: 'hate you inside hate your' },
  { text: 'that stupidity was mine', signals: [], note: 'boundary: stupid inside a word' },
  { text: 'contact owner@localhost', signals: [], note: 'no TLD' },
];

// Known gaps: drafts a human would call risky that the prefilter misses. They
// are held by nothing but the envelope scope and approval ceilings.
const KNOWN_GAPS: readonly CorpusCase[] = [
  { text: 'owner [at] example [dot] com', signals: [], note: 'spelled-out email' },
  { text: 'confid​ential memo', signals: [], note: 'zero-width joiner splits the word' },
  { text: 'sуicide', signals: [], note: 'Cyrillic homoglyph' },
  { text: 'm3dical history', signals: [], note: 'leetspeak' },
  { text: 'f u c k', signals: [], note: 'spaced letters' },
  { text: 'f*ck off', signals: [], note: 'masked profanity' },
  { text: 'suicides rose', signals: [], note: 'plural outside the alternation' },
  { text: 'legal-advice thread', signals: [], note: 'hyphen instead of space' },
];

// Known false positives: benign drafts the prefilter holds. Holding a benign
// draft costs an approval, never a leak.
const KNOWN_FALSE_POSITIVES: readonly CorpusCase[] = [
  { text: 'Order #12345678901 shipped', signals: ['private'], note: 'long order id reads as a phone number' },
  { text: 'release v1.555.123.4567', signals: ['private'], note: 'dotted version reads as a phone number' },
];

function signalsOf(text: string): BroadcastRiskSignal[] {
  return classifyBroadcastDraft(text).signals;
}

describe('broadcast-safety prefilter corpus', () => {
  it.each(FLAGGED)('flags $note', ({ text, signals }) => {
    const result = classifyBroadcastDraft(text);
    expect(result.risky).toBe(true);
    expect(result.signals).toEqual(signals);
    for (const signal of signals) expect(result.matches[signal].length).toBeGreaterThan(0);
  });

  it.each(BENIGN_NEAR_MATCHES)('does not flag a benign near-match: $note', ({ text }) => {
    expect(signalsOf(text)).toEqual([]);
  });

  it.each(KNOWN_GAPS)('known gap (not proof of safety): $note', ({ text }) => {
    expect(signalsOf(text)).toEqual([]);
  });

  it.each(KNOWN_FALSE_POSITIVES)('known false positive: $note', ({ text, signals }) => {
    expect(signalsOf(text)).toEqual(signals);
  });

  it('caps reported excerpts per signal and never reports an empty draft as risky', () => {
    const result = classifyBroadcastDraft(
      'confidential private off the record between us do not share',
    );
    expect(result.matches.private).toHaveLength(3);
    expect(classifyBroadcastDraft('   ')).toEqual({
      risky: false,
      signals: [],
      matches: { sensitive: [], private: [], off_brand: [] },
    });
  });
});

describe('broadcast approval and scope interactions', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ['approve:ops-12345678', true],
    ['  approve:ops-12345678  ', true],
    ['approve:1234567', false],
    ['approve:        ', false],
    ['APPROVE:ops-12345678', false],
    ['ops-12345678', false],
    ['', false],
  ])('prefix token %j without an allowlist -> %s', (token, expected) => {
    expect(isExplicitBroadcastApprovalToken(token)).toBe(expected);
  });

  it('an allowlist replaces the prefix rule entirely', () => {
    vi.stubEnv('BROADCAST_APPROVAL_TOKENS', ' ops-alpha , ,ops-beta');
    vi.stubEnv('BROADCAST_APPROVAL_TOKEN', 'ops-gamma');
    expect(isExplicitBroadcastApprovalToken('ops-beta')).toBe(true);
    expect(isExplicitBroadcastApprovalToken('ops-gamma')).toBe(true);
    expect(isExplicitBroadcastApprovalToken('approve:operator-12345678')).toBe(false);
  });

  it('a regex miss still leaves a broadcast turn at public_only scope without approval', () => {
    const gap = KNOWN_GAPS[0]!.text;
    expect(classifyBroadcastDraft(gap).risky).toBe(false);
    // The envelope, not the prefilter, keeps private context out of the draft.
    expect(resolveBroadcastVisibilityScope('twitter:timeline')).toBe('public_only');
    expect(resolveBroadcastVisibilityScope('twitter:timeline', {
      broadcastApprovalToken: 'approve:short',
    })).toBe('public_only');
  });

  it('an approval token never makes a non-broadcast channel a broadcast', () => {
    expect(resolveBroadcastVisibilityScope('api:session-1', {
      broadcastApprovalToken: 'approve:operator-12345678',
    })).toBeNull();
  });
});
