use sha2::{Digest, Sha256};
use std::ffi::OsStr;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::{env, fs};
use thiserror::Error;
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::sync::watch;

#[derive(Debug, Error)]
pub enum ProcessError {
    #[error("process I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("process cancelled")]
    Cancelled,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProcessOutput {
    pub status: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

/// Find a usable Python interpreter without trusting the renderer-provided path.
pub fn discover_python(bundle_root: Option<&Path>) -> Option<PathBuf> {
    let override_path = env::var_os("DARTSNUT_PYTHON")
        .filter(|value| !value.to_string_lossy().trim().is_empty())
        .map(PathBuf::from);
    let path_var = env::var_os("PATH");
    discover_python_with_environment(bundle_root, override_path.as_deref(), path_var.as_deref())
}

fn discover_python_with_environment(
    bundle_root: Option<&Path>,
    override_path: Option<&Path>,
    path_var: Option<&OsStr>,
) -> Option<PathBuf> {
    let mut candidates = Vec::new();

    // Explicit override is first, so it remains a true override when a
    // packaged interpreter is also present.
    if let Some(path) = override_path {
        candidates.push(path.to_owned());
    }

    if let Some(root) = bundle_root {
        // Accept both a resources directory and a directory that already is
        // the packaged python-runtime. Keep older development layouts too.
        for runtime_root in [
            root.to_owned(),
            root.join("python-runtime"),
            root.join("runtime"),
            root.join("python"),
            root.join(".venv"),
        ] {
            candidates.extend([
                runtime_root.join("bin").join("python3"),
                runtime_root.join("bin").join("python"),
                runtime_root.join("Scripts").join("python.exe"),
                runtime_root.join("python3"),
                runtime_root.join("python"),
                runtime_root.join("python.exe"),
            ]);
        }
    }

    candidates.extend([
        PathBuf::from("python3"),
        PathBuf::from("python"),
        PathBuf::from("py"),
    ]);

    candidates
        .into_iter()
        .find_map(|candidate| resolve_executable(&candidate, path_var))
}

fn resolve_executable(candidate: &Path, path_var: Option<&OsStr>) -> Option<PathBuf> {
    if candidate.components().count() != 1 {
        if is_regular_file(candidate) {
            return Some(candidate.to_owned());
        }

        #[cfg(windows)]
        if candidate.extension().is_none() {
            for extension in pathextensions() {
                let with_extension = candidate.with_extension(extension);
                if is_regular_file(&with_extension) {
                    return Some(with_extension);
                }
            }
        }
        return None;
    }

    let path_var = path_var?;
    let names = executable_names(candidate);
    for directory in env::split_paths(path_var) {
        for name in &names {
            let path = directory.join(name);
            if is_regular_file(&path) {
                return Some(path);
            }
        }
    }
    None
}

fn is_regular_file(path: &Path) -> bool {
    fs::metadata(path)
        .map(|metadata| metadata.is_file())
        .unwrap_or(false)
}

#[cfg(windows)]
fn executable_names(candidate: &Path) -> Vec<PathBuf> {
    let mut names = vec![candidate.to_owned()];
    if candidate.extension().is_none() {
        names.extend(pathextensions().map(|extension| candidate.with_extension(extension)));
    }
    names
}

#[cfg(not(windows))]
fn executable_names(candidate: &Path) -> Vec<PathBuf> {
    vec![candidate.to_owned()]
}

#[cfg(windows)]
fn pathextensions() -> impl Iterator<Item = String> {
    env::var_os("PATHEXT")
        .map(|value| {
            value
                .to_string_lossy()
                .split(';')
                .filter(|extension| !extension.is_empty())
                .map(|extension| extension.trim_start_matches('.').to_owned())
                .collect::<Vec<_>>()
        })
        .unwrap_or_else(|| vec!["EXE".to_owned(), "CMD".to_owned(), "BAT".to_owned()])
        .into_iter()
}

pub fn verify_sha256(path: impl AsRef<Path>, expected_hex: &str) -> Result<bool, io::Error> {
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

    let actual = format!("{:x}", hasher.finalize());
    Ok(actual.eq_ignore_ascii_case(expected_hex.trim()))
}

/// Keep secrets and host-specific proxy settings out of child process environments.
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
            "ALL_PROXY"
                | "HTTP_PROXY"
                | "HTTPS_PROXY"
                | "NO_PROXY"
                | "PYTHONHOME"
                | "PYTHONPATH"
                | "PYTHONUSERBASE"
                | "UV_NO_PROJECT"
                | "UV_NO_SYNC"
                | "UV_PROJECT_ENVIRONMENT"
                | "VIRTUAL_ENV"
        )
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
    use std::ffi::OsString;
    use uuid::Uuid;

    #[test]
    fn discovers_explicit_override_before_bundled_runtime() {
        let root = std::env::temp_dir().join(format!("dartsnut-runtime-{}", Uuid::new_v4()));
        let bundled = root.join("python-runtime/bin/python3");
        let override_path = root.join("override/python3");
        fs::create_dir_all(bundled.parent().unwrap()).unwrap();
        fs::create_dir_all(override_path.parent().unwrap()).unwrap();
        fs::write(&bundled, b"bundled").unwrap();
        fs::write(&override_path, b"override").unwrap();

        let path_var = OsString::from("/does/not/exist");
        assert_eq!(
            discover_python_with_environment(
                Some(&root),
                Some(&override_path),
                Some(path_var.as_os_str()),
            ),
            Some(override_path)
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn discovers_command_only_when_present_on_path() {
        let root = std::env::temp_dir().join(format!("dartsnut-runtime-{}", Uuid::new_v4()));
        let python = root.join("python3");
        fs::create_dir_all(&root).unwrap();
        fs::write(&python, b"python").unwrap();
        let path_var = env::join_paths([root.as_path()]).unwrap();

        assert_eq!(
            discover_python_with_environment(None, None, Some(path_var.as_os_str())),
            Some(python)
        );
        let missing_path = OsString::from("/does/not/exist");
        assert_eq!(
            discover_python_with_environment(None, None, Some(missing_path.as_os_str())),
            None
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn verifies_sha256_case_insensitively_without_loading_whole_file() {
        let path = std::env::temp_dir().join(format!("dartsnut-runtime-{}", Uuid::new_v4()));
        fs::write(&path, b"dartsnut").unwrap();
        assert!(!verify_sha256(
            &path,
            "f4b8f2f0f4f84b9e9d6e3f3c5f1c2e39f2c7d9f9c6c7f7b7f2b8c4a6e2b0f3c5"
        )
        .unwrap());
        let expected = format!("{:x}", Sha256::digest(b"dartsnut"));
        assert!(verify_sha256(&path, &format!("  {expected}  ")).unwrap());
        assert!(verify_sha256(&path, &expected.to_ascii_uppercase()).unwrap());
        assert!(verify_sha256(path.with_extension("missing"), &expected).is_err());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn filters_secrets_proxies_and_host_runtime_overrides() {
        let sanitized = sanitize_environment([
            ("PATH".to_owned(), "/usr/bin".to_owned()),
            ("LANG".to_owned(), "en_US.UTF-8".to_owned()),
            ("OPENAI_API_KEY".to_owned(), "secret".to_owned()),
            ("x-api-token".to_owned(), "secret".to_owned()),
            ("my_password".to_owned(), "secret".to_owned()),
            ("HTTPS_PROXY".to_owned(), "http://proxy".to_owned()),
            ("no_proxy".to_owned(), "localhost".to_owned()),
            ("PYTHONPATH".to_owned(), "/host/python".to_owned()),
            ("UV_PROJECT_ENVIRONMENT".to_owned(), "/host/venv".to_owned()),
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
