import { useState } from 'react';
import {
  Download,
  Eye,
  File as FileIcon,
  FileCode,
  FileText,
  Image as ImageIcon,
  Loader2,
} from 'lucide-react';
import type { WsAttachment } from '@/types/api';
import { fetchAgentAttachment } from '@/lib/api';
import {
  attachmentPreviewKind,
  formatAttachmentSize,
  type AttachmentPreviewKind,
} from '@/lib/attachments';
import { t } from '@/lib/i18n';

interface ChatAttachmentCardProps {
  attachment: WsAttachment;
  agentAlias: string;
  onPreview: (attachment: WsAttachment) => void;
}

function iconFor(kind: AttachmentPreviewKind | null) {
  switch (kind) {
    case 'image':
      return ImageIcon;
    case 'markdown':
    case 'text':
      return FileText;
    case 'html':
      return FileCode;
    default:
      return FileIcon;
  }
}

/**
 * One delivered-file row rendered under a chat bubble: MIME-based icon, title,
 * size, a download action, and a preview action for previewable types.
 */
export default function ChatAttachmentCard({
  attachment,
  agentAlias,
  onPreview,
}: ChatAttachmentCardProps) {
  const [downloading, setDownloading] = useState(false);
  const kind = attachmentPreviewKind(attachment);
  const Icon = iconFor(kind);
  const size = formatAttachmentSize(attachment.size);
  const label = attachment.title || attachment.filename;

  const handleDownload = async () => {
    setDownloading(true);
    try {
      const blob = await fetchAgentAttachment(agentAlias, attachment.id);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = attachment.filename || label || 'file';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch {
      // Download failures are non-fatal; the row stays available to retry.
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="mt-2 flex items-center gap-2 rounded-[var(--radius-md)] border border-pc-border bg-pc-base/40 px-3 py-2">
      <Icon className="h-5 w-5 flex-shrink-0 text-pc-accent" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium text-pc-text">{label}</p>
        {size && <p className="text-[10px] text-pc-text-faint">{size}</p>}
      </div>
      {kind && (
        <button
          type="button"
          onClick={() => onPreview(attachment)}
          aria-label={t('attachment.preview')}
          title={t('attachment.preview')}
          className="flex items-center gap-1 rounded-[var(--radius-sm)] px-2 py-1 text-[11px] text-pc-text-muted transition-colors hover:bg-pc-elevated hover:text-pc-text"
        >
          <Eye className="h-3.5 w-3.5" />
          {t('attachment.preview')}
        </button>
      )}
      <button
        type="button"
        onClick={handleDownload}
        disabled={downloading}
        aria-label={t('attachment.download')}
        title={t('attachment.download')}
        className="flex items-center gap-1 rounded-[var(--radius-sm)] px-2 py-1 text-[11px] text-pc-text-muted transition-colors hover:bg-pc-elevated hover:text-pc-text disabled:opacity-60"
      >
        {downloading ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Download className="h-3.5 w-3.5" />
        )}
        {t('attachment.download')}
      </button>
    </div>
  );
}
