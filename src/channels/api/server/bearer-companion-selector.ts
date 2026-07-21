import type { ApiAuthPrincipal } from '../../backplane/http/auth.js';

export const BEARER_COMPANION_SELECTOR_HEADER = 'x-psfn-companion-id';

export interface BearerCompanionRoutingConfig {
  pinnedCompanionId: string;
  knownCompanionIds: readonly string[];
  /** Omission disables per-request selection while retaining pinned routing. */
  selectableCompanionIds?: readonly string[];
}

export function createBearerCompanionRoutingConfig(input: {
  pinnedCompanionId: string | undefined;
  knownCompanionIds: readonly string[];
  selectableCompanionIds: readonly string[] | undefined;
}): BearerCompanionRoutingConfig | undefined {
  if (!input.pinnedCompanionId) {
    if (input.selectableCompanionIds !== undefined) {
      throw new Error(
        'channels.json.api.selectableCompanionIds requires channels.json.api.companionId',
      );
    }
    return undefined;
  }
  if (!input.knownCompanionIds.includes(input.pinnedCompanionId)) {
    throw new Error(
      `Pinned Bearer companion ${input.pinnedCompanionId} is not present in the companion roster`,
    );
  }
  const unknownSelectable = input.selectableCompanionIds?.find(
    companionId => !input.knownCompanionIds.includes(companionId),
  );
  if (unknownSelectable) {
    throw new Error(
      `Selectable Bearer companion ${unknownSelectable} is not present in the companion roster`,
    );
  }
  return {
    pinnedCompanionId: input.pinnedCompanionId,
    knownCompanionIds: [...input.knownCompanionIds],
    ...(input.selectableCompanionIds !== undefined
      ? { selectableCompanionIds: [...input.selectableCompanionIds] }
      : {}),
  };
}

export type BearerCompanionTargetResolution =
  | { ok: true; companionId: string }
  | {
    ok: false;
    status: 400 | 403 | 404;
    type:
      | 'invalid_bearer_companion_selector'
      | 'bearer_companion_selector_disabled'
      | 'bearer_companion_not_found'
      | 'bearer_companion_unauthorized';
    message: string;
  };

export function resolveBearerCompanionTarget(input: {
  requestedCompanionId: string | undefined;
  principal: ApiAuthPrincipal;
  routing: BearerCompanionRoutingConfig;
}): BearerCompanionTargetResolution {
  const requestedCompanionId = input.requestedCompanionId;
  if (requestedCompanionId === undefined) {
    return { ok: true, companionId: input.routing.pinnedCompanionId };
  }
  if (!requestedCompanionId) {
    return {
      ok: false,
      status: 400,
      type: 'invalid_bearer_companion_selector',
      message: 'X-PSFN-Companion-ID must name one companion when provided',
    };
  }

  if (input.principal.mode !== 'api_key' || input.principal.scope !== undefined) {
    return {
      ok: false,
      status: 403,
      type: 'bearer_companion_unauthorized',
      message: 'Bearer/OpenAI-compatible companion selection requires an unscoped API-key principal',
    };
  }

  const selectableCompanionIds = input.routing.selectableCompanionIds;
  if (selectableCompanionIds === undefined) {
    return {
      ok: false,
      status: 403,
      type: 'bearer_companion_selector_disabled',
      message: 'Bearer/OpenAI-compatible companion selection is disabled; omit X-PSFN-Companion-ID to use pinned routing',
    };
  }

  if (!input.routing.knownCompanionIds.includes(requestedCompanionId)) {
    return {
      ok: false,
      status: 404,
      type: 'bearer_companion_not_found',
      message: `Bearer/OpenAI-compatible companion selector does not recognize companion ${requestedCompanionId}`,
    };
  }

  if (!selectableCompanionIds.includes(requestedCompanionId)) {
    return {
      ok: false,
      status: 403,
      type: 'bearer_companion_unauthorized',
      message: `Bearer principal is not entitled to select companion ${requestedCompanionId}`,
    };
  }

  return { ok: true, companionId: requestedCompanionId };
}
