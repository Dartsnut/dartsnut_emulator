use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};

pub struct EmulatorRuntime {
    stdin: Mutex<Option<ChildStdin>>,
    child: Mutex<Option<Child>>,
    last_path: Mutex<Option<String>>,
}

impl Default for EmulatorRuntime {
    fn default() -> Self {
        Self {
            stdin: Mutex::new(None),
            child: Mutex::new(None),
            last_path: Mutex::new(None),
        }
    }
}

impl EmulatorRuntime {
    pub(crate) fn persist_last_path(app: &AppHandle, value: Option<&str>) {
        let Some(path) = app
            .path()
            .app_data_dir()
            .ok()
            .map(|p| p.join("emulator-state.json"))
        else {
            return;
        };
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let body = serde_json::json!({"lastWidgetDir": value});
        let tmp = path.with_extension("json.tmp");
        if let Ok(bytes) = serde_json::to_vec_pretty(&body) {
            let _ = std::fs::write(&tmp, bytes).and_then(|_| std::fs::rename(tmp, path));
        }
    }

    pub fn load_last_path(&self, app: &AppHandle) {
        let Some(path) = app
            .path()
            .app_data_dir()
            .ok()
            .map(|p| p.join("emulator-state.json"))
        else {
            return;
        };
        let value = std::fs::read_to_string(path)
            .ok()
            .and_then(|body| serde_json::from_str::<Value>(&body).ok())
            .and_then(|body| {
                body.get("lastWidgetDir")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            });
        if let Ok(mut slot) = self.last_path.lock() {
            *slot = value;
        }
    }

    pub fn set_last_path(&self, app: &AppHandle, value: String) {
        if let Ok(mut slot) = self.last_path.lock() {
            *slot = Some(value.clone());
        }
        Self::persist_last_path(app, Some(&value));
    }

    async fn ensure_started(&self, app: &AppHandle) -> Result<(), String> {
        {
            let mut child = self
                .child
                .lock()
                .map_err(|_| "emulator state unavailable")?;
            if let Some(process) = child.as_mut() {
                if process
                    .try_wait()
                    .map_err(|error| error.to_string())?
                    .is_none()
                {
                    return Ok(());
                }
                *child = None;
                if let Ok(mut stdin) = self.stdin.lock() {
                    *stdin = None;
                }
            }
        }
        let preferred_root = app
            .path()
            .resource_dir()
            .or_else(|_| std::env::current_dir().map_err(Into::into))
            .map_err(|error: tauri::Error| error.to_string())?;
        let mut roots = vec![preferred_root];
        if let Some(repo_root) = std::env::var_os("DARTSNUT_REPO_ROOT") {
            roots.push(PathBuf::from(repo_root));
        }
        if let Ok(mut current) = std::env::current_dir() {
            for _ in 0..4 {
                roots.push(current.clone());
                if !current.pop() {
                    break;
                }
            }
        }
        let root = roots
            .into_iter()
            .find(|candidate| {
                candidate
                    .join("services/emulator-core/bridge_service.py")
                    .is_file()
            })
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
        let script = root.join("services/emulator-core/bridge_service.py");
        if !script.is_file() {
            return Err(format!(
                "emulator bridge script not found: {}",
                script.display()
            ));
        }
        let python = crate::runtime::discover_python(Some(&root))
            .ok_or_else(|| "Python runtime unavailable".to_owned())?;
        let mut child = Command::new(python);
        child
            .arg(&script)
            .current_dir(&root)
            .env_clear()
            .envs(crate::runtime::sanitized_environment())
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        let mut process = child.spawn().map_err(|error| error.to_string())?;
        let stdin = process
            .stdin
            .take()
            .ok_or_else(|| "emulator stdin unavailable".to_owned())?;
        let stdout = process
            .stdout
            .take()
            .ok_or_else(|| "emulator stdout unavailable".to_owned())?;
        let stderr = process.stderr.take();
        let app_handle = app.clone();
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if let Ok(message) = serde_json::from_str::<Value>(&line) {
                    let event = message
                        .get("event")
                        .and_then(Value::as_str)
                        .unwrap_or("log");
                    let payload = message.get("payload").cloned().unwrap_or(Value::Null);
                    let tauri_event = match event {
                        "state" | "ready" | "heartbeat" => "emulator:state",
                        "frame" => "emulator:frame",
                        "log" | "diag" => "emulator:log",
                        "error" => "emulator:error",
                        _ => "emulator:event",
                    };
                    let _ = app_handle.emit(tauri_event, payload);
                }
            }
            let _ = app_handle.emit(
                "emulator:state",
                json!({
                    "widgetPath": null,
                    "running": false,
                    "fps": 0,
                    "status": "Bridge stopped",
                    "audioMuted": false
                }),
            );
        });
        if let Some(stderr) = stderr {
            let app_handle = app.clone();
            tauri::async_runtime::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let _ = app_handle.emit(
                        "emulator:log",
                        json!({
                            "source": "stderr",
                            "text": line,
                            "timestampMs": chrono::Utc::now().timestamp_millis()
                        }),
                    );
                }
            });
        }
        *self
            .child
            .lock()
            .map_err(|_| "emulator state unavailable")? = Some(process);
        *self
            .stdin
            .lock()
            .map_err(|_| "emulator state unavailable")? = Some(stdin);
        Ok(())
    }

    pub async fn send(
        &self,
        app: &AppHandle,
        allowed_workspace: Option<&Path>,
        mut command: Value,
    ) -> Result<(), String> {
        self.ensure_started(app).await?;
        if command.get("type").and_then(Value::as_str) == Some("set_path") {
            let raw = command.get("path").and_then(Value::as_str).unwrap_or("");
            let base = app
                .path()
                .resource_dir()
                .or_else(|_| std::env::current_dir().map_err(Into::into))
                .map_err(|error: tauri::Error| error.to_string())?;
            let base = std::fs::canonicalize(&base).unwrap_or(base);
            let allowed_root = allowed_workspace.map(|workspace| {
                std::fs::canonicalize(workspace).unwrap_or_else(|_| workspace.to_path_buf())
            });
            let candidate = if Path::new(raw).is_absolute() {
                PathBuf::from(raw)
            } else if let Some(workspace) = allowed_root.as_ref() {
                workspace.join(raw)
            } else {
                base.join(raw)
            };
            let resolved =
                std::fs::canonicalize(&candidate).map_err(|_| "widget path not found")?;
            if !resolved.starts_with(&base)
                && !allowed_root
                    .as_ref()
                    .is_some_and(|workspace| resolved.starts_with(workspace))
            {
                return Err("widget path escapes allowed workspace".to_owned());
            }
            command["path"] = Value::String(resolved.to_string_lossy().into_owned());
            if let Ok(mut last_path) = self.last_path.lock() {
                *last_path = command
                    .get("path")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                Self::persist_last_path(app, last_path.as_deref());
            }
        }
        let encoded =
            serde_json::to_string(&json!({"command": command})).map_err(|e| e.to_string())?;
        let mut stdin = self
            .stdin
            .lock()
            .map_err(|_| "emulator state unavailable")?
            .take()
            .ok_or_else(|| "emulator bridge unavailable".to_owned())?;
        if stdin.write_all(encoded.as_bytes()).await.is_err()
            || stdin.write_all(b"\n").await.is_err()
        {
            return Err("emulator bridge write failed".to_owned());
        }
        stdin.flush().await.map_err(|error| error.to_string())?;
        *self
            .stdin
            .lock()
            .map_err(|_| "emulator state unavailable")? = Some(stdin);
        Ok(())
    }

    pub async fn stop(&self) {
        let stdin = self.stdin.lock().ok().and_then(|mut guard| guard.take());
        if let Some(mut stdin) = stdin {
            let _ = stdin
                .write_all(b"{\"command\":{\"type\":\"shutdown\"}}\n")
                .await;
            let _ = stdin.shutdown().await;
        }
        if let Some(mut child) = self.child.lock().ok().and_then(|mut guard| guard.take()) {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
    }

    pub fn last_path(&self) -> Option<String> {
        self.last_path.lock().ok().and_then(|value| value.clone())
    }
}
