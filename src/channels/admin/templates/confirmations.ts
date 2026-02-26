import type { ConfirmationQueueEntry } from '../../../gateway/protocol.js';
import { escapeHtml } from './shared.js';

export interface ConfirmationQueueFragmentModel {
  entries: ConfirmationQueueEntry[];
  available: boolean;
  message?: string;
  isError?: boolean;
}

function formatTimestamp(value: number): string {
  return new Date(value).toLocaleString();
}

function stringifyParams(params: Record<string, unknown>): string {
  try {
    return JSON.stringify(params, null, 2);
  } catch {
    return '{}';
  }
}

function renderEntry(entry: ConfirmationQueueEntry): string {
  const escapedId = escapeHtml(entry.id);
  const method = escapeHtml(entry.method);
  const action = escapeHtml(entry.action);
  const scope = escapeHtml(entry.scope);
  const reason = escapeHtml(entry.companionReason);
  const paramsJson = stringifyParams(entry.params);
  const paramsJsonEscaped = escapeHtml(paramsJson);

  return `<tr>
    <td>
      <div><strong>${method}</strong> (${action})</div>
      <div class="confirmation-meta">ID: <code>${escapedId}</code></div>
      <div class="confirmation-meta">Scope: ${scope}</div>
      <div class="confirmation-meta">Requested: ${escapeHtml(formatTimestamp(entry.requestedAt))}</div>
      <div class="confirmation-meta">Expires: ${escapeHtml(formatTimestamp(entry.expiresAt))}</div>
      <div class="confirmation-meta">Reason: ${reason}</div>
    </td>
    <td>
      <pre class="confirmation-params">${paramsJsonEscaped}</pre>
    </td>
    <td>
      <form
        class="confirmation-actions"
        hx-post="/api/confirmations/resolve"
        hx-target="#confirmation-queue"
        hx-swap="outerHTML"
      >
        <input type="hidden" name="id" value="${escapedId}">
        <div class="form-group">
          <label for="modified-${escapedId}">Modified Params JSON</label>
          <textarea id="modified-${escapedId}" name="modifiedParamsJson">${paramsJsonEscaped}</textarea>
        </div>
        <div class="confirmation-buttons">
          <button type="submit" class="btn" name="decision" value="approve">Approve</button>
          <button type="submit" class="btn btn-danger" name="decision" value="deny">Deny</button>
          <button type="submit" class="btn" name="decision" value="modify">Modify</button>
        </div>
      </form>
    </td>
  </tr>`;
}

export function confirmationsPage(fragmentHtml: string): string {
  return `<div class="card">
    <p class="confirmation-intro">
      Actions requiring approval are queued here. Approve, deny, or modify parameters before execution.
    </p>
    ${fragmentHtml}
  </div>`;
}

export function confirmationQueueFragment(model: ConfirmationQueueFragmentModel): string {
  const messageHtml = model.message
    ? `<div class="${model.isError ? 'form-error' : 'form-success'}">${escapeHtml(model.message)}</div>`
    : '';

  if (!model.available) {
    return `<div id="confirmation-queue" hx-get="/api/confirmations/list" hx-trigger="every 15s" hx-swap="outerHTML">
      ${messageHtml}
      <div class="empty">Confirmation queue is unavailable.</div>
    </div>`;
  }

  if (model.entries.length === 0) {
    return `<div id="confirmation-queue" hx-get="/api/confirmations/list" hx-trigger="every 15s" hx-swap="outerHTML">
      ${messageHtml}
      <div class="empty">No pending confirmation actions.</div>
    </div>`;
  }

  const rows = model.entries.map(renderEntry).join('');
  return `<div id="confirmation-queue" hx-get="/api/confirmations/list" hx-trigger="every 15s" hx-swap="outerHTML">
    ${messageHtml}
    <table>
      <thead>
        <tr>
          <th>Action</th>
          <th>Parameters</th>
          <th>Review</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}
