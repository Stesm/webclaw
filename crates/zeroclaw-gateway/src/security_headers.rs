use std::sync::Arc;

use axum::extract::Request;
use axum::http::HeaderValue;
use axum::http::header::{HeaderMap, HeaderName};
use axum::middleware::Next;
use axum::response::Response;

const CSP_HEADER: &str = "content-security-policy";

/// The dashboard policy with no external image origins admitted. `img-src`
/// stays same-origin (plus `data:`/`blob:` for attachments and previews) so a
/// markdown image pointing at a third-party host cannot beacon from the
/// operator's browser.
pub(crate) const DEFAULT_CSP: &str = "default-src 'self'; \
     script-src 'self' 'unsafe-inline'; \
     style-src 'self' 'unsafe-inline'; \
     img-src 'self' data: blob:; \
     font-src 'self'; \
     connect-src 'self' ws: wss:; \
     object-src 'none'; \
     frame-ancestors 'none'; \
     base-uri 'none'; \
     form-action 'self'";

const SECURITY_HEADERS: &[(&str, &str)] = &[
    ("x-content-type-options", "nosniff"),
    ("x-frame-options", "DENY"),
    ("referrer-policy", "no-referrer"),
    ("cross-origin-opener-policy", "same-origin"),
    ("cross-origin-resource-policy", "same-origin"),
    ("x-permitted-cross-domain-policies", "none"),
    (
        "permissions-policy",
        "geolocation=(), microphone=(), camera=()",
    ),
];

const HSTS_HEADER: (&str, &str) = (
    "strict-transport-security",
    "max-age=63072000; includeSubDomains",
);

/// The dashboard policy admitting the operator-configured image origins.
///
/// Each entry must be a bare `https://host[:port]` origin; anything else is
/// dropped, so a typo or a wildcard cannot widen the policy beyond what the
/// operator named. This is the only way a third-party image renders inside
/// chat: the dashboard CSP otherwise forbids it, which is what keeps agent
/// markdown from silently beaconing to arbitrary hosts.
#[must_use]
pub fn content_security_policy(image_origins: &[String]) -> String {
    let mut img_src = String::from("img-src 'self' data: blob:");
    for origin in image_origins {
        if let Some(origin) = normalize_image_origin(origin) {
            img_src.push(' ');
            img_src.push_str(&origin);
        }
    }
    format!(
        "default-src 'self'; \
         script-src 'self' 'unsafe-inline'; \
         style-src 'self' 'unsafe-inline'; \
         {img_src}; \
         font-src 'self'; \
         connect-src 'self' ws: wss:; \
         object-src 'none'; \
         frame-ancestors 'none'; \
         base-uri 'none'; \
         form-action 'self'"
    )
}

/// Accept only a bare HTTPS origin: no path, query, fragment, userinfo, or
/// CSP-syntax characters. Plain HTTP would be blocked as mixed content on the
/// dashboard anyway, and a wildcard is a widening this allowlist refuses.
fn normalize_image_origin(raw: &str) -> Option<String> {
    let origin = raw.trim().trim_end_matches('/');
    let host = origin.strip_prefix("https://")?;
    if host.is_empty() {
        return None;
    }
    if !host
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b':' | b'[' | b']'))
    {
        return None;
    }
    Some(format!("https://{host}"))
}

pub async fn apply(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    inject(response.headers_mut(), false);
    response
}

/// Apply the headers with a policy built from the configured image origins
/// (see [`content_security_policy`]).
pub async fn apply_with_csp(request: Request, next: Next, csp: Arc<str>, hsts: bool) -> Response {
    let mut response = next.run(request).await;
    inject_with_csp(response.headers_mut(), hsts, &csp);
    response
}

pub(crate) fn inject(headers: &mut HeaderMap, hsts: bool) {
    inject_with_csp(headers, hsts, DEFAULT_CSP);
}

pub(crate) fn inject_with_csp(headers: &mut HeaderMap, hsts: bool, csp: &str) {
    for (name, value) in SECURITY_HEADERS {
        set_if_absent(headers, name, value);
    }
    set_if_absent_header(headers, CSP_HEADER, csp);
    if hsts {
        set_if_absent(headers, HSTS_HEADER.0, HSTS_HEADER.1);
    }
}

fn set_if_absent(headers: &mut HeaderMap, name: &'static str, value: &'static str) {
    set_if_absent_header(headers, name, value);
}

fn set_if_absent_header(headers: &mut HeaderMap, name: &str, value: &str) {
    let Ok(header_name) = HeaderName::try_from(name) else {
        return;
    };
    if headers.contains_key(&header_name) {
        return;
    }
    if let Ok(value) = HeaderValue::from_str(value) {
        headers.insert(header_name, value);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn injects_baseline_headers_without_hsts() {
        let mut headers = HeaderMap::new();
        inject(&mut headers, false);
        assert_eq!(headers.get("x-content-type-options").unwrap(), "nosniff");
        assert_eq!(headers.get("x-frame-options").unwrap(), "DENY");
        assert!(headers.get("strict-transport-security").is_none());
    }

    #[test]
    fn csp_permits_same_origin_dashboard_assets() {
        let mut headers = HeaderMap::new();
        inject(&mut headers, false);
        let csp = headers
            .get("content-security-policy")
            .unwrap()
            .to_str()
            .unwrap();
        assert!(csp.contains("default-src 'self'"));
        assert!(csp.contains("script-src 'self'"));
        assert!(csp.contains("connect-src 'self' ws: wss:"));
        assert!(csp.contains("img-src 'self' data: blob:"));
        assert!(csp.contains("frame-ancestors 'none'"));
    }

    #[test]
    fn injects_hsts_only_when_requested() {
        let mut headers = HeaderMap::new();
        inject(&mut headers, true);
        assert_eq!(
            headers.get("strict-transport-security").unwrap(),
            "max-age=63072000; includeSubDomains"
        );
    }

    #[test]
    fn empty_image_origins_keep_the_default_policy() {
        assert_eq!(content_security_policy(&[]), DEFAULT_CSP);
    }

    #[test]
    fn configured_image_origin_is_admitted() {
        let csp = content_security_policy(&["https://ai-signals.ru".to_string()]);
        assert!(
            csp.contains("img-src 'self' data: blob: https://ai-signals.ru;"),
            "{csp}"
        );
        // Trailing slash and surrounding whitespace are the same origin.
        let trimmed = content_security_policy(&["  https://ai-signals.ru/  ".to_string()]);
        assert_eq!(trimmed, csp);
        let port = content_security_policy(&["https://cdn.example.com:8443".to_string()]);
        assert!(
            port.contains("img-src 'self' data: blob: https://cdn.example.com:8443;"),
            "{port}"
        );
    }

    /// Anything that is not a bare HTTPS origin is refused, not coerced: a
    /// wildcard, a path, plain HTTP, or CSP syntax must not widen the policy.
    #[test]
    fn non_origin_entries_are_dropped() {
        let rejected = [
            "*",
            "https://*",
            "http://ai-signals.ru",
            "https://ai-signals.ru/static/bt_gate.png",
            "https://ai-signals.ru?a=1",
            "https://user@ai-signals.ru",
            "https://ai-signals.ru; script-src *",
            "data:",
            "ai-signals.ru",
            "https://",
        ];
        for entry in rejected {
            assert_eq!(
                content_security_policy(&[entry.to_string()]),
                DEFAULT_CSP,
                "{entry:?} must not reach the policy"
            );
        }
    }

    #[test]
    fn inject_with_csp_replaces_the_default_policy() {
        let mut headers = HeaderMap::new();
        let csp = content_security_policy(&["https://ai-signals.ru".to_string()]);
        inject_with_csp(&mut headers, false, &csp);
        let value = headers.get("content-security-policy").unwrap();
        assert!(value.to_str().unwrap().contains("https://ai-signals.ru"));
    }

    #[test]
    fn preserves_existing_header_values() {
        let mut headers = HeaderMap::new();
        headers.insert(
            HeaderName::from_static("content-security-policy"),
            HeaderValue::from_static("default-src 'self'"),
        );
        inject(&mut headers, false);
        assert_eq!(
            headers.get("content-security-policy").unwrap(),
            "default-src 'self'"
        );
    }
}
