//! Trait abstraction for session persistence backends.

use chrono::{DateTime, Utc};
use zeroclaw_api::agent::AttachmentRef;
use zeroclaw_api::model_provider::ChatMessage;

/// Metadata about a persisted session.
#[derive(Debug, Clone)]
pub struct SessionMetadata {
    /// Session key (e.g. `telegram_user123`).
    pub key: String,
    /// Optional human-readable name (e.g. `eyrie-commander-briefing`).
    pub name: Option<String>,
    /// When the session was first created.
    pub created_at: DateTime<Utc>,
    /// When the last message was appended.
    pub last_activity: DateTime<Utc>,
    /// Total number of messages in the session.
    pub message_count: usize,
    /// Alias of the agent that owned this session (HashMap key in
    /// `config.agents`). `None` for sessions persisted before per-agent
    /// attribution landed, or for backends that don't track it.
    pub agent_alias: Option<String>,
    /// Dotted ChannelRef the session belongs to (`<type>.<alias>`,
    /// e.g. `discord.clamps`). `None` for non-channel sessions (CLI,
    /// internal cron runs) or backends without routing columns.
    pub channel_id: Option<String>,
    /// Platform-side room / thread identifier (Discord channel id,
    /// Matrix room id, Slack thread ts, ...). `None` for direct messages
    /// or backends that don't track it.
    pub room_id: Option<String>,
    /// Inbound sender id verbatim (Discord username, phone number, ...).
    /// Not an FK — sessions can survive deletion of the upstream user.
    pub sender_id: Option<String>,
    /// Bounded one-line excerpt of the session's first user message, for
    /// labeling a conversation the operator hasn't named. Derived on read from
    /// the canonical message rows so it cannot go stale, and short enough that
    /// a listing for many sessions stays cheap to ship. `None` when the session
    /// has no user message yet, or the backend has no message store.
    pub preview: Option<String>,
}

/// Character budget of a session preview once whitespace is collapsed. Sized to
/// read as a conversation label next to an ellipsis, not as a message.
pub const SESSION_PREVIEW_MAX_CHARS: usize = 60;

/// Upper bound on how much of the first user message a backend hands to
/// [`normalize_session_preview`]. Truncating in SQL keeps a pathological first
/// message from being pulled out of the database in full just to be shortened.
pub const SESSION_PREVIEW_SOURCE_MAX_CHARS: usize = 400;

/// Turn a raw first-user-message into a one-line preview.
///
/// Drops the channel wall-clock marker first (see
/// [`strip_leading_channel_timestamp`]) so the character budget is spent on the
/// operator's own words, then collapses whitespace so a multi-line opening
/// message cannot break the list row, then truncates on a character boundary.
/// `None` for content that is empty after all of that, so callers treat it
/// exactly like "no preview".
pub fn normalize_session_preview(raw: &str) -> Option<String> {
    let body = strip_leading_channel_timestamp(raw);
    let collapsed = body.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        return None;
    }
    let mut preview: String = collapsed.chars().take(SESSION_PREVIEW_MAX_CHARS).collect();
    if collapsed.chars().count() > SESSION_PREVIEW_MAX_CHARS {
        preview.push('…');
    }
    Some(preview)
}

/// Drop the leading `[YYYY-MM-DD HH:MM:SS TZ] ` marker the channel orchestrator
/// stamps on persisted user turns (`timestamp_channel_user_content` in
/// `zeroclaw-channels`). Gateway turns are stored verbatim without it, so this
/// is a no-op for them.
///
/// Matches the datetime *shape* rather than the exact format: the zone is a
/// chrono `%Z` abbreviation whose spelling varies by host, and a leading
/// bracketed group that is not a timestamp (`[URGENT] …`) is operator content
/// and is left alone.
fn strip_leading_channel_timestamp(content: &str) -> &str {
    let trimmed = content.trim_start();
    let Some(rest) = trimmed.strip_prefix('[') else {
        return trimmed;
    };
    let Some(end) = rest.find(']') else {
        return trimmed;
    };
    let inside = &rest[..end];
    let bytes = inside.as_bytes();
    let looks_like_timestamp = inside.len() >= 19
        && bytes.first().is_some_and(u8::is_ascii_digit)
        && bytes.get(4) == Some(&b'-')
        && bytes.get(7) == Some(&b'-')
        && bytes.get(10) == Some(&b' ')
        && bytes.get(13) == Some(&b':')
        && bytes.get(16) == Some(&b':');
    if !looks_like_timestamp {
        return trimmed;
    }
    rest[end + 1..].trim_start()
}

/// Structured routing context recorded alongside a session. Mirrors the
/// `ChannelMessage` fields the orchestrator uses to compose
/// `conversation_history_key` so the session row can be queried by
/// channel / room / sender without re-parsing the synthetic key.
#[derive(Debug, Clone, Default)]
pub struct SessionContext<'a> {
    /// `<type>.<alias>` ChannelRef (`discord.clamps`).
    pub channel_id: Option<&'a str>,
    /// Platform-side room / thread id.
    pub room_id: Option<&'a str>,
    /// Inbound sender id (channel-native username, phone, ...).
    pub sender_id: Option<&'a str>,
}

/// Query parameters for listing sessions.
#[derive(Debug, Clone, Default)]
pub struct SessionQuery {
    /// Keyword to search in session messages (FTS5 if available).
    pub keyword: Option<String>,
    /// Maximum number of sessions to return.
    pub limit: Option<usize>,
}

/// One persisted message with the optional `created_at` the backend
/// stamped on it. JSONL / in-memory backends return `None`; SQLite
/// returns the row's `created_at` column.
#[derive(Debug, Clone)]
pub struct TimestampedMessage {
    pub message: ChatMessage,
    pub created_at: Option<DateTime<Utc>>,
    /// Delivered file attachments referenced by this message, if the backend
    /// persists them. Backends without attachment storage return an empty vec.
    pub attachments: Vec<AttachmentRef>,
}

/// Trait for session persistence backends.
/// Implementations must be `Send + Sync` for sharing across async tasks.
pub trait SessionBackend: Send + Sync {
    /// Load all messages for a session. Returns empty vec if session doesn't exist.
    fn load(&self, session_key: &str) -> Vec<ChatMessage>;

    /// Same as `load`, but each row carries its persisted `created_at`
    /// when the backend has one. Default impl falls back to `load`
    /// without timestamps so non-SQLite backends keep working.
    fn load_with_timestamps(&self, session_key: &str) -> Vec<TimestampedMessage> {
        self.load(session_key)
            .into_iter()
            .map(|message| TimestampedMessage {
                message,
                created_at: None,
                attachments: Vec::new(),
            })
            .collect()
    }

    /// Append a single message to a session.
    fn append(&self, session_key: &str, message: &ChatMessage) -> std::io::Result<()>;

    /// Append a message together with the file attachments it delivered.
    /// Backends that do not persist attachment metadata fall back to a plain
    /// [`append`](Self::append) so the message itself is never lost.
    fn append_with_attachments(
        &self,
        session_key: &str,
        message: &ChatMessage,
        _attachments: &[AttachmentRef],
    ) -> std::io::Result<()> {
        self.append(session_key, message)
    }

    /// Remove the last message from a session. Returns `true` if a message was removed.
    fn remove_last(&self, session_key: &str) -> std::io::Result<bool>;

    fn update_last(&self, session_key: &str, message: &ChatMessage) -> std::io::Result<bool> {
        if self.remove_last(session_key)? {
            self.append(session_key, message)?;
            Ok(true)
        } else {
            Ok(false)
        }
    }

    /// List all session keys.
    fn list_sessions(&self) -> Vec<String>;

    /// List sessions with metadata.
    fn list_sessions_with_metadata(&self) -> Vec<SessionMetadata> {
        // Default: construct metadata from messages (backends can override for efficiency)
        self.list_sessions()
            .into_iter()
            .map(|key| {
                let messages = self.load(&key);
                SessionMetadata {
                    key,
                    name: None,
                    created_at: Utc::now(),
                    last_activity: Utc::now(),
                    message_count: messages.len(),
                    agent_alias: None,
                    channel_id: None,
                    room_id: None,
                    sender_id: None,
                    preview: messages
                        .iter()
                        .find(|m| m.role == "user" && !m.content.trim().is_empty())
                        .and_then(|m| normalize_session_preview(&m.content)),
                }
            })
            .collect()
    }

    /// Compact a session file (remove duplicates/corruption). No-op by default.
    fn compact(&self, _session_key: &str) -> std::io::Result<()> {
        Ok(())
    }

    /// Remove sessions that haven't been active within the given TTL hours.
    fn cleanup_stale(&self, _ttl_hours: u32) -> std::io::Result<usize> {
        Ok(0)
    }

    /// Search sessions by keyword. Default returns empty (backends with FTS override).
    fn search(&self, _query: &SessionQuery) -> Vec<SessionMetadata> {
        Vec::new()
    }

    fn clear_messages(&self, session_key: &str) -> std::io::Result<usize> {
        let mut count = 0;
        while self.remove_last(session_key)? {
            count += 1;
        }
        Ok(count)
    }

    /// Delete all messages for a session. Returns `true` if the session existed.
    fn delete_session(&self, _session_key: &str) -> std::io::Result<bool> {
        Ok(false)
    }

    fn clear_agent_attribution(&self, _agent_alias: &str) -> std::io::Result<usize> {
        Ok(0)
    }

    fn rename_agent_attribution(&self, _from: &str, _to: &str) -> std::io::Result<usize> {
        Ok(0)
    }

    fn count_agent_attribution(&self, _agent_alias: &str) -> std::io::Result<usize> {
        Ok(0)
    }

    fn session_exists(&self, session_key: &str) -> bool {
        self.get_session_metadata(session_key).is_some()
    }

    /// Set or update the human-readable name for a session.
    fn set_session_name(&self, _session_key: &str, _name: &str) -> std::io::Result<()> {
        Ok(())
    }

    /// Get the human-readable name for a session (if set).
    fn get_session_name(&self, _session_key: &str) -> std::io::Result<Option<String>> {
        Ok(None)
    }

    /// Record the agent alias that owns a session. Called on WebSocket
    /// handshake when the alias is known. No-op for backends that don't
    /// track per-agent attribution.
    fn set_session_agent_alias(
        &self,
        _session_key: &str,
        _agent_alias: &str,
    ) -> std::io::Result<()> {
        Ok(())
    }

    /// Get the agent alias associated with a session, if recorded.
    fn get_session_agent_alias(&self, _session_key: &str) -> std::io::Result<Option<String>> {
        Ok(None)
    }

    fn set_session_context(
        &self,
        _session_key: &str,
        _context: SessionContext<'_>,
    ) -> std::io::Result<()> {
        Ok(())
    }

    fn get_session_metadata(&self, session_key: &str) -> Option<SessionMetadata> {
        let messages = self.load(session_key);
        if messages.is_empty() {
            return None;
        }
        Some(SessionMetadata {
            key: session_key.to_string(),
            name: self.get_session_name(session_key).ok().flatten(),
            created_at: Utc::now(),
            last_activity: Utc::now(),
            message_count: messages.len(),
            agent_alias: None,
            channel_id: None,
            room_id: None,
            sender_id: None,
            preview: messages
                .iter()
                .find(|m| m.role == "user" && !m.content.trim().is_empty())
                .and_then(|m| normalize_session_preview(&m.content)),
        })
    }

    /// Set the session state (e.g. "idle", "running", "error").
    /// `turn_id` identifies the current turn (set when running, cleared on idle).
    fn set_session_state(
        &self,
        _session_key: &str,
        _state: &str,
        _turn_id: Option<&str>,
    ) -> std::io::Result<()> {
        Ok(())
    }

    /// Get the current session state. Returns `None` if the backend doesn't track state.
    fn get_session_state(&self, _session_key: &str) -> std::io::Result<Option<SessionState>> {
        Ok(None)
    }

    /// List sessions currently in "running" state.
    fn list_running_sessions(&self) -> Vec<SessionMetadata> {
        Vec::new()
    }

    /// List sessions stuck in "running" state longer than `threshold_secs`.
    fn list_stuck_sessions(&self, _threshold_secs: u64) -> Vec<SessionMetadata> {
        Vec::new()
    }
}

/// Session state information.
#[derive(Debug, Clone)]
pub struct SessionState {
    /// Current state: "idle", "running", or "error".
    pub state: String,
    /// Turn ID of the active or last turn.
    pub turn_id: Option<String>,
    /// When the current state was entered.
    pub turn_started_at: Option<DateTime<Utc>>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_metadata_is_constructible() {
        let meta = SessionMetadata {
            key: "test".into(),
            name: None,
            created_at: Utc::now(),
            last_activity: Utc::now(),
            message_count: 5,
            agent_alias: None,
            channel_id: None,
            room_id: None,
            sender_id: None,
            preview: None,
        };
        assert_eq!(meta.key, "test");
        assert_eq!(meta.message_count, 5);
    }

    #[test]
    fn session_query_defaults() {
        let q = SessionQuery::default();
        assert!(q.keyword.is_none());
        assert!(q.limit.is_none());
    }

    #[test]
    fn preview_collapses_whitespace_and_truncates_on_a_char_boundary() {
        assert_eq!(
            normalize_session_preview("  hello\n  world  ").as_deref(),
            Some("hello world")
        );

        let long = "я".repeat(SESSION_PREVIEW_MAX_CHARS + 10);
        let preview = normalize_session_preview(&long).unwrap();
        assert_eq!(preview.chars().count(), SESSION_PREVIEW_MAX_CHARS + 1);
        assert!(preview.ends_with('…'));
        // A cut through a multi-byte character would have panicked above;
        // assert the prefix survived intact rather than merely not crashing.
        assert!(preview.starts_with(&"я".repeat(SESSION_PREVIEW_MAX_CHARS)));
    }

    #[test]
    fn preview_is_none_for_blank_content() {
        assert_eq!(normalize_session_preview("   \n\t "), None);
        assert_eq!(normalize_session_preview(""), None);
    }

    #[test]
    fn preview_drops_the_channel_wall_clock_marker_but_keeps_operator_brackets() {
        assert_eq!(
            normalize_session_preview("[2026-09-16 03:15:01 MSK] Привет").as_deref(),
            Some("Привет")
        );
        // Not a datetime — an opening bracketed tag is the operator's own text.
        assert_eq!(
            normalize_session_preview("[URGENT] deploy the fix").as_deref(),
            Some("[URGENT] deploy the fix")
        );
    }
}
