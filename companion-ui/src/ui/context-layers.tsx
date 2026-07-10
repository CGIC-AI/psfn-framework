import {
  AlertTriangle,
  Camera,
  FileText,
  Image,
  LockKeyhole,
  Mic,
  Paperclip,
  X,
} from 'lucide-react';
import type { ApprovalPanelState, ApprovalRequestView } from '../lib/approvals.js';
import type { ArtifactShelfItem, ArtifactShelfState } from '../lib/artifacts.js';
import type { AttachmentKind, PendingAttachment } from './types.js';

export function ToastLayer({
  approvals,
  artifacts,
  error,
  onApprovalDecision,
  onArtifactPreview,
  stacked,
  voiceNotice,
}: {
  approvals: ApprovalPanelState;
  artifacts: ArtifactShelfState;
  error: string | null;
  onApprovalDecision: (id: string, decision: 'approve' | 'deny') => void;
  onArtifactPreview: (artifactId: string) => void;
  stacked: boolean;
  voiceNotice: string | null;
}) {
  const hasToasts = error || voiceNotice || approvals.requests.length > 0 || artifacts.items.length > 0;
  if (!hasToasts) return null;

  return (
    <section className={`toast-layer ${stacked ? 'stacked' : ''}`} aria-label="Contextual updates">
      {voiceNotice && (
        <article className="context-toast voice-toast">
          <Mic aria-hidden />
          <div>
            <strong>Voice Mode</strong>
            <p>{voiceNotice}</p>
          </div>
        </article>
      )}
      {error && (
        <article className="context-toast error-toast">
          <AlertTriangle aria-hidden />
          <div>
            <strong>Connection issue</strong>
            <p>{error}</p>
          </div>
        </article>
      )}
      {approvals.requests.map((request) => (
        <ApprovalCard key={request.id} request={request} onDecision={onApprovalDecision} />
      ))}
      {artifacts.items.map((item) => (
        <ArtifactCard key={item.id} item={item} onPreview={onArtifactPreview} />
      ))}
    </section>
  );
}

function ApprovalCard({
  request,
  onDecision,
}: {
  request: ApprovalRequestView;
  onDecision: (id: string, decision: 'approve' | 'deny') => void;
}) {
  const pending = request.status === 'pending';
  return (
    <article className={`context-toast approval-toast ${request.status}`}>
      <LockKeyhole aria-hidden />
      <div>
        <strong>Approval Request</strong>
        <p>{request.title}</p>
        <p>{request.redactedContext}</p>
        {pending ? (
          <>
            {request.expiresInSeconds !== null && (
              <p className="approval-expiry" aria-live="polite">
                Expires in {request.expiresInSeconds}s
              </p>
            )}
            <div className="toast-actions">
              <button type="button" onClick={() => onDecision(request.id, 'deny')}>
                Deny
              </button>
              <button type="button" onClick={() => onDecision(request.id, 'approve')}>
                Approve
              </button>
            </div>
          </>
        ) : (
          <p className={`approval-resolution ${request.status}`}>
            {approvalStatusLabel(request.status)}
          </p>
        )}
      </div>
    </article>
  );
}

function ArtifactCard({
  item,
  onPreview,
}: {
  item: ArtifactShelfItem;
  onPreview: (artifactId: string) => void;
}) {
  const { preview } = item;
  const canFetch = item.previewable && (preview.state === 'idle' || preview.state === 'error');
  return (
    <article className="context-toast artifact-toast">
      <FileText aria-hidden />
      <div>
        <strong>Artifact Created</strong>
        <p>{item.label} · {item.mediaType}</p>
        <p className="artifact-provenance">{item.provenance}</p>
        <ArtifactPreview item={item} />
        {(canFetch || preview.state === 'loading') && (
          <div className="toast-actions">
            <button
              type="button"
              onClick={() => onPreview(item.id)}
              disabled={preview.state === 'loading'}
            >
              {preview.state === 'loading' ? 'Loading…' : preview.state === 'error' ? 'Retry' : 'View'}
            </button>
          </div>
        )}
      </div>
    </article>
  );
}

function ArtifactPreview({ item }: { item: ArtifactShelfItem }) {
  const { preview } = item;
  switch (preview.state) {
    case 'ready':
      if (preview.mediaType?.startsWith('image/') && preview.data) {
        return (
          <img
            className="artifact-preview-image"
            src={`data:${preview.mediaType};base64,${preview.data}`}
            alt={`Preview of ${item.label}`}
          />
        );
      }
      return <p className="artifact-preview-note">Preview ready ({preview.mediaType ?? item.mediaType})</p>;
    case 'denied':
      return <p className="artifact-preview-note denied">Preview denied by hub</p>;
    case 'expired':
      return <p className="artifact-preview-note expired">Preview expired</p>;
    case 'error':
      return <p className="artifact-preview-note error">{preview.message ?? 'Preview failed'}</p>;
    case 'unavailable':
      return <p className="artifact-preview-note">Preview unavailable</p>;
    case 'loading':
    case 'idle':
      return null;
  }
}

function approvalStatusLabel(status: ApprovalRequestView['status']): string {
  switch (status) {
    case 'approved':
      return 'Approved';
    case 'denied':
      return 'Denied';
    case 'expired':
      return 'Expired';
    case 'blocked':
      return 'Blocked';
    case 'pending':
      return 'Pending';
  }
}

export function AttachmentTray({
  attachments,
  onRemove,
}: {
  attachments: PendingAttachment[];
  onRemove: (id: string) => void;
}) {
  return (
    <section className="attachment-tray" aria-label="Pending attachments">
      {attachments.map((attachment) => (
        <article className="pending-attachment" key={attachment.id}>
          {attachment.kind === 'file' ? <Paperclip aria-hidden /> : <Image aria-hidden />}
          <div>
            <strong>{attachment.name}</strong>
            <p>{attachment.mediaType} · {formatFileSize(attachment.size)} · local only</p>
          </div>
          <button type="button" onClick={() => onRemove(attachment.id)} aria-label={`Remove ${attachment.name}`}>
            <X aria-hidden />
          </button>
        </article>
      ))}
    </section>
  );
}

export function AttachmentMenu({ onPick }: { onPick: (kind: AttachmentKind) => void }) {
  return (
    <div className="attachment-menu" role="menu">
      <button type="button" role="menuitem" onClick={() => onPick('file')}>
        <Paperclip aria-hidden />
        Upload file
      </button>
      <button type="button" role="menuitem" onClick={() => onPick('image')}>
        <Image aria-hidden />
        Upload image
      </button>
      <button type="button" role="menuitem" onClick={() => onPick('camera')}>
        <Camera aria-hidden />
        Take photo
      </button>
    </div>
  );
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb >= 10 ? 0 : 1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`;
}
