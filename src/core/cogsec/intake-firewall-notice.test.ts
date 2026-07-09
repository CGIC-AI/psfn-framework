import { describe, expect, it } from 'vitest';
import type { CogSecEvent } from './events.js';
import { buildCogSecEventNoticeBlock, formatCogSecNotice, toAgentVisibleCogSecEvent } from './safe-log.js';
import { evaluateCogSecMemoryCandidacy } from './memory-candidacy.js';
import {
  FORBIDDEN_ALARM_WORDS,
  FORBIDDEN_HUMAN_IMPERATIVE_WORDS,
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
});

describe('intake-firewall notice rendering via the safe-notice path (htm9.12)', () => {
  it('renders the fixed soft template, not the forensic CogSec notice', () => {
    const event = makeIntakeFirewallEvent();
    const rendered = formatCogSecNotice(toAgentVisibleCogSecEvent(event));

    // Truthful + soft: the notice states an item is held aside for the human.
    expect(rendered).toBe(renderIntakeFirewallNotice(1));
    expect(rendered).toContain(INTAKE_FIREWALL_NOTICE_SIGNATURE);

    // No forensic/operational detail leaks to the companion.
    expect(rendered).not.toMatch(/CogSec case/u);
    expect(rendered).not.toMatch(/tombstoned/iu);
    expect(rendered).not.toMatch(/Artifact counts/u);
    expect(rendered).not.toContain(event.caseId);
  });

  it('is truthful: it is only produced for an event that actually held an item', () => {
    const event = makeIntakeFirewallEvent();
    // The event attests a held item (an affected message range with one message).
    expect(event.affectedMessageRanges[0].messageIds).toEqual([42]);
    const block = buildCogSecEventNoticeBlock([event]);
    expect(block).toContain('<cogsec_notices>');
    expect(block).toContain(INTAKE_FIREWALL_NOTICE_SIGNATURE);
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
