import { describe, expect, it } from 'vitest';
import { extractContainerEnv, findContainer, findObject, parseManifest } from './verify-chart-render.js';

const MANIFEST = `---
apiVersion: v1
kind: ConfigMap
metadata:
  name: psfn-eidoverse-place-map
data:
  eidoverse-place-map.json: |
    {"schemaVersion":1,"worlds":{"demo-world":{"placeId":"eidoverse:demo-world","regions":{}}}}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: psfn-satellite-hub
spec:
  template:
    spec:
      containers:
        - name: satellite-hub
          env:
            - name: EIDOVERSE_MCP_ENABLED
              value: "true"
            - name: EIDOVERSE_MCP_ARGS_JSON
              value: '["--stdio"]'
            - name: EIDOVERSE_JOIN_TOKEN
              valueFrom:
                secretKeyRef:
                  name: psfn-app
                  key: EIDOVERSE_JOIN_TOKEN
          volumeMounts:
            - name: eidoverse-place-map
              mountPath: /app/config/eidoverse-place-map.json
              subPath: eidoverse-place-map.json
              readOnly: true
`;

describe('helm chart render extraction', () => {
  it('reads every rendered document', () => {
    expect(parseManifest(MANIFEST).map(object => object.kind)).toEqual(['ConfigMap', 'Deployment']);
  });

  it('keys the satellite-hub container environment by variable name', () => {
    const env = extractContainerEnv(MANIFEST, 'psfn-satellite-hub', 'satellite-hub');
    expect([...env.keys()].sort()).toEqual([
      'EIDOVERSE_JOIN_TOKEN',
      'EIDOVERSE_MCP_ARGS_JSON',
      'EIDOVERSE_MCP_ENABLED',
    ]);
    expect(env.get('EIDOVERSE_MCP_ENABLED')).toEqual({ value: 'true' });
    expect(env.get('EIDOVERSE_MCP_ARGS_JSON')).toEqual({ value: '["--stdio"]' });
  });

  it('reports a secret-backed credential without a literal value', () => {
    const token = extractContainerEnv(MANIFEST, 'psfn-satellite-hub', 'satellite-hub')
      .get('EIDOVERSE_JOIN_TOKEN');
    expect(token?.value).toBeUndefined();
    expect(token?.secretKeyRef).toEqual({ name: 'psfn-app', key: 'EIDOVERSE_JOIN_TOKEN' });
  });

  it('fails closed when the expected container is absent', () => {
    expect(() => extractContainerEnv(MANIFEST, 'psfn-satellite-hub', 'missing')).toThrow(
      /no container missing/u,
    );
  });

  it('locates rendered objects and volume mounts by name', () => {
    expect(findObject(MANIFEST, 'ConfigMap', 'psfn-eidoverse-place-map')).toBeDefined();
    expect(findObject(MANIFEST, 'ConfigMap', 'absent')).toBeUndefined();
    const container = findContainer(MANIFEST, 'psfn-satellite-hub', 'satellite-hub');
    expect(container?.volumeMounts).toHaveLength(1);
  });
});
