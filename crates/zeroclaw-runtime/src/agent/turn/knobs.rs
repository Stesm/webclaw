//! Per-caller loop behaviour knobsconsolidation).

use zeroclaw_config::schema::StreamReasoningMode;

/// How to handle max-tool-iteration exhaustion.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum MaxIterationBehavior {
    /// Ask the LLM for a tools-free final summary (channel/CLI behaviour).
    #[default]
    GracefulSummary,
    /// Bail with "exceeded maximum tool iterations" (embedder control signal).
    ErrorAtCap,
}

/// Explicit knobs for per-caller loop behaviour.
#[derive(Debug, Clone)]
pub struct LoopKnobs {
    pub dedup_enabled: bool,
    pub max_iteration_behavior: MaxIterationBehavior,
    pub detect_protocol_without_tools: bool,
    /// Controls whether provider reasoning deltas are reflected into the
    /// draft/status surface. Raw reasoning is opt-in; the default only emits a
    /// liveness tick so existing channel progress remains privacy-preserving.
    pub draft_reasoning: StreamReasoningMode,
    /// Keep provider calls buffered even when an `event_tx` tap is attached.
    /// Turn events (tool calls/results, post-hoc text) still fire, so a viewer
    /// sees progress; only token-by-token streaming is suppressed. Set by the
    /// cron transcript tap, which wants the event stream but must not change
    /// the job's provider transport.
    pub force_buffered_provider: bool,
}

impl Default for LoopKnobs {
    fn default() -> Self {
        Self {
            dedup_enabled: true,
            max_iteration_behavior: MaxIterationBehavior::GracefulSummary,
            detect_protocol_without_tools: true,
            draft_reasoning: StreamReasoningMode::Status,
            force_buffered_provider: false,
        }
    }
}
