import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const workloadsTemplate = readFileSync(
  join(process.cwd(), 'deploy', 'helm', 'psfn', 'templates', 'workloads.yaml'),
  'utf8',
);

function deploymentTemplate(component: 'agent' | 'garden' | 'gateway'): string {
  const name = `name: {{ include "psfn.fullname" . }}-${component}`;
  const document = workloadsTemplate
    .split(/^---\s*$/mu)
    .find(candidate => candidate.includes('kind: Deployment') && candidate.includes(name));

  if (!document) {
    throw new Error(`Missing Helm Deployment template for ${component}`);
  }
  return document;
}

const sessionHmacSecretRef = [
  '- name: GATEWAY_SESSION_HMAC_KEY',
  'valueFrom:',
  'secretKeyRef:',
  'name: {{ include "psfn.appSecretName" . }}',
  'key: {{ .Values.secrets.keys.gatewaySessionHmacKey }}',
];

describe('Helm runtime secret wiring', () => {
  it.each(['gateway', 'agent'] as const)(
    'provides the keyed audit/session HMAC dependency to %s through a Secret reference',
    (component) => {
      const deployment = deploymentTemplate(component);
      for (const line of sessionHmacSecretRef) {
        expect(deployment).toContain(line);
      }
      expect(deployment.match(/- name: GATEWAY_SESSION_HMAC_KEY/gu)).toHaveLength(1);
      expect(deployment).not.toMatch(/- name: GATEWAY_SESSION_HMAC_KEY\s*\n\s*value:/u);
    },
  );

  it('does not broaden the session HMAC secret into the network-only Garden container', () => {
    expect(deploymentTemplate('garden')).not.toContain('GATEWAY_SESSION_HMAC_KEY');
  });
});
