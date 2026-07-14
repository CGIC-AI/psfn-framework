import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type { IcpConversationCostBreakerEvent } from '../../../shared/telemetry/model-usage.js';

export type IcpCertificationArtifact =
  | {
    kind: 'agent_ready';
    companionId: string;
    postgresSchema: string;
    runtimeClass: string;
  }
  | {
    kind: 'availability';
    companionId: string;
    state: string;
  }
  | {
    kind: 'cost_decision';
    companionId: string;
    conversationId: string;
    model: string;
    outcome: IcpConversationCostBreakerEvent['outcome'];
    reason: IcpConversationCostBreakerEvent['reason'];
  }
  | {
    candidateId: string;
    companionId: string;
    deliveryDisposition?: string;
    kind: 'initiation';
    reasonCode?: string;
    source: string;
    status: string;
  }
  | {
    companionId: string;
    kind: 'garden_emergency_disable';
  }
  | {
    kind: 'harness_lifecycle';
    modelRequestCount: number;
    state: 'started' | 'stopped';
  };

/**
 * Content-free certification evidence. Keep this an explicit allow-list so
 * prompts, messages, private candidate reasons, and credentials cannot drift
 * into diagnostic artifacts when the harness grows.
 */
export class IcpCertificationArtifactRecorder {
  constructor(private readonly path: string) {}

  append(artifact: IcpCertificationArtifact): void {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify({
      schemaVersion: 1,
      timestampMs: Date.now(),
      ...artifact,
    })}\n`, 'utf8');
  }
}
