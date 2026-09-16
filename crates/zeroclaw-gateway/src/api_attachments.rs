//! `GET /api/agents/{alias}/attachments/{id}` — serve delivered file bytes.
//!
//! Agent-produced files reach the chat client as a typed [`AttachmentRef`]
//! whose `id` is the opaque content-addressed name under
//! `<agent workspace>/uploads/`. This route resolves that id to the workspace
//! file and streams it back for download / inline preview. The id is validated
//! as a bare content-hash filename (no separators), and the read reuses the
//! workspace containment resolver, so no caller-supplied path can escape.
//!
//! [`AttachmentRef`]: zeroclaw_api::agent::AttachmentRef

use axum::{
    body::Body,
    extract::{Path, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use zeroclaw_runtime::browse::{AGENT_ATTACHMENT_READ_CAP, read_agent_workspace_file_capped};

use super::AppState;
use super::api::require_auth;

/// Max length of a content-addressed id: full sha256 hex (64) plus `.` and a
/// short extension.
const MAX_ATTACHMENT_ID_LEN: usize = 96;

/// A delivered-file id is a bare content-addressed filename: hex digest with an
/// optional `.ext`. Rejecting separators and dots-only names here is defense in
/// depth on top of `resolve_under`, which already refuses escapes.
fn is_valid_attachment_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_ATTACHMENT_ID_LEN
        && !id.contains('/')
        && !id.contains('\\')
        && id != "."
        && id != ".."
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

pub async fn handle_agent_attachment(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((alias, id)): Path<(String, String)>,
) -> Response {
    if let Err(e) = require_auth(&state, &headers) {
        return e.into_response();
    }
    if !is_valid_attachment_id(&id) {
        return (StatusCode::BAD_REQUEST, "Invalid attachment id").into_response();
    }

    let config = state.config.read().clone();
    let rel = format!("uploads/{id}");
    match read_agent_workspace_file_capped(&config, &alias, &rel, AGENT_ATTACHMENT_READ_CAP) {
        Ok(file) => {
            let mime = mime_guess::from_path(&id)
                .first_or_octet_stream()
                .to_string();
            Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, mime)
                .header(header::CONTENT_DISPOSITION, "inline")
                .header("x-content-type-options", "nosniff")
                .header(
                    header::CACHE_CONTROL,
                    "private, max-age=31536000, immutable",
                )
                .body(Body::from(file.bytes))
                .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
        }
        Err(err) => (StatusCode::NOT_FOUND, format!("{err}")).into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::is_valid_attachment_id;

    #[test]
    fn accepts_content_addressed_ids() {
        assert!(is_valid_attachment_id("a1b2c3.pdf"));
        assert!(is_valid_attachment_id(&"0".repeat(64)));
    }

    #[test]
    fn rejects_path_separators_and_empty() {
        assert!(!is_valid_attachment_id(""));
        assert!(!is_valid_attachment_id("../secret"));
        assert!(!is_valid_attachment_id("sub/file.pdf"));
        assert!(!is_valid_attachment_id("a\\b.pdf"));
        assert!(!is_valid_attachment_id(".."));
        assert!(!is_valid_attachment_id("."));
    }
}
