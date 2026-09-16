import type { SessionMessageRow, TurnProgress, WsAttachment } from '@/types/api';
import { generateUUID } from '@/lib/uuid';

const MAX_MESSAGES = 100;
const PREFIX = 'zeroclaw_chat_history_v1:';

export interface PersistedChatBubble {
  id: string;
  role: 'user' | 'agent';
  content: string;
  thinking?: string;
  markdown?: boolean;
  /** Verbatim locally-composed user input — never gateway-prefixed, so the
   *  bubble skips stripServerTimestamp for it. (Server rows omit this.) */
  local?: boolean;
  toolCall?: { name: string; args?: unknown; output?: string };
  attachments?: WsAttachment[];
  timestamp: string;
}

function storageKey(sessionId: string): string {
  return `${PREFIX}${sessionId}`;
}

export function loadChatHistory(sessionId: string): PersistedChatBubble[] {
  try {
    const raw = localStorage.getItem(storageKey(sessionId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { messages?: PersistedChatBubble[] };
    if (!parsed.messages?.length) return [];
    return parsed.messages;
  } catch {
    return [];
  }
}

export function saveChatHistory(sessionId: string, messages: PersistedChatBubble[]): void {
  try {
    const slice = messages.slice(-MAX_MESSAGES);
    localStorage.setItem(storageKey(sessionId), JSON.stringify({ messages: slice }));
  } catch {
    // QuotaExceeded or private mode
  }
}

/**
 * Drop a conversation's cached transcript.
 *
 * Deleting a conversation has to take the local copy with it: the cache is
 * readable in the browser long after the gateway row is gone, which is not what
 * "delete" promises, and one key per conversation would otherwise accumulate
 * for as long as the origin's storage lives.
 */
export function removeChatHistory(sessionId: string): void {
  try {
    localStorage.removeItem(storageKey(sessionId));
  } catch {
    // Private mode — nothing was cached to begin with.
  }
}

/** Map server-persisted rows into UI messages (timestamps are synthetic for ordering). */
export function mapServerMessagesToPersisted(rows: SessionMessageRow[]): PersistedChatBubble[] {
  const base = Date.now() - rows.length * 1000;
  const out: PersistedChatBubble[] = [];
  let idx = 0;
  for (const row of rows) {
    if (row.role === 'system') continue;
    const ts = new Date(base + idx * 1000).toISOString();
    idx += 1;
    if (row.role === 'user') {
      // Persisted tool results arrive as a "[Tool results]" digest wrapping
      // <tool_result name="..."> blocks. Render each block as a tool card
      // instead of a raw user bubble.
      const results = parsePersistedToolResults(row.content);
      if (results) {
        for (const [name, output] of results) {
          out.push({
            id: generateUUID(),
            role: 'agent',
            content: '',
            markdown: false,
            toolCall: { name, output },
            timestamp: ts,
          });
        }
        continue;
      }
      out.push({
        id: generateUUID(),
        role: 'user',
        content: row.content,
        timestamp: ts,
      });
    } else if (row.role === 'assistant') {
      // Assistant rows may embed <tool_call>{...}</tool_call> blocks that were
      // part of the raw transcript. Split them into prose + tool cards.
      const { prose, calls } = parsePersistedToolCalls(row.content);
      if (prose.trim()) {
        out.push({
          id: generateUUID(),
          role: 'agent',
          content: prose,
          markdown: true,
          attachments: row.attachments,
          timestamp: ts,
        });
      } else if (row.attachments?.length) {
        // A turn whose only visible output was a delivered file has no prose;
        // keep the bubble so the attachment survives reload.
        out.push({
          id: generateUUID(),
          role: 'agent',
          content: '',
          markdown: false,
          attachments: row.attachments,
          timestamp: ts,
        });
      }
      for (const [name, args] of calls) {
        out.push({
          id: generateUUID(),
          role: 'agent',
          content: '',
          markdown: false,
          toolCall: { name, args },
          timestamp: ts,
        });
      }
    } else {
      out.push({
        id: generateUUID(),
        role: 'agent',
        content: row.content,
        markdown: false,
        attachments: row.attachments,
        timestamp: ts,
      });
    }
  }
  return out;
}

/** Extract <tool_call>{"name","arguments"}</tool_call> blocks from persisted assistant text. */
function parsePersistedToolCalls(content: string): {
  prose: string;
  calls: Array<[string, unknown | undefined]>;
} {
  if (!content.includes('<tool_call>')) {
    return { prose: content, calls: [] };
  }
  const calls: Array<[string, unknown | undefined]> = [];
  const prose = content
    .replace(/<tool_call>([\s\S]*?)<\/tool_call>/g, (_m, body: string) => {
      try {
        const parsed = JSON.parse(body.trim()) as { name?: string; arguments?: unknown };
        if (parsed.name) {
          calls.push([parsed.name, parsed.arguments]);
          return '';
        }
      } catch {
        // Malformed JSON: keep the raw block in prose.
      }
      return _m;
    })
    .trim();
  return { prose, calls };
}

/** Extract [Tool results] digests with <tool_result name="...">…</tool_result> blocks. */
function parsePersistedToolResults(content: string): Array<[string, string]> | null {
  if (!content.includes('<tool_result')) return null;
  const results: Array<[string, string]> = [];
  const re = /<tool_result\s+name="([^"]*)">([\s\S]*?)<\/tool_result>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    results.push([match[1] ?? '', match[2] ?? '']);
  }
  return results.length > 0 ? results : null;
}

export function persistedToUiMessages(
  rows: PersistedChatBubble[],
): Array<{
  id: string;
  role: 'user' | 'agent';
  content: string;
  thinking?: string;
  markdown?: boolean;
  local?: boolean;
  toolCall?: { name: string; args?: unknown; output?: string };
  attachments?: WsAttachment[];
  timestamp: Date;
}> {
  return rows.map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    thinking: m.thinking,
    markdown: m.markdown,
    local: m.local,
    toolCall: m.toolCall,
    attachments: m.attachments,
    timestamp: new Date(m.timestamp),
  }));
}

/**
 * Map the in-memory snapshot of a running gateway turn into UI messages: one
 * card per tool call (with output once it returns) followed by the accumulated
 * assistant text. Used to render live progress in a reopened tab, so it shows
 * what the surviving background turn is actually doing instead of a spinner.
 */
export function turnProgressToUiMessages(
  progress: TurnProgress,
): Array<{
  id: string;
  role: 'agent';
  content: string;
  thinking?: string;
  markdown?: boolean;
  local?: boolean;
  ephemeral?: boolean;
  toolCall?: { name: string; args?: unknown; output?: string };
  attachments?: WsAttachment[];
  timestamp: Date;
}> {
  const now = new Date();
  const out: Array<{
    id: string;
    role: 'agent';
    content: string;
    thinking?: string;
    markdown?: boolean;
    toolCall?: { name: string; args?: unknown; output?: string };
    timestamp: Date;
  }> = [];
  for (const call of progress.tool_calls) {
    const hasOutput = call.output !== undefined && call.output !== null;
    out.push({
      id: generateUUID(),
      role: 'agent',
      content: '',
      markdown: false,
      toolCall: { name: call.name, args: call.args, output: hasOutput ? call.output! : undefined },
      timestamp: now,
    });
  }
  const thinking = progress.thinking.trim();
  const text = progress.text.trim();
  if (text || thinking) {
    out.push({
      id: generateUUID(),
      role: 'agent',
      content: progress.text,
      thinking: thinking || undefined,
      markdown: true,
      timestamp: now,
    });
  }
  return out;
}

export function uiMessagesToPersisted(
  messages: Array<{
    id: string;
    role: 'user' | 'agent';
    content: string;
    thinking?: string;
    markdown?: boolean;
    local?: boolean;
    ephemeral?: boolean;
    toolCall?: { name: string; args?: unknown; output?: string };
    attachments?: WsAttachment[];
    timestamp: Date;
  }>,
): PersistedChatBubble[] {
  return messages
    // Skip messages flagged `ephemeral: true` (web slash-command output like
    // /help, /model banners, unknown-command notices). They are throwaway UI
    // feedback and must not be re-hydrated as fake assistant replies on reload. #7137
    .filter((m) => !m.ephemeral)
    .map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      thinking: m.thinking,
      markdown: m.markdown,
      // Preserve the verbatim-user-input flag so reloaded bubbles still skip
      // server-timestamp stripping.
      local: m.local,
      toolCall: m.toolCall,
      attachments: m.attachments,
      timestamp: m.timestamp.toISOString(),
    }));
}
