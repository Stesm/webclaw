import { useEffect, useRef, useState } from 'react';
import { AlertCircle, Loader2, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { WsAttachment } from '@/types/api';
import { fetchAgentAttachment } from '@/lib/api';
import { attachmentPreviewKind, type AttachmentPreviewKind } from '@/lib/attachments';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { t } from '@/lib/i18n';

interface AttachmentPreviewModalProps {
  attachment: WsAttachment;
  agentAlias: string;
  onClose: () => void;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; kind: AttachmentPreviewKind; text?: string; url?: string }
  | { status: 'error'; message: string };

/**
 * Popup that renders a delivered file inline. Images render from an object
 * URL, Markdown through the same renderer as chat, plain text in a `<pre>`,
 * and HTML in a script-disabled sandboxed iframe. Non-previewable types never
 * reach this component (the card hides the preview action).
 */
export default function AttachmentPreviewModal({
  attachment,
  agentAlias,
  onClose,
}: AttachmentPreviewModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  useFocusTrap(panelRef, { onClose });

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | undefined;
    const kind = attachmentPreviewKind(attachment) ?? 'text';

    (async () => {
      try {
        const blob = await fetchAgentAttachment(agentAlias, attachment.id);
        if (cancelled) return;
        if (kind === 'image') {
          objectUrl = URL.createObjectURL(blob);
          setState({ status: 'ready', kind, url: objectUrl });
        } else {
          const text = await blob.text();
          if (!cancelled) setState({ status: 'ready', kind, text });
        }
      } catch (err) {
        if (!cancelled) {
          setState({
            status: 'error',
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    })();

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [agentAlias, attachment]);

  const title = attachment.title || attachment.filename;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('attachment.preview_title')}
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-pc-base/70 backdrop-blur-sm" />
      <div
        ref={panelRef}
        className="relative flex w-full max-w-4xl max-h-[85vh] flex-col rounded-[var(--radius-xl)] border border-pc-border bg-pc-base shadow-[var(--pc-shadow-md)] animate-fade-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-pc-border px-4 py-3">
          <h2 className="truncate text-sm font-semibold text-pc-text">{title}</h2>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label={t('attachment.close')}
            className="rounded-[var(--radius-sm)] p-1 text-pc-text-muted transition-colors hover:bg-pc-elevated hover:text-pc-text"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-auto p-4">
          {state.status === 'loading' && (
            <div className="flex items-center justify-center gap-2 py-12 text-sm text-pc-text-muted">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('attachment.loading')}
            </div>
          )}

          {state.status === 'error' && (
            <div className="flex items-center justify-center gap-2 py-12 text-sm text-status-error">
              <AlertCircle className="h-4 w-4" />
              {t('attachment.load_failed')}
            </div>
          )}

          {state.status === 'ready' && state.kind === 'image' && state.url && (
            <img
              src={state.url}
              alt={title}
              className="mx-auto max-h-[70vh] max-w-full rounded-[var(--radius-md)]"
            />
          )}

          {state.status === 'ready' && state.kind === 'markdown' && (
            <div className="chat-markdown text-sm break-words leading-relaxed text-pc-text">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{state.text ?? ''}</ReactMarkdown>
            </div>
          )}

          {state.status === 'ready' && state.kind === 'html' && (
            <iframe
              title={title}
              sandbox=""
              srcDoc={state.text ?? ''}
              className="h-[70vh] w-full rounded-[var(--radius-md)] border border-pc-border bg-white"
            />
          )}

          {state.status === 'ready' && state.kind === 'text' && (
            <pre className="whitespace-pre-wrap break-words rounded-[var(--radius-sm)] bg-pc-code p-3 font-mono text-xs leading-relaxed text-pc-text-secondary">
              {state.text ?? ''}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
