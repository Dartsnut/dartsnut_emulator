//! Rust-owned local emulator runtime.
//!
//! Python remains widget implementation. Rust owns widget supervision,
//! shared-memory ABI, frame polling, renderer events, and process cleanup.

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::ffi::CString;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::mpsc as std_mpsc;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncRead};
use tokio::process::{Child, Command};
use tokio::sync::mpsc;
use tokio::time::{timeout, MissedTickBehavior};

const PDI_WIDTH: usize = 128;
const PDI_HEIGHT: usize = 160;
const PDI_SIZE: usize = 1 + PDI_WIDTH * PDI_HEIGHT * 3;
/// pydartsnut ABI: button byte, then twelve little-endian x/y pairs.
pub const PDO_SIZE: usize = 50;
const PDO_NAME: &str = "pdoshm";
const POSIX_SHM_NAME_MAX: usize = 31;
const GIF_FPS: usize = 24;
const GIF_MAX_FRAMES: usize = GIF_FPS * 30;

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn unique_pdi_name() -> String {
    let uuid = uuid::Uuid::new_v4().simple().to_string();
    let name = format!("pdi_{}", &uuid[..20]);
    debug_assert!(name.len() < POSIX_SHM_NAME_MAX);
    name
}

#[derive(Debug)]
struct SharedMemory {
    name: String,
    ptr: *mut u8,
    len: usize,
    #[cfg(unix)]
    fd: libc::c_int,
    #[cfg(windows)]
    mapping: windows_sys::Win32::Foundation::HANDLE,
}
unsafe impl Send for SharedMemory {}
unsafe impl Sync for SharedMemory {}

impl SharedMemory {
    fn create(name: impl Into<String>, len: usize) -> Result<Self, String> {
        let name = name.into();
        if len == 0 {
            return Err("shared memory size must be positive".to_owned());
        }
        #[cfg(unix)]
        {
            let c_name =
                CString::new(format!("/{name}")).map_err(|_| "shared memory name contains NUL")?;
            // PDI is unique; PDO is fixed for pydartsnut compatibility.
            unsafe {
                libc::shm_unlink(c_name.as_ptr());
            }
            let fd = unsafe {
                libc::shm_open(
                    c_name.as_ptr(),
                    libc::O_CREAT | libc::O_RDWR,
                    (libc::S_IRUSR | libc::S_IWUSR) as libc::c_uint,
                )
            };
            if fd < 0 {
                return Err(io::Error::last_os_error().to_string());
            }
            if unsafe { libc::ftruncate(fd, len as libc::off_t) } != 0 {
                let error = io::Error::last_os_error().to_string();
                unsafe {
                    libc::close(fd);
                }
                return Err(error);
            }
            let ptr = unsafe {
                libc::mmap(
                    std::ptr::null_mut(),
                    len,
                    libc::PROT_READ | libc::PROT_WRITE,
                    libc::MAP_SHARED,
                    fd,
                    0,
                )
            };
            if ptr == libc::MAP_FAILED {
                let error = io::Error::last_os_error().to_string();
                unsafe {
                    libc::close(fd);
                }
                return Err(error);
            }
            return Ok(Self {
                name,
                ptr: ptr.cast(),
                len,
                fd,
            });
        }
        #[cfg(windows)]
        {
            use std::os::windows::ffi::OsStrExt;
            use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
            use windows_sys::Win32::System::Memory::{
                CreateFileMappingW, MapViewOfFile, FILE_MAP_ALL_ACCESS, PAGE_READWRITE,
            };
            let wide: Vec<u16> = std::ffi::OsStr::new(&name)
                .encode_wide()
                .chain(std::iter::once(0))
                .collect();
            let mapping = unsafe {
                CreateFileMappingW(
                    INVALID_HANDLE_VALUE,
                    std::ptr::null(),
                    PAGE_READWRITE,
                    0,
                    len as u32,
                    wide.as_ptr(),
                )
            };
            if mapping == 0 {
                return Err(io::Error::last_os_error().to_string());
            }
            let ptr = unsafe { MapViewOfFile(mapping, FILE_MAP_ALL_ACCESS, 0, 0, len) };
            if ptr.is_null() {
                let error = io::Error::last_os_error().to_string();
                unsafe {
                    windows_sys::Win32::Foundation::CloseHandle(mapping);
                }
                return Err(error);
            }
            return Ok(Self {
                name,
                ptr: ptr.cast(),
                len,
                mapping,
            });
        }
        #[allow(unreachable_code)]
        Err("shared memory is unsupported on this platform".to_owned())
    }

    fn read(&self, offset: usize, len: usize) -> Option<&[u8]> {
        offset.checked_add(len).filter(|end| *end <= self.len)?;
        Some(unsafe { std::slice::from_raw_parts(self.ptr.add(offset), len) })
    }

    fn byte(&self, offset: usize) -> Option<u8> {
        self.read(offset, 1).map(|value| value[0])
    }

    fn write_byte(&self, offset: usize, value: u8) -> Result<(), String> {
        if offset >= self.len {
            return Err("shared memory offset out of range".to_owned());
        }
        unsafe {
            self.ptr.add(offset).write_volatile(value);
        }
        Ok(())
    }

    fn write_bytes(&self, offset: usize, value: &[u8]) -> Result<(), String> {
        offset
            .checked_add(value.len())
            .filter(|end| *end <= self.len)
            .ok_or_else(|| "shared memory write out of range".to_owned())?;
        unsafe {
            std::ptr::copy_nonoverlapping(value.as_ptr(), self.ptr.add(offset), value.len());
        }
        Ok(())
    }
}

impl Drop for SharedMemory {
    fn drop(&mut self) {
        #[cfg(unix)]
        unsafe {
            libc::munmap(self.ptr.cast(), self.len);
            libc::close(self.fd);
            if let Ok(name) = CString::new(format!("/{}", self.name)) {
                libc::shm_unlink(name.as_ptr());
            }
        }
        #[cfg(windows)]
        unsafe {
            windows_sys::Win32::System::Memory::UnmapViewOfFile(self.ptr.cast());
            windows_sys::Win32::Foundation::CloseHandle(self.mapping);
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EmulatorState {
    widget_path: Option<String>,
    widget_id: Option<String>,
    widget_type: Option<String>,
    running: bool,
    fps: u32,
    status: String,
    audio_muted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_capture_path: Option<String>,
    gif_recording: bool,
    gif_saving: bool,
    gif_elapsed_ms: u64,
}

impl Default for EmulatorState {
    fn default() -> Self {
        Self {
            widget_path: None,
            widget_id: None,
            widget_type: None,
            running: false,
            fps: 60,
            status: "Idle".to_owned(),
            audio_muted: false,
            last_error: None,
            last_capture_path: None,
            gif_recording: false,
            gif_saving: false,
            gif_elapsed_ms: 0,
        }
    }
}

#[derive(Clone, Debug)]
struct WidgetLog {
    source: &'static str,
    text: String,
    timestamp_ms: i64,
}

fn emit_log(app: &AppHandle, log: WidgetLog) {
    if !log.text.trim().is_empty() {
        let _ = app.emit(
            "emulator:log",
            json!({
                "source": log.source, "text": log.text, "timestampMs": log.timestamp_ms
            }),
        );
    }
}

fn bridge_log(text: impl Into<String>, source: &'static str) -> WidgetLog {
    WidgetLog {
        source,
        text: format!("[bridge] {}", text.into()),
        timestamp_ms: now_ms(),
    }
}

fn normalize_distribution(value: &str) -> String {
    value
        .split(|ch: char| !(ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-')))
        .next()
        .unwrap_or_default()
        .chars()
        .filter(|ch| !matches!(ch, '.' | '_' | '-'))
        .flat_map(char::to_lowercase)
        .collect()
}

fn classify_workspace(path: &Path) -> Result<(String, Value, String), String> {
    let body = fs::read_to_string(path.join("pyproject.toml"))
        .map_err(|_| "pyproject.toml was not found".to_owned())?;
    let parsed: toml::Value = toml::from_str(&body)
        .map_err(|error| format!("Could not parse pyproject.toml: {error}"))?;
    let project = parsed
        .get("project")
        .and_then(toml::Value::as_table)
        .ok_or_else(|| "pyproject.toml must contain a [project] table".to_owned())?;
    let app_id = project
        .get("name")
        .and_then(toml::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "pyproject.toml [project].name must not be empty".to_owned())?;
    if project
        .get("version")
        .and_then(toml::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_none()
    {
        return Err("pyproject.toml [project].version must not be empty".to_owned());
    }
    let dependencies = project
        .get("dependencies")
        .and_then(toml::Value::as_array)
        .ok_or_else(|| {
            "pyproject.toml [project].dependencies must be an array of strings".to_owned()
        })?;
    if !dependencies
        .iter()
        .filter_map(toml::Value::as_str)
        .any(|item| normalize_distribution(item) == "pydartsnut")
    {
        return Err("pyproject.toml must declare pydartsnut in [project].dependencies".to_owned());
    }
    let conf_path = path.join("conf.json");
    if !conf_path.exists() {
        return Ok((
            "game".to_owned(),
            Value::Object(Default::default()),
            app_id.to_owned(),
        ));
    }
    let conf: Value = serde_json::from_str(
        &fs::read_to_string(conf_path)
            .map_err(|error| format!("Broken widget conf.json: {error}"))?,
    )
    .map_err(|error| format!("Broken widget conf.json: {error}"))?;
    if conf.get("type").and_then(Value::as_str) == Some("game") {
        return Ok((
            "game".to_owned(),
            Value::Object(Default::default()),
            app_id.to_owned(),
        ));
    }
    if !conf.is_object() || conf.get("size").is_none() || conf.get("fields").is_none() {
        return Err("Broken widget conf.json: size and fields are required".to_owned());
    }
    Ok(("widget".to_owned(), conf, app_id.to_owned()))
}

fn dimensions(config: Option<&Value>) -> Result<(usize, usize), String> {
    let Some(size) = config
        .and_then(|value| value.get("size"))
        .and_then(Value::as_array)
    else {
        return Ok((PDI_WIDTH, PDI_HEIGHT));
    };
    if size.len() != 2 {
        return Err("Widget conf.json size must contain width and height".to_owned());
    }
    let width = size[0]
        .as_u64()
        .ok_or_else(|| "Widget width must be an integer".to_owned())? as usize;
    let height = size[1]
        .as_u64()
        .ok_or_else(|| "Widget height must be an integer".to_owned())? as usize;
    if width == 0 || height == 0 || width.saturating_mul(height).saturating_mul(3) + 1 > PDI_SIZE {
        return Err("Widget framebuffer exceeds 128x160 RGB shared-memory capacity".to_owned());
    }
    Ok((width, height))
}

fn repo_root(app: &AppHandle) -> PathBuf {
    let mut roots = Vec::new();
    if let Some(value) = std::env::var_os("DARTSNUT_REPO_ROOT") {
        roots.push(PathBuf::from(value));
    }
    if let Ok(value) = app.path().resource_dir() {
        roots.push(value);
    }
    if let Ok(mut current) = std::env::current_dir() {
        for _ in 0..6 {
            roots.push(current.clone());
            if !current.pop() {
                break;
            }
        }
    }
    roots
        .into_iter()
        .find(|root| root.join("services/emulator-core").is_dir())
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
}

fn launch_env(runtime: &crate::runtime::ManagedRuntimePaths) -> Vec<(String, String)> {
    let mut env: std::collections::HashMap<String, String> =
        crate::runtime::managed_environment(runtime)
            .into_iter()
            .collect();
    for key in [
        "VIRTUAL_ENV",
        "PYTHONHOME",
        "PYTHONPATH",
        "PYTHONUSERBASE",
        "UV_NO_PROJECT",
        "UV_NO_SYNC",
        "UV_PROJECT_ENVIRONMENT",
    ] {
        env.remove(key);
    }
    env.insert("PYTHONNOUSERSITE".to_owned(), "1".to_owned());
    env.insert("UV_NO_PYTHON_DOWNLOADS".to_owned(), "never".to_owned());
    env.insert("UV_NO_MANAGED_PYTHON".to_owned(), "1".to_owned());
    env.insert(
        "UV_PYTHON".to_owned(),
        runtime.python.to_string_lossy().into_owned(),
    );
    env.insert("PYTHONUNBUFFERED".to_owned(), "1".to_owned());
    env.into_iter().collect()
}

async fn terminate_widget(child: &mut Child) {
    let pid = child.id();
    #[cfg(unix)]
    if let Some(pid) = pid {
        unsafe {
            libc::kill(-(pid as libc::pid_t), libc::SIGTERM);
        }
    }
    let exited = timeout(Duration::from_secs(2), child.wait()).await.is_ok();
    if !exited {
        #[cfg(unix)]
        if let Some(pid) = pid {
            unsafe {
                libc::kill(-(pid as libc::pid_t), libc::SIGKILL);
            }
        }
        #[cfg(windows)]
        if let Some(pid) = pid {
            let _ = Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .status()
                .await;
        }
        let _ = child.kill().await;
        let _ = timeout(Duration::from_secs(2), child.wait()).await;
    }
}

struct EmulatorCore {
    workspace_root: PathBuf,
    runtime: crate::runtime::ManagedRuntimePaths,
    state: EmulatorState,
    current_path: Option<PathBuf>,
    current_params: Value,
    config: Option<Value>,
    data_store_path: Option<PathBuf>,
    child: Option<Child>,
    pdi: SharedMemory,
    pdo: SharedMemory,
    log_tx: mpsc::UnboundedSender<WidgetLog>,
    pending_logs: VecDeque<WidgetLog>,
    stream_tail: String,
    last_frame: Option<Vec<u8>>,
    frame_width: usize,
    frame_height: usize,
    capture_base_name: String,
    button_state: u8,
    darts: [(i32, i32); 12],
    gif_started: Option<Instant>,
    gif_zoom: u32,
    gif_frames: Vec<Vec<u8>>,
    gif_width: usize,
    gif_height: usize,
    #[allow(clippy::type_complexity)]
    gif_save_rx: Option<std_mpsc::Receiver<Result<(Vec<String>, PathBuf), String>>>,
    gif_save_thread: Option<JoinHandle<()>>,
    stall_started: Option<Instant>,
    last_stall_warning: Option<Instant>,
}

impl EmulatorCore {
    fn new(app: &AppHandle, log_tx: mpsc::UnboundedSender<WidgetLog>) -> Result<Self, String> {
        let pdi = SharedMemory::create(unique_pdi_name(), PDI_SIZE)?;
        pdi.write_byte(0, 1)?;
        let pdo = SharedMemory::create(PDO_NAME, PDO_SIZE)?;
        pdo.write_bytes(1, &[0xff; 48])?;
        pdo.write_byte(49, 100)?;
        let runtime = app
            .state::<crate::commands::AppState>()
            .runtime
            .require_ready()?;
        let core = Self {
            workspace_root: repo_root(app),
            runtime,
            state: EmulatorState::default(),
            current_path: None,
            current_params: Value::Object(Default::default()),
            config: None,
            data_store_path: None,
            child: None,
            pdi,
            pdo,
            log_tx,
            pending_logs: VecDeque::new(),
            stream_tail: String::new(),
            last_frame: None,
            frame_width: PDI_WIDTH,
            frame_height: PDI_HEIGHT,
            capture_base_name: "capture".to_owned(),
            button_state: 0,
            darts: [(-1, -1); 12],
            gif_started: None,
            gif_zoom: 4,
            gif_frames: Vec::new(),
            gif_width: 0,
            gif_height: 0,
            gif_save_rx: None,
            gif_save_thread: None,
            stall_started: None,
            last_stall_warning: None,
        };
        core.write_button_state()?;
        core.write_darts()?;
        Ok(core)
    }

    fn snapshot(&mut self) -> EmulatorState {
        if let Some(child) = self.child.as_mut() {
            if let Ok(Some(status)) = child.try_wait() {
                self.state.running = false;
                self.state.status = "Widget exited".to_owned();
                if !status.success()
                    && self.state.last_error.is_none()
                    && !self.stream_tail.trim().is_empty()
                {
                    self.state.last_error = Some(
                        self.stream_tail
                            .chars()
                            .rev()
                            .take(2000)
                            .collect::<String>()
                            .chars()
                            .rev()
                            .collect(),
                    );
                }
                self.child = None;
            }
        }
        self.state.clone()
    }

    fn write_button_state(&self) -> Result<(), String> {
        self.pdo.write_byte(0, self.button_state)
    }

    fn write_darts(&self) -> Result<(), String> {
        for (index, (x, y)) in self.darts.iter().copied().enumerate() {
            let base = index * 4 + 1;
            self.pdo.write_bytes(
                base,
                &(if x < 0 { u16::MAX } else { x as u16 }).to_le_bytes(),
            )?;
            self.pdo.write_bytes(
                base + 2,
                &(if y < 0 { u16::MAX } else { y as u16 }).to_le_bytes(),
            )?;
        }
        Ok(())
    }

    fn invalidate_frame(&mut self) -> Result<(), String> {
        self.last_frame = None;
        self.frame_width = PDI_WIDTH;
        self.frame_height = PDI_HEIGHT;
        self.pdi.write_byte(0, 1)
    }

    fn load_config(&mut self, path: &Path, params: Value) -> Result<(), String> {
        let path = if path.is_absolute() {
            path.to_path_buf()
        } else {
            self.workspace_root.join(path)
        };
        let path = fs::canonicalize(path).map_err(|_| "widget path not found".to_owned())?;
        if !path.is_dir() {
            return Err("widget path is not a directory".to_owned());
        }
        let (app_type, config, app_id) = classify_workspace(&path)?;
        self.current_path = Some(path.clone());
        self.current_params = params;
        self.data_store_path = Some(self.workspace_root.join("user").join("guest").join(&app_id));
        if let Some(path) = self.data_store_path.as_ref() {
            fs::create_dir_all(path).map_err(|e| e.to_string())?;
        }
        self.config = Some(config.clone());
        self.state.widget_path = Some(path.to_string_lossy().into_owned());
        self.state.widget_id = Some(app_id);
        self.state.widget_type = Some(app_type);
        self.capture_base_name = config
            .get("name")
            .and_then(Value::as_str)
            .map(|value| {
                value
                    .chars()
                    .map(|ch| if ch.is_whitespace() { '_' } else { ch })
                    .collect()
            })
            .map(|value: String| {
                if value.is_empty() {
                    "capture".to_owned()
                } else {
                    value
                }
            })
            .unwrap_or_else(|| "capture".to_owned());
        self.state.status.clear();
        Ok(())
    }

    async fn prepare_venv(&mut self, path: &Path) -> Result<(), String> {
        if !path.join("main.py").is_file() {
            return Err(format!(
                "Workspace venv skipped: missing main.py in {}",
                path.display()
            ));
        }
        self.state.status = "venv:Preparing workspace environment…".to_owned();
        let mut command = Command::new(&self.runtime.uv);
        command
            .arg("sync")
            .arg("--directory")
            .arg(path)
            .current_dir(path)
            .env_clear()
            .envs(launch_env(&self.runtime));
        let output = command.output().await.map_err(|e| e.to_string())?;
        for (source, body) in [("stdout", &output.stdout), ("stderr", &output.stderr)] {
            for line in String::from_utf8_lossy(body)
                .lines()
                .filter(|line| !line.trim().is_empty())
            {
                self.pending_logs.push_back(WidgetLog {
                    source,
                    text: line.to_owned(),
                    timestamp_ms: now_ms(),
                });
            }
        }
        if !output.status.success() {
            return Err("Failed to prepare workspace Python environment (uv sync)".to_owned());
        }
        Ok(())
    }

    async fn stop_widget(&mut self) {
        if self.state.gif_recording {
            let _ = self.stop_gif();
        }
        if let Some(mut child) = self.child.take() {
            self.queue_log("Stopping running widget process.", "stdout");
            terminate_widget(&mut child).await;
        }
        self.state.running = false;
        self.state.status = "Widget stopped".to_owned();
        let _ = self.invalidate_frame();
    }

    async fn start_widget(&mut self) -> Result<(), String> {
        let path = self
            .current_path
            .clone()
            .ok_or_else(|| "No widget path is configured".to_owned())?;
        self.load_config(&path, self.current_params.clone())?;
        self.stop_widget().await;
        self.prepare_venv(&path).await?;
        let params = serde_json::to_string(&self.current_params).map_err(|e| e.to_string())?;
        let path_arg = path.to_string_lossy().into_owned();
        let data_store = self
            .data_store_path
            .as_ref()
            .map(|p| p.to_string_lossy().into_owned());
        let mut args = vec![
            "run".to_owned(),
            "--no-sync".to_owned(),
            "--directory".to_owned(),
            path_arg,
            "main.py".to_owned(),
            "--params".to_owned(),
            params,
            "--shm".to_owned(),
            self.pdi.name.clone(),
        ];
        if let Some(path) = data_store {
            args.extend(["--data-store".to_owned(), path]);
        }
        let mut command = Command::new(&self.runtime.uv);
        command
            .args(&args)
            .current_dir(&path)
            .env_clear()
            .envs(launch_env(&self.runtime))
            .env("SDL_VIDEODRIVER", "dummy");
        if self.state.audio_muted {
            command.env("SDL_AUDIODRIVER", "dummy");
        } else {
            command.env_remove("SDL_AUDIODRIVER");
        }
        let verbose = std::env::var("DARTSNUT_EMULATOR_VERBOSE")
            .ok()
            .is_some_and(|value| {
                matches!(
                    value.trim().to_ascii_lowercase().as_str(),
                    "1" | "true" | "yes"
                )
            });
        if verbose {
            command.env_remove("PYGAME_HIDE_SUPPORT_PROMPT");
        } else {
            command.env("PYGAME_HIDE_SUPPORT_PROMPT", "1");
        }
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            unsafe {
                command.as_std_mut().pre_exec(|| {
                    if libc::setsid() == -1 {
                        return Err(io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
        }
        self.queue_log(
            format!("launch command cwd={} argv={args:?}", path.display()),
            "stdout",
        );
        let mut child = command.spawn().map_err(|e| e.to_string())?;
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        self.spawn_reader(stdout, "stdout");
        self.spawn_reader(stderr, "stderr");
        let pid = child.id();
        self.child = Some(child);
        self.state.running = true;
        self.state.status.clear();
        self.state.last_error = None;
        self.stream_tail.clear();
        self.queue_log(
            format!(
                "Child process started{}.",
                pid.map(|v| format!(" (pid={v})")).unwrap_or_default()
            ),
            "stdout",
        );
        Ok(())
    }

    fn spawn_reader<T>(&self, stream: Option<T>, source: &'static str)
    where
        T: AsyncRead + Unpin + Send + 'static,
    {
        let Some(stream) = stream else {
            return;
        };
        let tx = self.log_tx.clone();
        tauri::async_runtime::spawn(async move {
            let mut lines = tokio::io::BufReader::new(stream).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if !line.trim().is_empty() {
                    let _ = tx.send(WidgetLog {
                        source,
                        text: line,
                        timestamp_ms: now_ms(),
                    });
                }
            }
        });
    }

    fn queue_log(&mut self, text: impl Into<String>, source: &'static str) {
        self.pending_logs.push_back(bridge_log(text, source));
    }

    async fn apply(&mut self, command: Value) {
        let action = command
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let result = match action {
            "set_path" => command
                .get("path")
                .and_then(Value::as_str)
                .ok_or_else(|| "set_path requires string path".to_owned())
                .and_then(|path| self.load_config(Path::new(path), self.current_params.clone())),
            "set_params" => command
                .get("params")
                .filter(|v| v.is_object())
                .cloned()
                .ok_or_else(|| "set_params requires object params".to_owned())
                .map(|params| {
                    self.current_params = params;
                    self.state.status = "Params updated".to_owned();
                }),
            "shutdown" => {
                self.queue_log("shutdown requested", "stdout");
                self.stop_widget().await;
                self.state.status = "Shutting down".to_owned();
                Ok(())
            }
            "stop_widget" => {
                self.queue_log("stop_widget requested", "stdout");
                self.stop_widget().await;
                let muted = self.state.audio_muted;
                self.current_path = None;
                self.config = None;
                self.data_store_path = None;
                self.current_params = Value::Object(Default::default());
                self.state = EmulatorState {
                    audio_muted: muted,
                    ..EmulatorState::default()
                };
                Ok(())
            }
            "reload_widget" => {
                self.state.last_error = None;
                self.queue_log(
                    format!(
                        "reload_widget requested for {}",
                        self.current_path
                            .as_ref()
                            .map(|p| p.display().to_string())
                            .unwrap_or_else(|| "(no path set)".to_owned())
                    ),
                    "stdout",
                );
                self.start_widget().await
            }
            "set_audio_muted" => {
                let muted = command
                    .get("muted")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let running = self.child.is_some()
                    && self
                        .child
                        .as_mut()
                        .and_then(|child| child.try_wait().ok())
                        .flatten()
                        .is_none();
                self.state.audio_muted = muted;
                self.state.status = if muted {
                    "Audio muted"
                } else {
                    "Audio unmuted"
                }
                .to_owned();
                self.queue_log(
                    format!("emulator audio {}", if muted { "muted" } else { "unmuted" }),
                    "stdout",
                );
                if running {
                    self.start_widget().await
                } else {
                    Ok(())
                }
            }
            "set_button" => {
                let button = command
                    .get("button")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_ascii_uppercase();
                let mask = match button.as_str() {
                    "A" => 1,
                    "B" => 2,
                    "UP" => 4,
                    "RIGHT" => 8,
                    "LEFT" => 16,
                    "DOWN" => 32,
                    _ => {
                        self.fail(action, "Unknown button");
                        return;
                    }
                };
                let pressed = command
                    .get("pressed")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                if pressed {
                    self.button_state |= mask;
                } else {
                    self.button_state &= !mask;
                }
                self.write_button_state().map(|_| {
                    self.state.status =
                        format!("Button {button} {}", if pressed { "down" } else { "up" })
                })
            }
            "throw_dart" => {
                let index = command.get("index").and_then(Value::as_i64).unwrap_or(0);
                if !(0..12).contains(&index) {
                    self.fail(action, "Dart index out of range");
                    return;
                }
                self.darts[index as usize] = (
                    command.get("x").and_then(Value::as_i64).unwrap_or(-1) as i32,
                    command.get("y").and_then(Value::as_i64).unwrap_or(-1) as i32,
                );
                self.write_darts()
                    .map(|_| self.state.status = format!("Dart {} placed", index + 1))
            }
            "remove_dart_at" => {
                let point = (
                    command.get("x").and_then(Value::as_i64).unwrap_or(-1) as i32,
                    command.get("y").and_then(Value::as_i64).unwrap_or(-1) as i32,
                );
                if let Some(dart) = self.darts.iter_mut().find(|dart| **dart == point) {
                    *dart = (-1, -1);
                }
                self.write_darts()
                    .map(|_| self.state.status = "Dart removed".to_owned())
            }
            "clear_darts" => {
                self.darts = [(-1, -1); 12];
                self.write_darts()
                    .map(|_| self.state.status = "All darts cleared".to_owned())
            }
            "capture_screenshot" => {
                self.capture_screenshot(
                    command.get("zoom").and_then(Value::as_u64).unwrap_or(1) as u32
                )
            }
            "start_gif_recording" => self.start_gif_recording(
                command.get("zoom").and_then(Value::as_u64).unwrap_or(4) as u32,
            ),
            "stop_gif_recording" => self.stop_gif(),
            _ => Err(format!("Unsupported command: {action}")),
        };
        if let Err(error) = result {
            self.fail(action, &error);
        }
    }

    fn fail(&mut self, action: &str, error: &str) {
        self.queue_log(format!("{action} failed: {error}"), "stderr");
        self.state.last_error = Some(error.to_owned());
        self.state.status = "Command failed".to_owned();
    }

    fn zoom(value: u32) -> Result<u32, String> {
        if matches!(value, 1 | 2 | 4) {
            Ok(value)
        } else {
            Err("Capture zoom must be 1, 2, or 4".to_owned())
        }
    }

    fn capture_dir(&self) -> Result<PathBuf, String> {
        let home = std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        let downloads = home.join("Downloads").join("Dartsnut");
        if fs::create_dir_all(&downloads).is_ok() {
            return Ok(downloads);
        }
        let fallback = self.workspace_root.join("capture");
        fs::create_dir_all(&fallback).map_err(|e| e.to_string())?;
        Ok(fallback)
    }

    fn capture_screenshot(&mut self, value: u32) -> Result<(), String> {
        let zoom = Self::zoom(value)?;
        let frame = self
            .last_frame
            .as_ref()
            .ok_or_else(|| "No frame available yet for screenshot capture".to_owned())?;
        let timestamp = chrono::Local::now().format("%Y-%m-%d_%H-%M-%S").to_string();
        let mut dir = self.capture_dir()?;
        let (surface, width, height) = resize_rgb(frame, self.frame_width, self.frame_height, zoom);
        let path = dir.join(format!(
            "{}_surface_{timestamp}.png",
            self.capture_base_name
        ));
        let hardware = dir.join(format!("{}_{}.png", self.capture_base_name, timestamp));
        let mockup = build_capture_canvas(
            frame,
            self.frame_width,
            self.frame_height,
            &self.workspace_root,
        );
        if let Err(first_error) = save_rgb_png(&path, &surface, width, height)
            .and_then(|_| save_rgb_png(&hardware, &mockup, 588, 800))
        {
            let fallback = self.workspace_root.join("capture");
            let _ = fs::remove_file(&path);
            let _ = fs::remove_file(&hardware);
            if dir != fallback {
                fs::create_dir_all(&fallback).map_err(|_| first_error.clone())?;
                dir = fallback;
                let fallback_surface = dir.join(format!(
                    "{}_surface_{timestamp}.png",
                    self.capture_base_name
                ));
                let fallback_hardware =
                    dir.join(format!("{}_{}.png", self.capture_base_name, timestamp));
                save_rgb_png(&fallback_surface, &surface, width, height)
                    .and_then(|_| save_rgb_png(&fallback_hardware, &mockup, 588, 800))
                    .map_err(|_| first_error)?;
            } else {
                return Err(first_error);
            }
        }
        let path = dir.join(format!(
            "{}_surface_{timestamp}.png",
            self.capture_base_name
        ));
        let hardware = dir.join(format!("{}_{}.png", self.capture_base_name, timestamp));
        self.state.last_capture_path = Some(dir.to_string_lossy().into_owned());
        self.state.status = format!(
            "Screenshot captured: {}, {}",
            hardware.file_name().unwrap_or_default().to_string_lossy(),
            path.file_name().unwrap_or_default().to_string_lossy()
        );
        Ok(())
    }

    fn start_gif_recording(&mut self, value: u32) -> Result<(), String> {
        let zoom = Self::zoom(value)?;
        if self.state.gif_recording {
            return Err("A GIF recording is already active".to_owned());
        }
        if self.state.gif_saving {
            return Err("Wait for the current GIF to finish saving".to_owned());
        }
        let frame = self
            .last_frame
            .as_ref()
            .ok_or_else(|| "No frame available yet for GIF recording".to_owned())?;
        self.gif_started = Some(Instant::now());
        self.gif_zoom = zoom;
        self.gif_width = self.frame_width;
        self.gif_height = self.frame_height;
        self.gif_frames = vec![frame.clone()];
        self.state.gif_recording = true;
        self.state.gif_elapsed_ms = 0;
        self.state.status = "Recording GIF".to_owned();
        Ok(())
    }

    fn update_gif(&mut self) {
        let Some(started) = self.gif_started else {
            return;
        };
        let elapsed = started.elapsed();
        let target =
            ((elapsed.as_secs_f64() * GIF_FPS as f64).ceil() as usize).clamp(1, GIF_MAX_FRAMES);
        if let Some(frame) = self.last_frame.clone() {
            while self.gif_frames.len() < target {
                self.gif_frames.push(frame.clone());
            }
        }
        self.state.gif_elapsed_ms = elapsed.as_millis().min(30_000) as u64;
        if elapsed >= Duration::from_secs(30) {
            let _ = self.begin_gif_save();
        }
    }

    fn stop_gif(&mut self) -> Result<(), String> {
        if !self.state.gif_recording {
            return Err("No GIF recording is active".to_owned());
        }
        if self
            .gif_started
            .is_some_and(|started| started.elapsed() < Duration::from_secs(30))
        {
            self.update_gif();
        }
        self.begin_gif_save()
    }

    fn begin_gif_save(&mut self) -> Result<(), String> {
        if !self.state.gif_recording {
            return Ok(());
        }
        let frames = std::mem::take(&mut self.gif_frames);
        let dir = self.capture_dir()?;
        let timestamp = chrono::Local::now().format("%Y-%m-%d_%H-%M-%S").to_string();
        let source_width = self.gif_width;
        let source_height = self.gif_height;
        let zoom = self.gif_zoom;
        let base_name = self.capture_base_name.clone();
        let specs = if source_width == 128 && source_height == 160 {
            vec![("main", 0, 0, 128, 128), ("bottom", 0, 128, 64, 32)]
        } else {
            vec![("", 0, 0, source_width, source_height)]
        };
        let (tx, rx) = std_mpsc::channel();
        let thread = std::thread::spawn(move || {
            let result = (|| -> Result<Vec<String>, String> {
                let mut names = Vec::new();
                for (suffix, x, y, width, height) in specs {
                    let filename = if suffix.is_empty() {
                        format!("{}_{}.gif", base_name, timestamp)
                    } else {
                        format!("{}_{}_{}.gif", base_name, suffix, timestamp)
                    };
                    let path = dir.join(filename);
                    save_gif(
                        &path,
                        &frames,
                        source_width,
                        source_height,
                        x,
                        y,
                        width,
                        height,
                        zoom,
                    )?;
                    names.push(
                        path.file_name()
                            .unwrap_or_default()
                            .to_string_lossy()
                            .into_owned(),
                    );
                }
                Ok(names)
            })();
            let _ = tx.send(result.map(|names| (names, dir)));
        });
        self.gif_started = None;
        self.state.gif_recording = false;
        self.state.gif_saving = true;
        self.state.status = "Saving GIF".to_owned();
        self.gif_save_rx = Some(rx);
        self.gif_save_thread = Some(thread);
        Ok(())
    }

    fn poll_gif_save(&mut self) {
        let Some(rx) = self.gif_save_rx.as_ref() else {
            return;
        };
        let Ok(result) = rx.try_recv() else {
            return;
        };
        if let Some(thread) = self.gif_save_thread.take() {
            let _ = thread.join();
        }
        self.gif_save_rx = None;
        self.state.gif_saving = false;
        match result {
            Ok((names, dir)) => {
                self.state.last_error = None;
                self.state.last_capture_path = Some(dir.to_string_lossy().into_owned());
                self.state.status = format!("GIF recorded: {}", names.join(", "));
            }
            Err(error) => {
                self.state.last_error = Some(error.clone());
                self.state.status = "GIF save failed".to_owned();
                self.queue_log(format!("GIF save failed: {error}"), "stderr");
            }
        }
    }

    fn read_frame(&mut self) -> Option<Value> {
        if self.pdi.byte(0)? != 0 {
            return None;
        }
        let _ = self.pdi.write_byte(0, 2);
        let result = (|| {
            let (width, height) = dimensions(self.config.as_ref())?;
            let length = width
                .checked_mul(height)
                .and_then(|v| v.checked_mul(3))
                .ok_or_else(|| "invalid frame dimensions".to_owned())?;
            let frame = self
                .pdi
                .read(1, length)
                .ok_or_else(|| "frame outside shared memory".to_owned())?
                .to_vec();
            Ok::<_, String>((width, height, frame))
        })();
        let _ = self.pdi.write_byte(0, 1);
        let (width, height, frame) = result.ok()?;
        self.last_frame = Some(frame.clone());
        self.frame_width = width;
        self.frame_height = height;
        Some(
            json!({ "width": width, "height": height, "rgbBase64": base64::engine::general_purpose::STANDARD.encode(frame), "timestampMs": now_ms() }),
        )
    }

    async fn tick(&mut self, app: &AppHandle) {
        let _ = self.snapshot();
        if let Some(frame) = self.read_frame() {
            let _ = app.emit("emulator:frame", frame);
            self.stall_started = None;
            self.last_stall_warning = None;
        } else if self.state.running
            && self
                .child
                .as_mut()
                .and_then(|child| child.try_wait().ok())
                .flatten()
                .is_none()
            && self.pdi.byte(0) == Some(1)
        {
            let started = *self.stall_started.get_or_insert_with(Instant::now);
            if started.elapsed() >= Duration::from_secs(5)
                && self
                    .last_stall_warning
                    .is_none_or(|last| last.elapsed() >= Duration::from_secs(5))
            {
                self.last_stall_warning = Some(Instant::now());
                emit_log(app, WidgetLog { source: "stdout", text: "[bridge] Widget subprocess is alive but the emulator receives no RGB frames (shared-memory gate stays 1). Call pydartsnut Dartsnut.update_frame_buffer each frame from your main loop, or confirm the project uses pydartsnut for display.".to_owned(), timestamp_ms: now_ms() });
            }
        } else {
            self.stall_started = None;
        }
        self.update_gif();
        self.poll_gif_save();
        while let Some(log) = self.pending_logs.pop_front() {
            emit_log(app, log);
        }
    }

    fn take_log(&mut self, log: WidgetLog) {
        self.stream_tail = format!("{}\n{}: {}", self.stream_tail, log.source, log.text)
            .chars()
            .rev()
            .take(4000)
            .collect::<String>()
            .chars()
            .rev()
            .collect();
        self.pending_logs.push_back(log);
    }

    async fn shutdown(&mut self) {
        self.stop_widget().await;
        if let Some(thread) = self.gif_save_thread.take() {
            let _ = thread.join();
        }
        self.poll_gif_save();
    }
}

fn resize_rgb(source: &[u8], width: usize, height: usize, zoom: u32) -> (Vec<u8>, usize, usize) {
    let zoom = zoom.max(1) as usize;
    let output_width = width.saturating_mul(zoom);
    let output_height = height.saturating_mul(zoom);
    let mut output = vec![0; output_width.saturating_mul(output_height).saturating_mul(3)];
    for y in 0..output_height {
        for x in 0..output_width {
            let source_x = x / zoom;
            let source_y = y / zoom;
            let source_index = (source_y * width + source_x) * 3;
            let output_index = (y * output_width + x) * 3;
            if source_index + 3 <= source.len() {
                output[output_index..output_index + 3]
                    .copy_from_slice(&source[source_index..source_index + 3]);
            }
        }
    }
    (output, output_width, output_height)
}

fn resize_rgb_exact(
    source: &[u8],
    width: usize,
    height: usize,
    out_width: usize,
    out_height: usize,
) -> Vec<u8> {
    let mut output = vec![0; out_width.saturating_mul(out_height).saturating_mul(3)];
    for y in 0..out_height {
        for x in 0..out_width {
            let sx = x.saturating_mul(width) / out_width.max(1);
            let sy = y.saturating_mul(height) / out_height.max(1);
            let si = (sy * width + sx) * 3;
            let di = (y * out_width + x) * 3;
            if si + 3 <= source.len() {
                output[di..di + 3].copy_from_slice(&source[si..si + 3]);
            }
        }
    }
    output
}

fn blend_rgba_over_rgb(base: &mut [u8], overlay: &[u8]) {
    for (dst, src) in base.chunks_exact_mut(3).zip(overlay.chunks_exact(4)) {
        let alpha = src[3] as u16;
        let inv = 255 - alpha;
        for i in 0..3 {
            dst[i] = ((src[i] as u16 * alpha + dst[i] as u16 * inv) / 255) as u8;
        }
    }
}

fn build_capture_canvas(frame: &[u8], width: usize, height: usize, workspace: &Path) -> Vec<u8> {
    let mut canvas = vec![0u8; 588 * 800 * 3];
    if width == 128 && height == 160 {
        let (main, _, _) = resize_rgb(&frame[..128 * 128 * 3], 128, 128, 4);
        blit_rgb(&mut canvas, 588, &main, 512, 512, 38, 38);
        let bottom_src = &frame[128 * 128 * 3..128 * 160 * 3];
        let bottom = resize_rgb_exact(bottom_src, 64, 32, 342, 176);
        blit_rgb(&mut canvas, 588, &bottom, 342, 176, 123, 601);
    } else {
        let main = resize_rgb_exact(frame, width, height, 512, 512);
        blit_rgb(&mut canvas, 588, &main, 512, 512, 38, 38);
    }
    // Match legacy capture grid overlay: one line per logical pixel, alpha 20%.
    for i in 0..=128 {
        let x = 38 + i * 4;
        for y in 38..550 {
            if x < 588 {
                let p = (y * 588 + x) * 3;
                for c in 0..3 {
                    canvas[p + c] = ((canvas[p + c] as u16 * 204) / 255) as u8;
                }
            }
        }
        let y = 38 + i * 4;
        if y < 800 {
            for x in 38..550 {
                let p = (y * 588 + x) * 3;
                for c in 0..3 {
                    canvas[p + c] = ((canvas[p + c] as u16 * 204) / 255) as u8;
                }
            }
        }
    }
    if (width == 128 && height == 160) || (width == 64 && height == 32) {
        for i in 0..=64 {
            let x = 123 + ((i * 342 + 32) / 64);
            for y in 601..777 {
                if x < 588 {
                    let p = (y * 588 + x) * 3;
                    for c in 0..3 {
                        canvas[p + c] = ((canvas[p + c] as u16 * 204) / 255) as u8;
                    }
                }
            }
        }
        for i in 0..=32 {
            let y = 601 + ((i * 176 + 16) / 32);
            if y < 800 {
                for x in 123..465 {
                    let p = (y * 588 + x) * 3;
                    for c in 0..3 {
                        canvas[p + c] = ((canvas[p + c] as u16 * 204) / 255) as u8;
                    }
                }
            }
        }
    }
    if let Ok(bytes) = fs::read(workspace.join("PixelDarts.png")) {
        if let Ok(decoder) = png::Decoder::new(std::io::Cursor::new(bytes)).read_info() {
            let mut reader = decoder;
            let Some(size) = reader.output_buffer_size() else {
                return canvas;
            };
            let mut buf = vec![0; size];
            if let Ok(info) = reader.next_frame(&mut buf) {
                let overlay = &buf[..info.buffer_size()];
                if info.width == 588
                    && info.height == 800
                    && info.color_type == png::ColorType::Rgba
                {
                    blend_rgba_over_rgb(&mut canvas, overlay);
                }
            }
        }
    }
    canvas
}

fn blit_rgb(
    dst: &mut [u8],
    dst_width: usize,
    src: &[u8],
    src_width: usize,
    src_height: usize,
    x: usize,
    y: usize,
) {
    for row in 0..src_height {
        let from = row * src_width * 3;
        let to = ((y + row) * dst_width + x) * 3;
        if to + src_width * 3 <= dst.len() && from + src_width * 3 <= src.len() {
            dst[to..to + src_width * 3].copy_from_slice(&src[from..from + src_width * 3]);
        }
    }
}

fn save_rgb_png(path: &Path, rgb: &[u8], width: usize, height: usize) -> Result<(), String> {
    let file = fs::File::create(path).map_err(|error| error.to_string())?;
    let mut encoder = png::Encoder::new(file, width as u32, height as u32);
    encoder.set_color(png::ColorType::Rgb);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder.write_header().map_err(|error| error.to_string())?;
    writer
        .write_image_data(rgb)
        .map_err(|error| error.to_string())
}

fn gif_lzw(indices: &[u8]) -> Vec<u8> {
    let mut result = Vec::with_capacity(indices.len() * 2);
    let mut buffer = 0u32;
    let mut count = 0u8;
    let emit = |code: u16, result: &mut Vec<u8>, buffer: &mut u32, count: &mut u8| {
        *buffer |= u32::from(code) << *count;
        *count += 9;
        while *count >= 8 {
            result.push((*buffer & 0xff) as u8);
            *buffer >>= 8;
            *count -= 8;
        }
    };
    emit(256, &mut result, &mut buffer, &mut count);
    for index in indices {
        emit(256, &mut result, &mut buffer, &mut count);
        emit(u16::from(*index), &mut result, &mut buffer, &mut count);
    }
    emit(257, &mut result, &mut buffer, &mut count);
    if count > 0 {
        result.push(buffer as u8);
    }
    result
}

fn gif_frame_durations(frame_count: usize) -> Vec<u16> {
    let mut durations = Vec::with_capacity(frame_count);
    let mut previous_cs = 0usize;
    for index in 0..frame_count {
        let next_cs = ((index + 1) * 100 + GIF_FPS / 2) / GIF_FPS;
        durations.push((next_cs.saturating_sub(previous_cs)).clamp(1, u16::MAX as usize) as u16);
        previous_cs = next_cs;
    }
    durations
}

#[allow(clippy::too_many_arguments)]
fn gif_scaled_crop(
    source: &[u8],
    source_width: usize,
    source_height: usize,
    crop_x: usize,
    crop_y: usize,
    crop_width: usize,
    crop_height: usize,
    zoom: u32,
) -> Result<(Vec<u8>, usize, usize), String> {
    if source.len() < source_width.saturating_mul(source_height).saturating_mul(3)
        || crop_x.saturating_add(crop_width) > source_width
        || crop_y.saturating_add(crop_height) > source_height
    {
        return Err("Invalid GIF frame".to_owned());
    }
    let mut cropped = vec![0; crop_width.saturating_mul(crop_height).saturating_mul(3)];
    for y in 0..crop_height {
        let source_start = ((crop_y + y) * source_width + crop_x) * 3;
        let target_start = y * crop_width * 3;
        cropped[target_start..target_start + crop_width * 3]
            .copy_from_slice(&source[source_start..source_start + crop_width * 3]);
    }
    Ok(resize_rgb(&cropped, crop_width, crop_height, zoom))
}

#[allow(clippy::too_many_arguments)]
fn save_gif(
    path: &Path,
    frames: &[Vec<u8>],
    source_width: usize,
    source_height: usize,
    crop_x: usize,
    crop_y: usize,
    crop_width: usize,
    crop_height: usize,
    zoom: u32,
) -> Result<(), String> {
    if frames.is_empty() {
        return Err("Cannot save an empty GIF recording".to_owned());
    }
    let (_, width, height) = resize_rgb(
        &vec![0; crop_width.saturating_mul(crop_height).saturating_mul(3)],
        crop_width,
        crop_height,
        zoom,
    );
    if width > u16::MAX as usize || height > u16::MAX as usize {
        return Err("GIF dimensions exceed format limit".to_owned());
    }
    let (first, _, _) = gif_scaled_crop(
        &frames[0],
        source_width,
        source_height,
        crop_x,
        crop_y,
        crop_width,
        crop_height,
        zoom,
    )?;
    let mut palette = Vec::<[u8; 3]>::with_capacity(256);
    for pixel in first.chunks_exact(3) {
        let color = [pixel[0], pixel[1], pixel[2]];
        if !palette.contains(&color) && palette.len() < 256 {
            palette.push(color);
        }
    }
    while palette.len() < 256 {
        palette.push([0, 0, 0]);
    }
    let mut output = Vec::new();
    output.extend_from_slice(b"GIF89a");
    output.extend_from_slice(&(width as u16).to_le_bytes());
    output.extend_from_slice(&(height as u16).to_le_bytes());
    output.extend_from_slice(&[0xf7, 0, 0]);
    for color in &palette {
        output.extend_from_slice(color);
    }
    output.extend_from_slice(&[0x21, 0xff, 0x0b]);
    output.extend_from_slice(b"NETSCAPE2.0");
    output.extend_from_slice(&[0x03, 0x01, 0x00, 0x00, 0x00]);
    let durations = gif_frame_durations(frames.len());
    for (frame_index, source) in frames.iter().enumerate() {
        let (scaled, _, _) = gif_scaled_crop(
            source,
            source_width,
            source_height,
            crop_x,
            crop_y,
            crop_width,
            crop_height,
            zoom,
        )?;
        let indices: Vec<u8> = scaled
            .chunks_exact(3)
            .map(|pixel| {
                palette
                    .iter()
                    .enumerate()
                    .min_by_key(|(_, color)| {
                        let dr = i32::from(pixel[0]) - i32::from(color[0]);
                        let dg = i32::from(pixel[1]) - i32::from(color[1]);
                        let db = i32::from(pixel[2]) - i32::from(color[2]);
                        dr * dr + dg * dg + db * db
                    })
                    .map(|(index, _)| index as u8)
                    .unwrap_or(0)
            })
            .collect();
        output.extend_from_slice(&[0x21, 0xf9, 0x04, 0x00]);
        output.extend_from_slice(&durations[frame_index].to_le_bytes());
        output.extend_from_slice(&[0x00, 0x00]);
        output.push(0x2c);
        output.extend_from_slice(&(width as u16).to_le_bytes());
        output.extend_from_slice(&(height as u16).to_le_bytes());
        output.push(0);
        let encoded = gif_lzw(&indices);
        output.push(8);
        for chunk in encoded.chunks(255) {
            output.push(chunk.len() as u8);
            output.extend_from_slice(chunk);
        }
        output.push(0);
    }
    output.push(0x3b);
    fs::write(path, output).map_err(|error| error.to_string())
}

async fn run_loop(
    app: AppHandle,
    mut commands: mpsc::Receiver<Value>,
    mut core: EmulatorCore,
    mut logs: mpsc::UnboundedReceiver<WidgetLog>,
) {
    let _ = app.emit("emulator:state", core.snapshot());
    let mut interval = tokio::time::interval(Duration::from_millis(10));
    interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut heartbeat = tokio::time::interval(Duration::from_millis(500));
    heartbeat.set_missed_tick_behavior(MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            command = commands.recv() => match command {
                Some(command) => {
                    let shutdown = command.get("type").and_then(Value::as_str) == Some("shutdown");
                    core.apply(command).await;
                    let _ = app.emit("emulator:state", core.snapshot());
                    while let Some(log) = core.pending_logs.pop_front() { emit_log(&app, log); }
                    if shutdown { break; }
                }
                None => break,
            },
            Some(log) = logs.recv() => core.take_log(log),
            _ = interval.tick() => core.tick(&app).await,
            _ = heartbeat.tick() => { let _ = app.emit("emulator:state", core.snapshot()); },
        }
    }
    core.shutdown().await;
    let _ = app.emit("emulator:state", json!({"widgetPath":null,"running":false,"fps":0,"status":"Bridge stopped","audioMuted":false}));
}

struct RuntimeInner {
    command: Mutex<Option<mpsc::Sender<Value>>>,
    task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    last_path: Mutex<Option<String>>,
}

pub struct EmulatorRuntime {
    inner: Arc<RuntimeInner>,
}

impl Default for EmulatorRuntime {
    fn default() -> Self {
        Self {
            inner: Arc::new(RuntimeInner {
                command: Mutex::new(None),
                task: Mutex::new(None),
                last_path: Mutex::new(None),
            }),
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
            let _ = fs::create_dir_all(parent);
        }
        let tmp = path.with_extension("json.tmp");
        if let Ok(bytes) = serde_json::to_vec_pretty(&json!({"lastWidgetDir":value})) {
            let _ = fs::write(&tmp, bytes).and_then(|_| fs::rename(tmp, path));
        }
    }

    pub fn load_last_path(&self, app: &AppHandle) {
        let value = app
            .path()
            .app_data_dir()
            .ok()
            .map(|p| p.join("emulator-state.json"))
            .and_then(|path| fs::read_to_string(path).ok())
            .and_then(|body| serde_json::from_str::<Value>(&body).ok())
            .and_then(|body| {
                body.get("lastWidgetDir")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            });
        if let Ok(mut slot) = self.inner.last_path.lock() {
            *slot = value;
        }
    }

    pub fn set_last_path(&self, app: &AppHandle, value: String) {
        if let Ok(mut slot) = self.inner.last_path.lock() {
            *slot = Some(value.clone());
        }
        Self::persist_last_path(app, Some(&value));
    }

    fn validate_path(
        app: &AppHandle,
        allowed: Option<&Path>,
        raw: &str,
    ) -> Result<PathBuf, String> {
        let base = app
            .path()
            .resource_dir()
            .or_else(|_| std::env::current_dir().map_err(Into::into))
            .map_err(|error: tauri::Error| error.to_string())?;
        let base = fs::canonicalize(base).unwrap_or_else(|_| PathBuf::from("."));
        let allowed =
            allowed.map(|path| fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf()));
        let candidate = if Path::new(raw).is_absolute() {
            PathBuf::from(raw)
        } else if let Some(root) = allowed.as_ref() {
            root.join(raw)
        } else {
            base.join(raw)
        };
        let resolved =
            fs::canonicalize(candidate).map_err(|_| "widget path not found".to_owned())?;
        if !resolved.starts_with(&base)
            && !allowed
                .as_ref()
                .is_some_and(|root| resolved.starts_with(root))
        {
            return Err("widget path escapes allowed workspace".to_owned());
        }
        Ok(resolved)
    }

    async fn ensure_task(&self, app: &AppHandle) -> Result<mpsc::Sender<Value>, String> {
        if let Ok(slot) = self.inner.command.lock() {
            if let Some(sender) = slot.as_ref().filter(|sender| !sender.is_closed()) {
                return Ok(sender.clone());
            }
        }
        let (sender, receiver) = mpsc::channel(32);
        let (log_sender, log_receiver) = mpsc::unbounded_channel();
        let core = EmulatorCore::new(app, log_sender)?;
        let task = tauri::async_runtime::spawn(run_loop(app.clone(), receiver, core, log_receiver));
        *self
            .inner
            .command
            .lock()
            .map_err(|_| "emulator state unavailable")? = Some(sender.clone());
        *self
            .inner
            .task
            .lock()
            .map_err(|_| "emulator state unavailable")? = Some(task);
        Ok(sender)
    }

    pub async fn send(
        &self,
        app: &AppHandle,
        allowed: Option<&Path>,
        mut command: Value,
    ) -> Result<(), String> {
        if command.get("type").and_then(Value::as_str) == Some("set_path") {
            let raw = command.get("path").and_then(Value::as_str).unwrap_or("");
            let resolved = Self::validate_path(app, allowed, raw)?;
            command["path"] = Value::String(resolved.to_string_lossy().into_owned());
            if let Ok(mut slot) = self.inner.last_path.lock() {
                *slot = command
                    .get("path")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                Self::persist_last_path(app, slot.as_deref());
            }
        }
        let sender = self.ensure_task(app).await?;
        sender
            .send(command)
            .await
            .map_err(|_| "emulator task unavailable".to_owned())
    }

    pub async fn stop(&self) {
        let sender = self
            .inner
            .command
            .lock()
            .ok()
            .and_then(|mut slot| slot.take());
        if let Some(sender) = sender {
            let _ = sender.send(json!({"type":"shutdown"})).await;
        }
        if let Some(task) = self.inner.task.lock().ok().and_then(|mut slot| slot.take()) {
            let _ = timeout(Duration::from_secs(3), task).await;
        }
    }

    pub fn last_path(&self) -> Option<String> {
        self.inner
            .last_path
            .lock()
            .ok()
            .and_then(|value| value.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pdi_name_fits_darwin_limit() {
        assert!(unique_pdi_name().len() < POSIX_SHM_NAME_MAX);
    }

    #[test]
    fn pdo_abi_is_fifty_bytes() {
        assert_eq!(PDO_SIZE, 50);
    }

    #[test]
    fn distribution_name_normalizes_extras() {
        assert_eq!(normalize_distribution("pydartsnut>=1.2"), "pydartsnut");
        assert_eq!(normalize_distribution("pydartsnut-ce"), "pydartsnutce");
    }
}
