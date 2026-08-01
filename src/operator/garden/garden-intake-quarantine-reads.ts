import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  compileGardenRouteDeclarations,
} from '../../boundary/fleet-auth/garden-route-capabilities.js';
import {
  createIntakeQuarantineReadStore,
} from '../../core/cogsec/intake/quarantine-store.js';
import {
  resolveConfiguredCompanionDataDir,
  resolveIntakeQuarantinePath,
} from '../../persistence/layout.js';
import type { CompanionId } from '../../shared/routing/companion-id.js';
import { createOwnerFileConfigStore } from '../../system/config/config-store.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type { FleetGardenAdmittedPrincipalRequest } from './fleet-garden-control-plane.js';
import type { FleetGardenIntakeQuarantineReadPort } from './fleet-garden-operator-router.js';
import {
  ADMIN_INTAKE_QUARANTINE_API_PATH,
  buildAdminIntakeQuarantineReadRoutes,
} from './routes/intake-quarantine-routes.js';
import type { AuthorizedAdminApiRoute } from './routes/types.js';
import { dispatchAdminRoute } from './server-routes.js';
import {
  createAdminIntakeQuarantineReadService,
  type AdminIntakeQuarantineReadService,
} from './services/intake-quarantine-service.js';

export interface GardenIntakeQuarantineReadsOptions {
  readonly config: SubstrateConfig;
  readonly createReadService?: (
    config: SubstrateConfig,
    companionId: CompanionId | undefined,
    companionDataDir: string,
  ) => AdminIntakeQuarantineReadService;
}

export interface GardenIntakeQuarantineReadPort
extends FleetGardenIntakeQuarantineReadPort {
  handleLocalHttp(input: {
    readonly method: string;
    readonly path: string;
    readonly req: IncomingMessage;
    readonly res: ServerResponse;
  }): boolean;
}

/**
 * Garden-local quarantine read plane for fixed and fleet topologies.
 *
 * Queue and detail GETs read the atomically replaced quarantine snapshot from
 * the selected companion's read-only mounted data root. Confirm/decide
 * mutations are deliberately absent and continue through the authenticated
 * agent transport.
 */
export class GardenIntakeQuarantineReads implements GardenIntakeQuarantineReadPort {
  private readonly localRoutes: (() => AuthorizedAdminApiRoute[]) | undefined;
  private readonly routesByCompanion = new Map<CompanionId, () => AuthorizedAdminApiRoute[]>();

  constructor(options: GardenIntakeQuarantineReadsOptions) {
    const createReadService = options.createReadService ?? createDefaultReadService;
    const createRoutes = (
      companionId: CompanionId | undefined,
      companionDataDir: string,
    ): (() => AuthorizedAdminApiRoute[]) => {
      let routes: AuthorizedAdminApiRoute[] | undefined;
      return () => {
        routes ??= compileGardenRouteDeclarations(buildAdminIntakeQuarantineReadRoutes({
          quarantineService: createReadService(
            options.config,
            companionId,
            companionDataDir,
          ),
        }));
        return routes;
      };
    };

    const fleet = options.config.companionFleet;
    if (!fleet) {
      this.localRoutes = createRoutes(
        undefined,
        resolveConfiguredCompanionDataDir(options.config),
      );
      return;
    }
    this.localRoutes = undefined;
    for (const companion of fleet.companions) {
      if (this.routesByCompanion.has(companion.companionId)) {
        throw new Error(
          `Garden quarantine read companion is duplicated: ${companion.companionId}`,
        );
      }
      this.routesByCompanion.set(
        companion.companionId,
        createRoutes(companion.companionId, companion.companionDataDir),
      );
    }
  }

  handleLocalHttp(input: {
    readonly method: string;
    readonly path: string;
    readonly req: IncomingMessage;
    readonly res: ServerResponse;
  }): boolean {
    if (!isQuarantineRead(input.method, input.path)) return false;
    if (!this.localRoutes) {
      throw new Error('Local Garden quarantine read has no fixed companion-bound service');
    }
    return dispatchAdminRoute(
      this.localRoutes(),
      input.method,
      input.path,
      input.req,
      input.res,
    );
  }

  handleHttp(input: {
    readonly admission: FleetGardenAdmittedPrincipalRequest;
    readonly req: IncomingMessage;
    readonly res: ServerResponse;
  }): boolean {
    const { target } = input.admission;
    if (!isQuarantineRead(target.method, target.canonicalPath)) return false;
    const getRoutes = this.routesByCompanion.get(input.admission.companionId);
    if (!getRoutes) {
      throw new Error('Fleet Garden quarantine read has no companion-bound service');
    }
    const originalTarget = input.req.url;
    input.req.url = target.canonicalRequestTarget;
    try {
      return dispatchAdminRoute(
        getRoutes(),
        target.method,
        target.canonicalPath,
        input.req,
        input.res,
        input.admission.context,
        input.admission.companionId,
      );
    } finally {
      input.req.url = originalTarget;
    }
  }
}

function isQuarantineRead(method: string, path: string): boolean {
  return method === 'GET'
    && (path === ADMIN_INTAKE_QUARANTINE_API_PATH
      || path.startsWith(`${ADMIN_INTAKE_QUARANTINE_API_PATH}/`));
}

function createDefaultReadService(
  config: SubstrateConfig,
  _companionId: CompanionId | undefined,
  companionDataDir: string,
): AdminIntakeQuarantineReadService {
  let service: AdminIntakeQuarantineReadService | undefined;
  const getService = (): AdminIntakeQuarantineReadService => {
    if (service) return service;
    const intakePolicy = createOwnerFileConfigStore({
      dataDir: config.dataDir,
      companionDataDir,
      defaultContextWindow: config.defaultContextWindow,
    }).loadIntakePolicy();
    const store = createIntakeQuarantineReadStore(
      resolveIntakeQuarantinePath(companionDataDir),
      {
        itemTtlHours: intakePolicy.quarantine.itemTtlHours,
        maxHeldItems: intakePolicy.quarantine.maxHeldItems,
      },
    );
    service = createAdminIntakeQuarantineReadService({ store });
    return service;
  };
  return {
    listItems: context => getService().listItems(context),
    getItem: (id, context) => getService().getItem(id, context),
  };
}
