//! Safe sideload WebSocket transport used by Dartsnut devices.
//!
//! One worker owns the socket. Commands are serialized through a channel so
//! reads, request/response correlation, unsolicited logs, frames, exits, and
//! reconnects cannot race across Tauri command tasks.

use base64::Engine;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io;
use std::io::Cursor;
use std::path::Path;
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tungstenite::{connect, Error as WsError, Message, WebSocket};

use tauri::{AppHandle, Emitter};

const WS_PORT: u16 = 9251;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(10);
const RECONNECT_MAX_DELAY: Duration = Duration::from_secs(30);

/// Convert device PNG frames to renderer's shared RGB frame contract.
///
/// Device protocol intentionally transports PNG to keep websocket traffic small;
/// renderer contract is raw RGB base64 (same shape as local emulator frames).
fn normalize_frame_event(message: &Value) -> Option<Value> {
    if message.get("encoding").and_then(Value::as_str) != Some("png") {
        return None;
    }
    let encoded = message.get("frame").and_then(Value::as_str)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .ok()?;
    let decoder = png::Decoder::new(Cursor::new(bytes));
    let mut reader = decoder.read_info().ok()?;
    let output_size = reader.output_buffer_size()?;
    let mut buffer = vec![0; output_size];
    let info = reader.next_frame(&mut buffer).ok()?;
    let pixels = &buffer[..info.buffer_size()];
    let mut rgb = Vec::with_capacity(info.width as usize * info.height as usize * 3);
    match info.color_type {
        png::ColorType::Rgb => rgb.extend_from_slice(pixels),
        png::ColorType::Rgba => {
            for chunk in pixels.chunks_exact(4) {
                rgb.extend_from_slice(&chunk[..3]);
            }
        }
        png::ColorType::Grayscale => {
            for &value in pixels {
                rgb.extend_from_slice(&[value, value, value]);
            }
        }
        png::ColorType::GrayscaleAlpha => {
            for chunk in pixels.chunks_exact(2) {
                rgb.extend_from_slice(&[chunk[0], chunk[0], chunk[0]]);
            }
        }
        png::ColorType::Indexed => return None,
    }
    Some(json!({
        "active": true,
        "frame": {
            "width": info.width,
            "height": info.height,
            "rgbBase64": base64::engine::general_purpose::STANDARD.encode(rgb),
            "timestampMs": chrono::Utc::now().timestamp_millis()
        }
    }))
}

#[derive(Clone)]
pub struct SideloadClient {
    command_tx: mpsc::Sender<WorkerCommand>,
    state: Arc<Mutex<SideloadState>>,
}

#[derive(Default)]
struct SideloadState {
    capabilities: Option<SideloadCapabilities>,
    session_id: Option<String>,
    app_id: Option<String>,
    reconnect: bool,
}

#[derive(Clone, Debug, Default)]
pub struct SideloadCapabilities {
    pub protocol_version: u32,
    pub supported_sizes: Vec<String>,
    pub heartbeat_interval_seconds: u64,
    pub heartbeat_expiry_seconds: u64,
}

enum WorkerCommand {
    Request {
        payload: Value,
        response: mpsc::Sender<Result<Value, String>>,
    },
    Close,
}

impl SideloadClient {
    pub fn connect_and_probe(app: &AppHandle, host: &str) -> Result<Self, String> {
        let (command_tx, command_rx) = mpsc::channel();
        let state = Arc::new(Mutex::new(SideloadState {
            reconnect: true,
            ..Default::default()
        }));
        let thread_state = Arc::clone(&state);
        let thread_app = app.clone();
        let thread_host = host.to_owned();
        thread::Builder::new()
            .name("dartsnut-sideload".to_owned())
            .spawn(move || worker_loop(thread_app, thread_host, command_rx, thread_state))
            .map_err(|e| e.to_string())?;
        let client = Self { command_tx, state };
        let response = client.request(json!({"action":"sideload_capabilities"}))?;
        let capabilities = parse_capabilities(&response)
            .ok_or_else(|| "unsupported sideload capability response".to_owned())?;
        client
            .state
            .lock()
            .map_err(|_| "sideload state unavailable")?
            .capabilities = Some(capabilities);
        Ok(client)
    }

    pub fn capabilities(&self) -> Option<SideloadCapabilities> {
        self.state.lock().ok().and_then(|s| s.capabilities.clone())
    }

    pub fn start(
        &self,
        app: &AppHandle,
        workspace: &Path,
        app_id: &str,
        size: [u32; 2],
        params: Value,
    ) -> Result<String, String> {
        let session_id = uuid::Uuid::new_v4().to_string();
        let files = list_workspace_files(workspace)?;
        let _ = app.emit(
            "deploy:log",
            format!("Uploading {} sideload file(s)...", files.len()),
        );
        for relative in files {
            let bytes = std::fs::read(workspace.join(&relative)).map_err(|e| e.to_string())?;
            self.request(json!({
                "action":"sideload_upload",
                "session_id":session_id,
                "app_id":app_id,
                "relative_path":relative,
                "file_data":base64::engine::general_purpose::STANDARD.encode(bytes)
            }))?;
        }
        self.request(json!({
            "action":"sideload_start",
            "session_id":session_id,
            "app_id":app_id,
            "size":size,
            "params":params
        }))?;
        {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "sideload state unavailable")?;
            state.session_id = Some(session_id.clone());
            state.app_id = Some(app_id.to_owned());
        }
        self.spawn_heartbeat(app.clone(), session_id.clone());
        let _ = self.request_logs(app);
        Ok(session_id)
    }

    pub fn update_params(&self, params: Value) -> Result<(), String> {
        let session_id = self
            .state
            .lock()
            .map_err(|_| "sideload state unavailable")?
            .session_id
            .clone()
            .ok_or_else(|| "No active safe sideload session. Run widget first.".to_owned())?;
        self.request(
            json!({"action":"sideload_update_params","session_id":session_id,"params":params}),
        )?;
        Ok(())
    }

    pub fn reload(&self) -> Result<(), String> {
        let session_id = self
            .state
            .lock()
            .map_err(|_| "sideload state unavailable")?
            .session_id
            .clone()
            .ok_or_else(|| "No active safe sideload session. Run widget first.".to_owned())?;
        self.request(json!({"action":"sideload_reload","session_id":session_id}))?;
        Ok(())
    }

    pub fn request_logs(&self, app: &AppHandle) -> Result<bool, String> {
        let session_id = self
            .state
            .lock()
            .map_err(|_| "sideload state unavailable")?
            .session_id
            .clone();
        let Some(session_id) = session_id else {
            return Ok(false);
        };
        let response = self.request(json!({"action":"sideload_logs","session_id":session_id}))?;
        emit_logs_and_frames(app, &response, &session_id);
        if response.get("running").and_then(Value::as_bool) == Some(false) {
            self.finish_session(app, &session_id, "not_running", None);
            return Ok(false);
        }
        Ok(true)
    }

    pub fn stop(&self) -> Result<(), String> {
        let session_id = self
            .state
            .lock()
            .map_err(|_| "sideload state unavailable")?
            .session_id
            .clone();
        if let Some(session_id) = session_id {
            let _ = self.request(json!({"action":"sideload_stop","session_id":session_id}));
        }
        if let Ok(mut state) = self.state.lock() {
            state.session_id = None;
            state.app_id = None;
        }
        Ok(())
    }

    pub fn close(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.reconnect = false;
            state.session_id = None;
        }
        let _ = self.command_tx.send(WorkerCommand::Close);
    }

    fn request(&self, payload: Value) -> Result<Value, String> {
        let (response_tx, response_rx) = mpsc::channel();
        self.command_tx
            .send(WorkerCommand::Request {
                payload,
                response: response_tx,
            })
            .map_err(|_| "sideload worker stopped".to_owned())?;
        response_rx
            .recv_timeout(REQUEST_TIMEOUT)
            .map_err(|_| "sideload request timed out".to_owned())?
    }

    fn finish_session(
        &self,
        app: &AppHandle,
        session_id: &str,
        reason: &str,
        exit_code: Option<i64>,
    ) {
        if let Ok(mut state) = self.state.lock() {
            state.session_id = None;
        }
        let _ = app.emit("deploy:exit", json!({"sessionId":session_id,"appId":self.state.lock().ok().and_then(|s|s.app_id.clone()).unwrap_or_default(),"exitCode":exit_code,"reason":reason}));
        let _ = app.emit("deploy:frame", json!({"active": false}));
    }

    fn spawn_heartbeat(&self, app: AppHandle, session_id: String) {
        let client = self.clone();
        let interval = self
            .capabilities()
            .map(|c| c.heartbeat_interval_seconds)
            .filter(|s| *s > 0)
            .unwrap_or(HEARTBEAT_INTERVAL.as_secs());
        thread::spawn(move || loop {
            thread::sleep(Duration::from_secs(interval));
            let active = client.state.lock().ok().and_then(|s| s.session_id.clone());
            if active.as_deref() != Some(session_id.as_str()) {
                break;
            }
            if let Err(error) =
                client.request(json!({"action":"sideload_heartbeat","session_id":session_id}))
            {
                let _ = app.emit(
                    "deploy:log",
                    format!("Safe sideload heartbeat failed: {error}"),
                );
                // Heartbeat failure often means device restarted or socket briefly dropped.
                // Poll logs after reconnect so renderer resumes tail without manual action.
                let _ = client.request_logs(&app);
            }
        });
    }
}

fn worker_loop(
    app: AppHandle,
    host: String,
    rx: mpsc::Receiver<WorkerCommand>,
    state: Arc<Mutex<SideloadState>>,
) {
    let url = format!("ws://{host}:{WS_PORT}/ws");
    type Socket = WebSocket<tungstenite::stream::MaybeTlsStream<std::net::TcpStream>>;
    let mut socket: Option<Socket> = None;
    let mut request_id: u64 = 0;
    let mut pending: HashMap<u64, mpsc::Sender<Result<Value, String>>> = HashMap::new();
    let mut last_activity = Instant::now();
    let mut reconnect_attempt: u32 = 0;
    loop {
        if socket.is_none() {
            let reconnect_enabled = state.lock().map(|s| s.reconnect).unwrap_or(false);
            if !reconnect_enabled {
                fail_pending(&mut pending, "sideload worker stopped");
                return;
            }
            if reconnect_attempt > 0 {
                let delay = reconnect_delay(reconnect_attempt);
                let deadline = Instant::now() + delay;
                while Instant::now() < deadline {
                    if let Ok(WorkerCommand::Close) = rx.try_recv() {
                        if let Ok(mut guard) = state.lock() {
                            guard.reconnect = false;
                        }
                        fail_pending(&mut pending, "sideload worker stopped");
                        return;
                    }
                    thread::sleep(Duration::from_millis(50));
                }
            }
            match connect(url.as_str()) {
                Ok((mut connected, _)) => {
                    let _ = set_read_timeout(&mut connected, Duration::from_millis(250));
                    socket = Some(connected);
                    last_activity = Instant::now();
                    if reconnect_attempt > 0 {
                        let _ = app.emit("deploy:log", "Safe sideload reconnected".to_owned());
                        // Re-probe capabilities after every reconnect; protocol may have changed.
                        request_id += 1;
                        let probe = json!({"action":"sideload_capabilities","req_id":request_id});
                        let (probe_tx, _probe_rx) = mpsc::channel();
                        pending.insert(request_id, probe_tx);
                        if let Some(active) = socket.as_mut() {
                            if let Err(error) = active.send(Message::Text(probe.to_string())) {
                                let _ = app.emit(
                                    "deploy:log",
                                    format!("Safe sideload probe failed: {error}"),
                                );
                                socket = None;
                                continue;
                            }
                        }
                    }
                    reconnect_attempt = 0;
                }
                Err(error) => {
                    let _ = app.emit("deploy:log", format!("Safe sideload unavailable: {error}"));
                    reconnect_attempt = reconnect_attempt.saturating_add(1);
                    continue;
                }
            }
        }
        while let Ok(command) = rx.try_recv() {
            match command {
                WorkerCommand::Close => {
                    if let Some(active) = socket.as_mut() {
                        let _ = active.close(None);
                    }
                    fail_pending(&mut pending, "sideload worker stopped");
                    return;
                }
                WorkerCommand::Request {
                    mut payload,
                    response,
                } => {
                    request_id += 1;
                    if let Some(object) = payload.as_object_mut() {
                        object.insert("req_id".to_owned(), Value::Number(request_id.into()));
                    }
                    pending.insert(request_id, response);
                    let send_result = if let Some(active) = socket.as_mut() {
                        active
                            .send(Message::Text(payload.to_string()))
                            .map_err(|error| error.to_string())
                    } else {
                        Err("sideload socket unavailable".to_owned())
                    };
                    if let Err(error) = send_result {
                        if let Some(sender) = pending.remove(&request_id) {
                            let _ = sender.send(Err(error.to_string()));
                        }
                    }
                }
            }
        }
        let read_result = socket.as_mut().expect("socket connected").read();
        match read_result {
            Ok(Message::Text(text)) => {
                last_activity = Instant::now();
                if let Ok(message) = serde_json::from_str::<Value>(&text) {
                    handle_worker_message(&app, &state, &mut pending, message);
                }
            }
            Ok(Message::Binary(bytes)) => {
                if let Ok(text) = String::from_utf8(bytes.to_vec()) {
                    if let Ok(message) = serde_json::from_str::<Value>(&text) {
                        handle_worker_message(&app, &state, &mut pending, message);
                    }
                }
            }
            Ok(Message::Close(_)) => {
                let _ = app.emit("deploy:log", "Safe sideload connection closed".to_owned());
                fail_pending(&mut pending, "sideload connection lost");
                socket = None;
                reconnect_attempt = reconnect_attempt.saturating_add(1);
            }
            Ok(_) => {}
            Err(WsError::Io(error))
                if error.kind() == io::ErrorKind::WouldBlock
                    || error.kind() == io::ErrorKind::TimedOut =>
            {
                if last_activity.elapsed() > Duration::from_secs(120) {
                    if let Some(active) = socket.as_mut() {
                        let _ = active.close(None);
                    }
                    fail_pending(&mut pending, "sideload connection idle timeout");
                    socket = None;
                    reconnect_attempt = reconnect_attempt.saturating_add(1);
                }
            }
            Err(error) => {
                let _ = app.emit("deploy:log", format!("Safe sideload socket error: {error}"));
                fail_pending(&mut pending, "sideload connection lost");
                socket = None;
                reconnect_attempt = reconnect_attempt.saturating_add(1);
            }
        }
    }
}

fn fail_pending(pending: &mut HashMap<u64, mpsc::Sender<Result<Value, String>>>, reason: &str) {
    for (_, sender) in pending.drain() {
        let _ = sender.send(Err(reason.to_owned()));
    }
}

fn reconnect_delay(attempt: u32) -> Duration {
    let exponent = attempt.saturating_sub(1).min(5);
    let seconds = 1u64 << exponent;
    Duration::from_secs(seconds).min(RECONNECT_MAX_DELAY)
}

fn handle_worker_message(
    app: &AppHandle,
    state: &Arc<Mutex<SideloadState>>,
    pending: &mut HashMap<u64, mpsc::Sender<Result<Value, String>>>,
    message: Value,
) {
    if let Some(capabilities) = parse_capabilities(&message) {
        if let Ok(mut guard) = state.lock() {
            guard.capabilities = Some(capabilities);
        }
    }
    if let Some(req_id) = message.get("req_id").and_then(Value::as_u64) {
        if let Some(sender) = pending.remove(&req_id) {
            let result = response_error(&message).map_or(Ok(message.clone()), Err);
            let _ = sender.send(result);
        }
    }
    let action = message.get("action").and_then(Value::as_str).unwrap_or("");
    let session_id = message
        .get("session_id")
        .and_then(Value::as_str)
        .unwrap_or("");
    let active = state.lock().ok().and_then(|s| s.session_id.clone());
    if active.as_deref().is_some_and(|value| value != session_id) {
        return;
    }
    match action {
        "sideload_log" => {
            if let (Some(text), Some(_session_id)) = (
                message.get("text").and_then(Value::as_str),
                (!session_id.is_empty()).then_some(session_id),
            ) {
                let _ = app.emit("deploy:log", text.to_owned());
            }
        }
        "sideload_frame" if message.get("encoding").and_then(Value::as_str) == Some("png") => {
            if let Some(frame) = normalize_frame_event(&message) {
                let _ = app.emit("deploy:frame", frame);
            } else {
                let _ = app.emit(
                    "deploy:log",
                    "[sideload] dropped invalid PNG frame".to_owned(),
                );
            }
        }
        "sideload_exit" => {
            let _ = app.emit("deploy:exit", message);
            let _ = app.emit("deploy:frame", json!({"active": false}));
            if let Ok(mut guard) = state.lock() {
                guard.session_id = None;
            }
        }
        _ => {}
    }
}

fn emit_logs_and_frames(app: &AppHandle, response: &Value, session_id: &str) {
    if let Some(logs) = response.get("logs").and_then(Value::as_array) {
        for log in logs {
            if let Some(text) = log.get("text").and_then(Value::as_str) {
                let _ = app.emit("deploy:log", text.to_owned());
            }
        }
    }
    if let Some(frames) = response.get("frames").and_then(Value::as_array) {
        for frame in frames {
            let mut value = frame.clone();
            if let Some(obj) = value.as_object_mut() {
                obj.entry("session_id")
                    .or_insert_with(|| Value::String(session_id.to_owned()));
            }
            if let Some(frame) = normalize_frame_event(&value) {
                let _ = app.emit("deploy:frame", frame);
            }
        }
    }
}

fn response_error(message: &Value) -> Option<String> {
    message
        .get("error")
        .and_then(|value| {
            value.as_str().map(str::to_owned).or_else(|| {
                value
                    .get("message")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
        })
        .or_else(|| {
            (message.get("status").and_then(Value::as_str) == Some("error")).then(|| {
                message
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("sideload request failed")
                    .to_owned()
            })
        })
}

fn parse_capabilities(value: &Value) -> Option<SideloadCapabilities> {
    let protocol_version = value.get("protocol_version").and_then(Value::as_u64)? as u32;
    if protocol_version != 1 {
        return None;
    }
    let supported_sizes = value
        .get("supported_sizes")
        .and_then(Value::as_array)?
        .iter()
        .filter_map(|size| {
            if let Some(size) = size.as_str() {
                return Some(size.to_owned());
            }
            let values = size.as_array()?;
            if values.len() != 2 {
                return None;
            }
            Some(format!("{}x{}", values[0].as_u64()?, values[1].as_u64()?))
        })
        .collect::<Vec<_>>();
    if supported_sizes.is_empty() {
        return None;
    }
    Some(SideloadCapabilities {
        protocol_version,
        supported_sizes,
        heartbeat_interval_seconds: value
            .get("heartbeat_interval_seconds")
            .and_then(Value::as_u64)
            .unwrap_or(10),
        heartbeat_expiry_seconds: value
            .get("heartbeat_expiry_seconds")
            .and_then(Value::as_u64)
            .unwrap_or(30),
    })
}

fn set_read_timeout(
    socket: &mut WebSocket<tungstenite::stream::MaybeTlsStream<std::net::TcpStream>>,
    timeout: Duration,
) -> Result<(), String> {
    match socket.get_mut() {
        tungstenite::stream::MaybeTlsStream::Plain(stream) => stream
            .set_read_timeout(Some(timeout))
            .map_err(|e| e.to_string()),
        _ => Ok(()),
    }
}

fn list_workspace_files(root: &Path) -> Result<Vec<String>, String> {
    const EXCLUDED: &[&str] = &[
        ".git",
        ".dartsnut",
        ".DS_Store",
        ".venv",
        "venv",
        "node_modules",
        "__pycache__",
        ".pytest_cache",
        ".mypy_cache",
        ".ruff_cache",
        "dist",
        "build",
    ];
    let mut files = Vec::new();
    fn visit(
        root: &Path,
        dir: &Path,
        files: &mut Vec<String>,
        excluded: &[&str],
    ) -> Result<(), String> {
        let mut entries = std::fs::read_dir(dir)
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if excluded.iter().any(|value| *value == name) {
                continue;
            }
            let path = entry.path();
            if path.is_dir() {
                visit(root, &path, files, excluded)?;
            } else if path.is_file() {
                files.push(
                    path.strip_prefix(root)
                        .map_err(|e| e.to_string())?
                        .to_string_lossy()
                        .replace('\\', "/"),
                );
            }
        }
        Ok(())
    }
    visit(root, root, &mut files, EXCLUDED)?;
    files.sort();
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_capability_sizes_and_defaults() {
        let value = json!({"protocol_version":1,"supported_sizes":[[128,160],"240x240"]});
        let capabilities = parse_capabilities(&value).unwrap();
        assert_eq!(capabilities.supported_sizes, ["128x160", "240x240"]);
        assert_eq!(capabilities.heartbeat_interval_seconds, 10);
    }

    #[test]
    fn rejects_unknown_protocol_or_empty_sizes() {
        assert!(
            parse_capabilities(&json!({"protocol_version":2,"supported_sizes":["128x160"]}))
                .is_none()
        );
        assert!(parse_capabilities(&json!({"protocol_version":1,"supported_sizes":[]})).is_none());
    }

    #[test]
    fn reconnect_backoff_is_exponential_and_bounded() {
        assert_eq!(reconnect_delay(0), Duration::from_secs(1));
        assert_eq!(reconnect_delay(1), Duration::from_secs(1));
        assert_eq!(reconnect_delay(2), Duration::from_secs(2));
        assert_eq!(reconnect_delay(3), Duration::from_secs(4));
        assert_eq!(reconnect_delay(6), RECONNECT_MAX_DELAY);
        assert_eq!(reconnect_delay(7), RECONNECT_MAX_DELAY);
        assert_eq!(reconnect_delay(100), RECONNECT_MAX_DELAY);
    }

    #[test]
    fn normalizes_rgba_png_to_shared_rgb_contract() {
        let mut bytes = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut bytes, 1, 1);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header().unwrap();
            writer.write_image_data(&[0x11, 0x22, 0x33, 0xff]).unwrap();
        }
        let message = json!({
            "encoding": "png",
            "frame": base64::engine::general_purpose::STANDARD.encode(bytes)
        });
        let normalized = normalize_frame_event(&message).unwrap();
        assert_eq!(normalized["active"], true);
        assert_eq!(normalized["frame"]["width"], 1);
        assert_eq!(normalized["frame"]["height"], 1);
        let rgb = normalized["frame"]["rgbBase64"].as_str().unwrap();
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(rgb)
                .unwrap(),
            [0x11, 0x22, 0x33]
        );
    }
}
