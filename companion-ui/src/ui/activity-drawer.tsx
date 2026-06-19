import {
  Activity,
  AlertTriangle,
  Radio,
  ShieldCheck,
  Volume2,
  Wifi,
} from 'lucide-react';
import type { OperationalTrace } from '../lib/traces.js';
import { DrawerHeader } from './overlay-drawer.js';
import type { ActivityFilter } from './types.js';

export const ACTIVITY_FILTERS: ActivityFilter[] = [
  'all',
  'messages',
  'artifacts',
  'approvals',
  'voice',
  'tools',
  'system',
  'errors',
];

export function ActivityDrawer({
  filter,
  onClose,
  onFilterChange,
  traces,
  totalCount,
}: {
  filter: ActivityFilter;
  onClose: () => void;
  onFilterChange: (filter: ActivityFilter) => void;
  traces: OperationalTrace[];
  totalCount: number;
}) {
  return (
    <aside className="overlay-drawer activity-drawer" aria-label="Activity and events">
      <DrawerHeader icon={<Activity aria-hidden />} title="Activity" onClose={onClose} />
      <div className="drawer-content">
        <div className="filter-bar" role="tablist" aria-label="Activity filters">
          {ACTIVITY_FILTERS.map((option) => (
            <button
              className={filter === option ? 'active' : ''}
              type="button"
              role="tab"
              aria-selected={filter === option}
              onClick={() => onFilterChange(option)}
              key={option}
            >
              {option}
            </button>
          ))}
        </div>
        <div className="activity-count">
          Showing {traces.length} of {totalCount}
        </div>
        <div className="event-list">
          {traces.length === 0 ? (
            <p className="drawer-empty">No matching events</p>
          ) : (
            traces.slice().reverse().map((trace) => <TraceRow trace={trace} key={trace.id} />)
          )}
        </div>
      </div>
    </aside>
  );
}

export function traceMatchesFilter(trace: OperationalTrace, filter: ActivityFilter): boolean {
  if (filter === 'all') return true;
  const operation = trace.operationClass.toLowerCase();
  const type = trace.type.toLowerCase();
  switch (filter) {
    case 'messages':
      return type === 'message' || operation.includes('message');
    case 'artifacts':
      return operation.includes('artifact');
    case 'approvals':
      return operation.includes('approval');
    case 'voice':
      return operation.includes('relay_stt') || operation.includes('relay_tts') || type.includes('audio');
    case 'tools':
      return operation.includes('tool');
    case 'system':
      return operation.includes('hub') || operation.includes('heartbeat') || type === 'pong';
    case 'errors':
      return trace.status === 'failed' || type.includes('error');
  }
}

function TraceRow({ trace }: { trace: OperationalTrace }) {
  return (
    <article className={`event-row ${trace.status}`}>
      <div className="event-icon">{iconForTrace(trace)}</div>
      <div className="event-body">
        <div>
          <strong>{titleForTrace(trace)}</strong>
          <time>{formatClock(trace.receivedAt)}</time>
        </div>
        <p>{trace.summary}</p>
        <dl>
          <div>
            <dt>Type</dt>
            <dd>{trace.type}</dd>
          </div>
          <div>
            <dt>Seq</dt>
            <dd>{trace.sequence}</dd>
          </div>
          {Object.entries(trace.metadata).map(([key, value]) => (
            <div key={key}>
              <dt>{key}</dt>
              <dd>{String(value)}</dd>
            </div>
          ))}
        </dl>
      </div>
    </article>
  );
}

function iconForTrace(trace: OperationalTrace) {
  if (trace.status === 'failed') return <AlertTriangle aria-hidden />;
  if (trace.operationClass.includes('message')) return <Radio aria-hidden />;
  if (trace.operationClass.includes('relay')) return <Volume2 aria-hidden />;
  if (trace.operationClass.includes('hub')) return <Wifi aria-hidden />;
  return <ShieldCheck aria-hidden />;
}

function titleForTrace(trace: OperationalTrace): string {
  if (trace.operationClass.includes('assistant_message')) return 'Message Received';
  if (trace.operationClass.includes('user_message')) return 'Message Sent';
  if (trace.operationClass.includes('relay_stt')) return 'Voice Transcript';
  if (trace.operationClass.includes('relay_tts')) return 'Voice Playback';
  if (trace.operationClass.includes('hub_error')) return 'Error';
  if (trace.operationClass.includes('hub_session')) return 'Session Started';
  if (trace.operationClass.includes('hub_handshake')) return 'Connected';
  if (trace.operationClass.includes('hub_status')) return 'System';
  return trace.operationClass.replaceAll('_', ' ');
}

function formatClock(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
