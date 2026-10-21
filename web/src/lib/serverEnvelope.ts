/**
 * Server-owned metadata that must never reach the operator's eyes.
 *
 * Two different owners prepend a marker to a user turn:
 *
 * - The channel orchestrator stamps a wall-clock marker
 *   (`[YYYY-MM-DD HH:MM:SS TZ] `) on persisted channel turns.
 * - The agent runtime stamps its own clock on every turn before it reaches
 *   the provider (`[CURRENT DATE & TIME: <stamp>]`). The prefix is the
 *   model's authoritative clock, so it stays in the transcript the agent
 *   replays — but it is not something the operator wrote, and the transcript
 *   is what the dashboard shows back to them.
 *
 * Both markers are recognized by their *shape*, so an operator message that
 * happens to open with a bracketed tag (`[URGENT] deploy the fix`) is left
 * alone.
 */

/** The channel orchestrator's wall-clock marker. */
const CHANNEL_TIMESTAMP_RE = /^\s*\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [^\]]+\]\s*/;

/** The agent runtime's date/time envelope, with the datetime it carries. */
const RUNTIME_ENVELOPE_RE =
  /^\s*\[CURRENT DATE & TIME: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[^\]]*\]\s*/;

/**
 * Drop the server-owned markers from a message before it is shown.
 *
 * Anchored to the start of the content, so a bracketed datetime appearing
 * mid-message (a log line, an error report, a quoted prefix) is left intact.
 */
export function stripServerEnvelopes(content: string): string {
  return content.replace(RUNTIME_ENVELOPE_RE, '').replace(CHANNEL_TIMESTAMP_RE, '');
}
