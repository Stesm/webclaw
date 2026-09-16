//! In-process state for a session's in-flight gateway WebSocket turn.
//!
//! The turn outlives the WebSocket that started it (a tab close must not kill
//! the agent run), so a reopened socket cannot rely on receiving the live
//! frames it missed. Instead the turn mirrors a compact progress snapshot here
//! for as long as it runs; `GET /api/sessions/{id}/messages` hands that snapshot
//! to a reconnecting client so it can render the same tools and partial text
//! the original socket saw, instead of a spinner with no signal.
//!
//! This is deliberately process-local: a daemon restart already ends the turn,
//! so the snapshot has no state to preserve past the owning process.

use std::sync::Arc;

/// A tool invocation accumulated during the running turn.
#[derive(Clone, Debug, serde::Serialize)]
pub struct ToolProgress {
    /// Gateway correlation id (`tool_call_id`), empty when the provider gave none.
    pub id: String,
    pub name: String,
    pub args: serde_json::Value,
    /// `None` until the matching `TurnEvent::ToolResult` arrives.
    pub output: Option<String>,
}

/// Compact mirror of a running turn: partial assistant text, reasoning, and the
/// tool calls seen so far.
#[derive(Clone, Debug, Default, serde::Serialize)]
pub struct TurnProgress {
    pub text: String,
    pub thinking: String,
    pub tool_calls: Vec<ToolProgress>,
}

/// The live turn for one session: its cancellation handle, identity, and the
/// progress snapshot a reconnecting viewer reads.
pub struct ActiveTurn {
    token: tokio_util::sync::CancellationToken,
    #[allow(dead_code)]
    turn_id: String,
    progress: parking_lot::Mutex<TurnProgress>,
}

impl ActiveTurn {
    pub fn new(turn_id: String, token: tokio_util::sync::CancellationToken) -> Self {
        Self {
            token,
            turn_id,
            progress: parking_lot::Mutex::new(TurnProgress::default()),
        }
    }

    pub fn token(&self) -> tokio_util::sync::CancellationToken {
        self.token.clone()
    }

    /// Snapshot the current progress for a viewer.
    pub fn progress(&self) -> TurnProgress {
        self.progress.lock().clone()
    }

    pub fn append_text(&self, delta: &str) {
        self.progress.lock().text.push_str(delta);
    }

    pub fn append_thinking(&self, delta: &str) {
        self.progress.lock().thinking.push_str(delta);
    }

    /// Record a tool call, keeping the provider's correlation id for the later
    /// result match. A provider can reuse an empty id, so an empty id is not
    /// deduped; a non-empty duplicate is ignored so a replayed event cannot
    /// double the card.
    pub fn record_tool_call(&self, id: String, name: String, args: serde_json::Value) {
        let mut progress = self.progress.lock();
        if !id.is_empty() && progress.tool_calls.iter().any(|call| call.id == id) {
            return;
        }
        progress.tool_calls.push(ToolProgress {
            id,
            name,
            args,
            output: None,
        });
    }

    /// Attach a tool result to its card. Correlates by id first; otherwise
    /// falls back to the most recent output-less card with the same name, which
    /// matches the client's own `resolveToolResultIndex` fallback.
    pub fn record_tool_result(&self, id: &str, name: &str, output: String) {
        let mut progress = self.progress.lock();
        let by_id = if id.is_empty() {
            None
        } else {
            progress
                .tool_calls
                .iter()
                .rposition(|call| call.id == id && call.output.is_none())
        };
        let idx = by_id.or_else(|| {
            progress
                .tool_calls
                .iter()
                .rposition(|call| call.name == name && call.output.is_none())
        });
        if let Some(idx) = idx {
            progress.tool_calls[idx].output = Some(output);
        } else {
            progress.tool_calls.push(ToolProgress {
                id: id.to_string(),
                name: name.to_string(),
                args: serde_json::Value::Null,
                output: Some(output),
            });
        }
    }
}

/// Registry of live turns keyed by session key (`gw_<session_id>`).
pub type ActiveTurns = Arc<std::sync::Mutex<std::collections::HashMap<String, Arc<ActiveTurn>>>>;

#[cfg(test)]
mod tests {
    use super::*;

    fn turn() -> ActiveTurn {
        ActiveTurn::new("t".into(), tokio_util::sync::CancellationToken::new())
    }

    #[test]
    fn appends_text_and_thinking() {
        let turn = turn();
        turn.append_text("hello ");
        turn.append_text("world");
        turn.append_thinking("hmm");
        let progress = turn.progress();
        assert_eq!(progress.text, "hello world");
        assert_eq!(progress.thinking, "hmm");
    }

    #[test]
    fn correlates_result_by_id() {
        let turn = turn();
        turn.record_tool_call("a".into(), "shell".into(), serde_json::json!({}));
        turn.record_tool_call("b".into(), "read".into(), serde_json::json!({}));
        // Out-of-order result still lands on its own card.
        turn.record_tool_result("a", "shell", "done-a".into());
        let progress = turn.progress();
        assert_eq!(progress.tool_calls[0].output.as_deref(), Some("done-a"));
        assert!(progress.tool_calls[1].output.is_none());
    }

    #[test]
    fn falls_back_to_name_when_id_missing() {
        let turn = turn();
        turn.record_tool_call(String::new(), "shell".into(), serde_json::json!({}));
        turn.record_tool_result("", "shell", "out".into());
        assert_eq!(turn.progress().tool_calls[0].output.as_deref(), Some("out"));
    }

    #[test]
    fn empty_id_tool_calls_are_not_deduped() {
        let turn = turn();
        turn.record_tool_call(String::new(), "shell".into(), serde_json::json!({}));
        turn.record_tool_call(String::new(), "shell".into(), serde_json::json!({}));
        assert_eq!(turn.progress().tool_calls.len(), 2);
    }

    #[test]
    fn duplicate_non_empty_id_is_ignored() {
        let turn = turn();
        turn.record_tool_call("a".into(), "shell".into(), serde_json::json!({}));
        turn.record_tool_call("a".into(), "shell".into(), serde_json::json!({}));
        assert_eq!(turn.progress().tool_calls.len(), 1);
    }

    #[test]
    fn unmatched_result_creates_a_card() {
        let turn = turn();
        turn.record_tool_result("x", "shell", "out".into());
        let progress = turn.progress();
        assert_eq!(progress.tool_calls.len(), 1);
        assert_eq!(progress.tool_calls[0].output.as_deref(), Some("out"));
    }
}
