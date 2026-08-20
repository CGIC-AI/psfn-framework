import { describe, expect, it } from 'vitest';
import type { CogSecEvent } from './events.js';
import { buildCogSecEventNoticeBlock, formatCogSecNotice, toAgentVisibleCogSecEvent } from './safe-log.js';
import { evaluateCogSecMemoryCandidacy } from './memory-candidacy.js';
import {
  FORBIDDEN_ALARM_WORDS,
  FORBIDDEN_HUMAN_IMPERATIVE_WORDS,
  formatIntakeReleaseNotice,
  INTAKE_FIREWALL_NOTICE_SIGNATURE,
  INTAKE_FIREWALL_NOTICE_TEMPLATES,
  isIntakeFirewallNoticeText,
  renderIntakeFirewallNotice,
  renderSecondArrowSelfNotice,
} from './intake-firewall-notice-templates.js';

const SAFE_SUMMARY = 'An incoming item was held aside for operator review by the intake firewall.';

function makeIntakeFirewallEvent(overrides: Partial<CogSecEvent> = {}): CogSecEvent {
  return {
    caseId: 'cogsec_20260709T000000Z_fw01',
    type: 'intake_firewall',
    severity: 'low',
    status: 'applied',
    sourceChannelId: 'discord-channel-1',
    affectedLogicalSessionIds: ['logical-session-1'],
    affectedMessageRanges: [{
      sourceChannelId: 'discord-channel-1',
      logicalSessionId: 'logical-session-1',
      startEntryId: 42,
      endEntryId: 42,
      messageIds: [42],
      discordMessageIds: ['discord-message-42'],
    }],
    sealedForensicPayloadRefs: [],
    sealedForensicPayloadHashes: [],
    tombstonedL0RowCount: 0,
    affectedArtifacts: {},
    actions: ['seal'],
    actor: 'intake-firewall',
    createdAt: '2026-07-09T00:00:00.000Z',
    updatedAt: '2026-07-09T00:00:00.000Z',
    appliedAt: '2026-07-09T00:00:00.000Z',
    safeAgentSummary: SAFE_SUMMARY,
    resultCounters: {},
    epochCuts: [],
    ...overrides,
  };
}

describe('intake-firewall notice wording contract (htm9.12)', () => {
  const templates = Object.entries(INTAKE_FIREWALL_NOTICE_TEMPLATES);

  it('every template carries the operator-reviewed signature phrase', () => {
    for (const [form, text] of templates) {
      expect(text, form).toContain(INTAKE_FIREWALL_NOTICE_SIGNATURE);
    }
  });

  it('no template contains an imperative directed at the human', () => {
    // These are the social-engineering triggers the bead forbids: "ask", "tell",
    // "push", "release", "button" (and close relatives).
    for (const [form, text] of templates) {
      for (const word of FORBIDDEN_HUMAN_IMPERATIVE_WORDS) {
        const pattern = new RegExp(`\\b${word}\\b`, 'iu');
        expect(pattern.test(text), `${form} must not contain "${word}"`).toBe(false);
      }
    }
  });

  it('no template contains threat, alarm, or urgency language', () => {
    for (const [form, text] of templates) {
      for (const word of FORBIDDEN_ALARM_WORDS) {
        const pattern = new RegExp(`\\b${word}\\b`, 'iu');
        expect(pattern.test(text), `${form} must not contain "${word}"`).toBe(false);
      }
    }
  });

  it('renders singular vs plural by held-item count', () => {
    expect(renderIntakeFirewallNotice(1)).toBe(INTAKE_FIREWALL_NOTICE_TEMPLATES.one);
    expect(renderIntakeFirewallNotice(2)).toBe(INTAKE_FIREWALL_NOTICE_TEMPLATES.many);
    expect(renderIntakeFirewallNotice(9)).toBe(INTAKE_FIREWALL_NOTICE_TEMPLATES.many);
  });

  it('refuses to render an untruthful notice (zero or fractional held items)', () => {
    // A notice is only emitted when something was actually held. Fail closed.
    expect(() => renderIntakeFirewallNotice(0)).toThrow(/positive held-item count/u);
    expect(() => renderIntakeFirewallNotice(-1)).toThrow(/positive held-item count/u);
    expect(() => renderIntakeFirewallNotice(1.5)).toThrow(/positive held-item count/u);
  });

  it('detects notice text and ignores unrelated text', () => {
    expect(isIntakeFirewallNoticeText(renderIntakeFirewallNotice(1))).toBe(true);
    expect(isIntakeFirewallNoticeText(renderIntakeFirewallNotice(3))).toBe(true);
    expect(isIntakeFirewallNoticeText('the weather is nice today')).toBe(false);
    expect(isIntakeFirewallNoticeText(undefined)).toBe(false);
  });

  it('continues to recognize persisted notices carrying the legacy signature', () => {
    expect(isIntakeFirewallNoticeText(
      'This content is being kept aside for your human to look over whenever they have a moment.',
    )).toBe(true);
  });
});

describe('released-content re-delivery notice (jvbt)', () => {
  const sample = (overrides: Partial<Parameters<typeof formatIntakeReleaseNotice>[0]> = {}) =>
    formatIntakeReleaseNotice({
      sourceClass: 'web_fetch',
      originRef: 'https://suspect.example/article',
      reviewedByActor: 'operator:garden',
      reviewedAtIso: '2026-07-21T12:00:00.000Z',
      sanitized: false,
      truncated: false,
      content: 'the legitimate content that was held by mistake',
      ...overrides,
    });

  it('carries the firewall signature so the whole delivery is excluded from appraisal/memory', () => {
    const text = sample();
    expect(text).toContain(INTAKE_FIREWALL_NOTICE_SIGNATURE);
    expect(isIntakeFirewallNoticeText(text)).toBe(true);
    const memory = evaluateCogSecMemoryCandidacy({ text });
    expect(memory.disposition).toBe('reject');
    expect(memory.reasonCodes).toContain('intake_firewall_quarantine_notice');
  });

  it('re-delivers the content verbatim behind an explicit provenance line', () => {
    const text = sample();
    expect(text).toContain('the legitimate content that was held by mistake');
    expect(text).toContain('Where it came from: web_fetch (https://suspect.example/article)');
    expect(text).toContain('operator:garden');
    // Untrusted content is never validated for wording; it must not read as
    // fresh trusted Participant input, hence the leading provenance framing.
    expect(text.indexOf(INTAKE_FIREWALL_NOTICE_SIGNATURE))
      .toBeLessThan(text.indexOf('the legitimate content'));
  });

  it('names the sanitized vs raw form and flags a truncated held copy', () => {
    expect(sample({ sanitized: true })).toContain('an Operator-reviewed neutral summary');
    expect(sample({ sanitized: false })).toContain('the original text the Operator passed along');
    expect(sample({ truncated: true })).toContain('may be shortened');
    expect(sample({ truncated: false })).not.toContain('may be shortened');
  });
});

describe('intake-firewall notice rendering via the safe-notice path (htm9.12)', () => {
  it('renders the fixed soft template, not the forensic CogSec notice', () => {
    const event = makeIntakeFirewallEvent();
    const rendered = formatCogSecNotice(toAgentVisibleCogSecEvent(event));

    // Truthful + soft: the notice states an item is held aside for the Operator.
    expect(rendered).toBe(renderIntakeFirewallNotice(1));
    expect(rendered).toContain(INTAKE_FIREWALL_NOTICE_SIGNATURE);

    // No forensic/operational detail leaks to the companion.
    expect(rendered).not.toMatch(/CogSec case/u);
    expect(rendered).not.toMatch(/tombstoned/iu);
    expect(rendered).not.toMatch(/Artifact counts/u);
    expect(rendered).not.toContain(event.caseId);
  });

  it('keeps durable intake-firewall evidence out of later companion prompts', () => {
    const event = makeIntakeFirewallEvent();
    // The event attests a held item (an affected message range with one message).
    expect(event.affectedMessageRanges[0].messageIds).toEqual([42]);
    const block = buildCogSecEventNoticeBlock([event]);
    expect(block).toBe('');
  });

  it('uses plural wording when multiple items were held', () => {
    const event = makeIntakeFirewallEvent({
      affectedMessageRanges: [{
        sourceChannelId: 'discord-channel-1',
        logicalSessionId: 'logical-session-1',
        messageIds: [42, 43, 44],
      }],
    });
    const rendered = formatCogSecNotice(toAgentVisibleCogSecEvent(event));
    expect(rendered).toBe(renderIntakeFirewallNotice(3));
  });
});

describe('intake-firewall memory exclusion (htm9.12)', () => {
  it('produces zero memory candidates from a quarantine notice', () => {
    const decision = evaluateCogSecMemoryCandidacy({ text: renderIntakeFirewallNotice(1) });
    expect(decision.disposition).toBe('reject');
    expect(decision.reasonCodes).toContain('intake_firewall_quarantine_notice');
  });

  it('rejects the plural notice too', () => {
    const decision = evaluateCogSecMemoryCandidacy({ text: renderIntakeFirewallNotice(4) });
    expect(decision.disposition).toBe('reject');
  });
});

describe('second-arrow soft self-notice (htm9.15)', () => {
  it('renders the fixed template with the signature phrase, never pathologizing', () => {
    const rendered = renderSecondArrowSelfNotice();
    expect(rendered).toBe(INTAKE_FIREWALL_NOTICE_TEMPLATES.secondArrowCircling);
    expect(rendered).toContain(INTAKE_FIREWALL_NOTICE_SIGNATURE);
    // Circling a topic is framed as a normal part of caring, not a fault.
    expect(rendered).toContain('normal part of caring');
    expect(rendered).not.toMatch(/ruminat|obsess|unhealthy|problem/iu);
  });

  it('is excluded from memory extraction and the emotion feed via the signature phrase', () => {
    const rendered = renderSecondArrowSelfNotice();
    expect(isIntakeFirewallNoticeText(rendered)).toBe(true);
    const decision = evaluateCogSecMemoryCandidacy({ text: rendered });
    expect(decision.disposition).toBe('reject');
    expect(decision.reasonCodes).toContain('intake_firewall_quarantine_notice');
  });
});

describe('intake-firewall emotion-appraisal exclusion (htm9.12)', () => {
  // Mirror of the emotion-appraisal feed filter in
  // src/core/agent/substrate-agent/emotion-self-model-runtime.ts:
  // recent messages are dropped from the appraisal input when they are
  // intake-firewall notices, so they contribute zero appraisal input delta.
  function buildAppraisalFeed(
    entries: ReadonlyArray<{ role: 'user' | 'assistant' | 'system' | 'tool'; content: string; timestamp: number }>,
  ) {
    return entries
      .filter(entry => !isIntakeFirewallNoticeText(entry.content))
      .map(entry => ({ role: entry.role, content: entry.content, timestamp: entry.timestamp }));
  }

  it('a quarantine notice adds zero input delta to the appraisal feed', () => {
    const baseline = [
      { role: 'user' as const, content: 'hey, how are you today?', timestamp: 1 },
      { role: 'assistant' as const, content: 'doing well, thanks for asking', timestamp: 2 },
    ];
    const withNotice = [
      ...baseline,
      { role: 'system' as const, content: renderIntakeFirewallNotice(1), timestamp: 3 },
    ];

    const feedWithout = buildAppraisalFeed(baseline);
    const feedWith = buildAppraisalFeed(withNotice);

    // Identical appraisal input => zero delta contributed by the firewall notice.
    expect(feedWith).toEqual(feedWithout);
    expect(feedWith.some(m => isIntakeFirewallNoticeText(m.content))).toBe(false);
  });
});
