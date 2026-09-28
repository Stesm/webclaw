import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Loader2, X } from 'lucide-react';
import ToolCallCard from '@/components/ToolCallCard';
import { Badge, Button } from '@/components/ui';
import { getCronRunLog, getSessionMessages } from '@/lib/api';
import { mapServerMessagesToPersisted } from '@/lib/chatHistoryStorage';
import { formatRelative } from '@/lib/format';
import { t } from '@/lib/i18n';
import type { CronRunLogResponse } from '@/types/api';

type ViewerMessage = {
  id: string;
  role: 'user' | 'agent';
  content: string;
  markdown?: boolean;
  toolCall?: { name: string; args?: unknown; output?: string };
};

interface SessionViewerModalProps {
  /** Persisted session key (channel sessions) to render read-only. */
  sessionKey?: string;
  /** Cron job whose current/latest run transcript to render, polled live. */
  cronJobId?: string;
  title?: string;
  onClose: () => void;
}

const markdownComponents: Components = {
  a: ({ ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
};

function cronMessagesToViewer(messages: CronRunLogResponse['messages']): ViewerMessage[] {
  return messages.map((msg, i) => {
    switch (msg.type) {
      case 'user':
        return { id: `cron:${i}`, role: 'user', content: msg.content };
      case 'assistant':
        return { id: `cron:${i}`, role: 'agent', content: msg.content, markdown: true };
      case 'tool':
        return {
          id: `cron:${i}`,
          role: 'agent',
          content: '',
          toolCall: {
            name: msg.name,
            args: msg.args,
            output: msg.output ?? undefined,
          },
        };
    }
  });
}

/**
 * Read-only transcript viewer. Renders a persisted channel session, or a cron
 * run log — the cron variant polls while the run is still `running` so the
 * operator watches the transcript grow instead of waiting for the turn.
 */
export default function SessionViewerModal({
  sessionKey,
  cronJobId,
  title,
  onClose,
}: SessionViewerModalProps) {
  const isCron = cronJobId !== undefined;
  const [messages, setMessages] = useState<ViewerMessage[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const generationRef = useRef(0);

  const load = useCallback(async () => {
    const generation = ++generationRef.current;
    try {
      if (isCron) {
        const log = await getCronRunLog(cronJobId!);
        if (generation !== generationRef.current) return;
        setStatus(log.status);
        setMessages(cronMessagesToViewer(log.messages));
      } else {
        const data = await getSessionMessages(sessionKey!);
        if (generation !== generationRef.current) return;
        setMessages(
          mapServerMessagesToPersisted(data.messages).map((bubble) => ({
            id: bubble.id,
            role: bubble.role,
            content: bubble.content,
            markdown: bubble.markdown,
            toolCall: bubble.toolCall,
          })),
        );
      }
      setError(null);
    } catch (err) {
      if (generation !== generationRef.current) return;
      setError(err instanceof Error ? err.message : t('viewer.load_error'));
    } finally {
      if (generation === generationRef.current) setLoading(false);
    }
  }, [cronJobId, isCron, sessionKey]);

  useEffect(() => {
    void load();
  }, [load]);

  // Poll a live cron run so the transcript grows as the agent works. Stop once
  // the run reaches a terminal status.
  useEffect(() => {
    if (!isCron || status === null || status !== 'running') return;
    const timer = setInterval(() => void load(), 2000);
    return () => clearInterval(timer);
  }, [isCron, status, load]);

  useEffect(() => {
    function handleEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [onClose]);

  const heading = useMemo(
    () => title ?? (isCron ? t('viewer.cron_title') : t('viewer.session_title')),
    [isCron, title],
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'var(--pc-overlay, rgba(0,0,0,0.5))' }}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={heading}
        className="bg-pc-surface border border-pc-border rounded-[var(--radius-lg)] shadow-[var(--pc-shadow-md)] w-full max-w-3xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-5 py-3 border-b border-pc-border">
          <h3 className="text-base font-semibold text-pc-text">{heading}</h3>
          {isCron && status && (
            <Badge tone={status === 'ok' ? 'ok' : status === 'error' ? 'error' : 'neutral'}>
              {status}
            </Badge>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={onClose}
            aria-label={t('viewer.close')}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
          {loading && (
            <div className="flex items-center gap-2 text-xs text-pc-text-muted">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('viewer.loading')}
            </div>
          )}
          {error && <p className="text-sm text-status-error">{error}</p>}
          {!loading && !error && messages.length === 0 && (
            <p className="text-sm text-pc-text-muted">{t('viewer.empty')}</p>
          )}
          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`rounded-[var(--radius-lg)] px-4 py-3 border text-pc-text max-w-[85%] ${
                  msg.role === 'user'
                    ? 'bg-pc-accent/10 border-pc-accent/20'
                    : 'bg-pc-elevated border-pc-border'
                }`}
              >
                {msg.toolCall ? (
                  <ToolCallCard toolCall={msg.toolCall} />
                ) : msg.markdown ? (
                  <div className="text-sm break-words leading-relaxed">
                    <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                      {msg.content}
                    </ReactMarkdown>
                  </div>
                ) : (
                  <p className="text-sm whitespace-pre-wrap break-words leading-relaxed">
                    {msg.content}
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>

        {isCron && status === 'running' && (
          <div className="px-5 py-2 border-t border-pc-border text-[11px] text-pc-text-muted">
            {t('viewer.live')} · {formatRelative(new Date().toISOString())}
          </div>
        )}
      </div>
    </div>
  );
}
