export interface LifecycleVersionBump {
  authn?: boolean;
  authz?: boolean;
  binding?: boolean;
  grant?: boolean;
  policy?: boolean;
}

export interface LifecycleRevocation {
  kind: 'provider_subject' | 'contact_binding' | 'role_grant' | 'principal' | 'companion';
  resourceId: string;
}

export interface PreparedLifecycleMutation {
  affectedPrincipalIds: string[];
  bumps: ReadonlyMap<string, LifecycleVersionBump>;
  revocations: LifecycleRevocation[];
  companionReadd?: {
    companionId: string;
    priorVersion: number;
  };
  apply(
    authorityGeneration: number,
    companionLineage?: { lineageId: string; lineageGeneration: number },
  ): Promise<void>;
}

export class LifecycleMutationDenied extends Error {
  constructor(readonly reasonCode: string) {
    super('Fleet auth lifecycle transition denied');
    this.name = 'LifecycleMutationDenied';
  }
}

export function denyLifecycleMutation(reasonCode: string): never {
  throw new LifecycleMutationDenied(reasonCode);
}

export function requireOneLifecycleRow<T>(rows: T[], reasonCode: string): T {
  if (rows.length !== 1 || !rows[0]) denyLifecycleMutation(reasonCode);
  return rows[0];
}

export function mergeLifecycleBumps(
  entries: ReadonlyArray<[string, LifecycleVersionBump]>,
): ReadonlyMap<string, LifecycleVersionBump> {
  const merged = new Map<string, LifecycleVersionBump>();
  for (const [principalId, addition] of entries) {
    merged.set(principalId, { ...merged.get(principalId), ...addition });
  }
  return merged;
}
