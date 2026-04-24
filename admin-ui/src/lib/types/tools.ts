import type {
  AdminAdaptiveToolsData as CanonicalAdminAdaptiveToolsData,
  AdminToolAvailabilityView as CanonicalAdminToolAvailabilityView,
  AdminToolFailureEvent as CanonicalAdminToolFailureEvent,
  AdminToolHealthView as CanonicalAdminToolHealthView,
  AdminToolInventoryGroup as CanonicalAdminToolInventoryGroup,
} from '../../../../src/operator/garden/services/types.js';

export type { AdaptiveToolRuntimeState } from '../../../../src/core/agent/adaptive-tools-telemetry.js';
export type {
  RuntimeToolCatalogEntry,
  RuntimeToolCatalogSnapshot,
} from '../../../../src/core/agent/tool-catalog.js';
export type {
  RuntimeServiceFailure,
  RuntimeServiceHealth,
  RuntimeServiceHealthStatus,
  RuntimeServiceId,
} from '../../../../src/operator/tool-health/types.js';

export type AdminToolFailureEvent = CanonicalAdminToolFailureEvent;

export type AdminToolAvailabilityStatus = CanonicalAdminToolAvailabilityView['status'];

export type AdminToolAvailabilityView = CanonicalAdminToolAvailabilityView;

export type AdminToolHealthView = CanonicalAdminToolHealthView;

export type AdminToolInventoryGroup = CanonicalAdminToolInventoryGroup;

export type AdminAdaptiveToolsData = CanonicalAdminAdaptiveToolsData;
