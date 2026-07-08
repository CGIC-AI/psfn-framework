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
import type { ApprovalPanelState } from '../lib/approvals.js';
import type { ArtifactShelfState } from '../lib/artifacts.js';
import type { AttachmentKind, PendingAttachment } from './types.js';

export function ToastLayer({
  approvals,
  artifacts,
  error,
  stacked,
  voiceNotice,
}: {
  approvals: ApprovalPanelState;
  artifacts: ArtifactShelfState;
  error: string | null;
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
        <article className="context-toast approval-toast" key={request.id}>
          <LockKeyhole aria-hidden />
          <div>
            <strong>Approval Request</strong>
            <p>{request.redactedContext}</p>
            <div className="toast-actions">
              <button type="button" disabled>Deny</button>
              <button type="button" disabled>Approve</button>
            </div>
          </div>
        </article>
      ))}
      {artifacts.items.map((item) => (
        <article className="context-toast artifact-toast" key={item.id}>
          <FileText aria-hidden />
          <div>
            <strong>Artifact Created</strong>
            <p>{item.label} · {item.mediaType}</p>
            <div className="toast-actions">
              <button type="button" disabled>View</button>
            </div>
          </div>
        </article>
      ))}
    </section>
  );
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
