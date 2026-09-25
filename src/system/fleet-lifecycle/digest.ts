import { createHash } from 'node:crypto';

import { isRecord } from '../../shared/utils/types.js';
import type { FleetLifecyclePlan } from './contracts.js';

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort()
      .filter(key => value[key] !== undefined)
      .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function digestFleetLifecyclePlan(plan: Omit<FleetLifecyclePlan, 'digest'>): string {
  return sha256Hex(`fleet-lifecycle-plan:v1\0${canonicalJson(plan)}`);
}
