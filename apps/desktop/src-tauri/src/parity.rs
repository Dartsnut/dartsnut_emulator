use base64::Engine;
use reqwest::multipart;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::{DialogExt, FilePath};
use tauri_plugin_updater::UpdaterExt;

async fn pick_folder_async(app: &AppHandle) -> Option<FilePath> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |path| {
        let _ = sender.send(path);
    });
    receiver.await.ok().flatten()
}

async fn pick_file_async(app: &AppHandle) -> Option<FilePath> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_file(move |path| {
        let _ = sender.send(path);
    });
    receiver.await.ok().flatten()
}

fn ok() -> Value {
    json!({"ok": true})
}
fn unsupported(name: &str) -> Value {
    json!({"ok": false, "reason": "unsupported", "message": format!("{name} is not available in this build")})
}

fn workspace_path_allowed(state: &crate::commands::AppState, requested: &str) -> bool {
    let Some(active) = state
        .workspace_root
        .lock()
        .ok()
        .and_then(|value| value.clone())
    else {
        return false;
    };
    let Ok(active) = std::fs::canonicalize(active) else {
        return false;
    };
    let requested_path = std::path::Path::new(requested);
    let Ok(requested) = std::fs::canonicalize(requested_path) else {
        return false;
    };
    requested == active
}

pub(crate) fn community_base_url() -> String {
    std::env::var("DARTSNUT_BASE_API")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| "https://api.dartsnut.com".to_owned())
        .trim_end_matches('/')
        .to_owned()
}

fn community_session_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("community-session.json"))
}

fn community_session(app: &AppHandle) -> Value {
    community_session_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| json!({"loggedIn":false,"account":null,"token":null,"authMethod":null}))
}

pub(crate) fn community_token(app: &AppHandle) -> Option<String> {
    community_session(app)
        .get("token")
        .and_then(Value::as_str)
        .filter(|v| !v.trim().is_empty())
        .map(str::to_owned)
}

fn community_error(code: &str, message: impl Into<String>, server: Option<&str>) -> Value {
    let mut value = json!({"ok":false,"code":code,"message":message.into()});
    if let Some(server) = server {
        value["serverMessage"] = Value::String(server.to_owned());
    }
    value
}

async fn community_request(
    method: reqwest::Method,
    path: &str,
    token: Option<&str>,
    body: Option<Value>,
) -> Result<(u16, Value), String> {
    let base_url = community_base_url();
    let client = crate::proxy::client_for_url_async(&base_url).await?;
    let mut request = client
        .request(method, format!("{}{path}", base_url))
        .header("Accept", "application/json")
        .header("x-dartsnut-source", "desktop-tauri");
    if let Some(token) = token.filter(|v| !v.trim().is_empty()) {
        request = request.header("token", token);
    }
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request.send().await.map_err(|e| e.to_string())?;
    let status = response.status().as_u16();
    let value = response.json::<Value>().await.unwrap_or(Value::Null);
    Ok((status, value))
}

fn envelope_data(status: u16, raw: Value) -> Result<Value, Value> {
    let code = raw.get("code").and_then(Value::as_i64).unwrap_or_default();
    let server = raw
        .get("desc")
        .or_else(|| raw.get("msg"))
        .and_then(Value::as_str);
    if status == 403 {
        return Err(community_error(
            "session_expired",
            server.unwrap_or("Please sign in again."),
            server,
        ));
    }
    if code != 1001 && code != 200 {
        return Err(community_error(
            "api_error",
            server.unwrap_or("Community request failed."),
            server,
        ));
    }
    Ok(raw.get("data").cloned().unwrap_or(Value::Null))
}

fn normalize_id(value: &Value) -> Value {
    if let Some(n) = value.as_i64() {
        Value::Number(n.into())
    } else {
        Value::String(value.as_str().unwrap_or_default().to_owned())
    }
}

fn value_i64(value: Option<&Value>) -> i64 {
    value
        .and_then(|v| v.as_i64().or_else(|| v.as_str()?.parse().ok()))
        .unwrap_or_default()
}

fn normalize_apps(list: &[Value], project_type: &str) -> Vec<Value> {
    list.iter().map(|row| {
        let id = row.get("id").or_else(|| row.get("game_system_id")).or_else(|| row.get("widget_system_id")).cloned().unwrap_or(Value::String(String::new()));
        let app_id = row.get(if project_type == "widget" { "widget_id" } else { "game_id" }).or_else(|| row.get("app_id")).cloned().unwrap_or(Value::String(String::new()));
        let app_name = row.get(if project_type == "widget" { "widget_name" } else { "game_name" }).or_else(|| row.get("name")).cloned().unwrap_or(Value::String(String::new()));
        json!({"id":normalize_id(&id),"appId":app_id,"appName":app_name,"projectType":project_type,"mainCover":row.get("main_cover").cloned().unwrap_or(Value::String(String::new())),"description":row.get("description").cloned().unwrap_or(Value::String(String::new())),"status":row.get("status").cloned().unwrap_or(Value::String(String::new())),"createdAt":row.get("created_at").cloned().unwrap_or(Value::Null)})
    }).collect()
}

fn query_encode(value: &str) -> String {
    value.bytes().fold(String::new(), |mut out, byte| {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(byte as char);
        } else {
            out.push('%');
            out.push_str(&format!("{byte:02X}"));
        }
        out
    })
}

fn asset_pending_path(workspace: &Path) -> PathBuf {
    workspace.join(".dartsnut-pending-assets.json")
}

fn read_pending_assets(workspace: &Path) -> Vec<String> {
    std::fs::read_to_string(asset_pending_path(workspace))
        .ok()
        .and_then(|body| serde_json::from_str::<Vec<String>>(&body).ok())
        .unwrap_or_default()
}

fn write_pending_assets(workspace: &Path, slot_ids: &[String]) {
    let path = asset_pending_path(workspace);
    let tmp = path.with_extension("json.tmp");
    if let Ok(body) = serde_json::to_vec_pretty(slot_ids) {
        let _ = std::fs::write(&tmp, body).and_then(|_| std::fs::rename(tmp, path));
    }
}

fn mark_asset_pending(workspace: &Path, slot_id: &str) {
    let mut pending = read_pending_assets(workspace);
    if !pending.iter().any(|value| value == slot_id) {
        pending.push(slot_id.to_owned());
        pending.sort();
        write_pending_assets(workspace, &pending);
    }
}

#[tauri::command]
pub fn report_renderer_error(app: AppHandle, payload: Option<Value>) -> Result<(), String> {
    let Some(payload) = payload else {
        return Ok(());
    };
    let message = payload
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("renderer error");
    let stack = payload.get("stack").and_then(Value::as_str).unwrap_or("");
    let redact = |value: &str| {
        let clean = value
            .chars()
            .map(|c| {
                if c.is_control() && c != '\n' && c != '\t' {
                    ' '
                } else {
                    c
                }
            })
            .collect::<String>();
        clean
            .replace("Bearer ", "Bearer [REDACTED] ")
            .chars()
            .take(5000)
            .collect::<String>()
    };
    let line = format!(
        "{} renderer: {}{}\n",
        chrono::Utc::now().to_rfc3339(),
        redact(message),
        if stack.is_empty() {
            String::new()
        } else {
            format!("\n{}", redact(stack))
        }
    );
    let path = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("logs")
        .join("startup.log");
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    file.write_all(line.as_bytes()).map_err(|e| e.to_string())
}
#[tauri::command]
pub fn open_startup_logs(app: AppHandle) -> Result<(), String> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("logs")
        .join("startup.log");
    tauri_plugin_opener::open_path(path, None::<&str>).map_err(|e| e.to_string())
}
#[tauri::command]
pub fn copy_startup_diagnostics(app: AppHandle, payload: Option<Value>) -> Result<(), String> {
    let text = payload
        .and_then(|value| value.get("text").cloned().or(Some(value)))
        .map(|value| value.to_string())
        .unwrap_or_else(|| "Dartsnut Agent diagnostics unavailable".to_owned());
    app.clipboard()
        .write_text(text)
        .map_err(|error| error.to_string())
}
#[tauri::command]
pub fn reset_renderer_state(app: AppHandle, _payload: Option<Value>) -> Result<(), String> {
    app.emit("shell:renderer-state-reset", ())
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub fn restart_without_gpu(app: AppHandle, _payload: Option<Value>) -> Result<(), String> {
    std::env::set_var("DARTSNUT_DISABLE_GPU", "1");
    app.restart()
}
#[tauri::command]
pub fn generate_chat_title(
    app: AppHandle,
    state: tauri::State<'_, crate::commands::AppState>,
    payload: Option<Value>,
) -> Value {
    let Some(value) = payload else {
        return json!({"tree":{"projects":[],"chats":[]},"updated":false});
    };
    let chat_id = value.get("chatId").and_then(Value::as_str).unwrap_or("");
    let fallback = value
        .get("firstUserMessage")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if chat_id.is_empty() || fallback.is_empty() {
        return json!({"tree":{"projects":[],"chats":[]},"updated":false});
    }
    let title = fallback.split_whitespace().collect::<Vec<_>>().join(" ");
    let title = title.chars().take(60).collect::<String>();
    let Some(mut store_guard) = crate::commands::store_for_title(&app, &state) else {
        return json!({"tree":{"projects":[],"chats":[]},"updated":false});
    };
    let Some(store) = store_guard.as_mut() else {
        return json!({"tree":{"projects":[],"chats":[]},"updated":false});
    };
    let updated = store.rename_chat(chat_id, &title).unwrap_or(false);
    let (projects, chats) = store.list();
    json!({"tree":{"projects":projects,"chats":chats},"updated":updated,"title":title})
}
#[tauri::command]
pub fn get_window_chrome_insets() -> Value {
    let top = if cfg!(target_os = "windows") { 32 } else { 0 };
    json!({"top":top,"left":0,"right":0,"bottom":0})
}
#[tauri::command]
pub async fn install_app_update_now(
    app: AppHandle,
    state: tauri::State<'_, crate::commands::AppState>,
) -> Result<Value, String> {
    let pending = state
        .update
        .lock()
        .map_err(|_| "updater state unavailable")?;
    let Some(update) = pending.update.clone() else {
        return Ok(json!({"ok":false,"reason":"not_ready"}));
    };
    let Some(bytes) = pending.bytes.clone() else {
        return Ok(json!({"ok":false,"reason":"not_ready"}));
    };
    drop(pending);
    update.install(&bytes).map_err(|error| error.to_string())?;
    app.restart()
}
#[tauri::command]
pub async fn download_app_update(
    app: AppHandle,
    state: tauri::State<'_, crate::commands::AppState>,
) -> Result<Value, String> {
    let update = {
        let mut pending = state
            .update
            .lock()
            .map_err(|_| "updater state unavailable")?;
        if pending.downloading {
            return Ok(json!({"ok":false,"reason":"already_downloading"}));
        }
        let Some(update) = pending.update.clone() else {
            return Ok(json!({"ok":false,"reason":"not_available"}));
        };
        pending.downloading = true;
        pending.state.kind = crate::updates::UpdateKind::Downloading;
        pending.state.percent = Some(0);
        update
    };
    if let Ok(value) = state.update.lock() {
        let _ = app.emit("app:update-status-changed", value.state.clone());
    }
    let progress_app = app.clone();
    let available_version = update.version.clone();
    let downloaded = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
    let progress_counter = downloaded.clone();
    let bytes = update
        .download(
            move |chunk, length| {
                let current = progress_counter
                    .fetch_add(chunk as u64, std::sync::atomic::Ordering::Relaxed)
                    + chunk as u64;
                if let Some(length) = length.filter(|value| *value > 0) {
                    let percent = ((current.saturating_mul(100)) / length).min(99) as u8;
                    let _ = progress_app.emit(
                        "app:update-status-changed",
                        json!({
                            "kind": "downloading",
                            "currentVersion": env!("CARGO_PKG_VERSION"),
                            "availableVersion": available_version,
                            "percent": percent,
                            "message": "Downloading update..."
                        }),
                    );
                }
            },
            || {},
        )
        .await
        .map_err(|error| error.to_string())?;
    let mut pending = state
        .update
        .lock()
        .map_err(|_| "updater state unavailable")?;
    pending.downloading = false;
    pending.bytes = Some(bytes);
    pending.update = Some(update.clone());
    pending.state.kind = crate::updates::UpdateKind::Ready;
    pending.state.percent = Some(100);
    pending.state.message = Some("Update ready to install.".to_owned());
    let _ = app.emit("app:update-status-changed", pending.state.clone());
    Ok(json!({"ok":true}))
}
#[tauri::command]
pub async fn check_app_update(
    app: AppHandle,
    state: tauri::State<'_, crate::commands::AppState>,
) -> Result<Value, String> {
    {
        let mut pending = state
            .update
            .lock()
            .map_err(|_| "updater state unavailable")?;
        if pending.checking {
            return Ok(json!({"ok":false,"reason":"already_checking"}));
        }
        if pending.update.is_some() && pending.bytes.is_some() {
            return Ok(json!({"ok":false,"reason":"already_ready"}));
        }
        pending.checking = true;
        pending.state.kind = crate::updates::UpdateKind::Checking;
        pending.state.message = Some("Checking for updates...".to_owned());
    }
    if let Ok(value) = state.update.lock() {
        let _ = app.emit("app:update-status-changed", value.state.clone());
    }
    let result = app
        .updater()
        .map_err(|error| error.to_string())?
        .check()
        .await;
    let mut pending = state
        .update
        .lock()
        .map_err(|_| "updater state unavailable")?;
    pending.checking = false;
    match result {
        Ok(Some(update)) => {
            pending.state.kind = crate::updates::UpdateKind::Available;
            pending.state.available_version = Some(update.version.clone());
            pending.state.percent = Some(0);
            pending.state.message = Some("Update available.".to_owned());
            pending.update = Some(update);
            let _ = app.emit("app:update-status-changed", pending.state.clone());
            Ok(json!({"ok":true}))
        }
        Ok(None) => {
            pending.state.kind = crate::updates::UpdateKind::NotAvailable;
            pending.state.available_version = None;
            pending.state.message = Some("Dartsnut Agent is up to date.".to_owned());
            let _ = app.emit("app:update-status-changed", pending.state.clone());
            Ok(json!({"ok":true}))
        }
        Err(error) => {
            pending.state.kind = crate::updates::UpdateKind::Error;
            pending.state.message = Some(error.to_string());
            let _ = app.emit("app:update-status-changed", pending.state.clone());
            Ok(json!({"ok":false,"reason":"failed","message":error.to_string()}))
        }
    }
}
#[tauri::command]
pub fn set_shell_ui_theme(app: AppHandle, payload: Option<Value>) -> Result<(), String> {
    let value = payload.unwrap_or(Value::Null);
    let theme = match value.as_str().unwrap_or("system") {
        "dark" => Some(tauri::Theme::Dark),
        "light" => Some(tauri::Theme::Light),
        _ => None,
    };
    if let Some(window) = app.get_webview_window("main") {
        window.set_theme(theme).map_err(|e| e.to_string())?;
    }
    app.emit("shell:theme-changed", value)
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn pick_workspace(app: AppHandle, payload: Option<Value>) -> Value {
    let state = app.state::<crate::commands::AppState>();
    let require_empty = payload
        .as_ref()
        .and_then(|value| value.get("requireEmpty").and_then(Value::as_bool))
        .unwrap_or(false);
    let selected = pick_folder_async(&app).await;
    match selected {
        Some(path) => {
            let selected_path = path.to_string();
            if require_empty
                && std::fs::read_dir(&selected_path)
                    .map(|mut entries| entries.next().is_some())
                    .unwrap_or(true)
            {
                return json!({
                    "state": crate::commands::get_bootstrap_state(state),
                    "selectedPath": selected_path,
                    "accepted": false,
                    "reason": "non_empty"
                });
            }
            if let Ok(mut root) = state.workspace_root.lock() {
                *root = Some(PathBuf::from(&selected_path));
            }
            json!({
                "state": crate::commands::get_bootstrap_state(state),
                "selectedPath": selected_path,
                "accepted": true
            })
        }
        None => json!({
            "state": crate::commands::get_bootstrap_state(state),
            "selectedPath": null,
            "accepted": false,
            "reason": "cancelled"
        }),
    }
}

/// Native file picker used by Tauri because browser `File` objects do not expose
/// absolute filesystem paths (Electron's `webUtils.getPathForFile` did).
#[tauri::command]
pub async fn assets_pick_source_file(app: AppHandle) -> Value {
    let selected = pick_file_async(&app).await;
    match selected {
        Some(path) => json!({"ok":true,"path":path.to_string()}),
        None => json!({"ok":false,"reason":"cancelled"}),
    }
}
#[tauri::command]
pub fn machine_mcp_submit_question_answer(
    app: AppHandle,
    state: tauri::State<'_, crate::commands::AppState>,
    payload: Option<Value>,
) -> Value {
    crate::pending_inputs::submit_machine_answer(&app, &state, payload)
}
#[tauri::command]
pub fn agent_question_submit_answer(
    app: AppHandle,
    state: tauri::State<'_, crate::commands::AppState>,
    payload: Option<Value>,
) -> Value {
    crate::pending_inputs::submit_agent_answer(&app, &state, payload)
}

#[tauri::command]
pub async fn emulator_command(
    app: AppHandle,
    state: tauri::State<'_, crate::commands::AppState>,
    payload: Option<Value>,
) -> Result<Value, String> {
    let Some(command) = payload else {
        return Ok(json!({"ok":false,"error":"command is required"}));
    };
    let Some(kind) = command.get("type").and_then(Value::as_str) else {
        return Ok(json!({"ok":false,"error":"command type is required"}));
    };
    let supported = [
        "set_path",
        "set_params",
        "stop_widget",
        "shutdown",
        "reload_widget",
        "set_audio_muted",
        "set_button",
        "throw_dart",
        "remove_dart_at",
        "clear_darts",
        "capture_screenshot",
        "start_gif_recording",
        "stop_gif_recording",
    ];
    if !supported.contains(&kind) {
        return Ok(unsupported("emulator_command"));
    }
    let workspace = state
        .workspace_root
        .lock()
        .ok()
        .and_then(|value| value.clone());
    state
        .emulator
        .send(&app, workspace.as_deref(), command)
        .await?;
    Ok(json!({"ok": true}))
}
#[tauri::command]
pub async fn emulator_pick_path(app: AppHandle) -> Value {
    let state = app.state::<crate::commands::AppState>();
    match pick_folder_async(&app).await {
        Some(path) => {
            let absolute = std::path::PathBuf::from(path.to_string());
            let workspace = state
                .workspace_root
                .lock()
                .ok()
                .and_then(|value| value.clone());
            let returned = workspace
                .as_ref()
                .and_then(|root| absolute.strip_prefix(root).ok())
                .filter(|relative| !relative.as_os_str().is_empty())
                .map(|relative| relative.to_string_lossy().replace('\\', "/"))
                .unwrap_or_else(|| absolute.to_string_lossy().into_owned());
            state.emulator.set_last_path(&app, returned.clone());
            crate::emulator::EmulatorRuntime::persist_last_path(&app, Some(&returned));
            json!({"path": returned})
        }
        None => json!({"path":null}),
    }
}
#[tauri::command]
pub fn emulator_get_last_path(
    app: AppHandle,
    state: tauri::State<'_, crate::commands::AppState>,
) -> Value {
    state.emulator.load_last_path(&app);
    json!({"path":state.emulator.last_path()})
}
#[tauri::command]
pub fn emulator_get_background(app: AppHandle) -> Value {
    let root = app.path().resource_dir().ok();
    let path = root
        .as_ref()
        .map(|value| value.join("PixelDarts.png"))
        .filter(|value| value.is_file())
        .or_else(|| Some(std::path::PathBuf::from("PixelDarts.png")));
    let Some(path) = path else {
        return json!({"url":null});
    };
    let Ok(bytes) = std::fs::read(path) else {
        return json!({"url":null});
    };
    use base64::Engine;
    json!({"url": format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes))})
}
#[tauri::command]
pub fn emulator_open_capture_folder(
    app: AppHandle,
    state: tauri::State<'_, crate::commands::AppState>,
    payload: Option<Value>,
) -> Result<(), String> {
    let path = payload
        .as_ref()
        .and_then(|value| value.as_str())
        .or_else(|| {
            payload
                .as_ref()
                .and_then(|value| value.get("folderPath").and_then(Value::as_str))
        })
        .ok_or_else(|| "folderPath is required".to_owned())?;
    let requested = std::fs::canonicalize(path).map_err(|_| "capture folder not found")?;
    let workspace = state
        .workspace_root
        .lock()
        .ok()
        .and_then(|value| value.clone())
        .or_else(|| app.path().app_data_dir().ok());
    let Some(workspace) = workspace else {
        return Err("workspace unavailable".to_owned());
    };
    let workspace = std::fs::canonicalize(workspace).map_err(|_| "workspace unavailable")?;
    if !requested.starts_with(&workspace) {
        return Err("capture folder escapes allowed workspace".to_owned());
    }
    tauri_plugin_opener::open_path(requested, None::<&str>).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn deploy_connect(
    app: AppHandle,
    state: tauri::State<'_, crate::commands::AppState>,
    payload: Option<Value>,
) -> Result<Value, String> {
    let value = payload.unwrap_or(Value::Null);
    let host_value = value.get("host").and_then(Value::as_str).unwrap_or("");
    if host_value.trim().is_empty() {
        return Ok(json!({"ok":false,"error":"host is required","canRetry":true}));
    }
    let (username, host) = host_value
        .rsplit_once('@')
        .map(|(u, h)| (u.to_owned(), h.to_owned()))
        .unwrap_or_else(|| ("dartsnut".to_owned(), host_value.to_owned()));
    let password = value
        .get("password")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(ToOwned::to_owned)
        .or_else(|| std::env::var("DARTSNUT_SSH_PASSWORD").ok())
        .unwrap_or_else(|| "rpi".to_owned());
    let known_hosts = app
        .path()
        .app_data_dir()
        .ok()
        .map(|p| p.join("known_hosts"));
    let Some(path) = known_hosts else {
        return Ok(json!({"ok":false,"error":"app data path unavailable"}));
    };
    let config = crate::deploy::ssh::SshConfig::new(
        host.clone(),
        username,
        password,
        crate::deploy::ssh::HostKeyPolicy::TrustOnFirstUse { path },
    );
    match crate::deploy::ssh::SshConnection::connect(config).await {
        Ok(connection) => {
            if let Ok(mut slot) = state.deploy.lock() {
                *slot = Some(std::sync::Arc::new(connection));
            }
            match crate::deploy::sideload::SideloadClient::connect_and_probe(&app, &host) {
                Ok(sideload) => {
                    if let Ok(mut slot) = state.sideload.lock() {
                        *slot = Some(std::sync::Arc::new(sideload));
                    }
                    Ok(json!({"ok":true,"deviceName":host,"deployMode":"safe_sideload"}))
                }
                Err(_) => Ok(
                    json!({"ok":true,"deviceName":host,"deployMode":"legacy_unsafe","warning":"Safe sideload protocol unavailable; using SSH fallback"}),
                ),
            }
        }
        Err(error) => Ok(json!({"ok":false,"error":error.to_string(),"canRetry":true})),
    }
}
#[tauri::command]
pub async fn deploy_disconnect(
    state: tauri::State<'_, crate::commands::AppState>,
) -> Result<Value, String> {
    let sideload = state
        .sideload
        .lock()
        .ok()
        .and_then(|mut value| value.take());
    if let Some(sideload) = sideload {
        sideload.close();
    }
    let connection = state.deploy.lock().ok().and_then(|mut value| value.take());
    if let Some(connection) = connection {
        let _ = connection.close().await;
    }
    Ok(ok())
}
#[tauri::command]
pub async fn deploy_run(
    app: AppHandle,
    state: tauri::State<'_, crate::commands::AppState>,
    payload: Option<Value>,
) -> Result<Value, String> {
    let connection = state.deploy.lock().ok().and_then(|value| value.clone());
    let Some(connection) = connection else {
        return Ok(json!({"ok":false,"error":"not connected"}));
    };
    let workspace = state
        .workspace_root
        .lock()
        .ok()
        .and_then(|value| value.clone());
    let Some(workspace) = workspace else {
        return Ok(json!({"ok":false,"error":"workspace not selected"}));
    };
    let conf = std::fs::read_to_string(workspace.join("conf.json"))
        .ok()
        .and_then(|body| serde_json::from_str::<Value>(&body).ok())
        .unwrap_or(Value::Null);
    let app_id = conf
        .get("appId")
        .or_else(|| conf.get("app_id"))
        .and_then(Value::as_str)
        .unwrap_or("dartsnut-app");
    if !app_id
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
    {
        return Ok(json!({"ok":false,"error":"invalid app id"}));
    }
    if let Some(sideload) = state.sideload.lock().ok().and_then(|value| value.clone()) {
        let size = conf
            .get("widgetSize")
            .and_then(Value::as_str)
            .and_then(|value| value.split_once('x'))
            .and_then(|(w, h)| Some([w.parse().ok()?, h.parse().ok()?]))
            .unwrap_or([128, 160]);
        let params = payload
            .as_ref()
            .and_then(|value| value.get("widgetParamsJson"))
            .and_then(Value::as_str)
            .and_then(|value| serde_json::from_str::<Value>(value).ok())
            .unwrap_or_else(|| json!({}));
        return sideload.start(&app, &workspace, app_id, size, params).map(
            |session_id| json!({"ok":true,"sessionId":session_id,"deployMode":"safe_sideload"}),
        );
    }
    let archive = crate::deploy::archive::create_workspace_archive(&workspace)
        .map_err(|error| error.to_string())?;
    let staging_root = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("deploy-staging");
    std::fs::create_dir_all(&staging_root).map_err(|error| error.to_string())?;
    let local_archive = staging_root.join(format!("{app_id}-{}.tar.gz", uuid::Uuid::new_v4()));
    std::fs::write(&local_archive, archive).map_err(|error| error.to_string())?;
    let remote_archive = format!("/tmp/dartsnut-deploy-{app_id}.tar.gz");
    let result = async {
        connection.upload_file(&local_archive, &remote_archive).await.map_err(|error| error.to_string())?;
        let remote_dir = format!("$HOME/dartsnut_rpi/apps/{app_id}");
        let params = payload.as_ref().and_then(|value| value.get("widgetParamsJson")).and_then(Value::as_str).unwrap_or("");
        let command = if params.is_empty() {
            format!("set -e; mkdir -p {remote_dir}; tar -xzf {remote_archive} -C {remote_dir}; pkill -f 'main.py' || true; cd {remote_dir}; nohup python3 main.py > /tmp/dartsnut-{app_id}.log 2>&1 < /dev/null &")
        } else {
            let encoded = base64::engine::general_purpose::STANDARD.encode(params.as_bytes());
            format!("set -e; mkdir -p {remote_dir}; tar -xzf {remote_archive} -C {remote_dir}; printf '%s' {encoded} | base64 -d > {remote_dir}/.dartsnut_widget_params.json; pkill -f 'main.py' || true; cd {remote_dir}; nohup python3 main.py --params {remote_dir}/.dartsnut_widget_params.json > /tmp/dartsnut-{app_id}.log 2>&1 < /dev/null &")
        };
        let output = connection.exec(&command).await.map_err(|error| error.to_string())?;
        let _ = app.emit("deploy:log", String::from_utf8_lossy(&output.stdout).to_string());
        if !output.stderr.is_empty() {
            let _ = app.emit("deploy:log", String::from_utf8_lossy(&output.stderr).to_string());
        }
        Ok::<bool, String>(output.exit_code.unwrap_or(1) == 0)
    }.await;
    let _ = std::fs::remove_file(local_archive);
    result
        .map(|ok| json!({"ok":ok}))
        .or_else(|error| Ok(json!({"ok":false,"error":error})))
}
#[tauri::command]
pub async fn deploy_reload(
    state: tauri::State<'_, crate::commands::AppState>,
    _payload: Option<Value>,
) -> Result<Value, String> {
    if let Some(sideload) = state.sideload.lock().ok().and_then(|value| value.clone()) {
        return Ok(match sideload.reload() {
            Ok(()) => ok(),
            Err(error) => json!({"ok":false,"error":error}),
        });
    }
    let connection = state.deploy.lock().ok().and_then(|value| value.clone());
    let Some(connection) = connection else {
        return Ok(json!({"ok":false,"error":"not connected"}));
    };
    Ok(
        match connection.exec("pkill -HUP -f 'main.py' || true").await {
            Ok(_) => ok(),
            Err(error) => json!({"ok":false,"error":error.to_string()}),
        },
    )
}
#[tauri::command]
pub async fn deploy_apply_widget_params(
    state: tauri::State<'_, crate::commands::AppState>,
    payload: Option<Value>,
) -> Result<Value, String> {
    let params = payload
        .as_ref()
        .and_then(|value| value.get("widgetParamsJson").and_then(Value::as_str))
        .unwrap_or("");
    if params.is_empty() {
        return Ok(json!({"ok":false,"error":"widgetParamsJson is required"}));
    }
    if let Some(sideload) = state.sideload.lock().ok().and_then(|value| value.clone()) {
        let parsed = serde_json::from_str::<Value>(params).unwrap_or_else(|_| json!({}));
        return Ok(match sideload.update_params(parsed) {
            Ok(()) => ok(),
            Err(error) => json!({"ok":false,"error":error}),
        });
    }
    let connection = state.deploy.lock().ok().and_then(|value| value.clone());
    let Some(connection) = connection else {
        return Ok(json!({"ok":false,"error":"not connected"}));
    };
    let encoded = base64::engine::general_purpose::STANDARD.encode(params.as_bytes());
    let command = format!("printf '%s' {encoded} | base64 -d > $HOME/.dartsnut_widget_params.json");
    match connection.exec(&command).await {
        Ok(output) if output.exit_code.unwrap_or(1) == 0 => Ok(ok()),
        Ok(output) => {
            Ok(json!({"ok":false,"error":String::from_utf8_lossy(&output.stderr).to_string()}))
        }
        Err(error) => Ok(json!({"ok":false,"error":error.to_string()})),
    }
}
#[tauri::command]
pub async fn deploy_stop(
    state: tauri::State<'_, crate::commands::AppState>,
) -> Result<Value, String> {
    if let Some(sideload) = state.sideload.lock().ok().and_then(|value| value.clone()) {
        return Ok(match sideload.stop() {
            Ok(()) => ok(),
            Err(error) => json!({"ok":false,"error":error}),
        });
    }
    let connection = state.deploy.lock().ok().and_then(|value| value.clone());
    let Some(connection) = connection else {
        return Ok(json!({"ok":false,"error":"not connected"}));
    };
    Ok(match connection.exec("pkill -f 'main.py' || true").await {
        Ok(_) => ok(),
        Err(error) => json!({"ok":false,"error":error.to_string()}),
    })
}
#[tauri::command]
pub fn deploy_open_local_network_settings() -> Value {
    json!({"ok":true})
}

#[tauri::command]
pub async fn community_login(app: AppHandle, payload: Option<Value>) -> Result<Value, String> {
    let method = payload
        .as_ref()
        .and_then(|v| v.get("method").and_then(Value::as_str))
        .unwrap_or("password");
    let oauth_id_token = if method == "googleOAuth" {
        let client_id = std::env::var("DARTSNUT_GOOGLE_DESKTOP_CLIENT_ID")
            .or_else(|_| std::env::var("DARTSNUT_GOOGLE_CLIENT_ID"))
            .unwrap_or_default();
        if client_id.trim().is_empty() {
            return Ok(
                json!({"ok":false,"code":"config_missing","message":"Google sign-in is not configured."}),
            );
        }
        let pkce = crate::oauth::generate_pkce();
        let callback =
            crate::oauth::start_callback(pkce.state.clone(), std::time::Duration::from_secs(120))
                .await
                .map_err(|e| e.to_string())?;
        if let Ok(mut slot) = app.state::<crate::commands::AppState>().oauth_cancel.lock() {
            *slot = Some(callback.cancellation_flag());
        }
        let redirect_uri = format!("http://127.0.0.1:{}/oauth/google/callback", callback.port);
        let auth_url = format!(
            "https://accounts.google.com/o/oauth2/v2/auth?client_id={}&redirect_uri={}&response_type=code&scope=openid%20email%20profile&state={}&code_challenge={}&code_challenge_method=S256&prompt=select_account",
            query_encode(&client_id), query_encode(&redirect_uri), query_encode(&pkce.state), query_encode(&pkce.challenge)
        );
        tauri_plugin_opener::open_url(&auth_url, None::<&str>).map_err(|e| e.to_string())?;
        let code_result = callback.wait().await;
        if let Ok(mut slot) = app.state::<crate::commands::AppState>().oauth_cancel.lock() {
            *slot = None;
        }
        let code = match code_result {
            Ok(code) => code,
            Err(crate::oauth::OAuthError::Cancelled) => {
                return Ok(
                    json!({"ok":false,"code":"cancelled","message":"Google sign-in cancelled"}),
                );
            }
            Err(error) => return Err(error.to_string()),
        };
        let mut form = vec![
            ("client_id", client_id),
            ("redirect_uri", redirect_uri),
            ("grant_type", "authorization_code".to_owned()),
            ("code", code),
            ("code_verifier", pkce.verifier),
        ];
        if let Ok(secret) = std::env::var("DARTSNUT_GOOGLE_DESKTOP_CLIENT_SECRET") {
            if !secret.trim().is_empty() {
                form.push(("client_secret", secret));
            }
        }
        let token_response = crate::proxy::client_for_url("https://oauth2.googleapis.com/token")?
            .post("https://oauth2.googleapis.com/token")
            .form(&form)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let token_json = token_response.json::<Value>().await.unwrap_or(Value::Null);
        let id_token = token_json
            .get("id_token")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_owned();
        if id_token.is_empty() {
            return Ok(community_error(
                "oauth_error",
                token_json
                    .get("error_description")
                    .and_then(Value::as_str)
                    .unwrap_or("Google did not return an ID token."),
                None,
            ));
        }
        Some(id_token)
    } else {
        None
    };
    let account = payload
        .as_ref()
        .and_then(|v| v.get("account").and_then(Value::as_str))
        .unwrap_or("");
    if method == "google" || oauth_id_token.is_some() {
        let id_token = oauth_id_token
            .as_deref()
            .or_else(|| {
                payload
                    .as_ref()
                    .and_then(|v| v.get("idToken").and_then(Value::as_str))
            })
            .unwrap_or("");
        if id_token.trim().is_empty() {
            return Ok(
                json!({"ok":false,"code":"invalid_request","message":"idToken is required"}),
            );
        }
        let (status, raw) = community_request(
            reqwest::Method::POST,
            "/community/google/login",
            None,
            Some(json!({"idToken": id_token.trim()})),
        )
        .await?;
        let data = match envelope_data(status, raw) {
            Ok(v) => v,
            Err(e) => return Ok(e),
        };
        let token = data
            .get("token")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        if token.is_empty() {
            return Ok(community_error(
                "api_error",
                "Login response did not include a token.",
                None,
            ));
        }
        let user = data.get("user_info").cloned().unwrap_or(Value::Null);
        let acct = user
            .get("account")
            .and_then(Value::as_str)
            .unwrap_or("Google user")
            .to_owned();
        let session = json!({"loggedIn":true,"account":acct,"token":token,"authMethod":"google","hasSupabase":std::env::var("DARTSNUT_SUPABASE_ANON_KEY").map(|v| !v.is_empty()).unwrap_or(false)});
        let path = community_session_path(&app)?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(
            path,
            serde_json::to_vec_pretty(&session).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        return Ok(
            json!({"ok":true,"account":acct,"needsPasswordSetup":data.get("needs_password_setup").and_then(Value::as_bool).unwrap_or(false)}),
        );
    }
    let password = payload
        .as_ref()
        .and_then(|v| v.get("password").and_then(Value::as_str))
        .unwrap_or("");
    if account.trim().is_empty() || password.is_empty() {
        return Ok(json!({"ok":false,"code":"invalid_request","message":"account is required"}));
    }
    let (status, raw) = community_request(
        reqwest::Method::POST,
        "/community/member/login-in",
        None,
        Some(json!({"account":account,"password":password})),
    )
    .await?;
    let data = match envelope_data(status, raw) {
        Ok(v) => v,
        Err(e) => return Ok(e),
    };
    let token = data
        .get("token")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if token.is_empty() {
        return Ok(community_error(
            "api_error",
            "Login response did not include a token.",
            None,
        ));
    }
    let user = data.get("user_info").cloned().unwrap_or(Value::Null);
    let acct = user
        .get("account")
        .and_then(Value::as_str)
        .unwrap_or(account)
        .to_owned();
    let session = json!({"loggedIn":true,"account":acct,"token":token,"authMethod":"password","hasSupabase":std::env::var("DARTSNUT_SUPABASE_ANON_KEY").map(|v| !v.is_empty()).unwrap_or(false)});
    let path = community_session_path(&app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(
        path,
        serde_json::to_vec_pretty(&session).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    Ok(json!({"ok":true,"account":acct,"needsPasswordSetup":false}))
}
#[tauri::command]
pub async fn community_set_password(
    app: AppHandle,
    payload: Option<Value>,
) -> Result<Value, String> {
    let password = payload
        .as_ref()
        .and_then(|v| v.get("password").and_then(Value::as_str))
        .unwrap_or("");
    if password.len() < 8 {
        return Ok(
            json!({"ok":false,"code":"invalid_password","message":"password must contain at least 8 characters"}),
        );
    }
    let session = crate::commands::community_get_session(app.clone());
    let account = session.get("account").and_then(Value::as_str).unwrap_or("");
    if account.is_empty() {
        return Ok(
            json!({"ok":false,"code":"not_authenticated","message":"community login required"}),
        );
    }
    let Some(token) = community_token(&app) else {
        return Ok(community_error(
            "session_expired",
            "Please sign in first.",
            None,
        ));
    };
    let (status, raw) = community_request(
        reqwest::Method::POST,
        "/community/member/set-password",
        Some(&token),
        Some(json!({"password":password})),
    )
    .await?;
    match envelope_data(status, raw) {
        Ok(_) => Ok(json!({"ok":true,"account":account})),
        Err(e) => Ok(e),
    }
}
#[tauri::command]
pub fn community_cancel_google_login(app: AppHandle) -> Value {
    if let Ok(slot) = app.state::<crate::commands::AppState>().oauth_cancel.lock() {
        if let Some(flag) = slot.as_ref() {
            flag.store(true, std::sync::atomic::Ordering::SeqCst);
            return json!({"ok":true,"cancelled":true});
        }
    }
    json!({"ok":true,"cancelled":false})
}
#[tauri::command]
pub fn community_logout(app: AppHandle) -> Value {
    if let Ok(path) = app
        .path()
        .app_data_dir()
        .map(|p| p.join("community-session.json"))
    {
        let _ = std::fs::remove_file(path);
    }
    json!({"ok":true,"loggedIn":false})
}
#[tauri::command]
pub async fn community_get_llm_quota(app: AppHandle) -> Result<Value, String> {
    let Some(token) = community_token(&app) else {
        return Ok(community_error(
            "session_expired",
            "Please sign in first.",
            None,
        ));
    };
    let (status, raw) =
        community_request(reqwest::Method::GET, "/agent/llm/quota", Some(&token), None).await?;
    match envelope_data(status, raw) {
        Ok(data) => Ok(json!({"ok":true,"quota":data})),
        Err(e) => Ok(e),
    }
}
#[tauri::command]
pub async fn community_list_deploy_devices(app: AppHandle) -> Result<Value, String> {
    let Some(token) = community_token(&app) else {
        return Ok(community_error(
            "session_expired",
            "Please sign in first.",
            None,
        ));
    };
    let (status, raw) = community_request(
        reqwest::Method::GET,
        "/mobile/device-map/devices",
        Some(&token),
        None,
    )
    .await?;
    let data = match envelope_data(status, raw) {
        Ok(v) => v,
        Err(e) => return Ok(e),
    };
    let list = data
        .get("list")
        .or_else(|| data.get("devices"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let devices = list.iter().map(|row| json!({"deviceId":row.get("device_id").or_else(|| row.get("deviceId")).cloned().unwrap_or(Value::String(String::new())),"name":row.get("name").or_else(|| row.get("device_name")).cloned().unwrap_or(Value::String(String::new())),"model":row.get("model").cloned().unwrap_or(Value::String(String::new())),"ipAddress":row.get("ip_address").or_else(|| row.get("ipAddress")).cloned().unwrap_or(Value::String(String::new())),"ssid":row.get("ssid").cloned().unwrap_or(Value::String(String::new())),"updatedAt":row.get("updated_at").cloned().unwrap_or(Value::Null)})).collect::<Vec<_>>();
    Ok(
        json!({"ok":true,"devices":devices,"supabaseConfigured":std::env::var("DARTSNUT_SUPABASE_ANON_KEY").map(|v| !v.is_empty()).unwrap_or(false)}),
    )
}
#[tauri::command]
pub async fn community_list_my_games(app: AppHandle) -> Result<Value, String> {
    let Some(token) = community_token(&app) else {
        return Ok(community_error(
            "session_expired",
            "Please sign in first.",
            None,
        ));
    };
    let (status, raw) = community_request(
        reqwest::Method::GET,
        "/community/game/my-list",
        Some(&token),
        None,
    )
    .await?;
    let data = match envelope_data(status, raw) {
        Ok(v) => v,
        Err(e) => return Ok(e),
    };
    let list = data
        .get("list")
        .and_then(Value::as_array)
        .cloned()
        .or_else(|| data.as_array().cloned())
        .unwrap_or_default();
    let games = normalize_apps(&list, "game").into_iter().map(|app| json!({"id":app["id"].clone(),"gameId":app["appId"].clone(),"gameName":app["appName"].clone(),"mainCover":app["mainCover"].clone(),"description":app["description"].clone(),"status":app["status"].clone(),"createdAt":app["createdAt"].clone()})).collect::<Vec<_>>();
    let total = games.len();
    Ok(json!({"ok":true,"games":games,"total":total}))
}
#[tauri::command]
pub async fn community_get_publish_options(
    app: AppHandle,
    state: tauri::State<'_, crate::commands::AppState>,
) -> Result<Value, String> {
    let token = community_token(&app).unwrap_or_default();
    let (g, w, gc, wc, status) = tokio::join!(
        community_request(
            reqwest::Method::GET,
            "/community/game/my-list",
            Some(&token),
            None
        ),
        community_request(
            reqwest::Method::GET,
            "/community/widget/my-list",
            Some(&token),
            None
        ),
        community_request(
            reqwest::Method::GET,
            "/community/game-cate/list",
            Some(&token),
            None
        ),
        community_request(
            reqwest::Method::GET,
            "/community/widget-cate/list",
            Some(&token),
            None
        ),
        community_request(
            reqwest::Method::GET,
            "/community/status/info",
            Some(&token),
            None
        )
    );
    let parse_list = |item: Result<(u16, Value), String>, ty: &str| -> Result<Vec<Value>, Value> {
        let (s, r) = item.map_err(|e| community_error("network_error", e, None))?;
        let d = envelope_data(s, r)?;
        Ok(normalize_apps(
            &d.get("list")
                .and_then(Value::as_array)
                .cloned()
                .or_else(|| d.as_array().cloned())
                .unwrap_or_default(),
            ty,
        ))
    };
    let games = match parse_list(g, "game") {
        Ok(v) => v,
        Err(e) => return Ok(e),
    };
    let widgets = match parse_list(w, "widget") {
        Ok(v) => v,
        Err(e) => return Ok(e),
    };
    let categories = |item: Result<(u16, Value), String>| -> Result<Vec<Value>, Value> {
        let (s, r) = item.map_err(|e| community_error("network_error", e, None))?;
        let d = envelope_data(s, r)?;
        Ok(d.get("list").and_then(Value::as_array).cloned().or_else(|| d.as_array().cloned()).unwrap_or_default().into_iter().map(|x| json!({"id":x.get("id").cloned().unwrap_or(Value::String(String::new())),"name":x.get("name").or_else(||x.get("label")).cloned().unwrap_or(Value::String(String::new()))})).collect())
    };
    let game_categories = match categories(gc) {
        Ok(v) => v,
        Err(e) => return Ok(e),
    };
    let widget_categories = match categories(wc) {
        Ok(v) => v,
        Err(e) => return Ok(e),
    };
    let (ss, sr) = status.map_err(|e| e.to_string())?;
    let sd = match envelope_data(ss, sr) {
        Ok(v) => v,
        Err(e) => return Ok(e),
    };
    let game_controls = sd
        .get("GAME")
        .and_then(|v| v.get("CONTROL_OPTIONS"))
        .cloned()
        .unwrap_or_else(|| json!([]));
    let widget = sd.get("WIDGET").cloned().unwrap_or_else(|| json!({}));
    let workspace = state.workspace_root.lock().ok().and_then(|v| v.clone());
    let defaults = workspace.and_then(|root| std::fs::read_to_string(root.join("conf.json")).ok().and_then(|s|serde_json::from_str::<Value>(&s).ok())).map(|c|json!({"eligible":true,"appId":c.get("appId").or_else(||c.get("app_id")).cloned().unwrap_or(Value::String(String::new())),"projectType":if c.get("widgetFields").is_some(){"widget"}else{"game"},"appName":c.get("name").cloned().unwrap_or(Value::String(String::new())),"version":c.get("version").cloned().unwrap_or(Value::String("0.0.1".into())),"description":c.get("description").cloned().unwrap_or(Value::String(String::new())),"widgetSize":c.get("widgetSize").cloned().unwrap_or(Value::String(String::new()))})).unwrap_or_else(||json!({"eligible":false,"appId":"","projectType":null,"appName":"","version":"0.0.1","description":"","widgetSize":""}));
    Ok(
        json!({"ok":true,"games":games,"widgets":widgets,"gameCategories":game_categories,"widgetCategories":widget_categories,"gameControls":game_controls,"widgetControls":widget.get("CONTROL_OPTIONS").cloned().unwrap_or_else(||json!([])),"widgetSizes":widget.get("WIDGET_SIZE_OPTIONS").cloned().unwrap_or_else(||json!([])),"workspace":defaults}),
    )
}
#[tauri::command]
pub async fn community_list_app_versions(
    app: AppHandle,
    payload: Option<Value>,
) -> Result<Value, String> {
    let Some(token) = community_token(&app) else {
        return Ok(community_error(
            "session_expired",
            "Please sign in first.",
            None,
        ));
    };
    let v = payload.unwrap_or(Value::Null);
    let ty = v
        .get("projectType")
        .and_then(Value::as_str)
        .unwrap_or("game");
    let id = v
        .get("appSystemId")
        .cloned()
        .unwrap_or(Value::String(String::new()));
    let key = if ty == "widget" {
        "widget_system_id"
    } else {
        "game_system_id"
    };
    let id_text = id
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| id.to_string());
    let path = format!(
        "/community/{}-version/list?{}={}",
        if ty == "widget" { "widget" } else { "game" },
        key,
        query_encode(&id_text)
    );
    let (status, raw) = community_request(reqwest::Method::GET, &path, Some(&token), None).await?;
    let data = match envelope_data(status, raw) {
        Ok(v) => v,
        Err(e) => return Ok(e),
    };
    let list = data
        .get("list")
        .and_then(Value::as_array)
        .cloned()
        .or_else(|| data.as_array().cloned())
        .unwrap_or_default();
    Ok(json!({"ok":true,"versions":list,"total":list.len()}))
}
#[tauri::command]
pub async fn community_create_app(app: AppHandle, payload: Option<Value>) -> Result<Value, String> {
    let Some(token) = community_token(&app) else {
        return Ok(community_error(
            "session_expired",
            "Please sign in first.",
            None,
        ));
    };
    let v = payload.unwrap_or(Value::Null);
    let ty = v
        .get("projectType")
        .and_then(Value::as_str)
        .unwrap_or("game");
    let widget = ty == "widget";
    let body = if widget {
        json!({"main_cover":v["mainCover"],"widget_name":v["appName"],"widget_cate_id":value_i64(v.get("categoryId")),"widget_id":v["appId"],"control":v["control"],"widget_size":v.get("widgetSize").cloned().unwrap_or(Value::String(String::new()))})
    } else {
        json!({"main_cover":v["mainCover"],"game_name":v["appName"],"game_cate_id":value_i64(v.get("categoryId")),"game_id":v["appId"],"min_personal":v.get("minPersonal"),"max_personal":v.get("maxPersonal"),"control":v["control"]})
    };
    let (status, raw) = community_request(
        reqwest::Method::POST,
        if widget {
            "/community/widget/add"
        } else {
            "/community/game/add"
        },
        Some(&token),
        Some(body),
    )
    .await?;
    let data = match envelope_data(status, raw) {
        Ok(v) => v,
        Err(e) => return Ok(e),
    };
    let row = data
        .get(if widget { "widget" } else { "game" })
        .or_else(|| data.get("info"))
        .unwrap_or(&data);
    Ok(
        json!({"ok":true,"app":normalize_apps(std::slice::from_ref(row),ty).into_iter().next().unwrap_or_else(||json!({"id":v["appId"],"appId":v["appId"],"appName":v["appName"],"projectType":ty,"mainCover":v["mainCover"],"description":"","status":"","createdAt":null}))}),
    )
}
#[tauri::command]
pub async fn community_upload_native_image(
    app: AppHandle,
    payload: Option<Value>,
) -> Result<Value, String> {
    let Some(token) = community_token(&app) else {
        return Ok(community_error(
            "session_expired",
            "Please sign in first.",
            None,
        ));
    };
    let path = payload
        .as_ref()
        .and_then(|v| v.get("filePath").and_then(Value::as_str))
        .unwrap_or("");
    if path.is_empty() {
        return Ok(community_error(
            "invalid_request",
            "filePath is required",
            None,
        ));
    }
    let bytes = tokio::fs::read(path).await.map_err(|e| e.to_string())?;
    let part = multipart::Part::bytes(bytes).file_name(
        Path::new(path)
            .file_name()
            .and_then(|v| v.to_str())
            .unwrap_or("image.png")
            .to_owned(),
    );
    let form = multipart::Form::new().part("file", part);
    let upload_url = format!(
        "{}/community/upload/upload-native-image",
        community_base_url()
    );
    let response = crate::proxy::client_for_url(&upload_url)?
        .post(format!(
            "{}/community/upload/upload-native-image",
            community_base_url()
        ))
        .header("token", token)
        .multipart(form)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = response.status().as_u16();
    let raw = response.json::<Value>().await.unwrap_or(Value::Null);
    let data = match envelope_data(status, raw) {
        Ok(v) => v,
        Err(e) => return Ok(e),
    };
    let url = data
        .get("url")
        .or_else(|| data.get("path"))
        .or_else(|| data.get("file_url"))
        .and_then(Value::as_str)
        .unwrap_or("");
    if url.is_empty() {
        return Ok(community_error(
            "api_error",
            "Upload response did not include a URL.",
            None,
        ));
    }
    Ok(json!({"ok":true,"url":url}))
}
#[tauri::command]
pub async fn community_submit_app_version(
    app: AppHandle,
    state: tauri::State<'_, crate::commands::AppState>,
    payload: Option<Value>,
) -> Result<Value, String> {
    let Some(token) = community_token(&app) else {
        return Ok(community_error(
            "session_expired",
            "Please sign in first.",
            None,
        ));
    };
    let v = payload.unwrap_or(Value::Null);
    let ty = v
        .get("projectType")
        .and_then(Value::as_str)
        .unwrap_or("game");
    let root = state.workspace_root.lock().ok().and_then(|x| x.clone());
    let Some(root) = root else {
        return Ok(community_error(
            "no_workspace",
            "workspace not selected",
            None,
        ));
    };
    let conf = std::fs::read_to_string(root.join("conf.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .unwrap_or(Value::Null);
    let app_id = conf
        .get("appId")
        .or_else(|| conf.get("app_id"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let archive =
        crate::deploy::archive::create_workspace_archive(&root).map_err(|e| e.to_string())?;
    let part = multipart::Part::bytes(archive).file_name("dartsnut.zip");
    let field = if ty == "widget" {
        json!({"widget_id":app_id,"system_id":v["appSystemId"].to_string()})
    } else {
        json!({"game_id":app_id,"system_id":v["appSystemId"].to_string()})
    };
    let mut form = multipart::Form::new().part("file", part);
    if let Some(obj) = field.as_object() {
        for (k, val) in obj {
            let text = val
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| val.to_string());
            form = form.text(k.to_owned(), text);
        }
    }
    let endpoint = if ty == "widget" {
        "/community/upload/upload-widget-zip"
    } else {
        "/community/upload/upload-game-zip"
    };
    let upload_url = format!("{}{}", community_base_url(), endpoint);
    let upload = crate::proxy::client_for_url(&upload_url)?
        .post(upload_url)
        .header("token", &token)
        .multipart(form)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let us = upload.status().as_u16();
    let ur = upload.json::<Value>().await.unwrap_or(Value::Null);
    let ud = match envelope_data(us, ur) {
        Ok(v) => v,
        Err(e) => return Ok(e),
    };
    let url = ud
        .get("url")
        .or_else(|| ud.get("path"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let md5 = ud
        .get("md5")
        .or_else(|| ud.get("file_md5"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let body = if ty == "widget" {
        json!({"widget_system_id":v["appSystemId"],"widget_id":app_id,"app_id":app_id,"version":v["version"],"widget_download_url":url,"widget_download_md5":md5,"description":v["description"],"fields":v.get("fields").cloned().unwrap_or(Value::String(String::new())),"preview":v["preview"],"submit_mode":"review"})
    } else {
        json!({"game_system_id":v["appSystemId"],"game_id":app_id,"app_id":app_id,"version":v["version"],"game_download_url":url,"game_download_md5":md5,"description":v["description"],"fields":v.get("fields").cloned().unwrap_or(Value::String(String::new())),"preview":v["preview"],"submit_mode":"review"})
    };
    let (ss, sr) = community_request(
        reqwest::Method::POST,
        if ty == "widget" {
            "/community/widget-version/add"
        } else {
            "/community/game-version/add"
        },
        Some(&token),
        Some(body),
    )
    .await?;
    let sd = match envelope_data(ss, sr) {
        Ok(v) => v,
        Err(e) => return Ok(e),
    };
    Ok(
        json!({"ok":true,"versionId":sd.get("id").or_else(||sd.get("version_id")).cloned().unwrap_or(Value::Null),"status":sd.get("status").cloned().unwrap_or(Value::String("1".into())),"downloadUrl":url,"downloadMd5":md5}),
    )
}
#[tauri::command]
pub fn community_update_workspace_version(
    state: tauri::State<'_, crate::commands::AppState>,
    payload: Option<Value>,
) -> Value {
    let Some(root) = state.workspace_root.lock().ok().and_then(|x| x.clone()) else {
        return json!({"ok":false,"code":"no_workspace","message":"workspace not selected"});
    };
    let version = payload
        .as_ref()
        .and_then(|v| v.get("version").and_then(Value::as_str))
        .unwrap_or("");
    if version.trim().is_empty() {
        return json!({"ok":false,"code":"invalid_version","message":"version is required"});
    }
    let path = root.join("conf.json");
    let Ok(body) = std::fs::read_to_string(&path) else {
        return json!({"ok":false,"code":"invalid_workspace","message":"conf.json not found"});
    };
    let Ok(mut conf) = serde_json::from_str::<Value>(&body) else {
        return json!({"ok":false,"code":"invalid_workspace","message":"conf.json invalid"});
    };
    conf["version"] = Value::String(version.to_owned());
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, serde_json::to_vec_pretty(&conf).unwrap_or_default())
        .and_then(|_| std::fs::rename(&tmp, &path))
        .is_err()
    {
        return json!({"ok":false,"code":"write_failed","message":"could not update conf.json"});
    }
    json!({"ok":true,"workspace":{"eligible":true,"appId":conf.get("appId").or_else(||conf.get("app_id")).cloned().unwrap_or(Value::String(String::new())),"projectType":if conf.get("widgetFields").is_some(){"widget"}else{"game"},"appName":conf.get("name").cloned().unwrap_or(Value::String(String::new())),"version":version,"description":conf.get("description").cloned().unwrap_or(Value::String(String::new())),"widgetSize":conf.get("widgetSize").cloned().unwrap_or(Value::String(String::new()))}})
}
#[tauri::command]
pub async fn community_withdraw_app_version(
    app: AppHandle,
    payload: Option<Value>,
) -> Result<Value, String> {
    let Some(token) = community_token(&app) else {
        return Ok(community_error(
            "session_expired",
            "Please sign in first.",
            None,
        ));
    };
    let v = payload.unwrap_or(Value::Null);
    let ty = v
        .get("projectType")
        .and_then(Value::as_str)
        .unwrap_or("game");
    let body = json!({"id":v.get("versionId").cloned().unwrap_or(Value::Null)});
    let (s, r) = community_request(
        reqwest::Method::POST,
        if ty == "widget" {
            "/community/widget-version/withdraw"
        } else {
            "/community/game-version/withdraw"
        },
        Some(&token),
        Some(body),
    )
    .await?;
    let d = match envelope_data(s, r) {
        Ok(v) => v,
        Err(e) => return Ok(e),
    };
    Ok(json!({"ok":true,"status":d.get("status").cloned().unwrap_or(Value::String("-2".into()))}))
}

#[tauri::command]
pub fn assets_get_manifest(
    state: tauri::State<'_, crate::commands::AppState>,
    payload: Option<Value>,
) -> Value {
    let workspace = payload.as_ref().and_then(|v| v.as_str()).or_else(|| {
        payload
            .as_ref()
            .and_then(|v| v.get("workspacePath").and_then(Value::as_str))
    });
    let Some(workspace) = workspace else {
        return json!({"workspacePath":null,"manifest":null,"pendingChangeSlotIds":[]});
    };
    if !workspace_path_allowed(&state, workspace) {
        return json!({"workspacePath":workspace,"manifest":null,"pendingChangeSlotIds":[],"error":"workspace path is not active"});
    }
    let path = std::path::Path::new(workspace).join("dartsnut.assets.json");
    let manifest = std::fs::read_to_string(path)
        .ok()
        .and_then(|body| serde_json::from_str::<Value>(&body).ok());
    let pending = read_pending_assets(Path::new(workspace));
    json!({"workspacePath":workspace,"manifest":manifest,"pendingChangeSlotIds":pending})
}
#[tauri::command]
pub async fn assets_bind_slot(app: AppHandle, payload: Option<Value>) -> Value {
    let Some(value) = payload else {
        return json!({"ok":false,"error":{"code":"io_error","message":"request required"}});
    };
    let workspace = value
        .get("workspacePath")
        .and_then(Value::as_str)
        .unwrap_or("");
    let slot_id = value.get("slotId").and_then(Value::as_str).unwrap_or("");
    let source = value
        .get("sourcePath")
        .and_then(Value::as_str)
        .unwrap_or("");
    if workspace.is_empty() || slot_id.is_empty() || source.is_empty() {
        return json!({"ok":false,"error":{"slotId":slot_id,"code":"io_error","message":"workspacePath, slotId, and sourcePath are required"}});
    }
    if !workspace_path_allowed(&app.state::<crate::commands::AppState>(), workspace) {
        return json!({"ok":false,"error":{"slotId":slot_id,"code":"workspace_not_selected","message":"workspace path is not active"}});
    }
    let manifest_path = std::path::Path::new(workspace).join("dartsnut.assets.json");
    let Ok(body) = std::fs::read_to_string(&manifest_path) else {
        return json!({"ok":false,"error":{"slotId":slot_id,"code":"manifest_missing","message":"dartsnut.assets.json not found"}});
    };
    let Ok(mut manifest) = serde_json::from_str::<Value>(&body) else {
        return json!({"ok":false,"error":{"slotId":slot_id,"code":"io_error","message":"invalid asset manifest"}});
    };
    let Some(slot_index) = manifest
        .get("slots")
        .and_then(Value::as_array)
        .and_then(|slots| {
            slots
                .iter()
                .position(|slot| slot.get("id").and_then(Value::as_str) == Some(slot_id))
        })
    else {
        return json!({"ok":false,"error":{"slotId":slot_id,"code":"slot_not_found","message":"slot id not found"}});
    };
    let source_path = std::path::Path::new(source);
    if !source_path.is_file() {
        return json!({"ok":false,"error":{"slotId":slot_id,"code":"io_error","message":"source file not found"}});
    }
    let slot = manifest
        .get("slots")
        .and_then(Value::as_array)
        .and_then(|slots| slots.get(slot_index))
        .cloned()
        .unwrap_or(Value::Null);
    let kind = slot.get("kind").and_then(Value::as_str).unwrap_or("static");
    let size = slot
        .get("size")
        .and_then(Value::as_array)
        .and_then(|values| Some((values.first()?.as_u64()?, values.get(1)?.as_u64()?)))
        .unwrap_or((1, 1));
    let frames = slot.get("frames").and_then(Value::as_u64).unwrap_or(1);
    if !slot_id
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
    {
        return json!({"ok":false,"error":{"slotId":slot_id,"code":"io_error","message":"invalid slot id"}});
    }
    if let Some(script_root) = app
        .path()
        .resource_dir()
        .ok()
        .or_else(|| std::env::current_dir().ok())
    {
        let script = script_root.join("scripts/asset_preprocess.py");
        if script.is_file() {
            let python = crate::runtime::discover_python(Some(&script_root));
            if let Some(python) = python {
                let output = tokio::process::Command::new(python)
                    .arg(&script)
                    .arg("--slot")
                    .arg(slot_id)
                    .arg("--kind")
                    .arg(kind)
                    .arg("--size")
                    .arg(format!("{}x{}", size.0, size.1))
                    .arg("--frames")
                    .arg(frames.to_string())
                    .arg("--source")
                    .arg(source)
                    .arg("--workspace")
                    .arg(workspace)
                    .env_clear()
                    .envs(crate::runtime::sanitized_environment())
                    .output()
                    .await;
                if let Ok(output) = output {
                    if let Ok(result) = serde_json::from_slice::<Value>(&output.stdout) {
                        if result.get("ok").and_then(Value::as_bool) == Some(true) {
                            if let Some(binding) = result.get("binding").cloned() {
                                if let Some(slot) = manifest
                                    .get_mut("slots")
                                    .and_then(Value::as_array_mut)
                                    .and_then(|slots| slots.get_mut(slot_index))
                                {
                                    slot["binding"] = binding;
                                }
                                let tmp = manifest_path.with_extension("json.tmp");
                                if std::fs::write(
                                    &tmp,
                                    serde_json::to_vec_pretty(&manifest).unwrap_or_default(),
                                )
                                .and_then(|_| std::fs::rename(&tmp, &manifest_path))
                                .is_ok()
                                {
                                    mark_asset_pending(Path::new(workspace), slot_id);
                                    return result;
                                }
                            }
                        } else if result.is_object() {
                            return result;
                        }
                    }
                }
            }
        }
    }
    let ext = source_path
        .extension()
        .and_then(|x| x.to_str())
        .unwrap_or("bin");
    let source_rel = format!("assets/_sources/{slot_id}.{ext}");
    let destination = std::path::Path::new(workspace).join(&source_rel);
    if let Some(parent) = destination.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Err(error) = std::fs::copy(source_path, &destination) {
        return json!({"ok":false,"error":{"slotId":slot_id,"code":"io_error","message":error.to_string()}});
    }
    let result_kind = slot.get("kind").cloned().unwrap_or(Value::Null);
    let result_binding =
        json!({"source":source_rel,"frames":[],"meta":format!("assets/{slot_id}/meta.json")});
    if let Some(slot) = manifest
        .get_mut("slots")
        .and_then(Value::as_array_mut)
        .and_then(|slots| slots.get_mut(slot_index))
    {
        slot["binding"] = result_binding.clone();
    }
    let tmp = manifest_path.with_extension("json.tmp");
    if std::fs::write(
        &tmp,
        serde_json::to_vec_pretty(&manifest).unwrap_or_default(),
    )
    .and_then(|_| std::fs::rename(&tmp, &manifest_path))
    .is_err()
    {
        return json!({"ok":false,"error":{"slotId":slot_id,"code":"io_error","message":"could not persist asset manifest"}});
    }
    mark_asset_pending(Path::new(workspace), slot_id);
    json!({"ok":true,"slotId":slot_id,"kind":result_kind,"frames":1,"binding":result_binding})
}
#[tauri::command]
pub fn assets_unbind_slot(
    state: tauri::State<'_, crate::commands::AppState>,
    payload: Option<Value>,
) -> Value {
    let Some(value) = payload else {
        return json!({"ok":false,"message":"request required"});
    };
    let workspace = value
        .get("workspacePath")
        .and_then(Value::as_str)
        .unwrap_or("");
    let slot_id = value.get("slotId").and_then(Value::as_str).unwrap_or("");
    if !workspace_path_allowed(&state, workspace) {
        return json!({"ok":false,"message":"workspace path is not active"});
    }
    let path = std::path::Path::new(workspace).join("dartsnut.assets.json");
    let Ok(body) = std::fs::read_to_string(&path) else {
        return json!({"ok":false,"message":"manifest missing"});
    };
    let Ok(mut manifest) = serde_json::from_str::<Value>(&body) else {
        return json!({"ok":false,"message":"invalid manifest"});
    };
    let Some(slot) = manifest
        .get_mut("slots")
        .and_then(Value::as_array_mut)
        .and_then(|slots| {
            slots
                .iter_mut()
                .find(|slot| slot.get("id").and_then(Value::as_str) == Some(slot_id))
        })
    else {
        return json!({"ok":false,"message":"slot not found"});
    };
    slot["binding"] = Value::Null;
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(
        &tmp,
        serde_json::to_vec_pretty(&manifest).unwrap_or_default(),
    )
    .and_then(|_| std::fs::rename(&tmp, &path))
    .is_err()
    {
        return json!({"ok":false,"message":"could not persist asset manifest"});
    }
    mark_asset_pending(Path::new(workspace), slot_id);
    json!({"ok":true,"slotId":slot_id})
}
#[tauri::command]
pub fn assets_apply_assets(
    state: tauri::State<'_, crate::commands::AppState>,
    payload: Option<Value>,
) -> Value {
    let Some(value) = payload else {
        return json!({"ok":false,"reason":"missing_workspace"});
    };
    let workspace = value
        .get("workspacePath")
        .and_then(Value::as_str)
        .unwrap_or("");
    if !workspace_path_allowed(&state, workspace) {
        return json!({"ok":false,"reason":"workspace_not_selected"});
    }
    if workspace.is_empty() || !Path::new(workspace).is_dir() {
        return json!({"ok":false,"reason":"missing_workspace"});
    }
    let slots = value
        .get("slotIds")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .unwrap_or_else(|| read_pending_assets(Path::new(workspace)));
    if slots.is_empty() {
        return json!({"ok":false,"reason":"no_pending_changes"});
    }
    let pending = read_pending_assets(Path::new(workspace));
    let remaining = pending
        .into_iter()
        .filter(|id| !slots.iter().any(|slot| slot == id))
        .collect::<Vec<_>>();
    write_pending_assets(Path::new(workspace), &remaining);
    json!({"ok":true,"appliedSlotIds":slots})
}
#[tauri::command]
pub fn assets_read_preview(
    state: tauri::State<'_, crate::commands::AppState>,
    payload: Option<Value>,
) -> Value {
    let Some(value) = payload else {
        return json!({"ok":false,"message":"request required"});
    };
    let workspace = value
        .get("workspacePath")
        .and_then(Value::as_str)
        .unwrap_or("");
    let frame = value.get("framePath").and_then(Value::as_str).unwrap_or("");
    if !workspace_path_allowed(&state, workspace) {
        return json!({"ok":false,"message":"workspace path is not active"});
    }
    let root = std::path::Path::new(workspace);
    let path = root.join(frame);
    let Ok(root_canonical) = std::fs::canonicalize(root) else {
        return json!({"ok":false,"message":"workspace missing"});
    };
    let Ok(path_canonical) = std::fs::canonicalize(&path) else {
        return json!({"ok":false,"message":"preview missing"});
    };
    if !path_canonical.starts_with(&root_canonical) {
        return json!({"ok":false,"message":"preview path escapes workspace"});
    }
    let Ok(bytes) = std::fs::read(&path_canonical) else {
        return json!({"ok":false,"message":"preview unreadable"});
    };
    let mime = match path
        .extension()
        .and_then(|x| x.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        _ => "application/octet-stream",
    };
    use base64::Engine;
    json!({"ok":true,"dataUrl":format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes))})
}

pub fn emit_placeholder_events(app: &AppHandle) {
    let _ = app.emit("agent:bootstrap-state-changed", json!({"workspaceRoot":null,"activeProjectId":null,"activeChatId":null,"providerStatus":"missing_config","firstRunComplete":false}));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_encoding_is_url_safe() {
        assert_eq!(query_encode("a b/c"), "a%20b%2Fc");
        assert_eq!(query_encode("model-1_2.0~x"), "model-1_2.0~x");
    }

    #[test]
    fn community_envelope_accepts_success_codes_and_maps_errors() {
        assert_eq!(
            envelope_data(200, json!({"code":1001,"data":{"x":1}})).unwrap()["x"],
            1
        );
        let error = envelope_data(403, json!({"code":403,"msg":"expired"})).unwrap_err();
        assert_eq!(error["code"], "session_expired");
    }

    #[test]
    fn app_normalization_handles_game_fields() {
        let rows = normalize_apps(&[json!({"id":3,"game_id":"g1","game_name":"Game"})], "game");
        assert_eq!(rows[0]["appId"], "g1");
        assert_eq!(rows[0]["appName"], "Game");
    }
}
