use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ProviderError {
    #[error("provider base URL must use http or https")]
    InvalidScheme,
    #[error("provider base URL must include a host")]
    MissingHost,
    #[error("provider response status {0}")]
    HttpStatus(u16),
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct ResponsesRequest {
    pub model: String,
    pub input: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_response_id: Option<String>,
    pub stream: bool,
}

pub fn normalize_base_url(raw: &str) -> Result<String, ProviderError> {
    let mut value = raw.trim().trim_end_matches('/').to_owned();
    if value.is_empty() {
        value = "https://api.openai.com/v1".to_owned();
    }
    let lower = value.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Err(ProviderError::InvalidScheme);
    }
    let authority = value.split_once("://").map(|(_, rest)| rest).unwrap_or("");
    if authority.split('/').next().unwrap_or("").is_empty() {
        return Err(ProviderError::MissingHost);
    }
    if !value.ends_with("/v1") && !value.ends_with("/responses") {
        value.push_str("/v1");
    }
    Ok(value)
}

pub fn responses_url(base_url: &str) -> Result<String, ProviderError> {
    let base = normalize_base_url(base_url)?;
    if base.ends_with("/responses") {
        Ok(base)
    } else {
        Ok(format!("{base}/responses"))
    }
}

pub fn build_request(
    base_url: &str,
    model: impl Into<String>,
    input: Value,
    previous_response_id: Option<String>,
) -> Result<(String, ResponsesRequest), ProviderError> {
    Ok((
        responses_url(base_url)?,
        ResponsesRequest {
            model: model.into(),
            input,
            previous_response_id,
            stream: true,
        },
    ))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SseEvent {
    pub event: Option<String>,
    pub data: String,
}

pub fn parse_sse(input: &str) -> Vec<SseEvent> {
    let mut out = Vec::new();
    let mut event: Option<String> = None;
    let mut data = Vec::new();
    for line in input.lines() {
        if line.is_empty() {
            if !data.is_empty() {
                out.push(SseEvent {
                    event: event.take(),
                    data: data.join("\n"),
                });
            }
            data.clear();
            continue;
        }
        if let Some(value) = line.strip_prefix("event:") {
            event = Some(value.trim_start().to_owned());
        } else if let Some(value) = line.strip_prefix("data:") {
            data.push(value.strip_prefix(' ').unwrap_or(value).to_owned());
        }
    }
    if !data.is_empty() {
        out.push(SseEvent {
            event,
            data: data.join("\n"),
        });
    }
    out
}

pub fn normalize_error(status: u16, body: &str) -> Value {
    if !(200..300).contains(&status) {
        return json!({ "ok": false, "status": status, "error": body.chars().take(2000).collect::<String>() });
    }
    json!({ "ok": true })
}

/// Stream an OpenAI-compatible Responses request. Callback receives normalized SSE events.
pub async fn stream_responses<F>(
    base_url: &str,
    api_key: Option<&str>,
    model: &str,
    input: Value,
    previous_response_id: Option<String>,
    mut on_event: F,
) -> Result<(), ProviderError>
where
    F: FnMut(SseEvent) + Send,
{
    let (url, request) = build_request(base_url, model, input, previous_response_id)?;
    let client = crate::proxy::client_for_url_async(&url)
        .await
        .map_err(|_| ProviderError::HttpStatus(598))?;
    let mut builder = client.post(url).json(&request);
    if let Some(key) = api_key.filter(|value| !value.trim().is_empty()) {
        builder = builder.bearer_auth(key);
    }
    let response = builder
        .send()
        .await
        .map_err(|_| ProviderError::HttpStatus(599))?;
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(ProviderError::HttpStatus(status));
    }
    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| ProviderError::HttpStatus(598))?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(index) = buffer.find("\n\n") {
            let frame = buffer[..index].replace('\r', "");
            buffer.drain(..index + 2);
            for event in parse_sse(&frame) {
                on_event(event);
            }
        }
    }
    if !buffer.trim().is_empty() {
        for event in parse_sse(&buffer.replace('\r', "")) {
            on_event(event);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_openai_and_custom_urls() {
        assert_eq!(
            responses_url("https://api.openai.com").unwrap(),
            "https://api.openai.com/v1/responses"
        );
        assert_eq!(
            responses_url("http://localhost:8080/v1/").unwrap(),
            "http://localhost:8080/v1/responses"
        );
        assert_eq!(
            responses_url("https://gateway.test/responses").unwrap(),
            "https://gateway.test/responses"
        );
    }

    #[test]
    fn preserves_previous_response_id() {
        let (_, request) = build_request(
            "https://gateway.test/v1",
            "model-x",
            json!([{"role":"user","content":"hi"}]),
            Some("resp_1".into()),
        )
        .unwrap();
        assert_eq!(request.previous_response_id.as_deref(), Some("resp_1"));
        assert!(request.stream);
    }

    #[test]
    fn parses_ordered_multiline_sse() {
        let events = parse_sse("event: response.output_text.delta\ndata: {\"delta\":\"a\"}\n\nevent: response.completed\ndata: line1\ndata: line2\n");
        assert_eq!(events.len(), 2);
        assert_eq!(events[1].data, "line1\nline2");
    }

    #[test]
    fn rejects_non_http_urls() {
        assert_eq!(
            normalize_base_url("file:///tmp/provider"),
            Err(ProviderError::InvalidScheme)
        );
    }

    #[test]
    fn serializes_compatible_request_for_custom_endpoint() {
        let (url, request) = build_request(
            "http://localhost:8787/openai",
            "test",
            json!("ok"),
            Some("resp_prev".to_owned()),
        )
        .unwrap();
        let body = serde_json::to_string(&request).unwrap();
        assert_eq!(url, "http://localhost:8787/openai/v1/responses");
        assert!(body.contains("\"previous_response_id\":\"resp_prev\""));
        assert!(body.contains("\"stream\":true"));
    }
}
