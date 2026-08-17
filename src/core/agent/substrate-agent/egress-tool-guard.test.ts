import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Type } from '@sinclair/typebox';
import { describe, expect, it, vi } from 'vitest';
import type { IntakeEnvelopeSnapshot } from '../../../shared/contracts/intake-envelope.js';
import { validateIntakePolicy } from '../../../system/config/intake-policy-config.js';
import {
  createIntakeSinkGate,
  type IntakeSinkGateAuditEvent,
} from '../../cogsec/intake/sink-gates.js';
import { INTAKE_FIREWALL_NOTICE_TEMPLATES } from '../../cogsec/intake-firewall-notice-templates.js';
import { gateToolWithCapabilities } from '../../../system/capabilities/gate.js';
import { withCapabilityRequirement } from '../../../system/capabilities/requirements.js';
import { buildEgressToolGuard } from './egress-tool-guard.js';

const POLICY_SEED_PATH = join(process.cwd(), 'config', 'intake-policy.seed.json');

describe('buildEgressToolGuard', () => {
  it('attaches the active session identity to a hard trifecta block audit', () => {
    const seed = JSON.parse(readFileSync(POLICY_SEED_PATH, 'utf8')) as Record<string, unknown>;
    const auditEvents: IntakeSinkGateAuditEvent[] = [];
    const gate = createIntakeSinkGate({
      policy: validateIntakePolicy({ ...seed, mode: 'shadow' }, 'intake-policy.test'),
      actor: 'test:egress-tool-guard',
      onAudit: event => auditEvents.push(event),
    });
    const evaluate = vi.spyOn(gate, 'evaluate');
    const envelope: IntakeEnvelopeSnapshot = {
      envelopeId: '8b70243e',
      sourceClass: 'tool_output',
      sourceRiskTier: 'untrusted',
      state: 'quarantined',
      riskLabels: [],
      subject: { kind: 'body' },
    };
    const guard = buildEgressToolGuard({
      intakeSinkGate: gate,
      getActiveTurnIntakeEnvelopes: () => [envelope],
      getCurrentTurnDisclosureLineage: () => undefined,
      getActiveTurnSessionIdentity: () => ({
        sourceChannelId: 'discord:live-channel',
        logicalSessionId: 'discord:live-session',
      }),
    });

    const decision = guard?.evaluate({
      toolCallId: 'egress-call-1',
      toolName: 'fs',
      requiredTokens: ['repl.execute'],
      params: {},
    });

    expect(decision).toEqual({
      allowed: false,
      noticeText: INTAKE_FIREWALL_NOTICE_TEMPLATES.sinkHeld,
    });
    expect(evaluate).toHaveBeenCalledWith(
      'tool_egress',
      [envelope],
      { toolName: 'fs' },
      expect.objectContaining({
        attemptRef: 'egress-call-1',
        correlationRef: 'discord:live-session:fs',
      }),
    );
    expect(auditEvents.find(event => event.kind === 'egress_trifecta')?.context).toEqual(
      expect.objectContaining({
        toolName: 'fs',
        sourceChannelId: 'discord:live-channel',
        logicalSessionId: 'discord:live-session',
      }),
    );
  });

  it('returns the block notice and a diagnostic when durable incident recording fails', async () => {
    const seed = JSON.parse(readFileSync(POLICY_SEED_PATH, 'utf8')) as Record<string, unknown>;
    const execute = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'executed' }],
      details: {},
    });
    const gate = createIntakeSinkGate({
      policy: validateIntakePolicy({ ...seed, mode: 'shadow' }, 'intake-policy.test'),
      actor: 'test:egress-tool-guard',
      onBlockedEgressTrifecta: () => {
        throw new Error('incident store unavailable');
      },
    });
    const guard = buildEgressToolGuard({
      intakeSinkGate: gate,
      getActiveTurnIntakeEnvelopes: () => [{
        envelopeId: '8b70243e',
        sourceClass: 'tool_output',
        sourceRiskTier: 'untrusted',
        state: 'quarantined',
        riskLabels: [],
        subject: { kind: 'body' },
      }],
      getCurrentTurnDisclosureLineage: () => undefined,
      getActiveTurnSessionIdentity: () => ({
        sourceChannelId: 'discord:live-channel',
        logicalSessionId: 'discord:live-session',
      }),
    });
    const tool = withCapabilityRequirement({
      name: 'test_egress',
      label: 'test egress',
      description: 'egress guard test tool',
      parameters: Type.Object({}),
      execute,
    }, 'repl.execute');
    const granted = new Set(['repl.execute'] as const);
    const gated = gateToolWithCapabilities(
      tool,
      () => ({
        getTier: () => 'custom',
        getGrantedTokens: () => granted,
        has: token => granted.has(token as 'repl.execute'),
      }),
      () => guard,
    );

    const result = await gated.execute('call-id', {});

    expect(execute).not.toHaveBeenCalled();
    expect(result.content).toEqual([{
      type: 'text',
      text: INTAKE_FIREWALL_NOTICE_TEMPLATES.sinkHeld,
    }]);
    expect(result.details).toMatchObject({
      isError: true,
      egressGated: true,
      policyDenied: true,
      egressGuardDiagnostic: {
        code: 'intake_sink_gate_evaluation_failed',
      },
    });
  });
});
