import { escapeHtml } from './shared.js';
import {
  ADMIN_AUDIT_ACTION_TYPES,
  ADMIN_AUDIT_DECISIONS,
  ADMIN_AUDIT_TIME_RANGES,
} from '../audit-timeline.js';
import type {
  AdminAuditActionType,
  AdminAuditDecision,
  AdminAuditTimeRange,
  AdminAuditTimelineEntry,
  AdminAuditTimelineFilters,
} from '../types.js';

interface AuditTimelinePageModel {
  entries: AdminAuditTimelineEntry[];
  filters: AdminAuditTimelineFilters;
}

const ACTION_TYPE_LABELS: Record<AdminAuditActionType, string> = {
  tool_invocation: 'Tool invocation',
  identity_edit: 'Identity edit',
  external_action: 'External action',
  memory_mutation: 'Memory mutation',
  settings_change: 'Settings change',
};

const DECISION_LABELS: Record<AdminAuditDecision, string> = {
  allowed: 'Allowed',
  denied: 'Denied',
};

const TIME_RANGE_LABELS: Record<AdminAuditTimeRange, string> = {
  '15m': 'Last 15 minutes',
  '1h': 'Last hour',
  '24h': 'Last 24 hours',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  all: 'All time',
};

function renderSelectOption(value: string, label: string, selected: boolean): string {
  return `<option value="${escapeHtml(value)}"${selected ? ' selected' : ''}>${escapeHtml(label)}</option>`;
}

function formatEventValue(value: unknown): string {
  if (value === undefined) return '';
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.length} items]`;
  return JSON.stringify(value);
}

function formatWyomingEventDetails(type: string, payload: Record<string, unknown>): string | null {
  if (type === 'wyoming.session.start') {
    return [
      `connection=${formatEventValue(payload.connectionId)}`,
      `session=${formatEventValue(payload.sessionId)}`,
      `active=${formatEventValue(payload.activeSessions)}`,
      `max=${formatEventValue(payload.maxSessions)}`,
    ].join(' ');
  }

  if (type === 'wyoming.session.end') {
    return [
      `connection=${formatEventValue(payload.connectionId)}`,
      `session=${formatEventValue(payload.sessionId)}`,
      `reason=${formatEventValue(payload.reason)}`,
      `durationMs=${formatEventValue(payload.durationMs)}`,
    ].join(' ');
  }

  if (type === 'wyoming.policy.violation') {
    return [
      `code=${formatEventValue(payload.code)}`,
      `scope=${formatEventValue(payload.scope)}`,
      `connection=${formatEventValue(payload.connectionId)}`,
      `session=${formatEventValue(payload.sessionId)}`,
      `event=${formatEventValue(payload.eventType)}`,
      `limit=${formatEventValue(payload.limit)}`,
      `observed=${formatEventValue(payload.observed)}`,
      `action=${formatEventValue(payload.action)}`,
    ].filter(part => !part.endsWith('=')).join(' ');
  }

  if (type === 'wyoming.connection.error') {
    return [
      `connection=${formatEventValue(payload.connectionId)}`,
      `code=${formatEventValue(payload.code)}`,
      `error=${formatEventValue(payload.error)}`,
    ].join(' ');
  }

  if (type === 'wyoming.audit.summary') {
    return [
      `method=${formatEventValue(payload.method)}`,
      `decision=${formatEventValue(payload.decision)}`,
      `error=${formatEventValue(payload.error)}`,
    ].filter(part => !part.endsWith('=')).join(' ');
  }

  return null;
}

export function eventsPage(): string {
  return `
    <div hx-ext="sse" sse-connect="/events/stream">
      <div class="event-feed" id="event-feed" sse-swap="admin-event" hx-swap="afterbegin">
        <div class="event-item"><span class="event-type">Listening for events...</span></div>
      </div>
    </div>`;
}

export function eventItem(type: string, timestamp: number, payload: Record<string, unknown>): string {
  const time = new Date(timestamp).toLocaleTimeString();
  const wyomingDetails = type.startsWith('wyoming.')
    ? formatWyomingEventDetails(type, payload)
    : null;
  const details = wyomingDetails ?? Object.entries(payload)
    .filter(([k]) => k !== 'type' && k !== 'timestamp')
    .map(([k, v]) => `${k}=${formatEventValue(v)}`)
    .join(' ');
  return `<div class="event-item"><span class="event-time">${time}</span> <span class="event-type">${escapeHtml(type)}</span> ${escapeHtml(details)}</div>`;
}

export function auditTimelinePage(model: AuditTimelinePageModel): string {
  const { entries, filters } = model;
  const actionTypeOptions = [
    renderSelectOption('all', 'All action types', filters.actionType === 'all'),
    ...ADMIN_AUDIT_ACTION_TYPES.map((actionType) => renderSelectOption(
      actionType,
      ACTION_TYPE_LABELS[actionType],
      filters.actionType === actionType,
    )),
  ].join('');
  const decisionOptions = [
    renderSelectOption('all', 'All decisions', filters.decision === 'all'),
    ...ADMIN_AUDIT_DECISIONS.map((decision) => renderSelectOption(
      decision,
      DECISION_LABELS[decision],
      filters.decision === decision,
    )),
  ].join('');
  const timeRangeOptions = ADMIN_AUDIT_TIME_RANGES
    .map((timeRange) => renderSelectOption(timeRange, TIME_RANGE_LABELS[timeRange], filters.timeRange === timeRange))
    .join('');
  const items = entries.length > 0
    ? entries.map(entry => auditTimelineItem(entry)).join('')
    : '<div class="empty">No audit events match the selected filters.</div>';

  return `
    <p class="audit-intro">
      Unified timeline for tool invocations, identity edits, external actions, and memory mutations.
    </p>
    <form class="audit-filter-form" method="GET" action="/events">
      <label>
        Action type
        <select name="actionType">${actionTypeOptions}</select>
      </label>
      <label>
        Decision
        <select name="decision">${decisionOptions}</select>
      </label>
      <label>
        Time range
        <select name="timeRange">${timeRangeOptions}</select>
      </label>
      <button type="submit" class="btn">Apply filters</button>
    </form>
    <div class="audit-feed">${items}</div>`;
}

export function auditTimelineItem(entry: AdminAuditTimelineEntry): string {
  const timestamp = new Date(entry.timestamp);
  const dateLabel = timestamp.toLocaleDateString();
  const timeLabel = timestamp.toLocaleTimeString();
  const actionTypeLabel = ACTION_TYPE_LABELS[entry.actionType];
  const decisionLabel = DECISION_LABELS[entry.decision];
  const detailsHtml = entry.details
    ? `<div class="audit-item-details">${escapeHtml(entry.details)}</div>`
    : '';

  return `<article class="audit-item" data-action-type="${escapeHtml(entry.actionType)}" data-decision="${escapeHtml(entry.decision)}">
    <div class="audit-item-meta">
      <span class="audit-item-time">${escapeHtml(`${dateLabel} ${timeLabel}`)}</span>
      <span class="audit-badge">${escapeHtml(actionTypeLabel)}</span>
      <span class="audit-badge audit-badge-${escapeHtml(entry.decision)}">${escapeHtml(decisionLabel)}</span>
    </div>
    <div class="audit-item-narrative">${escapeHtml(entry.narrative)}</div>
    ${detailsHtml}
  </article>`;
}
