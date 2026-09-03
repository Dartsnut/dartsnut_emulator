use flate2::read::GzDecoder;
use futures_util::StreamExt;
use reqwest::header::RANGE;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::ffi::OsString;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use std::{env, fs};
use tauri::{AppHandle, Emitter, Manager};
use thiserror::Error;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use tokio::sync::watch;

pub const TARGET_PYTHON_VERSION: &str = "3.14.7";
pub const TARGET_PYTHON_RELEASE: &str = "20260901";
pub const TARGET_UV_VERSION: &str = "0.12.8";
pub const PILLOW_VERSION: &str = "12.1.1";

const RUNTIME_SCHEMA_VERSION: u32 = 1;
const PROBE_TIMEOUT: Duration = Duration::from_secs(4);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(180);
const USTC_HOST: &str = "mirrors.ustc.edu.cn";
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RuntimePlatform {
    DarwinArm64,
    WinX64,
}

impl RuntimePlatform {
    fn current() -> Result<Self, String> {
        #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
        {
            return Ok(Self::DarwinArm64);
        }
        #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
        {
            return Ok(Self::WinX64);
        }
        #[allow(unreachable_code)]
        Err(format!(
            "Unsupported runtime platform: {}/{}",
            env::consts::OS,
            env::consts::ARCH
        ))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ArchiveKind {
    TarGz,
    Zip,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ArtifactTarget {
    name: &'static str,
    archive: String,
    archive_kind: ArchiveKind,
    sha256: &'static str,
    extracted_executable: PathBuf,
    official_url: String,
    ustc_url: String,
}

fn python_target(platform: RuntimePlatform) -> ArtifactTarget {
    let (archive, executable, sha256) = match platform {
        RuntimePlatform::DarwinArm64 => (
            format!("cpython-{TARGET_PYTHON_VERSION}+{TARGET_PYTHON_RELEASE}-aarch64-apple-darwin-install_only_stripped.tar.gz"),
            PathBuf::from("python/bin/python3"),
            "4632cb1a6edad9e73d3c81b6d2e69131637d995173e3e85005df14102b0592ba",
        ),
        RuntimePlatform::WinX64 => (
            format!("cpython-{TARGET_PYTHON_VERSION}+{TARGET_PYTHON_RELEASE}-x86_64-pc-windows-msvc-install_only_stripped.tar.gz"),
            PathBuf::from("python/python.exe"),
            "ca3c33ca924dfcab3b74205a7a58a88b0255135c53f95497b26b5e60700fd66d",
        ),
    };
    ArtifactTarget {
        name: "Python",
        archive: archive.clone(),
        archive_kind: ArchiveKind::TarGz,
        sha256,
        extracted_executable: executable,
        official_url: format!(
            "https://github.com/astral-sh/python-build-standalone/releases/download/{TARGET_PYTHON_RELEASE}/{archive}"
        ),
        ustc_url: format!(
            "https://mirrors.ustc.edu.cn/github-release/astral-sh/python-build-standalone/{TARGET_PYTHON_RELEASE}/{archive}"
        ),
    }
}

fn uv_target(platform: RuntimePlatform) -> ArtifactTarget {
    let (archive, kind, executable, sha256) = match platform {
        RuntimePlatform::DarwinArm64 => (
            "uv-aarch64-apple-darwin.tar.gz",
            ArchiveKind::TarGz,
            "uv-aarch64-apple-darwin/uv",
            "8ce083658dbff20143607ca7af8e0c1d64b6fd7bf03a5cdcb62bf3d47d991b5f",
        ),
        RuntimePlatform::WinX64 => (
            "uv-x86_64-pc-windows-msvc.zip",
            ArchiveKind::Zip,
            "uv.exe",
            "e07acf3f8a29fe41f9e04b799c3325cb0e0893836bb222bf102829b45c679ad6",
        ),
    };
    ArtifactTarget {
        name: "uv",
        archive: archive.to_owned(),
        archive_kind: kind,
        sha256,
        extracted_executable: PathBuf::from(executable),
        official_url: format!(
            "https://github.com/astral-sh/uv/releases/download/{TARGET_UV_VERSION}/{archive}"
        ),
        ustc_url: format!(
            "https://mirrors.ustc.edu.cn/github-release/astral-sh/uv/{TARGET_UV_VERSION}/{archive}"
        ),
    }
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeProgress {
    pub running: bool,
    pub stage: Option<RuntimeStage>,
    pub percent: u8,
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artifact: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RuntimeStage {
    Check,
    Probe,
    Download,
    Verify,
    Extract,
    Install,
    Validate,
    Complete,
    Error,
}

#[derive(Clone, Debug)]
pub struct ManagedRuntimePaths {
    pub python: PathBuf,
    pub uv: PathBuf,
    pub environment_dir: PathBuf,
}

#[derive(Default)]
struct RuntimeManagerInner {
    running: AtomicBool,
    progress: Mutex<RuntimeProgress>,
    ready: Mutex<Option<ManagedRuntimePaths>>,
}

#[derive(Clone, Default)]
pub struct RuntimeManager {
    inner: Arc<RuntimeManagerInner>,
}

impl RuntimeManager {
    pub fn progress(&self) -> RuntimeProgress {
        self.inner
            .progress
            .lock()
            .map(|value| value.clone())
            .unwrap_or_default()
    }

    pub fn status(&self) -> Option<String> {
        None
    }

    pub fn require_ready(&self) -> Result<ManagedRuntimePaths, String> {
        self.inner
            .ready
            .lock()
            .map_err(|_| "Managed runtime state is unavailable".to_owned())?
            .clone()
            .ok_or_else(|| {
                self.progress()
                    .error
                    .unwrap_or_else(|| "Managed Python runtime is still being prepared".to_owned())
            })
    }

    pub fn start(&self, app: AppHandle) -> bool {
        if self
            .inner
            .running
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return false;
        }
        if let Ok(mut ready) = self.inner.ready.lock() {
            *ready = None;
        }
        self.publish(
            &app,
            RuntimeProgress {
                running: true,
                stage: Some(RuntimeStage::Check),
                percent: 0,
                message: Some("Checking runtime…".to_owned()),
                artifact: Some("runtime".to_owned()),
                ..RuntimeProgress::default()
            },
        );
        let manager = self.clone();
        tauri::async_runtime::spawn(async move {
            match ensure_managed_runtime(&app, &manager).await {
                Ok(paths) => {
                    if let Ok(mut ready) = manager.inner.ready.lock() {
                        *ready = Some(paths);
                    }
                    manager.publish(
                        &app,
                        RuntimeProgress {
                            running: false,
                            stage: Some(RuntimeStage::Complete),
                            percent: 100,
                            message: Some("Runtime ready".to_owned()),
                            error: None,
                            artifact: Some("runtime".to_owned()),
                        },
                    );
                    let _ = app.emit("agent:python-runtime-status", Option::<String>::None);
                }
                Err(error) => {
                    let previous = manager.progress();
                    manager.publish(
                        &app,
                        RuntimeProgress {
                            running: false,
                            stage: Some(RuntimeStage::Error),
                            message: Some(
                                "Runtime setup failed. Check your network and retry.".to_owned(),
                            ),
                            error: Some(error),
                            percent: previous.percent,
                            artifact: previous.artifact,
                        },
                    );
                    let _ = app.emit("agent:python-runtime-status", Option::<String>::None);
                }
            }
            manager.inner.running.store(false, Ordering::SeqCst);
        });
        true
    }

    fn update(
        &self,
        app: &AppHandle,
        stage: RuntimeStage,
        percent: u8,
        message: impl Into<String>,
        artifact: Option<&str>,
        _source: Option<&str>,
    ) {
        self.publish(
            app,
            RuntimeProgress {
                running: true,
                stage: Some(stage),
                percent,
                message: Some(message.into()),
                artifact: artifact.map(str::to_owned),
                ..RuntimeProgress::default()
            },
        );
    }

    fn publish(&self, app: &AppHandle, progress: RuntimeProgress) {
        if let Ok(mut current) = self.inner.progress.lock() {
            *current = progress.clone();
        }
        let _ = app.emit("agent:python-runtime-progress", progress);
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum DownloadSource {
    Official,
    Ustc,
    Cache,
}

#[derive(Clone, Debug)]
struct ProbeResult {
    source: DownloadSource,
    url: String,
    latency_ms: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeMetadata {
    schema_version: u32,
    python_version: String,
    python_release: String,
    uv_version: String,
    platform: RuntimePlatform,
    installed_at: String,
    python_source: DownloadSource,
    uv_source: DownloadSource,
    python_probe_ms: Option<u64>,
    uv_probe_ms: Option<u64>,
}

#[derive(Clone, Debug)]
struct DownloadResult {
    source: DownloadSource,
    probe_ms: Option<u64>,
}

struct RuntimeLayout {
    root: PathBuf,
    cache: PathBuf,
    staging: PathBuf,
    python_root: PathBuf,
    python_base: PathBuf,
    environment_dir: PathBuf,
    python: PathBuf,
    uv_root: PathBuf,
    uv: PathBuf,
    metadata: PathBuf,
}

impl RuntimeLayout {
    fn new(root: PathBuf, platform: RuntimePlatform) -> Self {
        let python_root = root.join(format!("python-{TARGET_PYTHON_VERSION}"));
        let python_base = python_root.join("base");
        let environment_dir = python_root.join("env");
        let (python, uv_name) = match platform {
            RuntimePlatform::DarwinArm64 => (environment_dir.join("bin/python"), "uv"),
            RuntimePlatform::WinX64 => (environment_dir.join("Scripts/python.exe"), "uv.exe"),
        };
        let uv_root = root.join(format!("uv-{TARGET_UV_VERSION}"));
        Self {
            cache: root.join("cache"),
            staging: root.join("staging"),
            uv: uv_root.join(uv_name),
            uv_root,
            metadata: root.join("runtime.json"),
            root,
            python_root,
            python_base,
            environment_dir,
            python,
        }
    }

    fn paths(&self) -> ManagedRuntimePaths {
        ManagedRuntimePaths {
            python: self.python.clone(),
            uv: self.uv.clone(),
            environment_dir: self.environment_dir.clone(),
        }
    }
}

async fn ensure_managed_runtime(
    app: &AppHandle,
    manager: &RuntimeManager,
) -> Result<ManagedRuntimePaths, String> {
    let platform = RuntimePlatform::current()?;
    let root = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve application data directory: {error}"))?
        .join("runtime");
    let layout = RuntimeLayout::new(root, platform);

    fs::create_dir_all(&layout.root).map_err(|error| error.to_string())?;
    if let Some(metadata) = read_metadata(&layout.metadata) {
        if metadata_matches(&metadata, platform, &layout) {
            let paths = layout.paths();
            manager.update(
                app,
                RuntimeStage::Validate,
                90,
                "Validating cached managed runtime…",
                None,
                None,
            );
            if validate_bootstrap_runtime(&paths).await.is_ok() {
                return Ok(paths);
            }
        }
    }

    remove_if_exists(&layout.metadata)?;
    remove_if_exists(&layout.python_root)?;
    remove_if_exists(&layout.uv_root)?;
    remove_if_exists(&layout.staging)?;
    fs::create_dir_all(&layout.cache).map_err(|error| error.to_string())?;
    fs::create_dir_all(&layout.staging).map_err(|error| error.to_string())?;

    let client = reqwest::Client::builder()
        .user_agent(format!("Dartsnut-Agent/{}", env!("CARGO_PKG_VERSION")))
        .redirect(reqwest::redirect::Policy::limited(5))
        .timeout(DOWNLOAD_TIMEOUT)
        .build()
        .map_err(|error| error.to_string())?;

    let python_artifact = python_target(platform);
    let uv_artifact = uv_target(platform);
    let python_archive = layout
        .cache
        .join(format!(
            "python-{TARGET_PYTHON_VERSION}-{TARGET_PYTHON_RELEASE}"
        ))
        .join(&python_artifact.archive);
    let uv_archive = layout
        .cache
        .join(format!("uv-{TARGET_UV_VERSION}"))
        .join(&uv_artifact.archive);
    let python_download = ensure_archive(
        app,
        manager,
        &client,
        &python_artifact,
        &python_archive,
        4,
        31,
    )
    .await?;
    let uv_download =
        ensure_archive(app, manager, &client, &uv_artifact, &uv_archive, 32, 49).await?;

    manager.update(
        app,
        RuntimeStage::Extract,
        52,
        "Extracting managed Python…",
        Some("Python"),
        None,
    );
    let python_stage = layout.staging.join("python");
    extract_archive(&python_archive, &python_stage, python_artifact.archive_kind)?;
    let extracted_python = python_stage.join(&python_artifact.extracted_executable);
    if !extracted_python.is_file() {
        return Err(format!(
            "Python archive did not contain {}",
            python_artifact.extracted_executable.display()
        ));
    }
    let extracted_python_root = python_stage.join("python");
    fs::create_dir_all(&layout.python_root).map_err(|error| error.to_string())?;
    fs::rename(&extracted_python_root, &layout.python_base).map_err(|error| error.to_string())?;

    manager.update(
        app,
        RuntimeStage::Extract,
        60,
        "Extracting managed uv…",
        Some("uv"),
        None,
    );
    let uv_stage = layout.staging.join("uv");
    extract_archive(&uv_archive, &uv_stage, uv_artifact.archive_kind)?;
    let extracted_uv = uv_stage.join(&uv_artifact.extracted_executable);
    if !extracted_uv.is_file() {
        return Err(format!(
            "uv archive did not contain {}",
            uv_artifact.extracted_executable.display()
        ));
    }
    fs::create_dir_all(&layout.uv_root).map_err(|error| error.to_string())?;
    fs::copy(&extracted_uv, &layout.uv).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&layout.uv, fs::Permissions::from_mode(0o755))
            .map_err(|error| error.to_string())?;
    }

    let base_relative = python_artifact
        .extracted_executable
        .strip_prefix("python")
        .unwrap_or(&python_artifact.extracted_executable);
    let base_python = layout.python_base.join(base_relative);
    manager.update(
        app,
        RuntimeStage::Install,
        66,
        "Creating managed Python environment…",
        Some("Python"),
        None,
    );
    let bootstrap_paths = ManagedRuntimePaths {
        python: base_python.clone(),
        uv: layout.uv.clone(),
        environment_dir: layout.python_base.clone(),
    };
    let mut bootstrap_environment = managed_environment(&bootstrap_paths);
    bootstrap_environment.retain(|(key, _)| key != "VIRTUAL_ENV");
    run_checked(
        &layout.uv,
        &[
            OsString::from("venv"),
            OsString::from("--python"),
            base_python.as_os_str().to_owned(),
            layout.environment_dir.as_os_str().to_owned(),
        ],
        Some(bootstrap_environment),
    )
    .await?;
    if !layout.python.is_file() {
        return Err(format!(
            "Managed Python was not created at {}",
            layout.python.display()
        ));
    }

    let paths = layout.paths();
    manager.update(
        app,
        RuntimeStage::Validate,
        92,
        "Validating Python and uv bootstrap…",
        Some("runtime"),
        None,
    );
    validate_bootstrap_runtime(&paths).await?;

    let metadata = RuntimeMetadata {
        schema_version: RUNTIME_SCHEMA_VERSION,
        python_version: TARGET_PYTHON_VERSION.to_owned(),
        python_release: TARGET_PYTHON_RELEASE.to_owned(),
        uv_version: TARGET_UV_VERSION.to_owned(),
        platform,
        installed_at: chrono::Utc::now().to_rfc3339(),
        python_source: python_download.source,
        uv_source: uv_download.source,
        python_probe_ms: python_download.probe_ms,
        uv_probe_ms: uv_download.probe_ms,
    };
    write_metadata(&layout.metadata, &metadata)?;
    remove_if_exists(&layout.staging)?;
    prune_old_versions(&layout.root)?;
    Ok(paths)
}

fn read_metadata(path: &Path) -> Option<RuntimeMetadata> {
    fs::read_to_string(path)
        .ok()
        .and_then(|body| serde_json::from_str(&body).ok())
}

fn metadata_matches(
    metadata: &RuntimeMetadata,
    platform: RuntimePlatform,
    layout: &RuntimeLayout,
) -> bool {
    metadata.schema_version == RUNTIME_SCHEMA_VERSION
        && metadata.python_version == TARGET_PYTHON_VERSION
        && metadata.python_release == TARGET_PYTHON_RELEASE
        && metadata.uv_version == TARGET_UV_VERSION
        && metadata.platform == platform
        && layout.python.is_file()
        && layout.uv.is_file()
}

fn write_metadata(path: &Path, metadata: &RuntimeMetadata) -> Result<(), String> {
    let body = serde_json::to_vec_pretty(metadata).map_err(|error| error.to_string())?;
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, body).map_err(|error| error.to_string())?;
    fs::rename(&temporary, path).map_err(|error| error.to_string())
}

async fn ensure_archive(
    app: &AppHandle,
    manager: &RuntimeManager,
    client: &reqwest::Client,
    target: &ArtifactTarget,
    destination: &Path,
    start_percent: u8,
    end_percent: u8,
) -> Result<DownloadResult, String> {
    if destination.is_file() && verify_sha256(destination, target.sha256).unwrap_or(false) {
        manager.update(
            app,
            RuntimeStage::Verify,
            end_percent,
            format!("Using verified cached {} archive", target.name),
            Some(target.name),
            None,
        );
        return Ok(DownloadResult {
            source: DownloadSource::Cache,
            probe_ms: None,
        });
    }
    if destination.exists() {
        fs::remove_file(destination).map_err(|error| error.to_string())?;
    }

    manager.update(
        app,
        RuntimeStage::Probe,
        start_percent,
        format!("Checking {} download availability…", target.name),
        Some(target.name),
        None,
    );
    let (official, ustc) = tokio::join!(
        probe_source(client, DownloadSource::Official, &target.official_url),
        probe_source(client, DownloadSource::Ustc, &target.ustc_url)
    );
    let candidates = ordered_candidates(official, ustc);
    if candidates.is_empty() {
        return Err(format!("No {} download source is reachable", target.name));
    }

    for candidate in candidates {
        manager.update(
            app,
            RuntimeStage::Download,
            start_percent,
            format!("Downloading {}…", target.name),
            Some(target.name),
            None,
        );
        match download_archive(
            app,
            manager,
            client,
            target,
            destination,
            &candidate,
            start_percent,
            end_percent,
        )
        .await
        {
            Ok(()) => {
                return Ok(DownloadResult {
                    source: candidate.source,
                    probe_ms: Some(candidate.latency_ms),
                })
            }
            Err(_) => continue,
        }
    }
    Err(format!(
        "Failed to download verified {} archive from available sources",
        target.name
    ))
}

fn ordered_candidates(
    official: Option<ProbeResult>,
    ustc: Option<ProbeResult>,
) -> Vec<ProbeResult> {
    let mut candidates = [official, ustc].into_iter().flatten().collect::<Vec<_>>();
    candidates.sort_by_key(|candidate| candidate.latency_ms);
    candidates
}

fn probe_response_is_valid(
    source: DownloadSource,
    status: reqwest::StatusCode,
    final_host: Option<&str>,
) -> bool {
    matches!(status.as_u16(), 200 | 206)
        && (source != DownloadSource::Ustc || final_host == Some(USTC_HOST))
}

async fn probe_source(
    client: &reqwest::Client,
    source: DownloadSource,
    url: &str,
) -> Option<ProbeResult> {
    let started = Instant::now();
    let response = tokio::time::timeout(
        PROBE_TIMEOUT,
        client.get(url).header(RANGE, "bytes=0-0").send(),
    )
    .await
    .ok()?
    .ok()?;
    if !probe_response_is_valid(source, response.status(), response.url().host_str()) {
        return None;
    }
    let mut stream = response.bytes_stream();
    let remaining = PROBE_TIMEOUT.checked_sub(started.elapsed())?;
    let first = tokio::time::timeout(remaining, stream.next())
        .await
        .ok()??
        .ok()?;
    if first.is_empty() {
        return None;
    }
    Some(ProbeResult {
        source,
        url: url.to_owned(),
        latency_ms: started.elapsed().as_millis().min(u64::MAX as u128) as u64,
    })
}

#[allow(clippy::too_many_arguments)]
async fn download_archive(
    app: &AppHandle,
    manager: &RuntimeManager,
    client: &reqwest::Client,
    target: &ArtifactTarget,
    destination: &Path,
    candidate: &ProbeResult,
    start_percent: u8,
    end_percent: u8,
) -> Result<(), String> {
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let temporary = destination.with_extension(format!("part-{}", uuid::Uuid::new_v4()));
    let result = async {
        let response = client
            .get(&candidate.url)
            .send()
            .await
            .map_err(|error| error.to_string())?;
        if !response.status().is_success() {
            return Err(format!("HTTP {}", response.status()));
        }
        if candidate.source == DownloadSource::Ustc && response.url().host_str() != Some(USTC_HOST)
        {
            return Err(
                "USTC redirected to official source because mirrored asset is absent".to_owned(),
            );
        }
        let total = response.content_length();
        let mut downloaded = 0_u64;
        let mut stream = response.bytes_stream();
        let mut file = tokio::fs::File::create(&temporary)
            .await
            .map_err(|error| error.to_string())?;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| error.to_string())?;
            file.write_all(&chunk)
                .await
                .map_err(|error| error.to_string())?;
            downloaded += chunk.len() as u64;
            if let Some(total) = total.filter(|value| *value > 0) {
                let fraction = (downloaded as f64 / total as f64).clamp(0.0, 1.0);
                let percent =
                    start_percent + ((end_percent - start_percent) as f64 * fraction).round() as u8;
                manager.update(
                    app,
                    RuntimeStage::Download,
                    percent,
                    format!(
                        "Downloading {}… {}%",
                        target.name,
                        (fraction * 100.0).round() as u8
                    ),
                    Some(target.name),
                    None,
                );
            }
        }
        file.sync_all().await.map_err(|error| error.to_string())?;
        if downloaded == 0 {
            return Err("download was empty".to_owned());
        }
        manager.update(
            app,
            RuntimeStage::Verify,
            end_percent,
            format!("Verifying {} download…", target.name),
            Some(target.name),
            None,
        );
        if !verify_sha256(&temporary, target.sha256).map_err(|error| error.to_string())? {
            return Err("SHA-256 mismatch".to_owned());
        }
        tokio::fs::rename(&temporary, destination)
            .await
            .map_err(|error| error.to_string())?;
        Ok(())
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&temporary).await;
    }
    result
}

fn extract_archive(path: &Path, destination: &Path, kind: ArchiveKind) -> Result<(), String> {
    remove_if_exists(destination)?;
    fs::create_dir_all(destination).map_err(|error| error.to_string())?;
    match kind {
        ArchiveKind::TarGz => {
            let file = fs::File::open(path).map_err(|error| error.to_string())?;
            let mut archive = tar::Archive::new(GzDecoder::new(file));
            let entries = archive.entries().map_err(|error| error.to_string())?;
            for entry in entries {
                let mut entry = entry.map_err(|error| error.to_string())?;
                if !entry
                    .unpack_in(destination)
                    .map_err(|error| error.to_string())?
                {
                    return Err("Archive contains an unsafe path".to_owned());
                }
            }
        }
        ArchiveKind::Zip => {
            let file = fs::File::open(path).map_err(|error| error.to_string())?;
            let mut archive = zip::ZipArchive::new(file).map_err(|error| error.to_string())?;
            for index in 0..archive.len() {
                let mut entry = archive.by_index(index).map_err(|error| error.to_string())?;
                let relative = entry
                    .enclosed_name()
                    .ok_or_else(|| "Archive contains an unsafe path".to_owned())?;
                let output = destination.join(relative);
                if entry.is_dir() {
                    fs::create_dir_all(&output).map_err(|error| error.to_string())?;
                    continue;
                }
                if let Some(parent) = output.parent() {
                    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
                }
                let mut target = fs::File::create(&output).map_err(|error| error.to_string())?;
                io::copy(&mut entry, &mut target).map_err(|error| error.to_string())?;
            }
        }
    }
    Ok(())
}

async fn validate_bootstrap_runtime(paths: &ManagedRuntimePaths) -> Result<(), String> {
    let uv_output = run_checked(
        &paths.uv,
        &[OsString::from("--version")],
        Some(managed_environment(paths)),
    )
    .await?;
    if uv_output.stdout.split_whitespace().nth(1) != Some(TARGET_UV_VERSION) {
        return Err(format!(
            "Managed uv version mismatch: {}",
            uv_output.stdout.trim()
        ));
    }
    let output = run_checked(
        &paths.uv,
        &[
            OsString::from("run"),
            OsString::from("--no-project"),
            OsString::from("--python"),
            paths.python.as_os_str().to_owned(),
            OsString::from("python"),
            OsString::from("-c"),
            OsString::from("import sys; print(sys.version.split()[0])"),
        ],
        Some(managed_environment(paths)),
    )
    .await?;
    if output.stdout.lines().last().map(str::trim) != Some(TARGET_PYTHON_VERSION) {
        return Err(format!(
            "Managed Python version mismatch: {}",
            output.stdout.trim()
        ));
    }
    Ok(())
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProcessOutput {
    pub status: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

async fn run_checked(
    program: &Path,
    args: &[OsString],
    environment: Option<Vec<(String, String)>>,
) -> Result<ProcessOutput, String> {
    let mut command = Command::new(program);
    command.args(args).stdin(Stdio::null());
    if let Some(environment) = environment {
        command.env_clear().envs(environment);
    }
    let output = command.output().await.map_err(|error| {
        format!(
            "Could not run managed command {}: {error}",
            program.display()
        )
    })?;
    let result = ProcessOutput {
        status: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    };
    if !output.status.success() {
        let detail = result.stderr.trim();
        return Err(if detail.is_empty() {
            format!("Managed command {} failed", program.display())
        } else {
            format!("Managed command {} failed: {detail}", program.display())
        });
    }
    Ok(result)
}

pub fn managed_environment(paths: &ManagedRuntimePaths) -> Vec<(String, String)> {
    let mut values = sanitized_environment();
    values.retain(|(key, _)| key != "PATH");
    let existing_path = env::var_os("PATH").unwrap_or_default();
    let mut path_entries = vec![
        paths
            .python
            .parent()
            .unwrap_or(&paths.environment_dir)
            .to_path_buf(),
        paths.uv.parent().unwrap_or(Path::new("")).to_path_buf(),
    ];
    path_entries.extend(env::split_paths(&existing_path));
    let joined = env::join_paths(path_entries)
        .unwrap_or(existing_path)
        .to_string_lossy()
        .into_owned();
    values.extend([
        ("PATH".to_owned(), joined),
        (
            "DARTSNUT_UV_BIN".to_owned(),
            paths.uv.to_string_lossy().into_owned(),
        ),
        (
            "UV_PYTHON".to_owned(),
            paths.python.to_string_lossy().into_owned(),
        ),
        (
            "VIRTUAL_ENV".to_owned(),
            paths.environment_dir.to_string_lossy().into_owned(),
        ),
        ("UV_NO_MANAGED_PYTHON".to_owned(), "1".to_owned()),
        ("UV_NO_PYTHON_DOWNLOADS".to_owned(), "never".to_owned()),
        ("PYTHONNOUSERSITE".to_owned(), "1".to_owned()),
        ("PYTHONDONTWRITEBYTECODE".to_owned(), "1".to_owned()),
        ("PYTHONUNBUFFERED".to_owned(), "1".to_owned()),
    ]);
    values
}

/// Install image tooling only when an asset workflow needs it.
///
/// Runtime startup deliberately validates only the Python/uv bootstrap. The
/// asset preprocessor imports Pillow, so its caller must invoke this helper
/// immediately before launching that tool. Successful installation is
/// idempotent: an already importable Pillow is left untouched.
pub async fn ensure_pillow(paths: &ManagedRuntimePaths) -> Result<PathBuf, String> {
    let runtime_root = paths
        .python
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .and_then(Path::parent)
        .ok_or_else(|| "managed runtime layout unavailable".to_owned())?;
    let tool_dir = runtime_root.join("asset-tools");
    let tool_python = if cfg!(windows) {
        tool_dir.join("Scripts/python.exe")
    } else {
        tool_dir.join("bin/python")
    };
    let manifest = tool_dir.join("requirements.txt");
    if !manifest.is_file() {
        fs::create_dir_all(&tool_dir).map_err(|error| error.to_string())?;
        fs::write(&manifest, format!("Pillow=={PILLOW_VERSION}\n"))
            .map_err(|error| error.to_string())?;
    }
    let environment = managed_environment(paths);
    if !tool_python.is_file() {
        run_checked(
            &paths.uv,
            &[
                OsString::from("venv"),
                OsString::from("--python"),
                paths.python.as_os_str().to_owned(),
                tool_dir.as_os_str().to_owned(),
            ],
            Some(environment.clone()),
        )
        .await?;
    }
    if run_checked(
        &paths.uv,
        &[
            OsString::from("run"),
            OsString::from("--no-project"),
            OsString::from("--python"),
            tool_python.as_os_str().to_owned(),
            OsString::from("python"),
            OsString::from("-c"),
            OsString::from("import PIL"),
        ],
        Some(environment.clone()),
    )
    .await
    .is_ok()
    {
        return Ok(tool_python);
    }

    run_checked(
        &paths.uv,
        &[
            OsString::from("pip"),
            OsString::from("install"),
            OsString::from("--requirement"),
            manifest.as_os_str().to_owned(),
            OsString::from("--python"),
            tool_python.as_os_str().to_owned(),
        ],
        Some(environment.clone()),
    )
    .await
    .map_err(|error| format!("Could not install Pillow: {error}"))?;

    run_checked(
        &paths.uv,
        &[
            OsString::from("run"),
            OsString::from("--no-project"),
            OsString::from("--python"),
            tool_python.as_os_str().to_owned(),
            OsString::from("python"),
            OsString::from("-c"),
            OsString::from("import PIL"),
        ],
        Some(environment),
    )
    .await
    .map(|_| tool_python)
    .map_err(|error| format!("Pillow installation did not make PIL importable: {error}"))
}

fn remove_if_exists(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    if path.is_dir() {
        fs::remove_dir_all(path).map_err(|error| error.to_string())
    } else {
        fs::remove_file(path).map_err(|error| error.to_string())
    }
}

fn prune_old_versions(root: &Path) -> Result<(), String> {
    let python_current = format!("python-{TARGET_PYTHON_VERSION}");
    let uv_current = format!("uv-{TARGET_UV_VERSION}");
    let entries = fs::read_dir(root).map_err(|error| error.to_string())?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if (name.starts_with("python-") && name != python_current)
            || (name.starts_with("uv-") && name != uv_current)
        {
            let _ = remove_if_exists(&entry.path());
        }
    }
    Ok(())
}

fn sha256_file(path: &Path) -> Result<String, io::Error> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let bytes_read = file.read(&mut buffer)?;
        if bytes_read == 0 {
            break;
        }
        hasher.update(&buffer[..bytes_read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

pub fn verify_sha256(path: impl AsRef<Path>, expected_hex: &str) -> Result<bool, io::Error> {
    Ok(sha256_file(path.as_ref())?.eq_ignore_ascii_case(expected_hex.trim()))
}

/// Keep secrets and host Python settings out of managed child processes.
pub fn sanitized_environment() -> Vec<(String, String)> {
    let variables = env::vars_os().map(|(key, value)| {
        (
            key.to_string_lossy().into_owned(),
            value.to_string_lossy().into_owned(),
        )
    });
    sanitize_environment(variables)
}

fn sanitize_environment<I>(variables: I) -> Vec<(String, String)>
where
    I: IntoIterator<Item = (String, String)>,
{
    variables
        .into_iter()
        .filter(|(key, _)| !is_sensitive_environment_key(key))
        .collect()
}

fn is_sensitive_environment_key(key: &str) -> bool {
    let upper = key.to_ascii_uppercase();
    upper.contains("KEY")
        || upper.contains("TOKEN")
        || upper.contains("SECRET")
        || upper.contains("PASSWORD")
        || upper.contains("COOKIE")
        || matches!(
            upper.as_str(),
            "PYTHONHOME"
                | "PYTHONPATH"
                | "PYTHONUSERBASE"
                | "DARTSNUT_PYTHON"
                | "DARTSNUT_UV_BIN"
                | "UV_PYTHON"
                | "UV_NO_PROJECT"
                | "UV_NO_SYNC"
                | "UV_PROJECT_ENVIRONMENT"
                | "VIRTUAL_ENV"
        )
}

#[derive(Debug, Error)]
pub enum ProcessError {
    #[error("process I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("process cancelled")]
    Cancelled,
}

pub async fn run_command(
    program: &str,
    args: &[&str],
    mut cancel: watch::Receiver<bool>,
) -> Result<ProcessOutput, ProcessError> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    let stdout_task = tokio::spawn(async move {
        let mut bytes = Vec::new();
        if let Some(stream) = stdout.as_mut() {
            stream.read_to_end(&mut bytes).await?;
        }
        Ok::<_, std::io::Error>(bytes)
    });
    let stderr_task = tokio::spawn(async move {
        let mut bytes = Vec::new();
        if let Some(stream) = stderr.as_mut() {
            stream.read_to_end(&mut bytes).await?;
        }
        Ok::<_, std::io::Error>(bytes)
    });
    tokio::select! {
        _ = cancel.changed() => {
            let _ = child.kill().await;
            stdout_task.abort();
            stderr_task.abort();
            Err(ProcessError::Cancelled)
        }
        status = child.wait() => {
            let status = status?;
            let stdout = stdout_task.await.map_err(|error| std::io::Error::other(error.to_string()))??;
            let stderr = stderr_task.await.map_err(|error| std::io::Error::other(error.to_string()))??;
            Ok(ProcessOutput {
                status: status.code(),
                stdout: String::from_utf8_lossy(&stdout).into_owned(),
                stderr: String::from_utf8_lossy(&stderr).into_owned(),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn target_manifest_pins_supported_archives_and_hashes() {
        let mac_python = python_target(RuntimePlatform::DarwinArm64);
        assert_eq!(
            mac_python.archive,
            "cpython-3.14.7+20260901-aarch64-apple-darwin-install_only_stripped.tar.gz"
        );
        assert!(mac_python.ustc_url.contains("/20260901/"));
        assert_eq!(
            mac_python.sha256,
            "4632cb1a6edad9e73d3c81b6d2e69131637d995173e3e85005df14102b0592ba"
        );
        let windows_python = python_target(RuntimePlatform::WinX64);
        assert_eq!(
            windows_python.archive,
            "cpython-3.14.7+20260901-x86_64-pc-windows-msvc-install_only_stripped.tar.gz"
        );
        assert_eq!(
            windows_python.sha256,
            "ca3c33ca924dfcab3b74205a7a58a88b0255135c53f95497b26b5e60700fd66d"
        );
        let mac_uv = uv_target(RuntimePlatform::DarwinArm64);
        assert_eq!(mac_uv.archive, "uv-aarch64-apple-darwin.tar.gz");
        assert!(mac_uv.ustc_url.contains("/0.12.8/"));
        assert_eq!(
            mac_uv.sha256,
            "8ce083658dbff20143607ca7af8e0c1d64b6fd7bf03a5cdcb62bf3d47d991b5f"
        );
        let windows_uv = uv_target(RuntimePlatform::WinX64);
        assert_eq!(windows_uv.archive, "uv-x86_64-pc-windows-msvc.zip");
        assert_eq!(
            windows_uv.sha256,
            "e07acf3f8a29fe41f9e04b799c3325cb0e0893836bb222bf102829b45c679ad6"
        );
        for target in [mac_python, windows_python, mac_uv, windows_uv] {
            assert!(!target.official_url.contains("LatestRelease"));
            assert!(!target.ustc_url.contains("LatestRelease"));
        }
    }

    #[test]
    fn source_order_uses_fastest_successful_probe() {
        let official = ProbeResult {
            source: DownloadSource::Official,
            url: "https://official.test/archive".to_owned(),
            latency_ms: 200,
        };
        let ustc = ProbeResult {
            source: DownloadSource::Ustc,
            url: "https://ustc.test/archive".to_owned(),
            latency_ms: 50,
        };
        let ordered = ordered_candidates(Some(official.clone()), Some(ustc.clone()));
        assert_eq!(ordered[0].source, DownloadSource::Ustc);
        assert_eq!(ordered[1].source, DownloadSource::Official);

        let ordered = ordered_candidates(
            Some(ProbeResult {
                latency_ms: 10,
                ..official
            }),
            Some(ustc),
        );
        assert_eq!(ordered[0].source, DownloadSource::Official);
        assert_eq!(ordered_candidates(None, None).len(), 0);
    }

    #[test]
    fn probes_accept_expected_statuses_and_reject_ustc_redirects() {
        assert!(probe_response_is_valid(
            DownloadSource::Official,
            reqwest::StatusCode::OK,
            Some("objects.githubusercontent.com")
        ));
        assert!(probe_response_is_valid(
            DownloadSource::Ustc,
            reqwest::StatusCode::PARTIAL_CONTENT,
            Some(USTC_HOST)
        ));
        assert!(!probe_response_is_valid(
            DownloadSource::Ustc,
            reqwest::StatusCode::OK,
            Some("github.com")
        ));
        assert!(!probe_response_is_valid(
            DownloadSource::Official,
            reqwest::StatusCode::NOT_FOUND,
            Some("github.com")
        ));
    }

    #[test]
    fn progress_payload_does_not_expose_runtime_versions_or_source() {
        let payload = serde_json::to_value(RuntimeProgress {
            running: false,
            stage: Some(RuntimeStage::Complete),
            percent: 100,
            message: Some("Runtime ready".to_owned()),
            artifact: Some("runtime".to_owned()),
            ..RuntimeProgress::default()
        })
        .unwrap();
        assert!(payload.get("pythonVersion").is_none());
        assert!(payload.get("uvVersion").is_none());
        assert!(payload.get("source").is_none());
    }

    #[test]
    fn metadata_requires_exact_targets_platform_and_binaries() {
        let root = env::temp_dir().join(format!("dartsnut-metadata-{}", uuid::Uuid::new_v4()));
        let layout = RuntimeLayout::new(root.clone(), RuntimePlatform::DarwinArm64);
        fs::create_dir_all(layout.python.parent().unwrap()).unwrap();
        fs::create_dir_all(layout.uv.parent().unwrap()).unwrap();
        fs::write(&layout.python, b"python").unwrap();
        fs::write(&layout.uv, b"uv").unwrap();
        let metadata = RuntimeMetadata {
            schema_version: RUNTIME_SCHEMA_VERSION,
            python_version: TARGET_PYTHON_VERSION.to_owned(),
            python_release: TARGET_PYTHON_RELEASE.to_owned(),
            uv_version: TARGET_UV_VERSION.to_owned(),
            platform: RuntimePlatform::DarwinArm64,
            installed_at: "now".to_owned(),
            python_source: DownloadSource::Official,
            uv_source: DownloadSource::Ustc,
            python_probe_ms: Some(10),
            uv_probe_ms: Some(20),
        };
        assert!(metadata_matches(
            &metadata,
            RuntimePlatform::DarwinArm64,
            &layout
        ));
        fs::remove_file(&layout.uv).unwrap();
        assert!(!metadata_matches(
            &metadata,
            RuntimePlatform::DarwinArm64,
            &layout
        ));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn legacy_requirements_hash_does_not_gate_bootstrap_metadata() {
        let root =
            env::temp_dir().join(format!("dartsnut-legacy-metadata-{}", uuid::Uuid::new_v4()));
        let layout = RuntimeLayout::new(root.clone(), RuntimePlatform::DarwinArm64);
        fs::create_dir_all(layout.python.parent().unwrap()).unwrap();
        fs::create_dir_all(layout.uv.parent().unwrap()).unwrap();
        fs::write(&layout.python, b"python").unwrap();
        fs::write(&layout.uv, b"uv").unwrap();
        let metadata: RuntimeMetadata = serde_json::from_str(&format!(
            r#"{{
                    "schemaVersion": {},
                    "pythonVersion": "{}",
                    "pythonRelease": "{}",
                    "uvVersion": "{}",
                    "platform": "darwin-arm64",
                    "requirementsSha256": "stale-root-requirements",
                    "installedAt": "now",
                    "pythonSource": "official",
                    "uvSource": "cache"
                }}"#,
            RUNTIME_SCHEMA_VERSION, TARGET_PYTHON_VERSION, TARGET_PYTHON_RELEASE, TARGET_UV_VERSION
        ))
        .unwrap();
        assert!(metadata_matches(
            &metadata,
            RuntimePlatform::DarwinArm64,
            &layout
        ));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn zip_extraction_rejects_parent_path_entries() {
        let root = env::temp_dir().join(format!("dartsnut-zip-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let archive_path = root.join("unsafe.zip");
        let archive_file = fs::File::create(&archive_path).unwrap();
        let mut writer = zip::ZipWriter::new(archive_file);
        writer
            .start_file("../outside.txt", zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(b"unsafe").unwrap();
        writer.finish().unwrap();

        let destination = root.join("extract");
        let error = extract_archive(&archive_path, &destination, ArchiveKind::Zip).unwrap_err();
        assert!(error.contains("unsafe path"));
        assert!(!root.join("outside.txt").exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn verifies_sha256_case_insensitively_without_loading_whole_file() {
        let path = env::temp_dir().join(format!("dartsnut-runtime-{}", uuid::Uuid::new_v4()));
        fs::write(&path, b"dartsnut").unwrap();
        let expected = format!("{:x}", Sha256::digest(b"dartsnut"));
        assert!(verify_sha256(&path, &format!("  {expected}  ")).unwrap());
        assert!(verify_sha256(&path, &expected.to_ascii_uppercase()).unwrap());
        assert!(verify_sha256(path.with_extension("missing"), &expected).is_err());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn filters_secrets_and_host_runtime_overrides() {
        let sanitized = sanitize_environment([
            ("PATH".to_owned(), "/usr/bin".to_owned()),
            ("LANG".to_owned(), "en_US.UTF-8".to_owned()),
            ("OPENAI_API_KEY".to_owned(), "secret".to_owned()),
            ("DARTSNUT_PYTHON".to_owned(), "/host/python".to_owned()),
            ("DARTSNUT_UV_BIN".to_owned(), "/host/uv".to_owned()),
            ("UV_PYTHON".to_owned(), "/host/python".to_owned()),
            ("PYTHONPATH".to_owned(), "/host/python".to_owned()),
        ]);
        assert_eq!(
            sanitized,
            vec![
                ("PATH".to_owned(), "/usr/bin".to_owned()),
                ("LANG".to_owned(), "en_US.UTF-8".to_owned()),
            ]
        );
    }
}
