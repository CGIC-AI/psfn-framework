import type { PromptLayer } from '../../../core/identity/prompt-types.js';
import { TEMPORAL_RULES_LAYER_IDENTIFIER } from '../../../core/identity/temporal-rules-layer.js';
import {
  isAuditedAdminTokenOperator,
  type GardenRequestContext,
} from '../garden-request-context.js';

/**
 * Who may write operator-type prompt layers through the Garden prompt API
 * (psfn-framework-c5e65). Operator layers are always-on operator instructions
 * composed into the static prompt prefix, so only the audited operator
 * principal may create, edit, toggle, roll back or delete them:
 *   - the standalone Garden operator credential;
 *   - the audited ADMIN_TOKEN operator door (actor kind admin_token_operator);
 *   - an SSO owner/admin principal admitted for `prompts.manage`.
 * The testing-harness door, public callers and any other principal fail closed.
 * Runtime/channel/task layers and the companion's own identity tools are
 * unaffected.
 */
export type OperatorLayerWriter =
  | { ok: true; actor: string }
  | { ok: false; message: string };

export function resolveOperatorLayerWriter(
  context: GardenRequestContext | undefined,
): OperatorLayerWriter {
  if (!context || context.kind === 'public') {
    return { ok: false, message: 'Operator prompt layers require an authenticated operator' };
  }
  if (context.kind === 'standalone_token') {
    return { ok: true, actor: context.actor.actorId };
  }
  if (context.actor.provider === 'testing_harness') {
    return { ok: false, message: 'The testing-harness door cannot write operator prompt layers' };
  }
  if (context.action !== 'prompts.manage') {
    return { ok: false, message: 'Operator prompt layers require prompts.manage authority' };
  }
  const adminTokenDoor: boolean = isAuditedAdminTokenOperator(context);
  if (adminTokenDoor) {
    return { ok: true, actor: `admin-token:${context.actor.principalId}` };
  }
  if (context.actor.provider === 'discord'
    && (context.actor.role === 'owner' || context.actor.role === 'admin')) {
    return { ok: true, actor: `fleet-principal:${context.actor.principalId}` };
  }
  return { ok: false, message: 'Operator prompt layers require an operator principal' };
}

const OPERATOR_LAYER_IDENTIFIER_SHAPE = /^operator\.[a-z0-9][a-z0-9_-]*(?:\.[a-z0-9][a-z0-9_-]*)*$/u;

/**
 * An operator-authored layer is addressed by a unique `operator.*` identifier.
 * The system-seeded temporal rules identifier is reserved for its seed.
 */
export function operatorLayerIdentifierError(
  identifier: string | undefined,
  layers: readonly Pick<PromptLayer, 'id' | 'type' | 'identifier'>[],
  selfId?: string,
): string | null {
  if (!identifier) return 'Operator prompt layers require an identifier under operator.*';
  if (!OPERATOR_LAYER_IDENTIFIER_SHAPE.test(identifier)) {
    return 'Operator prompt layer identifier must be operator.<lowercase segments>';
  }
  if (identifier === TEMPORAL_RULES_LAYER_IDENTIFIER && !layers.some(layer => (
    layer.id === selfId && layer.identifier === TEMPORAL_RULES_LAYER_IDENTIFIER
  ))) {
    return `${TEMPORAL_RULES_LAYER_IDENTIFIER} is reserved for the system-seeded layer`;
  }
  if (layers.some(layer => layer.identifier === identifier && layer.id !== selfId)) {
    return `A prompt layer already uses identifier ${identifier}`;
  }
  return null;
}
