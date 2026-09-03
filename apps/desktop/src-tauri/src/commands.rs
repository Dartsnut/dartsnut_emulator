use serde::Deserialize;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::projects::ProjectStore;
use crate::BRIDGE_READY_EVENT;

pub struct AppState {
    pub projects: Mutex<Option<ProjectStore>>,
    pub workspace_root: Mutex<Option<PathBuf>>,
    pub active_project_id: Mutex<Option<String>>,
    pub active_chat_id: Mutex<Option<String>>,
    pub agent: crate::agent::AgentState,
    pub agent_question: Mutex<Option<crate::pending_inputs::AgentQuestionPending>>,
    pub machine_mcp_question: Mutex<Option<crate::pending_inputs::MachineMcpQuestionPending>>,
    /// Chat attachment IDs mapped to their workspace-relative copied paths.
    /// Entries are populated for the active prompt and consumed by Rig tools.
    pub chat_attachments: Mutex<HashMap<String, String>>,
    pub oauth_cancel: Mutex<Option<Arc<std::sync::atomic::AtomicBool>>>,
    pub deploy: Mutex<Option<Arc<crate::deploy::ssh::SshConnection>>>,
    pub sideload: Mutex<Option<Arc<crate::deploy::sideload::SideloadClient>>>,
    pub emulator: crate::emulator::EmulatorRuntime,
    pub runtime: crate::runtime::RuntimeManager,
    pub update: Mutex<crate::commands::PendingUpdate>,
    pub(crate) provider_settings: Mutex<ProviderSettingsFile>,
    /// Prevents window-close and app-exit paths from racing cleanup.
    pub quit_cleanup_started: AtomicBool,
}

pub struct PendingUpdate {
    pub state: crate::updates::UpdateState,
    pub update: Option<tauri_plugin_updater::Update>,
    pub bytes: Option<Vec<u8>>,
    pub checking: bool,
    pub downloading: bool,
    pub auto_download: bool,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            projects: Mutex::new(None),
            workspace_root: Mutex::new(None),
            active_project_id: Mutex::new(None),
            active_chat_id: Mutex::new(None),
            agent: crate::agent::AgentState::default(),
            agent_question: Mutex::new(None),
            machine_mcp_question: Mutex::new(None),
            chat_attachments: Mutex::new(HashMap::new()),
            oauth_cancel: Mutex::new(None),
            deploy: Mutex::new(None),
            sideload: Mutex::new(None),
            emulator: crate::emulator::EmulatorRuntime::default(),
            runtime: crate::runtime::RuntimeManager::default(),
            update: Mutex::new(PendingUpdate {
                state: crate::updates::UpdateState::idle(env!("CARGO_PKG_VERSION")),
                update: None,
                bytes: None,
                checking: false,
                downloading: false,
                auto_download: true,
            }),
            provider_settings: Mutex::new(ProviderSettingsFile::default()),
            quit_cleanup_started: AtomicBool::new(false),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthStatus {
    pub status: &'static str,
    pub app_id: &'static str,
    pub scaffold: bool,
}

#[tauri::command]
pub fn health() -> HealthStatus {
    HealthStatus {
        status: "ok",
        app_id: "com.dartsnut.agent",
        scaffold: false,
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapState {
    pub workspace_root: Option<String>,
    pub active_project_id: Option<String>,
    pub active_chat_id: Option<String>,
    pub provider_status: String,
    pub first_run_complete: bool,
}

#[tauri::command]
pub fn get_bootstrap_state(state: State<'_, AppState>) -> BootstrapState {
    bootstrap_state(&state)
}

pub(crate) fn bootstrap_state(state: &AppState) -> BootstrapState {
    let active_project_id = state
        .active_project_id
        .lock()
        .ok()
        .and_then(|value| value.clone());
    let active_chat_id = state
        .active_chat_id
        .lock()
        .ok()
        .and_then(|value| value.clone());
    let provider = state
        .provider_settings
        .lock()
        .ok()
        .map(|v| v.clone())
        .unwrap_or_default();
    let provider_status = if provider.active_provider == "dartsnut-llm" {
        "ready"
    } else if provider.custom.base_url.trim().is_empty()
        || provider.custom.model.trim().is_empty()
        || provider.custom.api_key.trim().is_empty()
    {
        "missing_config"
    } else {
        "ready"
    };
    BootstrapState {
        workspace_root: state
            .workspace_root
            .lock()
            .ok()
            .and_then(|value| value.clone())
            .map(|p| p.to_string_lossy().into_owned()),
        active_project_id,
        active_chat_id,
        provider_status: provider_status.to_owned(),
        first_run_complete: false,
    }
}

#[tauri::command]
pub fn renderer_ready(app: AppHandle) -> Result<(), String> {
    app.emit("agent:renderer-ready", ())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn emit_bridge_event(app: AppHandle, event: String, payload: Value) -> Result<(), String> {
    if !event.starts_with("dartsnut:") {
        return Err("bridge event must use dartsnut: namespace".to_owned());
    }
    app.emit(&event, payload).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn bridge_ready(app: AppHandle) -> Result<HealthStatus, String> {
    let status = health();
    app.emit(BRIDGE_READY_EVENT, &status)
        .map_err(|error| error.to_string())?;
    Ok(status)
}

#[tauri::command]
pub fn list_projects(app: AppHandle, state: State<'_, AppState>) -> Value {
    let app_data = match app.path().app_data_dir() {
        Ok(path) => path,
        Err(error) => return json!({ "projects": [], "chats": [], "error": error.to_string() }),
    };
    let mut store = state.projects.lock().expect("project store mutex poisoned");
    if store.is_none() {
        *store = ProjectStore::open(app_data).ok();
    }
    match store.as_ref() {
        Some(store) => {
            let (projects, chats) = store.list();
            json!({ "projects": projects, "chats": chats })
        }
        None => json!({ "projects": [], "chats": [] }),
    }
}

fn store_for<'a>(
    app: &AppHandle,
    state: &'a State<'_, AppState>,
) -> Option<std::sync::MutexGuard<'a, Option<ProjectStore>>> {
    let app_data = app.path().app_data_dir().ok()?;
    let mut store = state.projects.lock().ok()?;
    if store.is_none() {
        *store = ProjectStore::open(app_data).ok();
    }
    Some(store)
}

pub(crate) fn store_for_title<'a>(
    app: &AppHandle,
    state: &'a State<'_, AppState>,
) -> Option<std::sync::MutexGuard<'a, Option<ProjectStore>>> {
    store_for(app, state)
}

fn tree_value(store: &ProjectStore) -> Value {
    let (projects, chats) = store.list();
    json!({ "projects": projects, "chats": chats })
}

#[tauri::command]
pub fn create_project(app: AppHandle, state: State<'_, AppState>, payload: Value) -> Value {
    let folder = payload
        .get("folderPath")
        .and_then(Value::as_str)
        .unwrap_or("");
    if folder.is_empty() {
        return json!({ "ok": false, "error": "folderPath is required" });
    }
    let name = payload.get("name").and_then(Value::as_str);
    let Some(mut store) = store_for(&app, &state) else {
        return json!({ "ok": false, "error": "project store unavailable" });
    };
    let Some(store) = store.as_mut() else {
        return json!({ "ok": false, "error": "project store unavailable" });
    };
    match store.ensure_project(folder, name) {
        Ok(project) => {
            *state.active_project_id.lock().unwrap() = Some(project.id.clone());
            *state.workspace_root.lock().unwrap() = Some(PathBuf::from(&project.folder_path));
            let chat = store.create_chat(&project.id, None).ok();
            *state.active_chat_id.lock().unwrap() = chat.as_ref().map(|value| value.id.clone());
            json!({ "state": bootstrap_state(&state), "tree": tree_value(store) })
        }
        Err(error) => json!({ "ok": false, "error": error.to_string() }),
    }
}

#[tauri::command]
pub fn remove_project(app: AppHandle, state: State<'_, AppState>, payload: Value) -> Value {
    let project_id = payload
        .as_str()
        .or_else(|| payload.get("projectId").and_then(Value::as_str))
        .unwrap_or("");
    let Some(mut store) = store_for(&app, &state) else {
        return json!({ "ok": false, "error": "project store unavailable" });
    };
    let Some(store) = store.as_mut() else {
        return json!({ "ok": false, "error": "project store unavailable" });
    };
    match store.remove_project(project_id) {
        Ok(_) => {
            *state.active_project_id.lock().unwrap() = None;
            *state.active_chat_id.lock().unwrap() = None;
            *state.workspace_root.lock().unwrap() = None;
            json!({ "state": bootstrap_state(&state), "tree": tree_value(store) })
        }
        Err(error) => json!({ "ok": false, "error": error.to_string() }),
    }
}

#[tauri::command]
pub fn create_chat(app: AppHandle, state: State<'_, AppState>, payload: Value) -> Value {
    let project_id = payload
        .get("projectId")
        .and_then(Value::as_str)
        .unwrap_or("");
    let Some(mut store) = store_for(&app, &state) else {
        return json!({ "ok": false, "error": "project store unavailable" });
    };
    let Some(store) = store.as_mut() else {
        return json!({ "ok": false, "error": "project store unavailable" });
    };
    match store.create_chat(project_id, None) {
        Ok(chat) => {
            *state.active_project_id.lock().unwrap() = Some(project_id.to_owned());
            *state.active_chat_id.lock().unwrap() = Some(chat.id.clone());
            json!({ "state": bootstrap_state(&state), "tree": tree_value(store) })
        }
        Err(error) => json!({ "ok": false, "error": error.to_string() }),
    }
}

#[tauri::command]
pub fn archive_chat(app: AppHandle, state: State<'_, AppState>, payload: Value) -> Value {
    let chat_id = payload
        .as_str()
        .or_else(|| payload.get("chatId").and_then(Value::as_str))
        .unwrap_or("");
    let Some(mut store) = store_for(&app, &state) else {
        return json!({ "ok": false, "error": "project store unavailable" });
    };
    let Some(store) = store.as_mut() else {
        return json!({ "ok": false, "error": "project store unavailable" });
    };
    match store.archive_chat(chat_id) {
        Ok(_) => json!({ "tree": tree_value(store) }),
        Err(error) => json!({ "ok": false, "error": error.to_string() }),
    }
}

#[tauri::command]
pub fn select_project(app: AppHandle, state: State<'_, AppState>, payload: Value) -> Value {
    let project_id = payload
        .get("projectId")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let requested_chat = payload.get("chatId").and_then(Value::as_str);
    let Some(mut store_guard) = store_for(&app, &state) else {
        return json!({"state": bootstrap_state(&state), "tree": {"projects": [], "chats": []}, "accepted": false});
    };
    let Some(store) = store_guard.as_mut() else {
        return json!({"state": bootstrap_state(&state), "tree": {"projects": [], "chats": []}, "accepted": false});
    };
    let Some(project_id) = project_id else {
        *state.active_project_id.lock().unwrap() = None;
        *state.active_chat_id.lock().unwrap() = None;
        *state.workspace_root.lock().unwrap() = None;
        return json!({"state": bootstrap_state(&state), "tree": tree_value(store), "accepted": true});
    };
    let Some(project) = store.project(&project_id) else {
        return json!({"state": bootstrap_state(&state), "tree": tree_value(store), "accepted": false});
    };
    let chat_id = requested_chat
        .and_then(|id| store.chat(id))
        .filter(|chat| chat.project_id == project_id && chat.archived_at.is_none())
        .map(|chat| chat.id);
    *state.active_project_id.lock().unwrap() = Some(project_id.clone());
    *state.active_chat_id.lock().unwrap() = chat_id.clone();
    *state.workspace_root.lock().unwrap() = Some(PathBuf::from(&project.folder_path));
    json!({ "state": bootstrap_state(&state), "tree": tree_value(store), "accepted": true })
}

#[tauri::command]
pub fn select_chat(app: AppHandle, state: State<'_, AppState>, payload: Value) -> Value {
    let chat_id = payload
        .as_str()
        .or_else(|| payload.get("chatId").and_then(Value::as_str))
        .map(str::to_owned);
    let Some(mut store_guard) = store_for(&app, &state) else {
        return json!({"state": bootstrap_state(&state), "tree": {"projects": [], "chats": []}, "accepted": false});
    };
    let Some(store) = store_guard.as_mut() else {
        return json!({"state": bootstrap_state(&state), "tree": {"projects": [], "chats": []}, "accepted": false});
    };
    let Some(chat_id) = chat_id else {
        return json!({"state": bootstrap_state(&state), "tree": tree_value(store), "accepted": false});
    };
    let Some(chat) = store
        .chat(&chat_id)
        .filter(|chat| chat.archived_at.is_none())
    else {
        return json!({"state": bootstrap_state(&state), "tree": tree_value(store), "accepted": false});
    };
    let Some(project) = store.project(&chat.project_id) else {
        return json!({"state": bootstrap_state(&state), "tree": tree_value(store), "accepted": false});
    };
    *state.active_project_id.lock().unwrap() = Some(project.id.clone());
    *state.active_chat_id.lock().unwrap() = Some(chat_id);
    *state.workspace_root.lock().unwrap() = Some(PathBuf::from(&project.folder_path));
    json!({ "state": bootstrap_state(&state), "tree": tree_value(store), "accepted": true })
}

#[tauri::command]
pub fn get_provider_settings(app: AppHandle, state: State<'_, AppState>) -> Value {
    let settings = read_provider_settings(&app);
    if let Ok(mut current) = state.provider_settings.lock() {
        *current = settings.clone();
    }
    serde_json::to_value(settings).unwrap_or_else(
        |_| json!({"activeProvider":"dartsnut-llm","custom":{"baseUrl":"","apiKey":"","model":""}}),
    )
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderSettingsFile {
    pub(crate) active_provider: String,
    pub(crate) custom: CustomProviderSettings,
}

impl Default for ProviderSettingsFile {
    fn default() -> Self {
        Self {
            active_provider: "dartsnut-llm".to_owned(),
            custom: CustomProviderSettings::default(),
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CustomProviderSettings {
    pub(crate) base_url: String,
    pub(crate) api_key: String,
    pub(crate) model: String,
}

pub(crate) fn read_provider_settings(app: &AppHandle) -> ProviderSettingsFile {
    let fallback = ProviderSettingsFile {
        active_provider: "custom".to_owned(),
        custom: CustomProviderSettings {
            base_url: "https://api.openai.com/v1".to_owned(),
            api_key: String::new(),
            model: "gpt-4.1-mini".to_owned(),
        },
    };
    provider_file(app)
        .ok()
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|body| serde_json::from_str::<ProviderSettingsFile>(&body).ok())
        .unwrap_or(fallback)
}

fn provider_file(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("provider-settings.json"))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn save_provider_settings(app: AppHandle, state: State<'_, AppState>, payload: Value) -> Value {
    let Ok(settings) = serde_json::from_value::<ProviderSettingsFile>(payload.clone()) else {
        return json!({ "ok": false, "error": "invalid provider settings" });
    };
    if settings.active_provider != "dartsnut-llm"
        && (settings.custom.base_url.trim().is_empty() || settings.custom.model.trim().is_empty())
    {
        return json!({ "ok": false, "error": "baseUrl and model are required" });
    }
    let Ok(path) = provider_file(&app) else {
        return json!({ "ok": false, "error": "app data path unavailable" });
    };
    let body = match serde_json::to_vec_pretty(&settings) {
        Ok(body) => body,
        Err(error) => return json!({ "ok": false, "error": error.to_string() }),
    };
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let tmp = path.with_extension("json.tmp");
    if fs::write(&tmp, body)
        .and_then(|_| fs::rename(&tmp, &path))
        .is_err()
    {
        return json!({ "ok": false, "error": "could not persist provider settings" });
    }
    if let Ok(mut current) = state.provider_settings.lock() {
        *current = settings.clone();
    }
    serde_json::to_value(settings)
        .unwrap_or_else(|_| json!({ "ok": false, "error": "could not encode provider settings" }))
}

#[tauri::command]
pub fn get_python_runtime_status(state: State<'_, AppState>) -> Option<String> {
    state.runtime.status()
}

#[tauri::command]
pub fn get_python_runtime_progress(state: State<'_, AppState>) -> crate::runtime::RuntimeProgress {
    state.runtime.progress()
}

#[tauri::command]
pub fn retry_python_runtime_setup(app: AppHandle, state: State<'_, AppState>) -> bool {
    state.runtime.start(app)
}

#[tauri::command]
pub fn deploy_get_eligibility(state: State<'_, AppState>) -> Value {
    let Some(root) = state
        .workspace_root
        .lock()
        .ok()
        .and_then(|value| value.clone())
    else {
        return json!({ "ok": false, "reason": "workspace_not_selected" });
    };
    let pyproject = fs::read_to_string(root.join("pyproject.toml")).ok();
    let conf = fs::read_to_string(root.join("conf.json")).ok();
    classify_dartsnut_project_files(pyproject.as_deref(), conf.as_deref())
}

fn classify_dartsnut_project_files(
    pyproject_text: Option<&str>,
    conf_json_text: Option<&str>,
) -> Value {
    let Some(pyproject_text) = pyproject_text else {
        return json!({"ok":false,"reason":"missing_pyproject"});
    };
    let Ok(pyproject) = toml::from_str::<toml::Value>(pyproject_text) else {
        return json!({"ok":false,"reason":"invalid_pyproject"});
    };
    let Some(project) = pyproject.get("project").and_then(toml::Value::as_table) else {
        return json!({"ok":false,"reason":"invalid_pyproject"});
    };
    let app_id = project
        .get("name")
        .and_then(toml::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let Some(app_id) = app_id else {
        return json!({"ok":false,"reason":"missing_project_name"});
    };
    let version = project
        .get("version")
        .and_then(toml::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let Some(version) = version else {
        return json!({"ok":false,"reason":"missing_project_version"});
    };
    let Some(dependencies) = project
        .get("dependencies")
        .and_then(toml::Value::as_array)
        .filter(|items| items.iter().all(|item| item.as_str().is_some()))
    else {
        return json!({"ok":false,"reason":"invalid_pyproject"});
    };
    let package_name = regex::Regex::new(r"^\s*([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)")
        .expect("package requirement regex must compile");
    let has_pydartsnut = dependencies.iter().any(|dependency| {
        let Some(requirement) = dependency.as_str() else {
            return false;
        };
        package_name
            .captures(requirement)
            .and_then(|captures| captures.get(1))
            .map(|name| {
                name.as_str()
                    .chars()
                    .filter(|character| !matches!(character, '.' | '_' | '-'))
                    .collect::<String>()
                    .eq_ignore_ascii_case("pydartsnut")
            })
            .unwrap_or(false)
    });
    if !has_pydartsnut {
        return json!({"ok":false,"reason":"missing_pydartsnut"});
    }

    let Some(conf_json_text) = conf_json_text else {
        return json!({"ok":true,"appId":app_id,"version":version,"projectType":"game"});
    };
    let Ok(conf) = serde_json::from_str::<Value>(conf_json_text) else {
        return json!({"ok":false,"reason":"broken_widget"});
    };
    let Some(conf) = conf.as_object() else {
        return json!({"ok":false,"reason":"broken_widget"});
    };
    if conf.get("type").and_then(Value::as_str) == Some("game") {
        return json!({"ok":true,"appId":app_id,"version":version,"projectType":"game"});
    }
    if !conf.contains_key("size") || !conf.contains_key("fields") {
        return json!({"ok":false,"reason":"broken_widget"});
    }
    json!({"ok":true,"appId":app_id,"version":version,"projectType":"widget"})
}

#[tauri::command]
pub fn get_widget_config(state: State<'_, AppState>, payload: Option<Value>) -> Value {
    let scope = payload
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_else(|| "workspace".to_owned());
    let Some(root) = state
        .workspace_root
        .lock()
        .ok()
        .and_then(|value| value.clone())
    else {
        return json!({ "scope": scope, "status": "unavailable", "configKey": null, "confPath": null, "message": "Widget configuration is unavailable until a workspace is selected." });
    };
    let conf_path = root.join("conf.json");
    let Ok(body) = fs::read_to_string(&conf_path) else {
        return json!({"scope":scope,"status":"missing","configKey":null,"confPath":conf_path,"message":"conf.json not found"});
    };
    let Ok(conf) = serde_json::from_str::<Value>(&body) else {
        return json!({"scope":scope,"status":"invalid","configKey":null,"confPath":conf_path,"message":"conf.json is invalid"});
    };
    let fields = conf
        .get("widgetFields")
        .or_else(|| conf.get("fields"))
        .cloned();
    let Some(fields) = fields else {
        return json!({"scope":scope,"status":"not_widget","configKey":null,"confPath":conf_path,"message":"workspace does not declare widget fields"});
    };
    json!({"scope":scope,"status":"ready","configKey":conf.get("configKey").or_else(|| conf.get("appId")).and_then(Value::as_str).unwrap_or("widget"),"confPath":conf_path,"fields":fields,"errors":[]})
}

#[tauri::command]
pub fn community_get_session(app: AppHandle) -> Value {
    let google_client_id = std::env::var("DARTSNUT_GOOGLE_CLIENT_ID").unwrap_or_default();
    let google_desktop_client_id =
        std::env::var("DARTSNUT_GOOGLE_DESKTOP_CLIENT_ID").unwrap_or_default();
    let google_sign_in_available =
        !google_client_id.trim().is_empty() || !google_desktop_client_id.trim().is_empty();
    let fallback = json!({ "loggedIn": false, "account": null, "analyticsUserId": null, "authMethod": null, "hasSupabase": false, "googleClientId": google_client_id, "googleDesktopClientId": google_desktop_client_id, "googleSignInAvailable": google_sign_in_available });
    app.path()
        .app_data_dir()
        .ok()
        .map(|p| p.join("community-session.json"))
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|body| serde_json::from_str::<Value>(&body).ok())
        .map(|mut value| {
            if let Some(obj) = value.as_object_mut() {
                obj.remove("token");
                obj.entry("googleClientId").or_insert_with(|| {
                    Value::String(std::env::var("DARTSNUT_GOOGLE_CLIENT_ID").unwrap_or_default())
                });
                obj.entry("googleDesktopClientId").or_insert_with(|| {
                    Value::String(
                        std::env::var("DARTSNUT_GOOGLE_DESKTOP_CLIENT_ID").unwrap_or_default(),
                    )
                });
                obj.insert(
                    "googleSignInAvailable".into(),
                    Value::Bool(google_sign_in_available),
                );
            }
            value
        })
        .unwrap_or(fallback)
}

#[tauri::command]
pub fn get_app_update_status(state: State<'_, AppState>) -> Value {
    serde_json::to_value(
        state
            .update
            .lock()
            .map(|value| value.state.clone())
            .unwrap_or_else(|_| crate::updates::UpdateState::idle(env!("CARGO_PKG_VERSION"))),
    )
    .unwrap_or_else(|_| json!({ "kind": "idle", "currentVersion": env!("CARGO_PKG_VERSION") }))
}

#[tauri::command]
pub fn get_app_update_auto_download(app: AppHandle) -> bool {
    let path = app
        .path()
        .app_data_dir()
        .ok()
        .map(|p| p.join("app-update-preferences.json"));
    path.and_then(|p| fs::read_to_string(p).ok())
        .and_then(|body| serde_json::from_str::<Value>(&body).ok())
        .and_then(|v| v.get("autoDownload").and_then(Value::as_bool))
        .unwrap_or(true)
}

#[tauri::command]
pub fn set_app_update_auto_download(
    app: AppHandle,
    state: State<'_, AppState>,
    payload: Option<Value>,
) -> bool {
    let enabled = payload
        .as_ref()
        .and_then(|v| v.as_bool())
        .or_else(|| {
            payload
                .as_ref()
                .and_then(|v| v.get("enabled").and_then(Value::as_bool))
        })
        .unwrap_or(true);
    if let Ok(dir) = app.path().app_data_dir() {
        let _ = fs::create_dir_all(&dir);
        let path = dir.join("app-update-preferences.json");
        let tmp = path.with_extension("json.tmp");
        if let Ok(body) = serde_json::to_vec_pretty(&json!({"autoDownload": enabled})) {
            let _ = fs::write(&tmp, body).and_then(|_| fs::rename(&tmp, &path));
        }
    }
    if let Ok(mut pending) = state.update.lock() {
        pending.auto_download = enabled;
    }
    enabled
}

#[cfg(test)]
mod tests {
    use super::{classify_dartsnut_project_files, health};

    const PYPROJECT: &str = r#"
[project]
name = "demo"
version = "1.2.3"
dependencies = ["Py_DartsNut[extra] >= 1"]
"#;

    #[test]
    fn health_reports_canonical_identity() {
        let status = health();
        assert_eq!(status.status, "ok");
        assert_eq!(status.app_id, "com.dartsnut.agent");
        assert!(!status.scaffold);
    }

    #[test]
    fn project_without_conf_is_eligible_game() {
        let result = classify_dartsnut_project_files(Some(PYPROJECT), None);
        assert_eq!(result["ok"], true);
        assert_eq!(result["appId"], "demo");
        assert_eq!(result["version"], "1.2.3");
        assert_eq!(result["projectType"], "game");
    }

    #[test]
    fn project_with_widget_conf_is_eligible_widget() {
        let result = classify_dartsnut_project_files(
            Some(PYPROJECT),
            Some(r#"{"size":[128,64],"fields":[]}"#),
        );
        assert_eq!(result["ok"], true);
        assert_eq!(result["projectType"], "widget");
    }

    #[test]
    fn invalid_project_metadata_stays_ineligible() {
        let missing_dependency = PYPROJECT.replace("Py_DartsNut[extra] >= 1", "requests");
        assert_eq!(
            classify_dartsnut_project_files(Some(&missing_dependency), None)["reason"],
            "missing_pydartsnut"
        );
        assert_eq!(
            classify_dartsnut_project_files(Some(PYPROJECT), Some("{}"))["reason"],
            "broken_widget"
        );
    }
}
