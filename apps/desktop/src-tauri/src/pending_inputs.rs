//! Blocking renderer-mediated inputs used by agent tools.
//!
//! Each prompt owns a one-shot responder. Answers are accepted exactly once;
//! invalid answers leave prompt pending so renderer can correct the input.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::{Mutex, MutexGuard};
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;
use uuid::Uuid;

use crate::commands::AppState;

pub const AGENT_EVENT: &str = "agent:events";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentQuestionOption {
    pub value: String,
    pub label: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentQuestionPrompt {
    pub question: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<AgentQuestionOption>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allow_free_text: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub free_text_placeholder: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MachineMcpQuestionMachine {
    pub device_id: String,
    pub name: String,
    pub model: String,
    pub ip_address: String,
    pub ssid: String,
    pub updated_at: Option<String>,
}

#[derive(Debug)]
pub struct AgentQuestionPending {
    pub question_id: String,
    pub prompt: AgentQuestionPrompt,
    pub responder: oneshot::Sender<Option<String>>,
}

#[derive(Debug)]
pub struct MachineMcpQuestionPending {
    pub machines: Vec<MachineMcpQuestionMachine>,
    pub responder: oneshot::Sender<Option<MachineMcpAnswer>>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct MachineMcpAnswer {
    pub host: String,
    pub device_id: Option<String>,
}

pub fn emit_agent_event(app: &AppHandle, value: Value) {
    let _ = app.emit(AGENT_EVENT, value);
}

fn normalize_machine_host(value: &str) -> Option<String> {
    let trimmed = value.trim();
    let without_protocol = if trimmed.len() >= 7 && trimmed[..7].eq_ignore_ascii_case("http://") {
        &trimmed[7..]
    } else if trimmed.len() >= 8 && trimmed[..8].eq_ignore_ascii_case("https://") {
        &trimmed[8..]
    } else {
        trimmed
    };
    let host = without_protocol.trim_end_matches('/');
    if !host.is_empty()
        && !host.contains('/')
        && !host.contains('?')
        && !host.contains('#')
        && !host.chars().any(char::is_whitespace)
    {
        return Some(host.to_owned());
    }
    None
}

fn lock<'a, T>(mutex: &'a Mutex<T>) -> Result<MutexGuard<'a, T>, String> {
    mutex
        .lock()
        .map_err(|_| "pending input state unavailable".to_owned())
}

pub async fn ask_user_question(
    app: &AppHandle,
    state: &AppState,
    prompt: AgentQuestionPrompt,
) -> Option<String> {
    let question_id = Uuid::new_v4().to_string();
    let (tx, rx) = oneshot::channel();
    {
        let mut pending = lock(&state.agent_question).ok()?;
        if pending.is_some() {
            return None;
        }
        *pending = Some(AgentQuestionPending {
            question_id: question_id.clone(),
            prompt: prompt.clone(),
            responder: tx,
        });
    }
    emit_agent_event(
        app,
        json!({"type":"agent_question","questionId":question_id,"visible":true,"question":prompt.question,"options":prompt.options,"allowFreeText":prompt.allow_free_text,"freeTextPlaceholder":prompt.free_text_placeholder}),
    );
    let answer = rx.await.ok().flatten();
    if let Ok(mut pending) = state.agent_question.lock() {
        if pending
            .as_ref()
            .is_some_and(|current| current.question_id == question_id)
        {
            pending.take();
            emit_agent_event(
                app,
                json!({"type":"agent_question","questionId":question_id,"visible":false,"question":""}),
            );
        }
    }
    answer
}

pub async fn ask_machine(
    app: &AppHandle,
    state: &AppState,
    machines: Vec<MachineMcpQuestionMachine>,
) -> Option<MachineMcpAnswer> {
    let (tx, rx) = oneshot::channel();
    {
        let mut pending = lock(&state.machine_mcp_question).ok()?;
        if pending.is_some() {
            return None;
        }
        *pending = Some(MachineMcpQuestionPending {
            machines: machines.clone(),
            responder: tx,
        });
    }
    emit_agent_event(
        app,
        json!({"type":"machine_mcp_prompt","at":chrono::Utc::now().timestamp_millis(),"visible":true,"machines":machines,"manualOnly":machines.is_empty()}),
    );
    let answer = rx.await.ok().flatten();
    if let Ok(mut pending) = state.machine_mcp_question.lock() {
        if pending.is_some() {
            pending.take();
            emit_agent_event(
                app,
                json!({"type":"machine_mcp_prompt","at":chrono::Utc::now().timestamp_millis(),"visible":false}),
            );
        }
    }
    answer
}

pub fn submit_agent_answer(app: &AppHandle, state: &AppState, payload: Option<Value>) -> Value {
    let Some(payload) = payload else {
        return json!({"ok":false,"reason":"invalid_value"});
    };
    let Some(question_id) = payload.get("questionId").and_then(Value::as_str) else {
        return json!({"ok":false,"reason":"invalid_value"});
    };
    let Some(value_raw) = payload.get("value").and_then(Value::as_str) else {
        return json!({"ok":false,"reason":"invalid_value"});
    };
    let value = value_raw.trim().to_owned();
    let mut pending = match lock(&state.agent_question) {
        Ok(value) => value,
        Err(_) => return json!({"ok":false,"reason":"no_pending"}),
    };
    let Some(current) = pending.as_ref() else {
        return json!({"ok":false,"reason":"no_pending"});
    };
    if current.question_id != question_id {
        return json!({"ok":false,"reason":"stale_question"});
    }
    if value.is_empty() || value.chars().count() > 4_000 {
        return json!({"ok":false,"reason":"invalid_value"});
    }
    let matches_option = current
        .prompt
        .options
        .as_ref()
        .is_some_and(|options| options.iter().any(|option| option.value == value));
    if !matches_option && current.prompt.allow_free_text != Some(true) {
        return json!({"ok":false,"reason":"invalid_value"});
    }
    let current = pending.take().expect("pending checked above");
    let _ = current.responder.send(Some(value));
    emit_agent_event(
        app,
        json!({"type":"agent_question","questionId":current.question_id,"visible":false,"question":""}),
    );
    json!({"ok":true})
}

pub fn submit_machine_answer(app: &AppHandle, state: &AppState, payload: Option<Value>) -> Value {
    let Some(payload) = payload else {
        return json!({"ok":false,"reason":"invalid_value"});
    };
    let mut pending = match lock(&state.machine_mcp_question) {
        Ok(value) => value,
        Err(_) => return json!({"ok":false,"reason":"no_pending"}),
    };
    let Some(current) = pending.as_ref() else {
        return json!({"ok":false,"reason":"no_pending"});
    };
    let answer =
        match payload.get("kind").and_then(Value::as_str) {
            Some("machine") => {
                let device_id = payload
                    .get("deviceId")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let ip_address = payload
                    .get("ipAddress")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let Some(host) = normalize_machine_host(ip_address) else {
                    return json!({"ok":false,"reason":"invalid_value"});
                };
                if !current.machines.iter().any(|machine| {
                    machine.device_id == device_id && machine.ip_address == ip_address
                }) {
                    return json!({"ok":false,"reason":"invalid_value"});
                }
                MachineMcpAnswer {
                    host,
                    device_id: Some(device_id.to_owned()),
                }
            }
            Some("manual_ip") => {
                let Some(host) = normalize_machine_host(
                    payload.get("value").and_then(Value::as_str).unwrap_or(""),
                ) else {
                    return json!({"ok":false,"reason":"invalid_value"});
                };
                MachineMcpAnswer {
                    host,
                    device_id: None,
                }
            }
            _ => return json!({"ok":false,"reason":"invalid_value"}),
        };
    let current = pending.take().expect("pending checked above");
    let _ = current.responder.send(Some(answer));
    emit_agent_event(
        app,
        json!({"type":"machine_mcp_prompt","at":chrono::Utc::now().timestamp_millis(),"visible":false}),
    );
    json!({"ok":true})
}

pub fn cancel_pending(app: &AppHandle, state: &AppState) {
    if let Ok(mut pending) = state.machine_mcp_question.lock() {
        if let Some(current) = pending.take() {
            let _ = current.responder.send(None);
            emit_agent_event(
                app,
                json!({"type":"machine_mcp_prompt","at":chrono::Utc::now().timestamp_millis(),"visible":false}),
            );
        }
    }
    if let Ok(mut pending) = state.agent_question.lock() {
        if let Some(current) = pending.take() {
            let id = current.question_id.clone();
            let _ = current.responder.send(None);
            emit_agent_event(
                app,
                json!({"type":"agent_question","questionId":id,"visible":false,"question":""}),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn machine_host_normalization() {
        assert_eq!(
            normalize_machine_host("http://127.0.0.1:1"),
            Some("127.0.0.1:1".to_owned())
        );
        assert!(normalize_machine_host("127.0.0.1/path").is_none());
        assert!(normalize_machine_host("  ").is_none());
    }
}
