import { SENSITIVITY_LEVELS } from '../../../system/trust/types.js';
import type { AutomataBusSqlQueryable } from '../../../faculties/automata/bus/postgres-store.js';
import {
  AUTOMATA_TERMINAL_HANDOFF_SOURCE,
  AUTOMATA_TERMINAL_NO_FINDING_SOURCE,
} from '../../../faculties/automata/terminal-lifecycle.js';
import { requireAutomataBusNonEmptyString } from '../../../faculties/automata/bus/postgres-query-sql.js';
import type {
  AdminAutomataClassActivity,
  AdminAutomataClassActivityInput,
  AdminAutomataClassActivityRead,
} from './automata-coverage.js';

interface ClassActivityRow {
  automaton_class: unknown;
  useful_handoffs: unknown;
  no_finding_handoffs: unknown;
  worker_findings: unknown;
  last_useful_at: unknown;
  empty_streak: unknown;
}

interface HandoffRunRow {
  run_id: unknown;
}

function requireCount(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Automata class activity ${field} must be a non-negative safe integer`);
  }
  return value;
}

function optionalInstant(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  const instant = value instanceof Date ? value.getTime() : Date.parse(String(value));
  if (!Number.isFinite(instant)) throw new Error(`Automata class activity ${field} must be a timestamp`);
  return new Date(instant).toISOString();
}

/**
 * Per-class Bus learning activity for one companion over the owner window.
 *
 * Aggregates only: counts of useful and no-finding terminal handoffs, worker
 * findings (notes and evidence-backed appends), the latest useful handoff, and
 * the current empty streak (no-finding handoffs since the latest useful one).
 * No claim, evidence, or body text leaves this query. The terminal-run probe is
 * bounded by the caller's run-id list and answers only which of those runs
 * left a terminal handoff.
 */
export async function readAutomataClassActivity(
  pool: AutomataBusSqlQueryable,
  companionId: string,
  input: AdminAutomataClassActivityInput,
): Promise<AdminAutomataClassActivityRead> {
  if (input.companionId !== companionId) {
    throw new Error('Automata class activity companion scope mismatch');
  }
  if (!Number.isSafeInteger(input.windowStartMs) || input.windowStartMs < 0) {
    throw new Error('Automata class activity windowStartMs must be a non-negative safe integer');
  }
  const windowStart = new Date(input.windowStartMs).toISOString();
  const runIds = input.terminalRunIds.map(runId => requireAutomataBusNonEmptyString(runId, 'runId'));
  const terminalSources = [AUTOMATA_TERMINAL_HANDOFF_SOURCE, AUTOMATA_TERMINAL_NO_FINDING_SOURCE];
  const [activityRows, handoffRows] = await Promise.all([
    pool.query<ClassActivityRow>(`
      WITH windowed AS (
        SELECT e.automaton_class,
               e.sequence,
               e.occurred_at,
               e.event_json #>> '{body,source}' AS source
        FROM automata_bus_events e
        WHERE e.companion_id = $1
          AND e.event_type = 'finding'
          AND 'operator' = ANY(e.audiences)
          AND e.sensitivity = ANY($2::text[])
          AND e.occurred_at >= $3::timestamptz
      ),
      last_useful AS (
        SELECT automaton_class, MAX(sequence) AS sequence
        FROM windowed
        WHERE source = $4
        GROUP BY automaton_class
      )
      SELECT w.automaton_class,
             (COUNT(*) FILTER (WHERE w.source = $4))::int AS useful_handoffs,
             (COUNT(*) FILTER (WHERE w.source = $5))::int AS no_finding_handoffs,
             (COUNT(*) FILTER (
               WHERE w.source IS DISTINCT FROM $4 AND w.source IS DISTINCT FROM $5
             ))::int AS worker_findings,
             MAX(w.occurred_at) FILTER (WHERE w.source = $4) AS last_useful_at,
             (COUNT(*) FILTER (
               WHERE w.source = $5 AND w.sequence > COALESCE(u.sequence, 0)
             ))::int AS empty_streak
      FROM windowed w
      LEFT JOIN last_useful u ON u.automaton_class = w.automaton_class
      GROUP BY w.automaton_class
      ORDER BY w.automaton_class
    `, [
      companionId,
      [...SENSITIVITY_LEVELS],
      windowStart,
      AUTOMATA_TERMINAL_HANDOFF_SOURCE,
      AUTOMATA_TERMINAL_NO_FINDING_SOURCE,
    ]),
    runIds.length === 0
      ? Promise.resolve({ rows: [] as HandoffRunRow[] })
      : pool.query<HandoffRunRow>(`
        SELECT DISTINCT e.run_id
        FROM automata_bus_events e
        WHERE e.companion_id = $1
          AND e.run_id = ANY($2::text[])
          AND e.event_type = 'finding'
          AND e.event_json #>> '{body,source}' = ANY($3::text[])
      `, [companionId, runIds, terminalSources]),
  ]);
  const classes: AdminAutomataClassActivity[] = activityRows.rows.map(row => ({
    automatonClass: requireAutomataBusNonEmptyString(row.automaton_class, 'automaton_class'),
    usefulHandoffs: requireCount(row.useful_handoffs, 'useful_handoffs'),
    noFindingHandoffs: requireCount(row.no_finding_handoffs, 'no_finding_handoffs'),
    workerFindings: requireCount(row.worker_findings, 'worker_findings'),
    lastUsefulAt: optionalInstant(row.last_useful_at, 'last_useful_at'),
    emptyStreak: requireCount(row.empty_streak, 'empty_streak'),
  }));
  const requested = new Set(runIds);
  const handoffRunIds = handoffRows.rows.map(row => requireAutomataBusNonEmptyString(row.run_id, 'run_id'));
  if (handoffRunIds.some(runId => !requested.has(runId))) {
    throw new Error('Automata class activity returned a run outside its requested scope');
  }
  return { companionId, windowStart, classes, handoffRunIds };
}
