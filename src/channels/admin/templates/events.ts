import { escapeHtml } from './shared.js';

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
  const details = Object.entries(payload)
    .filter(([k]) => k !== 'type' && k !== 'timestamp')
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' ');
  return `<div class="event-item"><span class="event-time">${time}</span> <span class="event-type">${escapeHtml(type)}</span> ${escapeHtml(details)}</div>`;
}
