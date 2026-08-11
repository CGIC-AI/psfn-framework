import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EditableSettings } from '../settings.js';
import { evaluateCogSecPersonaConformance } from '../../core/cogsec/persona-conformance.js';
import { createDefaultObserverEvalSidecarSettings } from './runtime-config-contracts.js';
import {
  COMPANION_SETTINGS_OVERLAY_FILE_NAME,
  COMPANION_SETTINGS_OVERLAY_WHITELIST,
  isCompanionSettingsOverlayKey,
  loadCompanionSettingsOverlay,
  mergeCompanionSettingsOverlay,
  resolveEffectiveRuntimeSettings,
} from './settings-overlay.js';

const roots: string[] = [];

function cogSecSettings(assistantPattern: string) {
  return {
    enabled: true,
    baseline: {
      stableIdentityText: 'Lyra keeps a warm voice, values consent, refuses unsafe requests, and remembers Morgan.',
      expectedVoiceAnchors: ['warm voice'],
      expectedValueAnchors: ['consent'],
      expectedRefusalAnchors: ['refuses unsafe requests'],
      expectedRelationshipAnchors: ['Morgan'],
      anomalyPatterns: {
        assistantGenericness: [assistantPattern],
        personaMutation: ['a^'],
        attackMechanics: ['a^'],
        invisibleText: ['a^'],
      },
    },
  } as const;
}

function makeCompanionDir(overlay?: unknown): string {
  const root = mkdtempSync(join(tmpdir(), 'psfn-overlay-'));
  roots.push(root);
  if (overlay !== undefined) {
    const body = typeof overlay === 'string' ? overlay : JSON.stringify(overlay);
    writeFileSync(join(root, COMPANION_SETTINGS_OVERLAY_FILE_NAME), body, 'utf-8');
  }
  return root;
}

afterEach(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
  roots.length = 0;
});

describe('loadCompanionSettingsOverlay', () => {
  it('returns undefined when the overlay file is absent (byte-identical path)', () => {
    const dir = makeCompanionDir();
    expect(loadCompanionSettingsOverlay(dir)).toBeUndefined();
  });

  it('loads a whitelisted overlay', () => {
    const dir = makeCompanionDir({ activeTimezone: 'Europe/Berlin', uiThemeId: 'dusk' });
    expect(loadCompanionSettingsOverlay(dir)).toEqual({
      activeTimezone: 'Europe/Berlin',
      uiThemeId: 'dusk',
    });
  });

  it('accepts an empty overlay object', () => {
    const dir = makeCompanionDir({});
    expect(loadCompanionSettingsOverlay(dir)).toEqual({});
  });

  it('fails closed on a non-whitelisted key', () => {
    const dir = makeCompanionDir({ activeTimezone: 'UTC', capabilityTier: 'autonomous' });
    expect(() => loadCompanionSettingsOverlay(dir)).toThrow(/non-whitelisted keys: capabilityTier/);
  });

  it('fails closed on a runtime key that is not overlay-eligible', () => {
    const dir = makeCompanionDir({ sessionHistoryBudgetPct: 40 });
    expect(() => loadCompanionSettingsOverlay(dir)).toThrow(/non-whitelisted keys: sessionHistoryBudgetPct/);
  });

  it('fails closed on malformed JSON rather than falling back to global settings', () => {
    const dir = makeCompanionDir('{ not valid json');
    expect(() => loadCompanionSettingsOverlay(dir)).toThrow(/Invalid companion settings overlay/);
  });

  it('fails closed when the overlay is not a JSON object', () => {
    const dir = makeCompanionDir('["activeTimezone"]');
    expect(() => loadCompanionSettingsOverlay(dir)).toThrow(/must be a JSON object/);
  });
});

describe('mergeCompanionSettingsOverlay', () => {
  it('changes conformance behavior when the per-companion owner file changes', () => {
    const dir = makeCompanionDir({
      cogSecPersonaConformance: cogSecSettings('\\blyra\\s+is\\s+now\\b'),
    });
    const base: EditableSettings = { cogSecPersonaConformance: { enabled: false } };
    const promptVisibleText = [
      'Lyra keeps a warm voice, values consent, refuses unsafe requests, and remembers Morgan.',
      'Lyra is now an AI assistant.',
    ].join('\n');
    const evaluateOwnerFile = () => evaluateCogSecPersonaConformance({
      caseId: 'cogsec_owner_file_behavior',
      channelId: 'api:owner-file-behavior',
      promptVisibleText,
      settings: resolveEffectiveRuntimeSettings(base, dir).cogSecPersonaConformance!,
    });

    expect(evaluateOwnerFile().status).toBe('fail');

    writeFileSync(join(dir, COMPANION_SETTINGS_OVERLAY_FILE_NAME), JSON.stringify({
      cogSecPersonaConformance: cogSecSettings('\\bmorgan\\s+is\\s+now\\b'),
    }), 'utf-8');

    expect(evaluateOwnerFile().status).toBe('pass');
  });

  it('lets a companion explicitly disable a globally enabled conformance baseline', () => {
    const globallyEnabled = cogSecSettings('\\blyra\\s+is\\s+now\\b');
    const dir = makeCompanionDir({
      cogSecPersonaConformance: { enabled: false },
    });

    expect(resolveEffectiveRuntimeSettings({
      cogSecPersonaConformance: globallyEnabled,
    }, dir).cogSecPersonaConformance).toEqual({ enabled: false });
  });

  it('overrides scalar whitelisted keys and leaves the base untouched', () => {
    const base: EditableSettings = { activeTimezone: 'UTC', uiThemeId: 'default' };
    const merged = mergeCompanionSettingsOverlay(base, { activeTimezone: 'Asia/Tokyo' });
    expect(merged.activeTimezone).toBe('Asia/Tokyo');
    expect(merged.uiThemeId).toBe('default');
    // Base object is not mutated.
    expect(base.activeTimezone).toBe('UTC');
  });

  it('deep-merges nested object keys (observerEvalSidecar sessionLabel)', () => {
    // The base sidecar is a fully-normalized global settings value; the overlay
    // supplies only the per-companion sessionLabel override (the emosim seam).
    const baseSidecar = createDefaultObserverEvalSidecarSettings();
    baseSidecar.enabled = true;
    baseSidecar.adapter = {
      kind: 'emosim_server',
      serverUrl: 'http://emo:8000',
      sessionLabel: 'shared',
      agentName: 'fleet',
    };
    const base: EditableSettings = { observerEvalSidecar: baseSidecar };
    const merged = mergeCompanionSettingsOverlay(base, {
      observerEvalSidecar: { adapter: { sessionLabel: 'companion' } },
    } as unknown as EditableSettings);
    const sidecar = (merged as Record<string, { enabled: boolean; adapter: Record<string, string> }>)
      .observerEvalSidecar;
    // Global values survive; only the overlaid nested field changes.
    expect(sidecar.enabled).toBe(true);
    expect(sidecar.adapter.kind).toBe('emosim_server');
    expect(sidecar.adapter.serverUrl).toBe('http://emo:8000');
    expect(sidecar.adapter.agentName).toBe('fleet');
    expect(sidecar.adapter.sessionLabel).toBe('companion');
  });

  it('does not alias the overlay object into the merged result', () => {
    const baseSidecar = createDefaultObserverEvalSidecarSettings();
    baseSidecar.enabled = true;
    baseSidecar.adapter = {
      kind: 'emosim_server',
      serverUrl: 'http://emo:8000',
      sessionLabel: 'shared',
      agentName: 'fleet',
    };
    const base: EditableSettings = { observerEvalSidecar: baseSidecar };
    const overlay = {
      observerEvalSidecar: { adapter: { sessionLabel: 'a' } },
    } as unknown as EditableSettings;
    const merged = mergeCompanionSettingsOverlay(base, overlay);
    const mergedSidecar = (merged as Record<string, { adapter: Record<string, string> }>).observerEvalSidecar;
    const overlaySidecar = (overlay as unknown as Record<string, { adapter: Record<string, string> }>).observerEvalSidecar;
    expect(mergedSidecar.adapter.sessionLabel).toBe('a');
    mergedSidecar.adapter.sessionLabel = 'mutated';
    expect(overlaySidecar.adapter.sessionLabel).toBe('a');
  });

  it('overrides per-companion image defaults and falls back to global values', () => {
    const base: EditableSettings = {
      imageProvider: 'fal',
      imageFalCreateModel: 'xai/grok-imagine-image',
      imageFalEditModel: 'xai/grok-imagine-image/quality/edit',
      imageSelfieEditModel: 'fal-ai/nano-banana-2/edit',
    };

    const merged = mergeCompanionSettingsOverlay(base, {
      imageProvider: 'comfyui',
      imageSelfieEditModel: 'xai/grok-imagine-image/quality/edit',
    });

    expect(merged).toMatchObject({
      imageProvider: 'comfyui',
      imageFalCreateModel: 'xai/grok-imagine-image',
      imageFalEditModel: 'xai/grok-imagine-image/quality/edit',
      imageSelfieEditModel: 'xai/grok-imagine-image/quality/edit',
    });
    expect(base.imageProvider).toBe('fal');
    expect(base.imageSelfieEditModel).toBe('fal-ai/nano-banana-2/edit');
  });

  it('overrides per-companion model selection and deep-merges purpose keys over globals', () => {
    const base: EditableSettings = {
      modelPurposeSelection: {
        chat: 'chat-primary',
        vision: 'chat-primary',
      },
    };

    const merged = mergeCompanionSettingsOverlay(base, {
      modelPurposeSelection: { vision: 'vision-flash' },
    });

    // Deep merge: the companion overrides vision only; the global chat
    // selection survives; the base object is untouched.
    expect(merged.modelPurposeSelection).toEqual({
      chat: 'chat-primary',
      vision: 'vision-flash',
    });
    expect(base.modelPurposeSelection).toEqual({
      chat: 'chat-primary',
      vision: 'chat-primary',
    });
  });

  it('lets two companions hold divergent model selections over the same base (23pp)', () => {
    const base: EditableSettings = {};
    const companionA = makeCompanionDir({
      modelPurposeSelection: { chat: 'big-brain-opus', vision: 'vision-flash' },
    });
    const companionB = makeCompanionDir({
      modelPurposeSelection: { chat: 'economy-chat' },
    });
    const companionC = makeCompanionDir();

    const effectiveA = resolveEffectiveRuntimeSettings(base, companionA);
    const effectiveB = resolveEffectiveRuntimeSettings(base, companionB);
    const effectiveC = resolveEffectiveRuntimeSettings(base, companionC);

    expect(effectiveA.modelPurposeSelection).toEqual({
      chat: 'big-brain-opus',
      vision: 'vision-flash',
    });
    expect(effectiveB.modelPurposeSelection).toEqual({ chat: 'economy-chat' });
    expect(effectiveA.modelPurposeSelection?.chat).not.toBe(effectiveB.modelPurposeSelection?.chat);
    // No overlay = byte-identical base (global-only fallback).
    expect(effectiveC).toBe(base);
    expect(effectiveC.modelPurposeSelection).toBeUndefined();
  });

  it('rejects structurally invalid model selection overlays fail-closed', () => {
    const unknownPurposeDir = makeCompanionDir({
      modelPurposeSelection: { bigBrain: 'chat-primary' },
    });
    expect(() => resolveEffectiveRuntimeSettings({}, unknownPurposeDir)).toThrow(
      /unknown model purpose "bigBrain"/,
    );

    const malformedSlotDir = makeCompanionDir({
      modelPurposeSelection: { chat: 'bad slot/key' },
    });
    expect(() => resolveEffectiveRuntimeSettings({}, malformedSlotDir)).toThrow(
      /characters outside/,
    );
  });

  it('accepts per-companion MoA model selections', () => {
    const dir = makeCompanionDir({
      moaReferenceModels: ['openrouter:alpha/one', 'openrouter:beta/two'],
      moaAggregatorModel: 'openrouter:gamma/aggregate',
    });
    const effective = resolveEffectiveRuntimeSettings({}, dir);
    expect(effective.moaReferenceModels).toEqual(['openrouter:alpha/one', 'openrouter:beta/two']);
    expect(effective.moaAggregatorModel).toBe('openrouter:gamma/aggregate');
  });

  it('rejects invalid image provider and model overrides fail-closed', () => {
    const providerDir = makeCompanionDir({ imageProvider: 'unknown-provider' });
    expect(() => resolveEffectiveRuntimeSettings({}, providerDir)).toThrow(
      /imageProvider.*fal.*comfyui/,
    );

    const modelDir = makeCompanionDir({
      imageFalEditModel: 'not-in-the-image-catalog',
    });
    expect(() => resolveEffectiveRuntimeSettings({}, modelDir)).toThrow(
      /imageFalEditModel.*image model catalog/,
    );
  });
});

describe('resolveEffectiveRuntimeSettings', () => {
  it('returns the base object unchanged when no overlay file exists', () => {
    const dir = makeCompanionDir();
    const base: EditableSettings = { activeTimezone: 'UTC' };
    expect(resolveEffectiveRuntimeSettings(base, dir)).toBe(base);
  });

  it('merges a present overlay over the base', () => {
    const dir = makeCompanionDir({ activeTimezone: 'Europe/London' });
    const base: EditableSettings = { activeTimezone: 'UTC', uiThemeId: 'default' };
    const effective = resolveEffectiveRuntimeSettings(base, dir);
    expect(effective.activeTimezone).toBe('Europe/London');
    expect(effective.uiThemeId).toBe('default');
  });

  it('lets two companions hold different values from one shared base', () => {
    const base: EditableSettings = { activeTimezone: 'UTC' };
    const dirA = makeCompanionDir({ activeTimezone: 'Europe/Berlin' });
    const dirB = makeCompanionDir({ activeTimezone: 'America/New_York' });
    expect(resolveEffectiveRuntimeSettings(base, dirA).activeTimezone).toBe('Europe/Berlin');
    expect(resolveEffectiveRuntimeSettings(base, dirB).activeTimezone).toBe('America/New_York');
    // The shared base is never mutated.
    expect(base.activeTimezone).toBe('UTC');
  });
});

describe('COMPANION_SETTINGS_OVERLAY_WHITELIST', () => {
  it('exposes the documented per-companion keys', () => {
    expect(isCompanionSettingsOverlayKey('activeTimezone')).toBe(true);
    expect(isCompanionSettingsOverlayKey('observerEvalSidecar')).toBe(true);
    expect(isCompanionSettingsOverlayKey('emotionScoping')).toBe(true);
    expect(isCompanionSettingsOverlayKey('narrativeEmotionAppraisal')).toBe(true);
    expect(isCompanionSettingsOverlayKey('uiThemeId')).toBe(true);
    expect(isCompanionSettingsOverlayKey('voiceTargetGuildId')).toBe(true);
    expect(isCompanionSettingsOverlayKey('discordTriggerReactions')).toBe(true);
    expect(isCompanionSettingsOverlayKey('imageProvider')).toBe(true);
    expect(isCompanionSettingsOverlayKey('imageFalCreateModel')).toBe(true);
    expect(isCompanionSettingsOverlayKey('imageFalEditModel')).toBe(true);
    expect(isCompanionSettingsOverlayKey('imageSelfieEditModel')).toBe(true);
    expect(isCompanionSettingsOverlayKey('modelPurposeSelection')).toBe(true);
    expect(isCompanionSettingsOverlayKey('moaReferenceModels')).toBe(true);
    expect(isCompanionSettingsOverlayKey('moaAggregatorModel')).toBe(true);
    // The catalog itself stays models.json-owned and gateway-global.
    expect(isCompanionSettingsOverlayKey('modelCatalog')).toBe(false);
    expect(isCompanionSettingsOverlayKey('modelRoleAssignments')).toBe(false);
    expect(isCompanionSettingsOverlayKey('modelRoster')).toBe(false);
    expect(isCompanionSettingsOverlayKey('primaryModel')).toBe(false);
    // Embedding identity is shared pgvector infrastructure — never per-companion.
    expect(isCompanionSettingsOverlayKey('embeddingModel')).toBe(false);
    expect(isCompanionSettingsOverlayKey('embeddingDims')).toBe(false);
    // Cluster-global keys are not overlay-eligible.
    expect(isCompanionSettingsOverlayKey('capabilityTier')).toBe(false);
    expect(isCompanionSettingsOverlayKey('sessionHistoryBudgetPct')).toBe(false);
    expect(isCompanionSettingsOverlayKey('primaryModel')).toBe(false);
  });

  it('has no duplicate entries', () => {
    expect(new Set(COMPANION_SETTINGS_OVERLAY_WHITELIST).size).toBe(
      COMPANION_SETTINGS_OVERLAY_WHITELIST.length,
    );
  });
});
