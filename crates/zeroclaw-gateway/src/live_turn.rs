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
use tokio::sync::mpsc;
use zeroclaw_runtime::agent::SteeringInput;

/// Why a steering message could not join the running turn.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SteerRefusal {
    /// The turn's steering queue is full.
    Full,
    /// The turn no longer accepts steering: it is finishing.
    Closed,
    /// The sender is not the principal that started the turn.
    NotOwner,
}

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

/// The live turn for one session: its cancellation handle, identity, its
/// steering channel, and the progress snapshot a reconnecting viewer reads.
pub struct ActiveTurn {
    token: tokio_util::sync::CancellationToken,
    #[allow(dead_code)]
    turn_id: String,
    /// Principal that started the turn. `None` is the shared operator identity
    /// (a gateway with no per-user auth): every socket is the same sender.
    /// Otherwise a socket may steer only when it resolves to this subject, so
    /// watching a turn never grants another principal a say in it.
    owner: Option<String>,
    progress: parking_lot::Mutex<TurnProgress>,
    /// The running turn's steering channel, attached by the socket that started
    /// it so a socket that merely watches the turn (a reloaded tab, a second
    /// pane) can still add a message to it. `None` before the turn's channel is
    /// installed; a send then reports [`SteerRefusal::Closed`].
    steering: parking_lot::Mutex<Option<mpsc::Sender<SteeringInput>>>,
}

impl ActiveTurn {
    pub fn new(turn_id: String, token: tokio_util::sync::CancellationToken) -> Self {
        Self {
            token,
            turn_id,
            owner: None,
            progress: parking_lot::Mutex::new(TurnProgress::default()),
            steering: parking_lot::Mutex::new(None),
        }
    }

    /// Bind the turn to the principal that started it.
    pub fn with_owner(mut self, owner: Option<String>) -> Self {
        self.owner = owner;
        self
    }

    /// Install the running turn's steering channel.
    pub fn set_steering(&self, sender: mpsc::Sender<SteeringInput>) {
        *self.steering.lock() = Some(sender);
    }

    /// Queue one steering message on behalf of `subject`.
    ///
    /// The message joins the running turn as its own user turn before the next
    /// model round; it never starts a second turn. Refusals are reported, never
    /// queued behind: a full queue or a finishing turn would otherwise turn the
    /// caller's message into an unbounded wait.
    pub fn steer(&self, subject: Option<&str>, input: SteeringInput) -> Result<(), SteerRefusal> {
        if !self.accepts_steering_from(subject) {
            return Err(SteerRefusal::NotOwner);
        }
        let steering = self.steering.lock();
        let Some(sender) = steering.as_ref() else {
            return Err(SteerRefusal::Closed);
        };
        match sender.try_send(input) {
            Ok(()) => Ok(()),
            Err(mpsc::error::TrySendError::Full(_)) => Err(SteerRefusal::Full),
            Err(mpsc::error::TrySendError::Closed(_)) => Err(SteerRefusal::Closed),
        }
    }

    fn accepts_steering_from(&self, subject: Option<&str>) -> bool {
        match self.owner.as_deref() {
            None => true,
            Some(owner) => subject == Some(owner),
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

    #[test]
    fn steering_is_closed_before_the_channel_is_installed() {
        let turn = turn();
        assert_eq!(
            turn.steer(None, SteeringInput::new("hi".to_string())),
            Err(SteerRefusal::Closed)
        );
    }

    #[test]
    fn steering_reaches_the_turn_queue_and_reports_a_full_one() {
        let turn = turn();
        let (tx, mut rx) = mpsc::channel(1);
        turn.set_steering(tx);
        assert_eq!(
            turn.steer(None, SteeringInput::new("hi".to_string())),
            Ok(())
        );
        assert_eq!(
            turn.steer(None, SteeringInput::new("again".to_string())),
            Err(SteerRefusal::Full)
        );
        assert_eq!(rx.try_recv().expect("queued").text(), "hi");
    }

    #[test]
    fn steering_from_another_principal_is_refused() {
        let turn = ActiveTurn::new("t".into(), tokio_util::sync::CancellationToken::new())
            .with_owner(Some("alice".into()));
        let (tx, _rx) = mpsc::channel(1);
        turn.set_steering(tx);
        assert_eq!(
            turn.steer(None, SteeringInput::new("anon".to_string())),
            Err(SteerRefusal::NotOwner)
        );
        assert_eq!(
            turn.steer(Some("bob"), SteeringInput::new("wrong".to_string())),
            Err(SteerRefusal::NotOwner)
        );
        assert_eq!(
            turn.steer(Some("alice"), SteeringInput::new("ok".to_string())),
            Ok(())
        );
    }

    #[test]
    fn a_dropped_receiver_is_reported_closed() {
        let turn = turn();
        let (tx, rx) = mpsc::channel::<SteeringInput>(1);
        turn.set_steering(tx);
        drop(rx);
        assert_eq!(
            turn.steer(None, SteeringInput::new("late".to_string())),
            Err(SteerRefusal::Closed)
        );
    }
}
