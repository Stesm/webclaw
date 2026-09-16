/**
 * Naming rules for a conversation, shared by every surface that labels one.
 *
 * The gateway stores an operator-chosen `name` and, for unnamed sessions,
 * derives a `preview` from the session's first user message (already stripped
 * of the channel wall-clock marker and truncated by the backend). An explicit
 * name wins, the preview is the fallback label, and the raw session id is the
 * last resort when neither exists.
 */

export interface SessionTitleSource {
  name?: string;
  preview?: string;
  session_id: string;
}

/** Label for a conversation row: name, else preview, else the session id. */
export function sessionDisplayTitle(session: SessionTitleSource): string {
  const name = session.name?.trim();
  if (name) return name;
  const preview = session.preview?.trim();
  return preview || session.session_id;
}
