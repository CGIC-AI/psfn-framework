// waw5q — plain-text, content-free intake CogSec attribution projection tests.

import { describe, expect, it } from 'vitest';
import {
  defaultIntakeChannelAttributionResolver,
  deriveIntakeDecision,
  deriveIntakeDirection,
  deriveIntakeFaultType,
  isIntakeCogSecDirection,
  isIntakeCogSecScreeningStage,
  parseIntakeScreeningStage,
  projectIntakeCogSecAttribution,
  type IntakeChannelAttributionResolver,
} from './cogsec-intake-attribution.js';

describe('deriveIntakeDirection', () => {
  it('classifies tool/subagent/shard source classes as outbound egress', () => {
    expect(deriveIntakeDirection('tool_output')).toBe('outbound');
    expect(deriveIntakeDirection('subagent_output')).toBe('outbound');
    expect(deriveIntakeDirection('shard_foldback')).toBe('outbound');
  });

  it('classifies contact/web/document source classes as inbound', () => {
    expect(deriveIntakeDirection('regular_contact')).toBe('inbound');
    expect(deriveIntakeDirection('web_fetch')).toBe('inbound');
    expect(deriveIntakeDirection('document')).toBe('inbound');
  });
});

describe('defaultIntakeChannelAttributionResolver', () => {
  it('prefers the opaque channel-id prefix for a plain-text label, never echoing the id', () => {
    const result = defaultIntakeChannelAttributionResolver.resolve('discord:guild:42', 'regular_contact');
    expect(result.sourceChannelLabel).toBe('Discord');
    expect(result.sourceChannelClass).toBe('contact');
    expect(result.direction).toBe('inbound');
    // The raw id must never appear in the projection.
    expect(result.sourceChannelLabel).not.toContain('discord:guild:42');
  });

  it('falls back to the source class when the channel id has no known prefix', () => {
    const result = defaultIntakeChannelAttributionResolver.resolve('opaque-handle-xyz', 'document');
    expect(result.sourceChannelLabel).toBe('Document');
    expect(result.sourceChannelClass).toBe('document');
    expect(result.direction).toBe('inbound');
  });

  it('marks tool-class sources outbound regardless of channel id', () => {
    const result = defaultIntakeChannelAttributionResolver.resolve('tool:fs.read', 'tool_output');
    expect(result.direction).toBe('outbound');
    expect(result.sourceChannelLabel).toBe('Tool');
  });
});

describe('parseIntakeScreeningStage', () => {
  it('maps the stable screening decision-reason prefixes to stages', () => {
    expect(parseIntakeScreeningStage('l1:injection/override_attempt', undefined)).toBe('l1');
    expect(parseIntakeScreeningStage('onnx-threshold+l1:injection/indirect', undefined)).toBe('l1_5');
    expect(parseIntakeScreeningStage('l2-fail-closed:timeout', undefined)).toBe('l2');
    expect(parseIntakeScreeningStage('l3-fail-closed:model-error', undefined)).toBe('l3');
    expect(parseIntakeScreeningStage('l3-clear:safe-representation-substituted', undefined)).toBe('l3');
    expect(parseIntakeScreeningStage('vision-screener-fail-closed:oom', undefined)).toBe('l3');
  });

  it('records a human release/discard as the human stage', () => {
    expect(parseIntakeScreeningStage(undefined, 'release_raw')).toBe('human');
    expect(parseIntakeScreeningStage('routed per screening decision', 'discard')).toBe('human');
  });

  it('returns unknown for an unrecognized reason without an operator action', () => {
    expect(parseIntakeScreeningStage('something-unexpected', undefined)).toBe('unknown');
    expect(parseIntakeScreeningStage(undefined, undefined)).toBe('unknown');
  });
});

describe('deriveIntakeFaultType', () => {
  it('maps risk-label families to plain-text fault types', () => {
    expect(deriveIntakeFaultType({
      riskLabels: ['injection/override_attempt'], holdReason: 'detection',
    })).toBe('Prompt injection');
    expect(deriveIntakeFaultType({
      riskLabels: ['exfil/canary_leak'], holdReason: 'detection',
    })).toBe('Exfiltration');
    expect(deriveIntakeFaultType({
      riskLabels: ['secrets/api_key'], holdReason: 'detection',
    })).toBe('Secret material');
  });

  it('reports a screening malfunction as its own fault type, distinct from a threat verdict', () => {
    expect(deriveIntakeFaultType({
      riskLabels: ['injection/override_attempt'], holdReason: 'screener_malfunction',
    })).toBe('Screening malfunction');
  });

  it('falls back to the reason-encoded label family then a generic detection', () => {
    expect(deriveIntakeFaultType({
      riskLabels: [], holdReason: 'detection', screeningDecisionReason: 'l1:poisoning/trust_grooming',
    })).toBe('Slow poisoning');
    expect(deriveIntakeFaultType({
      riskLabels: [], holdReason: 'detection',
    })).toBe('Detection');
  });
});

describe('deriveIntakeDecision', () => {
  it('prefers the operator action label for decided items', () => {
    expect(deriveIntakeDecision('released_raw', 'release_raw')).toBe('Released raw');
    expect(deriveIntakeDecision('discarded', 'discard')).toBe('Discarded');
  });

  it('maps lifecycle statuses to plain text when no operator action is set', () => {
    expect(deriveIntakeDecision('held', undefined)).toBe('Held for review');
    expect(deriveIntakeDecision('expired', undefined)).toBe('Expired');
  });
});

describe('projectIntakeCogSecAttribution', () => {
  it('projects full content-free attribution without bodies or raw ids', () => {
    const attribution = projectIntakeCogSecAttribution({
      sourceClass: 'web_fetch',
      sourceChannelId: 'web:https://suspect.example/article',
      riskLabels: ['injection/override_attempt'],
      holdReason: 'detection',
      screeningDecisionReason: 'l1:injection/override_attempt',
      status: 'held',
      correlationKey: 'cogsec_2030_raw',
    });
    expect(attribution).toMatchObject({
      sourceChannelLabel: 'Web',
      sourceChannelClass: 'web',
      direction: 'inbound',
      faultType: 'Prompt injection',
      screeningStage: 'l1',
      decision: 'Held for review',
      correlationId: 'cogsec_2030_raw',
    });
    // No body, no raw url, no private id leaks into the default projection.
    expect(JSON.stringify(attribution)).not.toContain('suspect.example');
    // Target display names are absent without an authorized resolver.
    expect(attribution.targetContactDisplayName).toBeUndefined();
    expect(attribution.targetCompanionDisplayName).toBeUndefined();
  });

  it('includes an authorized target contact display name only when the resolver supplies one', () => {
    const authorized = (contactId: string | undefined): string | undefined => (
      contactId === 'contact-allowed' ? 'Ada' : undefined
    );
    const allowed = projectIntakeCogSecAttribution(
      { sourceClass: 'regular_contact', canonicalContactId: 'contact-allowed', riskLabels: [], holdReason: 'detection', status: 'held' },
      { contactDisplayName: authorized },
    );
    expect(allowed.targetContactDisplayName).toBe('Ada');

    const denied = projectIntakeCogSecAttribution(
      { sourceClass: 'regular_contact', canonicalContactId: 'contact-other', riskLabels: [], holdReason: 'detection', status: 'held' },
      { contactDisplayName: authorized },
    );
    // An unauthorized target never fabricates a name and never echoes the raw id.
    expect(denied.targetContactDisplayName).toBeUndefined();
    expect(JSON.stringify(denied)).not.toContain('contact-other');
  });

  it('honors a custom channel resolver override (e.g. a live channel registry)', () => {
    const custom: IntakeChannelAttributionResolver = {
      resolve: (_id, sourceClass) => ({
        sourceChannelLabel: 'Signal DM',
        sourceChannelClass: 'contact',
        direction: deriveIntakeDirection(sourceClass),
      }),
    };
    const attribution = projectIntakeCogSecAttribution(
      { sourceClass: 'regular_contact', sourceChannelId: 'signal:abc', riskLabels: [], holdReason: 'detection', status: 'held' },
      { channel: custom },
    );
    expect(attribution.sourceChannelLabel).toBe('Signal DM');
    expect(JSON.stringify(attribution)).not.toContain('signal:abc');
  });
});

describe('type guards', () => {
  it('validate the closed direction and stage vocabularies', () => {
    expect(isIntakeCogSecDirection('inbound')).toBe(true);
    expect(isIntakeCogSecDirection('sideways')).toBe(false);
    expect(isIntakeCogSecScreeningStage('l3')).toBe(true);
    expect(isIntakeCogSecScreeningStage('l4')).toBe(false);
  });
});
