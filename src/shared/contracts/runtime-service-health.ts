// ── Runtime service health status contract (psfn-framework-kbdvl.1) ──
//
// Core-owned health status union consumed by the substrate agent, adaptive
// tool runtime, and self-status diagnostics without pulling operator/gateway
// health-aggregator types into the core import closure.

export type RuntimeServiceHealthStatus =
  | 'healthy'
  | 'degraded'
  | 'unavailable'
  | 'not_applicable';
