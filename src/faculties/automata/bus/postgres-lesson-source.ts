import {
  SENSITIVITY_LEVELS,
  sensitivityAtMost,
  type SensitivityLevel,
} from '../../../system/trust/types.js';
import {
  parseAutomataBusEvent,
  type AutomataBusEvent,
  type AutomataBusFindingBody,
} from './contract.js';
import type {
  AutomataLessonReadScope,
  AutomataLessonSourceFinding,
  AutomataLessonSourcePort,
} from './lesson-projection.js';
import type {
  AutomataBusAudience,
  AutomataBusSqlPool,
} from './postgres-store.js';

interface CurrentLessonRow {
  audiences: unknown;
  sensitivity: unknown;
  event_json: unknown;
}

export interface PostgresAutomataLessonSourceOptions {
  pool: AutomataBusSqlPool;
  companionId: string;
}

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`Automata lesson source ${field} must be non-empty`);
  return normalized;
}

function isSensitivity(value: unknown): value is SensitivityLevel {
  return typeof value === 'string' && SENSITIVITY_LEVELS.includes(value as SensitivityLevel);
}

function parseAudiences(value: unknown): AutomataBusAudience[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every(candidate => (
    candidate === 'eligible-automata' || candidate === 'operator'
  ))) {
    throw new Error('Automata lesson source row audiences are invalid');
  }
  if (new Set(value).size !== value.length) {
    throw new Error('Automata lesson source row audiences contain duplicates');
  }
  return [...value] as AutomataBusAudience[];
}

function bodyOf(event: AutomataBusEvent): AutomataBusFindingBody | undefined {
  if (event.type === 'finding') return event.body;
  return event.body.relation === 'retracts' ? undefined : event.body.replacement;
}

export class PostgresAutomataLessonSource implements AutomataLessonSourcePort {
  private readonly companionId: string;

  constructor(private readonly options: PostgresAutomataLessonSourceOptions) {
    this.companionId = requiredText(options.companionId, 'companionId');
  }

  async listCurrent(scope: AutomataLessonReadScope): Promise<AutomataLessonSourceFinding[]> {
    if (scope.companionId !== this.companionId) {
      throw new Error('Automata lesson source companion scope mismatch');
    }
    if (!isSensitivity(scope.maxSensitivity)) {
      throw new Error('Automata lesson source maxSensitivity is invalid');
    }
    const allowedSensitivities = SENSITIVITY_LEVELS.filter(level => (
      sensitivityAtMost(level, scope.maxSensitivity)
    ));
    const result = await this.options.pool.query<CurrentLessonRow>(`
      SELECT audiences, sensitivity, event_json
      FROM automata_bus_current_findings
      WHERE companion_id = $1
        AND $2 = ANY(audiences)
        AND sensitivity = ANY($3::text[])
        AND (
          event_json #> '{body,lessonAttribution}' IS NOT NULL
          OR event_json #> '{body,replacement,lessonAttribution}' IS NOT NULL
        )
      ORDER BY sequence ASC
    `, [this.companionId, scope.audience, allowedSensitivities]);

    return result.rows.flatMap((row): AutomataLessonSourceFinding[] => {
      const audiences = parseAudiences(row.audiences);
      if (!isSensitivity(row.sensitivity)) {
        throw new Error('Automata lesson source row sensitivity is invalid');
      }
      const parsed = parseAutomataBusEvent(row.event_json);
      if (parsed.status !== 'accepted') {
        throw new Error(`Automata lesson source row event is invalid: ${parsed.issues.join('; ')}`);
      }
      const event = parsed.value;
      if (event.companionId !== scope.companionId) {
        throw new Error('Automata lesson source returned a cross-companion finding');
      }
      if (!audiences.includes(scope.audience)) {
        throw new Error('Automata lesson source returned a finding outside the requested audience');
      }
      if (!sensitivityAtMost(row.sensitivity, scope.maxSensitivity)) {
        throw new Error('Automata lesson source returned a finding outside the requested sensitivity');
      }
      const body = bodyOf(event);
      const attribution = body?.lessonAttribution;
      if (body === undefined || attribution === undefined) return [];
      return [{
        companionId: event.companionId,
        eventId: event.eventId,
        automatonClass: event.context.automatonClass,
        promptRevision: attribution.promptRevision,
        toolName: attribution.toolName,
        failureCategory: attribution.failureCategory,
        lessonCode: attribution.lessonCode,
        provenance: body.provenance,
        verificationStatus: body.verification.status,
        evidenceRefs: body.evidence.map(evidence => evidence.reference),
        audiences,
        sensitivity: row.sensitivity,
        contradictionEventIds: [...attribution.contradictionEventIds],
      }];
    });
  }
}
