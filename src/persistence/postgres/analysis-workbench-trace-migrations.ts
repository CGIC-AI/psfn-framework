// Analysis-workbench trace ring (bead vb11). Persists the redacted
// AnalysisWorkbenchTraceView projection so the Garden /analysis-workbench page
// survives a Garden/agent restart. Companion-scoped, bounded per companion to
// the same 50-entry window the in-memory ring uses; the redacted projection is
// stored verbatim as JSONB and read back newest-first.
export const POSTGRES_ANALYSIS_WORKBENCH_TRACE_MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE IF NOT EXISTS analysis_workbench_traces (
    id TEXT PRIMARY KEY,
    companion_id TEXT NOT NULL,
    recorded_at_ms BIGINT NOT NULL,
    trace_json JSONB NOT NULL,
    CHECK (recorded_at_ms >= 0),
    CHECK (jsonb_typeof(trace_json) = 'object'),
    CHECK (octet_length(trace_json::text) <= 1048576)
  );
  `,
  `
  CREATE INDEX IF NOT EXISTS idx_analysis_workbench_traces_companion_recorded
    ON analysis_workbench_traces(companion_id, recorded_at_ms DESC, id DESC);
  `,
];
