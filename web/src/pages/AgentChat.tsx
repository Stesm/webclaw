import { memo, useMemo, useState, useEffect, useRef, useCallback } from 'react';
import { Link, Navigate, useParams, useSearchParams } from 'react-router-dom';
import { Send, Square, Bot, User, AlertCircle, Copy, Check, X, Trash2, Minimize2, Maximize2, ChevronDown, ChevronUp, Wrench, BarChart2, FolderOpen, ImagePlus, Loader2 } from 'lucide-react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useAgent, type ChatMessage } from '@/contexts/AgentContext';
import { ApiError, uploadChatImage } from '@/lib/api';
import { useDraft } from '@/hooks/useDraft';
import { t } from '@/lib/i18n';
import {
  COMMANDS,
  helpText,
  isSlashCommand,
  matchCommands,
  parseCommand,
  type CommandSpec,
} from '@/lib/slashCommands';
import { Button } from '@/components/ui';
import ChatWorkspace from '@/pages/ChatWorkspace';

import ToolCallCard from '@/components/ToolCallCard';
import ApprovalBanner from '@/components/ApprovalBanner';
import { resolveContextBarState } from '@/lib/contextBar';
import SessionPicker from '@/components/SessionPicker';
import ChatAttachmentCard from '@/components/ChatAttachmentCard';
import AttachmentPreviewModal from '@/components/AttachmentPreviewModal';
import type { WsAttachment } from '@/types/api';
import { turnProgressToUiMessages } from '@/lib/chatHistoryStorage';
import { stripServerEnvelopes } from '@/lib/serverEnvelope';

const DRAFT_KEY_PREFIX = 'agent-chat';

// Open chat links in a new tab so navigation never replaces the live chat
// page. In-page anchors (e.g. GFM footnote refs) keep default navigation.
const markdownComponents: Components = {
  a: ({ node: _node, href, ...props }) =>
    href?.startsWith('#') ? (
      <a {...props} href={href} />
    ) : (
      <a {...props} href={href} target="_blank" rel="noopener noreferrer" />
    ),
};

/** Format token count with commas (e.g., 12345 -> "12,345"). */
function fmtTokens(n: number): string {
  return n.toLocaleString();
}

/** Context bar component showing context window usage. */
function ContextBar({ contextMaxTokens, contextModelWindow, contextInputTokens }: {
  contextMaxTokens: number | null;
  contextModelWindow: number | null;
  contextInputTokens: number | null;
}) {
  const state = resolveContextBarState(
    contextMaxTokens,
    contextModelWindow,
    contextInputTokens,
  );
  if (!state) return null;

  const label = `${t('agent.context_usage')}: ${fmtTokens(state.used).padStart(7)} / ${fmtTokens(state.denominator).padStart(7)}  [${state.cells}]  ${state.percent.toFixed(0)}%`;

  // A chip, not a bar: it shares the composer's status line with the status
  // pill, which is centered on the input, so it keeps to the right and shows
  // the whole meter only where there is room for it. The full label stays
  // reachable as the tooltip on a phone.
  return (
    <div
      className="flex shrink-0 items-center gap-1.5 text-[10px] font-mono"
      style={{ color: 'var(--pc-text-muted)' }}
      title={label}
    >
      <BarChart2 className="h-3 w-3" />
      <span className="hidden sm:inline">{label}</span>
      <span className="sm:hidden">{state.percent.toFixed(0)}%</span>
    </div>
  );
}

/**
 * Route entry point for `/agent/:alias`. Reads the alias from the URL and
 * hands it to the multi-agent ChatWorkspace as the initial chat to open and
 * activate. The workspace itself owns the set of open chats and never
 * remounts on tab/layout switches, so the alias is passed as a prop (not used
 * as a React `key`) — that keeps every chat's AgentProvider WebSocket alive
 * across tab switches. Missing alias → redirect to the agents list.
 */
export default function AgentChat() {
  const { alias } = useParams<{ alias: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  // One-shot conversation request from a dashboard deep link. Read here, not
  // in the workspace, so query-only navigations still reach it — the workspace
  // is never remounted (it owns live sockets), so it could not observe them.
  const requestedSessionId = searchParams.get('session') ?? undefined;

  // Consume the request: the workspace applied it in the same render this
  // value reached it, so drop the parameter (router-driven, hence `replace`)
  // to keep the URL honest. A later deep link to the same conversation sets it
  // again from `undefined`, which is what lets a repeat click land.
  useEffect(() => {
    if (!requestedSessionId) return;
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('session');
        return next;
      },
      { replace: true },
    );
  }, [requestedSessionId, setSearchParams]);

  if (!alias) {
    return <Navigate to="/agents" replace />;
  }
  return <ChatWorkspace initialAlias={alias} initialSessionId={requestedSessionId} />;
}

/** Status snapshot a chat pane pushes up to the workspace tab bar. */
export interface AgentChatStatus {
  typing: boolean;
  messageCount: number;
}

/**
 * Full chat view for a single agent. Must be rendered inside an
 * `<AgentProvider>` (it calls `useAgent()` internally). Exported so the
 * multi-agent `ChatWorkspace` can mount one instance per open chat and keep
 * them all alive simultaneously.
 *
 * `onStatus` lets the host (the workspace) observe live typing / message-count
 * changes per pane without itself subscribing to the agent context — used to
 * drive the streaming and unread indicators in the tab bar.
 */
export function AgentChatInner({
  agentAlias,
  onStatus,
  showChrome = true,
  onToggleChrome,
}: {
  agentAlias: string;
  onStatus?: (s: AgentChatStatus) => void;
  /**
   * Whether this pane renders its own chrome: the header pickers and the
   * action toolbar. The workspace hides them, together with its tab bar, behind
   * one side handle, so a phone can hand the whole viewport to the transcript.
   */
  showChrome?: boolean;
  /**
   * Collapse (or restore) the workspace chrome. Given, the pane's action
   * toolbar also carries the control that folds the chrome away — which is why
   * the toolbar exists at all for a conversation with no messages yet.
   */
  onToggleChrome?: () => void;
}) {
  const {
    messages,
    sendMessage,
    connected,
    error,
    typing,
    streamingContent,
    streamingThinking,
    currentModel,
    availableModels,
    switchModel,
    modelLoading,
    deleteMessage,
    clearAllMessages,
    startNewSession,
    sessionId,
    hydrated,
    addLocalMessage,
    abortSession,
    pendingApproval,
    respondToApproval,
    contextMaxTokens,
    contextModelWindow,
    contextInputTokens,
    liveProgress,
  } = useAgent();

  // Keyed by conversation, not just alias: with the same agent open in two
  // panes an alias-only key would make both share one draft, so typing in one
  // would overwrite the other's unsent message.
  const draftKey = `${DRAFT_KEY_PREFIX}.${agentAlias}.${sessionId}`;
  const { draft, saveDraft, clearDraft } = useDraft(draftKey);
  const [input, setInput] = useState(draft);
  // Mirror of `input` for writers that run after an await (an attachment
  // marker landing once the operator has typed more). A functional update
  // against React state alone could not also hand the final value to the draft
  // store, so the updater form of applyInput resolves against this instead.
  const inputValueRef = useRef(input);
  const writeInput = useCallback((value: string) => {
    inputValueRef.current = value;
    setInput(value);
  }, []);

  // `saveDraft` is bound to the conversation on screen when it was created.
  // A deferred writer (an upload that lands after the operator switched
  // conversations) reads the current text from `inputValueRef`, so it must
  // also write under the current key; using the key it captured would park
  // the text in the old conversation while showing it in the new one.
  // Resolve both at invocation time. Whether a deferred writer should instead
  // be dropped after a switch is the caller's decision.
  const saveDraftRef = useRef(saveDraft);
  saveDraftRef.current = saveDraft;

  /**
   * Single writer for the live composer text. Every change to what the
   * operator has typed (keystrokes, slash-command completion, a marker
   * appended by a later feature) goes through here so the per-conversation
   * draft store stays in step with the textarea. A bare `setInput` would leave
   * the stored draft behind and lose the change on the next conversation
   * switch. Accepts a value or an updater over the latest text; both the text
   * and the draft key are the ones current when it runs, not when it was
   * captured.
   */
  const applyInput = useCallback((next: string | ((prev: string) => string)) => {
    const value = typeof next === 'function' ? next(inputValueRef.current) : next;
    writeInput(value);
    saveDraftRef.current(value);
  }, [writeInput]);
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  // Slash-command autocomplete popover (#7137). Shown while the input begins
  // with a single '/' and the token still matches at least one command.
  const [showCommandHint, setShowCommandHint] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [compact, setCompact] = useState(() => {
    try { return localStorage.getItem('zeroclaw_chat_compact') === '1'; } catch { return false; }
  });
  // Tool execution is plumbing, not chat. Default off so tool_call /
  // tool_result frames do not surface inline in the conversation transcript.
  // Toggleable from the chat toolbar (Wrench button). The WebSocket lives in
  // AgentContext, which always pushes tool cards into messages; this toggle
  // filters them at render time so toggling on retroactively reveals prior
  // tool activity.
  const [showToolActivity, setShowToolActivity] = useState(() => {
    try { return localStorage.getItem('zeroclaw_show_tool_activity') === '1'; } catch { return false; }
  });

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const modelDropdownRef = useRef<HTMLDivElement>(null);
  // The composer floats over the transcript, so the scroll area reserves its
  // height at the end of the content (see the sentinel below). Measured rather
  // than assumed: the field grows with what is typed, and the status line and
  // the safe-area inset are part of the block.
  const composerRef = useRef<HTMLDivElement>(null);
  const [composerHeight, setComposerHeight] = useState(0);
  const messagesRef = useRef<HTMLDivElement>(null);
  // Whether the reader was at the bottom *before* the composer changed size.
  // Read there, not in the effect below: by the time the effect runs the
  // sentinel has already grown, and the distance to the bottom with it.
  const wasAtBottomRef = useRef(true);

  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    const update = () => {
      const scroller = messagesRef.current;
      if (scroller) {
        wasAtBottomRef.current =
          scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop < 64;
      }
      setComposerHeight(el.offsetHeight);
    };
    update();
    // Not every environment has the observer (a DOM-less test renderer does
    // not); the height is then simply whatever the first measurement said.
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // The field grows upward as the operator types, which would let it cover the
  // newest message on a reader parked at the bottom. Growth lands here (after
  // the sentinel has taken the new height), and only a reader who was already
  // at the bottom is moved with it — scrolling up to read is not interrupted.
  useEffect(() => {
    const scroller = messagesRef.current;
    if (!scroller || !wasAtBottomRef.current) return;
    scroller.scrollTop = scroller.scrollHeight;
  }, [composerHeight]);

  // AgentChatInner stays mounted while the selected conversation changes.
  // Load that conversation's draft explicitly; useState's initializer only ran
  // for the first session and cannot provide this synchronization by itself.
  useEffect(() => {
    writeInput(draft);
  }, [draftKey, draft, writeInput]);

  // Report live status (typing + message count) up to the host workspace so it
  // can render streaming / unread indicators in the tab bar. Fires on every
  // typing flip or message-count change; the workspace decides what to do with
  // it (e.g. mark a hidden tab unread when its count grows).
  useEffect(() => {
    onStatus?.({ typing, messageCount: messages.length });
  }, [typing, messages.length, onStatus]);

  // Scroll to bottom on new messages / streaming.
  // Note: WebSocket lifecycle, hydration, and tool_call/tool_result handling
  // moved to AgentContext (PR #6101). Tool activity is filtered at render
  // time below using `showToolActivity`, not at the message-handler layer.
  // `block: 'end'` matters now that the sentinel is as tall as the floating
  // composer: aligning its bottom with the scrollport's bottom leaves exactly
  // that much space under the newest message, where the field sits.
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, typing, streamingContent]);

  // Map the polled snapshot to live rows. `turnProgressToUiMessages` derives
  // stable ids from the snapshot itself, so a poll that adds text or resolves a
  // tool updates the existing rows in place instead of remounting them.
  const liveProgressUi = useMemo(
    () => (liveProgress ? turnProgressToUiMessages(liveProgress) : []),
    [liveProgress],
  );

  // Close model dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (modelDropdownRef.current && !modelDropdownRef.current.contains(e.target as Node)) {
        setShowModelDropdown(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  /**
   * Slash-command dispatcher (#7137). Returns true when `trimmed` was handled
   * as a command (and therefore must NOT be sent to the model as a prompt).
   * Commands drive existing session primitives — clear/reset and model switch —
   * and surface their feedback as local info messages, never to the gateway.
   */
  const runCommand = useCallback((trimmed: string): boolean => {
    if (!isSlashCommand(trimmed)) return false;

    const { command, args } = parseCommand(trimmed);
    switch (command) {
      case 'help':
        addLocalMessage(helpText());
        return true;

      case 'clear':
        clearAllMessages();
        addLocalMessage(t('agent.cmd_cleared'));
        return true;

      // Was an alias for /clear, which deleted the conversation. Now that an
      // agent can hold several, "new" means what it says: start another one and
      // leave this one on the gateway (issue #7543).
      case 'new':
        if (!startNewSession()) {
          addLocalMessage(t('agent.sessions_unavailable'));
        }
        return true;

      case 'upload':
        // Same picker as the attach button — the input click is allowed here
        // because runCommand fires from the user's Enter keypress, keeping
        // the browser's user-activation requirement satisfied.
        fileInputRef.current?.click();
        return true;

      case 'model': {
        const name = args.trim();
        if (!name) {
          const current = currentModel
            ? t('agent.cmd_model_current').replace('{model}', currentModel)
            : t('agent.cmd_model_none');
          const list = availableModels.length > 0
            ? `\n${t('agent.cmd_model_available').replace('{models}', availableModels.join(', '))}`
            : '';
          addLocalMessage(`${current}${list}`);
          return true;
        }
        if (name === currentModel) {
          addLocalMessage(t('agent.cmd_model_current').replace('{model}', name));
          return true;
        }
        if (availableModels.length > 0 && !availableModels.includes(name)) {
          addLocalMessage(
            t('agent.cmd_model_unknown')
              .replace('{model}', name)
              .replace('{models}', availableModels.join(', ')),
          );
          return true;
        }
        // switchModel silently no-ops while another switch is in flight, which
        // looks like the command was ignored. Surface that state explicitly. #7137
        if (modelLoading) {
          addLocalMessage(t('agent.cmd_model_busy'));
          return true;
        }
        addLocalMessage(t('agent.cmd_model_switching').replace('{model}', name));
        // Reuse the existing model-switch path (config write + socket rebuild).
        void switchModel(name).catch(() => {
          // switchModel surfaces its own error via context `error` state, but
          // the user just typed a command and expects inline feedback there too.
          addLocalMessage(t('agent.cmd_model_failed').replace('{model}', name));
        });
        return true;
      }

      default:
        addLocalMessage(t('agent.cmd_unknown').replace('{cmd}', `/${command}`));
        return true;
    }
  }, [addLocalMessage, clearAllMessages, startNewSession, currentModel, availableModels, switchModel, modelLoading]);

  const handleSend = () => {
    const trimmed = input.trim();
    if (!trimmed) return;

    // Slash commands are dispatched BEFORE the connectivity check so purely
    // local commands like /help still work during transient disconnects.
    // Network-dependent commands (/clear, /model) self-recover via their own
    // reconnect paths inside the context. #7137
    if (isSlashCommand(trimmed)) {
      runCommand(trimmed);
    } else {
      if (!connected) return;
      // `//` is the documented escape for a literal leading slash (#7223);
      // strip one `/` so `//foo` is sent to the agent as `/foo`.
      sendMessage(trimmed.startsWith('//') ? trimmed.slice(1) : trimmed);
    }
    setShowCommandHint(false);
    writeInput('');
    clearDraft();
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
      inputRef.current.focus();
    }
  };

  const isComposingRef = useRef(false);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape' && showCommandHint) {
      setShowCommandHint(false);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !isComposingRef.current) {
      e.preventDefault();
      handleSend();
    }
  };

  // ── Image upload (picker + drag-and-drop) ──────────────────────────────
  // Both gestures funnel into one helper: upload each file, then append the
  // returned [IMAGE:<path>] marker to the draft so the user can add context
  // before sending. The gateway sniffs the payload by magic bytes; the
  // client-side type filter only spares an obviously wrong file the round
  // trip. Failures surface as chat-local messages (same channel as unknown
  // slash commands), never as sent messages.
  const [uploading, setUploading] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // dragenter/dragleave fire per child element; a depth counter keeps the
  // overlay stable while the pointer crosses inner boundaries.
  const dragDepthRef = useRef(0);

  const uploadImages = useCallback(async (files: Iterable<File>) => {
    const list = Array.from(files);
    if (list.length === 0) return;
    setUploading(true);
    try {
      for (const file of list) {
        if (file.type && !file.type.startsWith('image/')) {
          addLocalMessage(t('agent.upload_not_image').replace('{name}', file.name));
          continue;
        }
        try {
          const res = await uploadChatImage(agentAlias, file);
          applyInput((prev) => `${prev && !prev.endsWith(' ') ? `${prev} ` : prev}${res.marker} `);
        } catch (err) {
          const message = err instanceof ApiError
            ? err.envelope.message
            : err instanceof Error ? err.message : String(err);
          addLocalMessage(t('agent.upload_failed').replace('{error}', message));
        }
      }
    } finally {
      setUploading(false);
      inputRef.current?.focus();
    }
  }, [agentAlias, addLocalMessage, applyInput]);

  const dragHasFiles = (e: React.DragEvent) => e.dataTransfer.types.includes('Files');

  const handleDragEnter = (e: React.DragEvent) => {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    dragDepthRef.current += 1;
    setDragActive(true);
  };
  const handleDragOver = (e: React.DragEvent) => {
    if (dragHasFiles(e)) e.preventDefault();
  };
  const handleDragLeave = (e: React.DragEvent) => {
    if (!dragHasFiles(e)) return;
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragActive(false);
  };
  const handleDrop = (e: React.DragEvent) => {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    dragDepthRef.current = 0;
    setDragActive(false);
    void uploadImages(e.dataTransfer.files);
  };

  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    applyInput(value);
    // Show the command popover while typing the command token (a single
    // leading '/' with no space yet). Hide once the user moves to arguments or
    // the token no longer matches any command.
    const showHint = /^\/[^/\s]*$/.test(value) && matchCommands(value.slice(1)).length > 0;
    setShowCommandHint(showHint);
    e.target.style.height = 'auto';
    e.target.style.height = `${Math.min(e.target.scrollHeight, 200)}px`;
  };

  // Apply a command from the autocomplete popover: fill the input with the
  // command and a trailing space (for arg-taking commands) or dispatch it
  // immediately when it takes no further input.
  const applyCommandHint = useCallback((spec: CommandSpec) => {
    setShowCommandHint(false);
    const takesArgs = spec.usage.includes('[');
    const value = `/${spec.name}${takesArgs ? ' ' : ''}`;
    applyInput(value);
    inputRef.current?.focus();
  }, [applyInput]);

  const matchedCommands: CommandSpec[] = /^\/[^/\s]*$/.test(input)
    ? matchCommands(input.slice(1))
    : COMMANDS.slice();

  const handleCopy = useCallback((msgId: string, content: string) => {
    const onSuccess = () => {
      setCopiedId(msgId);
      setTimeout(() => setCopiedId((prev) => (prev === msgId ? null : prev)), 2000);
    };

    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(content).then(onSuccess).catch(() => {
        fallbackCopy(content) && onSuccess();
      });
    } else {
      fallbackCopy(content) && onSuccess();
    }
  }, []);

  const handleDeleteMessage = useCallback((msgId: string) => {
    deleteMessage(msgId);
  }, [deleteMessage]);

  const [previewAttachment, setPreviewAttachment] = useState<WsAttachment | null>(null);
  const handlePreviewAttachment = useCallback((attachment: WsAttachment) => {
    setPreviewAttachment(attachment);
  }, []);
  const closePreviewAttachment = useCallback(() => setPreviewAttachment(null), []);

  const handleClearAll = useCallback(() => {
    clearAllMessages();
  }, [clearAllMessages]);

  // Stop button: POST /api/sessions/{id}/abort. The gateway cancels the
  // in-flight turn, the WS handler sends an `error` frame which our
  // onMessage handler already maps to typing=false.
  const handleAbort = useCallback(async () => {
    try {
      await abortSession();
    } catch {
      // Best-effort: surface nothing if the abort itself fails. The
      // user can retry, and any leaked typing state clears on the next
      // server frame.
    }
  }, [abortSession]);

  const toggleCompact = useCallback(() => {
    setCompact((prev) => {
      const next = !prev;
      try { localStorage.setItem('zeroclaw_chat_compact', next ? '1' : '0'); } catch { /* noop */ }
      return next;
    });
  }, []);

  const toggleToolActivity = useCallback(() => {
    setShowToolActivity((prev) => {
      const next = !prev;
      try { localStorage.setItem('zeroclaw_show_tool_activity', next ? '1' : '0'); } catch { /* noop */ }
      return next;
    });
  }, []);

  /**
   * Fallback copy using a temporary textarea for HTTP contexts
   * where navigator.clipboard is unavailable.
   */
  function fallbackCopy(text: string): boolean {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand('copy');
      return true;
    } catch {
      return false;
    } finally {
      document.body.removeChild(textarea);
    }
  }

  const handleModelSwitch = async (model: string) => {
    setShowModelDropdown(false);
    if (model === currentModel) return;
    try {
      await switchModel(model);
    } catch {
      // Error is already set by switchModel internally
    }
  };

  return (
    /* translate="no" / notranslate (#7057): browser auto-translation (e.g.
       Chrome → Google Translate) rewrites text nodes into <font> wrappers.
       React reconciliation then trips "Failed to execute 'removeChild' on
       'Node'" and unmounts the view. The crash repro surface spans every
       dynamic-text region on this page: streaming output, ReactMarkdown
       message bodies, the {error} banner above the toolbar, and
       ApprovalBanner (whose <pre>{argumentsSummary}</pre> and per-second
       remainingSec re-render are at least as crash-prone as streaming).
       Hoisting the opt-out to the outermost container covers all of them
       with a single ancestor. Static UI chrome here localizes through
       t() i18n, so losing browser translation on it is intentional. */
    <div
      translate="no"
      className="notranslate relative flex flex-col h-full min-h-0 min-w-0"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {dragActive && (
        <div
          className="absolute inset-2 z-50 flex items-center justify-center pointer-events-none rounded-[var(--radius-md)]"
          style={{
            border: '2px dashed var(--pc-accent)',
            background: 'color-mix(in srgb, var(--pc-accent) 10%, transparent)',
          }}
        >
          <span
            className="px-3 py-1.5 text-sm font-medium rounded-[var(--radius-md)]"
            style={{ background: 'var(--pc-bg-surface)', color: 'var(--pc-accent)' }}
          >
            {t('agent.drop_to_attach')}
          </span>
        </div>
      )}
      {/* Header with model selector. One row, never two: the conversation and
          model pickers are the parts that must stay on screen, and wrapping
          them onto a second line doubled the header's height and pushed the
          transcript into a vertical scroll on a phone. So the row stays rigid
          and the pickers absorb the pressure instead — they shrink and their
          labels truncate (see `SessionPicker` and the model button below).
          The agent name is redundant here: the workspace tab bar above
          already names the agent, so it only takes room on wider screens.
          Hidden while the workspace's chrome is collapsed. */}
      {showChrome && (
      <div className="flex items-center gap-2 px-4 py-2 border-b border-pc-border bg-pc-surface">
        <div className="flex items-center gap-2 min-w-0 shrink-0">
          <Bot className="h-4 w-4 text-pc-accent shrink-0" />
          <span className="hidden sm:inline text-sm font-medium text-pc-text truncate">
            {agentAlias}
          </span>
          <Link
            to={`/agent/${encodeURIComponent(agentAlias)}/workspace`}
            className="inline-flex items-center gap-1 px-2 h-6 rounded-[var(--radius-md)] text-xs font-medium text-pc-text-secondary transition-colors hover:text-pc-text hover:bg-[var(--pc-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pc-focus)] shrink-0"
            title={t('agentchat.open_workspace')}
            aria-label={t('agentchat.open_workspace')}
          >
            <FolderOpen className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">{t('agentchat.files')}</span>
          </Link>
        </div>

        <div className="flex items-center gap-2 min-w-0 ml-auto">
          <SessionPicker agentAlias={agentAlias} />

          {/* The model (network) picker keeps its full width: its alias is
              what the operator reads, and the conversation picker next to it
              is the one that can afford to truncate. */}
          <div className="relative shrink-0" ref={modelDropdownRef}>
            <button
              type="button"
              onClick={() => setShowModelDropdown((v) => !v)}
              disabled={modelLoading || typing || (availableModels.length === 0 && currentModel === null)}
              className="flex w-full items-center gap-2 px-3 h-7 rounded-[var(--radius-md)] text-xs font-medium border border-pc-border bg-pc-elevated text-pc-text-secondary transition-colors hover:text-pc-text hover:border-pc-border-strong disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pc-focus)] min-w-0"
            >
              <span className="min-w-0 truncate max-w-[130px] sm:max-w-[180px]">
                {modelLoading
                  ? t('agent.model_switching')
                  : (currentModel ?? (availableModels.length === 0 ? t('agent.model_loading') : t('agent.select_model')))}
              </span>
              <ChevronDown className="h-3 w-3" />
            </button>

            {showModelDropdown && availableModels.length > 0 && (
              <div className="absolute right-0 mt-1.5 rounded-[var(--radius-md)] border border-pc-border bg-pc-elevated shadow-[var(--pc-shadow-md)] z-50 py-1 min-w-[200px] max-w-[calc(100vw-2rem)] max-h-60 overflow-y-auto">
                {availableModels.map((model) => {
                  const isActive = model === currentModel;
                  return (
                    <button
                      key={model}
                      type="button"
                      onClick={() => handleModelSwitch(model)}
                      className={`w-full text-left px-3 py-2 text-xs transition-colors ${
                        isActive
                          ? 'text-pc-accent bg-pc-accent/10'
                          : 'text-pc-text hover:bg-[var(--pc-hover)]'
                      }`}
                    >
                      {model}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
      )}

      {/* Connection status bar */}
      {error && (
        <div className="px-4 py-2 border-b border-status-error/20 bg-status-error/10 text-status-error flex items-center gap-2 text-sm animate-fade-in">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {/* Chat toolbar. Icon-only on a phone: three labelled buttons did not
          fit one line, and wrapping them onto a second line cost the same
          vertical space the header was just refunded. Every button keeps its
          accessible name. Hidden with the rest of the pane chrome — and the
          row exists for an empty conversation only to hold the control that
          folds the chrome away, since the workspace's own handle row is not
          there while the chrome is open. */}
      {showChrome && (messages.length > 0 || onToggleChrome) && (
        <div className="flex items-center justify-end gap-2 px-4 py-2 border-b border-pc-border bg-pc-surface">
          {messages.length > 0 && (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={toggleCompact}
                aria-label={t('agent.compact_mode')}
              >
                {compact ? <Maximize2 className="h-3 w-3" /> : <Minimize2 className="h-3 w-3" />}
                <span className="hidden sm:inline">{t('agent.compact_mode')}</span>
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={toggleToolActivity}
                aria-label={showToolActivity ? t('agent.tool_activity_hide') : t('agent.tool_activity_show')}
                aria-pressed={showToolActivity}
              >
                <Wrench className="h-3 w-3" />
                <span className="hidden sm:inline">
                  {showToolActivity ? t('agent.tool_activity_hide') : t('agent.tool_activity_show')}
                </span>
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={handleClearAll}
                aria-label={t('agent.clear_all')}
              >
                <Trash2 className="h-3 w-3" />
                <span className="hidden sm:inline">{t('agent.clear_all')}</span>
              </Button>
            </>
          )}
          {onToggleChrome && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onToggleChrome}
              aria-expanded={showChrome}
              aria-label={t('agent.chat_panel_toggle')}
              title={t('agent.chat_panel_toggle')}
            >
              <ChevronUp className="h-3 w-3" />
            </Button>
          )}
        </div>
      )}

      {/* Messages area. It spans the pane's whole height: the composer floats
          over it, so the transcript — and the empty-state block below — reads
          to the bottom of the page instead of stopping above the field. */}
      <div
        ref={messagesRef}
        className={`flex-1 overflow-y-auto p-4 ${compact ? 'space-y-1.5' : 'space-y-4'}`}
      >
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center animate-fade-in text-pc-text-muted">
            <div className="h-14 w-14 rounded-[var(--radius-lg)] flex items-center justify-center mb-4 bg-pc-accent/10">
              <Bot className="h-7 w-7 text-pc-accent" />
            </div>
            {/* Until the transcript lands, an empty list means "still loading",
                not "empty conversation" — saying the latter misreports a
                conversation the operator just picked precisely because it has
                history in it. */}
            {hydrated ? (
              <>
                <p className="text-base font-semibold mb-1 text-pc-text">{t('agentchat.empty_title')}</p>
                <p className="text-sm text-pc-text-muted">{t('agent.start_conversation')}</p>
              </>
            ) : (
              <p className="text-sm text-pc-text-muted">{t('agent.session_loading')}</p>
            )}
          </div>
        )}

        {messages
          .filter((msg) => showToolActivity || !msg.toolCall)
          .map((msg, idx) => (
            <MessageItem
              key={msg.id}
              msg={msg}
              idx={idx}
              compact={compact}
              agentAlias={agentAlias}
              isCopied={copiedId === msg.id}
              onCopy={handleCopy}
              onDelete={handleDeleteMessage}
              onPreviewAttachment={handlePreviewAttachment}
            />
          ))}

        {/* Live progress of a turn another connection owns (e.g. a background
            turn that survived this tab closing). Rendered from the polled
            in-memory snapshot so a reopened tab shows the running tools and
            partial text instead of an opaque spinner. */}
        {liveProgressUi
          .filter((msg) => showToolActivity || !msg.toolCall)
          .map((msg, idx) => (
            <MessageItem
              key={msg.id}
              msg={msg}
              idx={idx}
              compact={compact}
              agentAlias={agentAlias}
              isCopied={false}
              onCopy={handleCopy}
              onDelete={handleDeleteMessage}
              onPreviewAttachment={handlePreviewAttachment}
            />
          ))}

        {typing && liveProgressUi.length === 0 && (
          <div className="flex items-start gap-3 animate-fade-in">
            <div className="flex-shrink-0 w-8 h-8 rounded-[var(--radius-md)] flex items-center justify-center border border-pc-border bg-pc-elevated">
              <Bot className="h-4 w-4 text-pc-accent" />
            </div>
            {streamingContent || streamingThinking ? (
              <div className="rounded-[var(--radius-lg)] px-4 py-3 border border-pc-border bg-pc-elevated text-pc-text max-w-[75%]">
                {streamingThinking && (
                  <details className="mb-2" open={!streamingContent}>
                    <summary className="text-xs cursor-pointer select-none text-pc-text-muted">{t('agentchat.thinking')}{!streamingContent && '...'}</summary>
                    <pre className="text-xs mt-1 whitespace-pre-wrap break-words leading-relaxed overflow-auto max-h-60 p-2 rounded-[var(--radius-sm)] text-pc-text-muted bg-pc-code">{streamingThinking}</pre>
                  </details>
                )}
                {streamingContent && <p className="text-sm whitespace-pre-wrap break-words leading-relaxed">{streamingContent}</p>}
              </div>
            ) : (
              <div className="rounded-[var(--radius-lg)] px-4 py-3 border border-pc-border bg-pc-elevated flex items-center gap-1.5">
                <span className="bounce-dot w-1.5 h-1.5 rounded-full bg-pc-accent" />
                <span className="bounce-dot w-1.5 h-1.5 rounded-full bg-pc-accent" />
                <span className="bounce-dot w-1.5 h-1.5 rounded-full bg-pc-accent" />
              </div>
            )}
          </div>
        )}

        <div ref={messagesEndRef} style={{ height: composerHeight || undefined }} />
      </div>

      {previewAttachment && (
        <AttachmentPreviewModal
          attachment={previewAttachment}
          agentAlias={agentAlias}
          onClose={closePreviewAttachment}
        />
      )}

      {/* Input area, floating over the transcript: the messages scroll the pane's
          whole height and pass under this, so a bubble is visible next to and
          below the field instead of the chat stopping above it. The sentinel at
          the end of the transcript is as tall as this block, which is what keeps
          the newest message clear of the field when the reader is at the bottom.
          The block itself paints nothing: no background, no top border, so the
          bottom of the chat is the transcript's own surface. The two things that
          do carry a background are the field and the status pill — and the field
          is the input: the attach and send/stop controls live inside its border,
          so they cost no height of their own. The bottom safe-area inset is
          padding, not height: with `viewport-fit=cover` the composer would
          otherwise sit under the home indicator of an installed PWA and the
          system gesture would steal the tap. `max()` rather than a sum — the app
          is already sized to the dynamic viewport, so the inset is the whole
          allowance and adding the usual padding on top would open a second
          gap. */}
      <div
        ref={composerRef}
        className="absolute inset-x-0 bottom-0 z-20 flex flex-col bg-transparent"
      >
        {/* Tool approval banner — supervised-mode consent prompt (#6522).
            Inside the overlay so a parked approval stays above the field it
            would otherwise be covered by. */}
        {pendingApproval && (
          <ApprovalBanner pending={pendingApproval} onRespond={respondToApproval} />
        )}
        <div className="bg-transparent px-3 pt-1 pb-[max(0.5rem,calc(env(safe-area-inset-bottom)-1.125rem))]">
        {/* Slash-command autocomplete popover (#7137) */}
        {showCommandHint && matchedCommands.length > 0 && (
          <div className="relative max-w-4xl mx-auto">
            <div
              className="absolute bottom-1 left-0 rounded-xl border shadow-lg z-50 py-1 min-w-[260px] overflow-hidden"
              style={{ background: 'var(--pc-bg-elevated)', borderColor: 'var(--pc-border)' }}
            >
              <div
                className="px-3 py-1 text-[10px] uppercase tracking-wide"
                style={{ color: 'var(--pc-text-faint)' }}
              >
                {t('agent.cmd_hint_title')}
              </div>
              {matchedCommands.map((spec) => (
                <button
                  key={spec.name}
                  type="button"
                  onMouseDown={(e) => { e.preventDefault(); applyCommandHint(spec); }}
                  className="w-full text-left px-3 py-2 text-xs transition-colors flex items-center gap-2"
                  style={{ color: 'var(--pc-text-primary)' }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--pc-bg-surface)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                >
                  <span className="font-mono font-medium" style={{ color: 'var(--pc-accent)' }}>{spec.usage}</span>
                  <span className="truncate" style={{ color: 'var(--pc-text-muted)' }}>{t(spec.descriptionKey)}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="max-w-4xl mx-auto">
          {/* One field, not a field with satellites: the attach and send/stop
              controls live inside the input's own border, so the composer
              reads as a single line of UI and the buttons cost no extra
              height. `appearance-none` on every control in it is deliberate:
              iOS Safari gives a form control its own native backing and border
              otherwise, which showed up on the phone as an opaque plaque
              inside this block that no stylesheet of ours had painted.
              At rest the field is translucent so the transcript under it stays
              readable; focus is the single highlight — an accent border, no
              separate ring, which read as a second outline on the phone. */}
          <div className="flex items-end gap-1 rounded-[var(--radius-lg)] border border-pc-border bg-pc-input px-1.5 py-1.5 opacity-70 transition-[opacity,background-color,border-color] focus-within:border-pc-accent focus-within:bg-pc-input focus-within:opacity-100">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files) void uploadImages(e.target.files);
                // Reset so picking the same file again re-fires onChange.
                e.target.value = '';
              }}
            />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="flex-shrink-0 w-8 h-8 px-0 appearance-none"
              aria-label={t('agent.attach_image')}
              title={t('agent.attach_image')}
            >
              {uploading
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : <ImagePlus className="h-4 w-4" />}
            </Button>
            {/* `outline` is inline, not just a utility: the app's global
                `:focus-visible` ring (index.css) outranks Tailwind's
                `focus:outline-none` here, and Safari treats a text field as
                focus-visible even on a tap — so the ring appeared inside the
                field, reading as a second outline next to the field's own
                accent border. The border is the focus indicator. */}
            <textarea
              ref={inputRef}
              rows={1}
              value={input}
              onChange={handleTextareaChange}
              onKeyDown={handleKeyDown}
              onCompositionStart={() => { isComposingRef.current = true; }}
              onCompositionEnd={() => { isComposingRef.current = false; }}
              placeholder={!connected
                ? t('agent.connecting')
                : !hydrated
                  ? t('agent.session_loading')
                  : typing
                    ? t('agent.running')
                    : t('agent.type_message')}
              disabled={!connected || typing || !hydrated}
              className="flex-1 min-w-0 appearance-none bg-transparent px-1 text-sm text-pc-text resize-none placeholder:text-pc-text-muted disabled:opacity-40"
              style={{ minHeight: '32px', maxHeight: '200px', paddingTop: '6px', paddingBottom: '6px', outline: 'none' }}
            />
            {typing ? (
              <Button
                variant="danger"
                size="sm"
                onClick={handleAbort}
                className="flex-shrink-0 w-8 h-8 px-0 appearance-none"
                aria-label={t('agent.stop')}
                title={t('agent.stop')}
              >
                <Square className="h-3.5 w-3.5" fill="currentColor" />
              </Button>
            ) : (
              <Button
                variant="primary"
                size="sm"
                onClick={handleSend}
                disabled={!connected || !hydrated || !input.trim()}
                className="flex-shrink-0 w-8 h-8 px-0 appearance-none"
                aria-label={t('agent.send')}
              >
                <Send className="h-4 w-4" />
              </Button>
            )}
          </div>

          {/* Status, centered under the field, carried by the pill's own color
              — a dot plus a label said the same thing twice and took a row.
              The context meter keeps the far right of that row, where it stays
              out of the centered pill's way on a phone. */}
          <div className="relative mt-2 flex items-center justify-center">
            <span
              className={`rounded-full px-2.5 py-0.5 text-[10px] font-medium ${
                typing
                  ? 'bg-pc-accent/15 text-pc-accent'
                  : connected
                    ? 'bg-status-success/15 text-status-success'
                    : 'bg-status-error/15 text-status-error'
              }`}
            >
              {typing
                ? t('agent.running')
                : connected
                  ? t('agent.connected_status')
                  : t('agent.disconnected_status')}
            </span>
            <div className="absolute right-0">
              <ContextBar contextMaxTokens={contextMaxTokens} contextModelWindow={contextModelWindow} contextInputTokens={contextInputTokens} />
            </div>
          </div>
        </div>
      </div>
      </div>
    </div>
  );
}

// Server-owned markers (the channel wall-clock stamp, the runtime's
// date/time envelope) are stripped for display and copy; the bubble shows its
// own wall-clock caption separately. See `@/lib/serverEnvelope`.

// Each chat message is rendered through this memoized component so that
// typing into the input does not re-render every existing message (and
// re-run ReactMarkdown on each one). Keep the prop surface small and pass
// `isCopied` rather than the parent's full copiedId so only the affected
// row re-renders when the copy indicator flips. See #5125.
interface MessageItemProps {
  msg: ChatMessage;
  idx: number;
  compact: boolean;
  agentAlias: string;
  isCopied: boolean;
  onCopy: (id: string, content: string) => void;
  onDelete: (id: string) => void;
  onPreviewAttachment: (attachment: WsAttachment) => void;
}

const MessageItem = memo(function MessageItem({
  msg,
  idx,
  compact,
  agentAlias,
  isCopied,
  onCopy,
  onDelete,
  onPreviewAttachment,
}: MessageItemProps) {
  // Locally-composed user input and locally-generated command output are
  // verbatim and never carry the gateway's `[timestamp]` prefix, so don't strip
  // them (that would clip a message starting with a bracketed datetime). Only
  // server-sourced messages can be prefixed.
  const cleanContent = msg.local || msg.ephemeral ? msg.content : stripServerEnvelopes(msg.content);

  return (
    <div
      className={`group flex items-start ${compact ? 'gap-2' : 'gap-3'} ${
        msg.role === 'user' ? 'flex-row-reverse animate-slide-in-right' : 'animate-slide-in-left'
      }`}
      style={{ animationDelay: `${Math.min(idx * 30, 200)}ms` }}
    >
      {!compact && (
        <div
          className={`flex-shrink-0 w-8 h-8 rounded-[var(--radius-md)] flex items-center justify-center border ${
            msg.notice
              ? 'bg-status-warning/10 border-status-warning/30'
              : msg.role === 'user'
              ? 'bg-pc-accent/15 border-pc-accent/30'
              : 'bg-pc-elevated border-pc-border'
          }`}
        >
          {msg.notice ? (
            <AlertCircle className="h-4 w-4 text-status-warning" />
          ) : msg.role === 'user' ? (
            <User className="h-4 w-4 text-pc-accent" />
          ) : (
            <Bot className="h-4 w-4 text-pc-accent" />
          )}
        </div>
      )}
      {/* Compact mode on a phone: the bubble takes 90-95% of the row, so the
          leftover is a single offset on the far side rather than a wide
          gutter on both. Wider screens keep the roomier 75%. */}
      <div className={`relative ${compact ? 'max-w-[92%] sm:max-w-[75%]' : 'max-w-[75%]'}`}>
        <div
          className={`${compact ? 'rounded-[var(--radius-md)] px-3 py-1.5 border' : 'rounded-[var(--radius-lg)] px-4 py-3 border'} text-pc-text ${
            msg.notice
              ? 'bg-status-warning/5 border-status-warning/30'
              : msg.role === 'user'
              ? 'bg-pc-accent/10 border-pc-accent/20'
              : 'bg-pc-elevated border-pc-border'
          }`}
        >
          {msg.thinking && (
            <details className="mb-2">
              <summary className="text-xs cursor-pointer select-none text-pc-text-muted">{t('agentchat.thinking')}</summary>
              <pre className="text-xs mt-1 whitespace-pre-wrap break-words leading-relaxed overflow-auto max-h-60 p-2 rounded-[var(--radius-sm)] text-pc-text-muted bg-pc-code">{msg.thinking}</pre>
            </details>
          )}
          {msg.toolCall ? (
            <ToolCallCard toolCall={msg.toolCall} />
          ) : msg.markdown ? (
            <div className={`${compact ? 'text-xs' : 'text-sm'} break-words leading-relaxed chat-markdown`}><ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{cleanContent}</ReactMarkdown></div>
          ) : (
            <p className={`${compact ? 'text-xs' : 'text-sm'} whitespace-pre-wrap break-words leading-relaxed`}>{cleanContent}</p>
          )}
          {msg.attachments?.map((attachment) => (
            <ChatAttachmentCard
              key={attachment.id}
              attachment={attachment}
              agentAlias={agentAlias}
              onPreview={onPreviewAttachment}
            />
          ))}
          {!compact && (
            <p className="text-[10px] mt-1.5 text-pc-text-faint">
              {msg.timestamp.toLocaleTimeString()}
            </p>
          )}
        </div>
        <div className="flex items-center justify-end gap-1 mt-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={() => onCopy(msg.id, cleanContent)}
            aria-label={t('agent.copy_message')}
            className="p-1 rounded-[var(--radius-sm)] text-pc-text-muted hover:text-pc-text transition-colors"
          >
            {isCopied ? (
              <Check className="h-3.5 w-3.5 text-status-success" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
          </button>
          <button
            onClick={() => onDelete(msg.id)}
            aria-label={t('agent.delete_message')}
            className="p-1 rounded-[var(--radius-sm)] text-pc-text-muted hover:text-status-error transition-colors"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
});
