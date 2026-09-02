use crate::commands::AppState;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::time::{sleep, Duration};

pub const AGENT_EVENT: &str = "agent:events";
const MAX_TURNS: usize = 128;
const MAX_ATTEMPTS: usize = 3;

fn requests_removed_hosted_tool(prompt: &str) -> bool {
    let prompt = prompt.to_ascii_lowercase();
    [
        "web search",
        "search the web",
        "browse the internet",
        "code interpreter",
        "python sandbox",
        "run python",
    ]
    .iter()
    .any(|term| prompt.contains(term))
}

#[derive(Default)]
pub struct AgentState {
    pub(crate) active: Mutex<Option<Arc<AtomicBool>>>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptRequest {
    pub prompt: String,
    pub chat_media_attachments: Option<Vec<ChatMediaAttachment>>,
    pub chat_id: Option<String>,
    pub agent_session: Option<SessionIntent>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMediaAttachment {
    pub id: String,
    pub path: String,
    pub workspace_path: Option<String>,
    pub name: String,
    pub mime_type: String,
    pub kind: String,
    pub size: Option<u64>,
}

fn prepare_chat_attachments(
    workspace_root: &std::path::Path,
    attachments: &[ChatMediaAttachment],
) -> Result<Vec<(String, String)>, String> {
    let root = std::fs::canonicalize(workspace_root).map_err(|e| e.to_string())?;
    let mut paths = Vec::with_capacity(attachments.len());
    for attachment in attachments {
        if let Some(relative) = attachment
            .workspace_path
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            let path = crate::workspace::WorkspaceRoot::open(&root)
                .map_err(|error| error.to_string())?
                .resolve(relative)
                .map_err(|error| error.to_string())?;
            if !path.is_file() {
                return Err(format!(
                    "attachment workspace path is not a file: {relative}"
                ));
            }
            paths.push((attachment.id.clone(), relative.replace('\\', "/")));
            continue;
        }
        let source = std::fs::canonicalize(&attachment.path)
            .map_err(|_| format!("attachment source not found: {}", attachment.name))?;
        if !source.is_file() {
            return Err(format!(
                "attachment source is not a file: {}",
                attachment.name
            ));
        }
        let safe_name: String = attachment
            .name
            .chars()
            .map(|ch| {
                if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_') {
                    ch
                } else {
                    '_'
                }
            })
            .take(120)
            .collect();
        let safe_id: String = attachment
            .id
            .chars()
            .map(|ch| {
                if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_') {
                    ch
                } else {
                    '_'
                }
            })
            .take(80)
            .collect();
        let relative = format!(
            "assets/chat-attachments/{}-{}",
            if safe_id.is_empty() {
                "attachment"
            } else {
                &safe_id
            },
            if safe_name.is_empty() {
                "file"
            } else {
                &safe_name
            }
        );
        let destination = root.join(&relative);
        if !destination.starts_with(&root) {
            return Err("attachment destination escapes workspace root".to_owned());
        }
        if source != destination {
            if let Some(parent) = destination.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::copy(&source, &destination).map_err(|e| e.to_string())?;
        }
        paths.push((attachment.id.clone(), relative));
    }
    Ok(paths)
}
#[derive(Clone, Debug, Deserialize)]
pub struct SessionIntent {
    pub intent: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptLine {
    pub kind: String,
    pub at: i64,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionFile {
    chat_id: Option<String>,
    session_id: Option<String>,
    updated_at: Option<String>,
    turn_count: usize,
    previous_response_id: Option<String>,
    transcript: Vec<TranscriptLine>,
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
fn session_path(app: &AppHandle, chat_id: Option<&str>) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("agent-sessions");
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let raw = chat_id.unwrap_or("workspace");
    let safe = raw
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_') {
                ch
            } else {
                '_'
            }
        })
        .take(120)
        .collect::<String>();
    Ok(root.join(format!(
        "{}.json",
        if safe.is_empty() { "workspace" } else { &safe }
    )))
}
fn load_session(app: &AppHandle, chat_id: Option<&str>) -> SessionFile {
    session_path(app, chat_id)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| SessionFile {
            chat_id: chat_id.map(str::to_owned),
            ..Default::default()
        })
}
fn persist_session(app: &AppHandle, session: &SessionFile) -> Result<(), String> {
    let path = session_path(app, session.chat_id.as_deref())?;
    let tmp = path.with_extension("json.tmp");
    fs::write(
        &tmp,
        serde_json::to_vec_pretty(session).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    fs::rename(tmp, path).map_err(|e| e.to_string())
}
fn emit(app: &AppHandle, value: Value) {
    let _ = app.emit(AGENT_EVENT, value);
}
#[tauri::command]
pub async fn send_prompt(
    app: AppHandle,
    state: State<'_, AppState>,
    raw: Value,
) -> Result<Value, String> {
    let payload_value = raw.get("payload").cloned().unwrap_or(raw);
    let payload: PromptRequest =
        serde_json::from_value(payload_value).map_err(|e| e.to_string())?;
    if payload.prompt.trim().is_empty() {
        return Ok(json!({"ok":false,"message":"prompt is required"}));
    }
    if requests_removed_hosted_tool(&payload.prompt) {
        emit(
            &app,
            json!({"type":"error","code":"unsupported_hosted_tool","message":"Hosted web search and code interpreter are unavailable in this build","at":now_ms()}),
        );
        return Ok(
            json!({"ok":false,"failureReason":"unsupported_hosted_tool","message":"Hosted web search and code interpreter are unavailable in this build"}),
        );
    }
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut active = state
            .agent
            .active
            .lock()
            .map_err(|_| "agent state unavailable")?;
        if active.is_some() {
            return Ok(json!({"ok":false,"failureReason":"run_already_active"}));
        }
        *active = Some(cancel.clone());
    }
    let result = run_prompt(&app, &cancel, payload).await;
    if let Ok(mut active) = state.agent.active.lock() {
        *active = None;
    }
    if let Ok(mut attachments) = state.chat_attachments.lock() {
        attachments.clear();
    }
    result
}

async fn run_prompt(
    app: &AppHandle,
    cancel: &Arc<AtomicBool>,
    payload: PromptRequest,
) -> Result<Value, String> {
    let workspace_root = app
        .state::<AppState>()
        .workspace_root
        .lock()
        .ok()
        .and_then(|value| value.clone());
    let attachment_entries = match (
        workspace_root.as_deref(),
        payload.chat_media_attachments.as_deref(),
    ) {
        (Some(root), Some(attachments)) => prepare_chat_attachments(root, attachments)?,
        (None, Some(attachments)) if !attachments.is_empty() => {
            return Ok(json!({
                "ok": false,
                "failureReason": "workspace_not_selected",
                "message": "Select a workspace before using chat attachments"
            }));
        }
        _ => Vec::new(),
    };
    if let Ok(mut registry) = app.state::<AppState>().chat_attachments.lock() {
        registry.clear();
        for (id, relative) in &attachment_entries {
            registry.insert(id.clone(), relative.clone());
        }
    }
    let attachment_paths = attachment_entries
        .iter()
        .map(|(_, relative)| relative.clone())
        .collect::<Vec<_>>();
    let effective_prompt = if attachment_paths.is_empty() {
        payload.prompt.clone()
    } else {
        format!(
            "{}\n\nAttached media files (already copied into workspace):\n{}\n\nUse only these workspace-relative paths in code/config.",
            payload.prompt.trim(),
            attachment_paths.iter().map(|path| format!("- {path}")).collect::<Vec<_>>().join("\n")
        )
    };
    let mut session = load_session(app, payload.chat_id.as_deref());
    if payload
        .agent_session
        .as_ref()
        .is_some_and(|x| x.intent == "fresh")
    {
        session = SessionFile {
            chat_id: payload.chat_id.clone(),
            ..Default::default()
        };
    }
    if session.turn_count >= MAX_TURNS {
        return Ok(
            json!({"ok":false,"failureReason":"run_expired","message":"Maximum 128 turns reached"}),
        );
    }
    session.turn_count += 1;
    session.transcript.push(TranscriptLine {
        kind: "user".into(),
        at: now_ms(),
        text: effective_prompt.clone(),
        tool_name: None,
    });
    emit(
        app,
        json!({"type":"status","message":"Agent running","at":now_ms()}),
    );
    let settings = crate::commands::read_provider_settings(app);
    let base_url = settings.custom.base_url.as_str();
    let api_key = settings.custom.api_key.as_str();
    let model = settings.custom.model.as_str();
    crate::rig_runtime::validate_agent_configuration(base_url, api_key, model)
        .map_err(|error| format!("Rig agent configuration failed: {error}"))?;
    let mut last_error = String::new();
    for attempt in 1..=MAX_ATTEMPTS {
        if cancel.load(Ordering::Relaxed) {
            return Ok(json!({"ok":false,"message":"cancelled"}));
        }
        let result = crate::rig_runtime::stream_prompt_with_app(
            base_url,
            api_key,
            model,
            &effective_prompt,
            session.previous_response_id.clone(),
            app.path().app_data_dir().ok().and_then(|_| {
                app.state::<AppState>()
                    .workspace_root
                    .lock()
                    .ok()
                    .and_then(|v| v.clone())
            }),
            cancel.clone(),
            Some(app.clone()),
            |event| match event {
                crate::rig_runtime::StreamEvent::TextDelta(delta) => emit(
                    app,
                    json!({"type":"text_delta","source":"rig","delta":delta}),
                ),
                crate::rig_runtime::StreamEvent::ToolCall { name, arguments } => emit(
                    app,
                    json!({"type":"tool_called","source":"rig","name":name,"arguments":arguments}),
                ),
                crate::rig_runtime::StreamEvent::ToolResult { name } => emit(
                    app,
                    json!({"type":"tool_output","source":"rig","name":name}),
                ),
            },
        )
        .await;
        if cancel.load(Ordering::Relaxed) {
            return Ok(json!({"ok":false,"message":"cancelled"}));
        }
        match result {
            Ok(outcome) => {
                session.previous_response_id = outcome.response_id;
                session.updated_at = Some(chrono::Utc::now().to_rfc3339());
                session.transcript.push(TranscriptLine {
                    kind: "assistant".into(),
                    at: now_ms(),
                    text: outcome.output.clone(),
                    tool_name: None,
                });
                persist_session(app, &session)?;
                emit(
                    app,
                    json!({"type":"final","content":outcome.output,"at":now_ms()}),
                );
                return Ok(json!({"ok":true}));
            }
            Err(e) => last_error = e.to_string(),
        }
        if attempt < MAX_ATTEMPTS {
            emit(
                app,
                json!({"type":"status","message":format!("Retrying agent request ({attempt}/{MAX_ATTEMPTS})"),"at":now_ms()}),
            );
            sleep(Duration::from_millis(100 * attempt as u64)).await;
        }
    }
    emit(
        app,
        json!({"type":"error","message":last_error,"at":now_ms()}),
    );
    Ok(json!({"ok":false,"message":last_error}))
}

#[tauri::command]
pub fn cancel_agent(app: AppHandle, state: State<'_, AppState>) -> Result<Value, String> {
    crate::pending_inputs::cancel_pending(&app, &state);
    if let Some(flag) = state
        .agent
        .active
        .lock()
        .map_err(|_| "agent state unavailable")?
        .as_ref()
    {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(json!({"ok":true}))
}

#[tauri::command]
pub fn get_workspace_session_summary(app: AppHandle, payload: Option<String>) -> Value {
    let s = load_session(&app, payload.as_deref());
    let tail = s
        .transcript
        .iter()
        .rev()
        .take(40)
        .cloned()
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>();
    json!({"chatId":s.chat_id,"hasPersistedSession":s.updated_at.is_some(),"sessionId":s.session_id,"updatedAt":s.updated_at,"templateMode":null,"transcriptTail":tail,"tokenUsage":null,"agentProfileId":null})
}

#[tauri::command]
pub fn reset_workspace_session(app: AppHandle, payload: Option<String>) -> Result<Value, String> {
    match fs::remove_file(session_path(&app, payload.as_deref())?) {
        Ok(()) => Ok(json!({"ok":true})),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({"ok":true})),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn limits() {
        assert_eq!(MAX_TURNS, 128);
        assert_eq!(MAX_ATTEMPTS, 3);
    }
    #[test]
    fn cancel() {
        let x = Arc::new(AtomicBool::new(false));
        x.store(true, Ordering::Relaxed);
        assert!(x.load(Ordering::Relaxed));
    }

    #[test]
    fn hosted_tools_are_explicitly_unsupported() {
        assert!(requests_removed_hosted_tool("please search the web"));
        assert!(requests_removed_hosted_tool("run python in the sandbox"));
        assert!(!requests_removed_hosted_tool("build a darts game"));
    }

    #[test]
    fn chat_attachment_copy_is_workspace_bound_and_deterministic() {
        let root =
            std::env::temp_dir().join(format!("dartsnut-attachments-{}", uuid::Uuid::new_v4()));
        let source = root
            .parent()
            .unwrap()
            .join(format!("outside-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(&source, b"png").unwrap();
        let attachments = vec![ChatMediaAttachment {
            id: "id/with spaces".into(),
            path: source.to_string_lossy().into_owned(),
            workspace_path: None,
            name: "hero image!.png".into(),
            mime_type: "image/png".into(),
            kind: "image".into(),
            size: Some(3),
        }];
        let copied = prepare_chat_attachments(&root, &attachments).unwrap();
        assert_eq!(copied.len(), 1);
        let relative = &copied[0].1;
        assert!(relative.starts_with("assets/chat-attachments/id_with_spaces-hero_image_.png"));
        assert_eq!(std::fs::read(root.join(relative)).unwrap(), b"png");
        let _ = std::fs::remove_file(source);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn chat_attachment_workspace_path_rejects_missing_file() {
        let root =
            std::env::temp_dir().join(format!("dartsnut-attachments-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let attachment = ChatMediaAttachment {
            id: "id".into(),
            path: "unused".into(),
            workspace_path: Some("missing.png".into()),
            name: "missing.png".into(),
            mime_type: "image/png".into(),
            kind: "image".into(),
            size: None,
        };
        assert!(prepare_chat_attachments(&root, &[attachment]).is_err());
        let _ = std::fs::remove_dir_all(root);
    }
}
