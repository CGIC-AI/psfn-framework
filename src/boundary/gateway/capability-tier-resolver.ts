import { CapabilityRuntime } from '../../system/capabilities/runtime.js';
import type { CapabilityAccess } from '../../system/capabilities/access.js';
import type { CapabilityTier } from '../../system/config/runtime-config-contracts.js';
import type { ResolvedCompanionsFleetConfig } from '../../system/config/companions-config.js';

export interface GatewayCapabilityTierResolverInput {
  /**
   * Gateway-rooted CapabilityRuntime (input.startupHydration.companionDataDir).
   * Single-companion authority, and the base for gateway-global callers that
   * carry no authenticated companion (e.g. voice/channel plugin activation).
   */
  baseRuntime: CapabilityRuntime;
  /** True when the gateway serves a fleet (bootstrap.server.multiCompanion.enabled). */
  multiCompanion: boolean;
  /** Resolved fleet; each entry carries its own absolute companionDataDir. */
  companionFleet?: ResolvedCompanionsFleetConfig;
}

/**
 * an52.3: capability-tier.json is per-companion (PER_COMPANION_OWNER_FILES),
 * but the gateway hydrates a single companionDataDir. In the one-gateway/
 * N-companion topology the tier of every tier-gated decision (shard-backend
 * admission, autonomous-approval auto-clear, LLM eligibility) must resolve
 * against the *authenticated* companion's own capability-tier.json — mirroring
 * how resolveConnectionWorkspacePath / resolveConnectionPolicyConfig key on the
 * connection's companion id. This resolver owns one CapabilityRuntime per fleet
 * companion, rooted at that companion's data dir, cached like the workspace map.
 */
export class GatewayCapabilityTierResolver {
  private readonly baseRuntime: CapabilityRuntime;
  private readonly multiCompanion: boolean;
  private readonly companionDataDirById: ReadonlyMap<string, string>;
  private readonly runtimeByCompanionId = new Map<string, CapabilityRuntime>();

  constructor(input: GatewayCapabilityTierResolverInput) {
    this.baseRuntime = input.baseRuntime;
    this.multiCompanion = input.multiCompanion;
    this.companionDataDirById = new Map(
      (input.companionFleet?.companions ?? []).map(entry => [entry.companionId, entry.companionDataDir]),
    );
  }

  /**
   * Strict per-companion tier for security-sensitive gates (shard backends,
   * approval auto-clear). In multi-companion mode a missing or unknown
   * authenticated companion cannot resolve a tier, so this fails closed
   * (throws) rather than silently using the gateway's own root tier.
   */
  resolveTier(companionId: string | undefined): CapabilityTier {
    if (!this.multiCompanion) {
      return this.baseRuntime.getTier();
    }
    if (!companionId) {
      throw new Error(
        'Multi-companion capability tier resolution requires an authenticated companion connection',
      );
    }
    return this.resolveCompanionRuntime(companionId).getTier();
  }

  /**
   * Lenient CapabilityAccess for gateway-global eligibility callers with no
   * per-companion identity — channel/STT/TTS plugin activation
   * (plugin-eligibility.ts), whose tier is a process decision, not a
   * per-connection one. Companion-scoped consumers must use
   * resolveAccessStrict; this accessor must never gate a per-companion call.
   */
  resolveAccess(companionId?: string): CapabilityAccess {
    if (!this.multiCompanion || !companionId) {
      return this.baseRuntime;
    }
    return this.resolveCompanionRuntime(companionId);
  }

  /**
   * Strict CapabilityAccess for companion-scoped eligibility consumers (the
   * gateway LLM client). In multi-companion mode an absent companion identity
   * means the caller's tier cannot be established, so this throws — never a
   * silent fallback to the gateway root's tier. Single-companion mode keeps
   * the base runtime (one root = correct behavior).
   */
  resolveAccessStrict(companionId: string | undefined): CapabilityAccess {
    if (!this.multiCompanion) {
      return this.baseRuntime;
    }
    if (!companionId) {
      throw new Error(
        'Multi-companion LLM eligibility requires an authenticated companion identity (fail closed)',
      );
    }
    return this.resolveCompanionRuntime(companionId);
  }

  private resolveCompanionRuntime(companionId: string): CapabilityRuntime {
    const cached = this.runtimeByCompanionId.get(companionId);
    if (cached) {
      return cached;
    }
    const companionDataDir = this.companionDataDirById.get(companionId);
    if (!companionDataDir) {
      throw new Error(
        `No companion data dir is resolved for companion ${companionId}; `
        + 'its capability tier cannot be established (fail closed).',
      );
    }
    // CapabilityRuntime loads capability-tier.json eagerly; a missing/malformed
    // owner file throws here and propagates to the caller's fail-closed handler.
    const runtime = new CapabilityRuntime({ dataDir: companionDataDir });
    this.runtimeByCompanionId.set(companionId, runtime);
    return runtime;
  }
}
