//! Async SSH/SFTP transport feasibility slice.
//!
//! The public API keeps transport details out of deploy orchestration. It
//! deliberately requires an explicit host-key policy: russh's default handler
//! rejects every key, and this module never provides a trust-all fallback.

use std::fmt;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use russh::client::Handler;
use russh::keys::{self, PublicKey, PublicKeyOrCertificate};
use russh::{ChannelMsg, Disconnect};
use russh_sftp::client::SftpSession;
use thiserror::Error;
use tokio::io::AsyncWriteExt;

/// Which SSH channel stream produced an output chunk.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OutputStream {
    Stdout,
    Stderr,
}

/// A completed remote command result.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ExecOutput {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub exit_code: Option<u32>,
    pub exit_signal: Option<String>,
}

/// Host-key verification policy.
///
/// `KnownHosts` rejects both unknown keys and changed keys. `TrustOnFirstUse`
/// records an unknown key only after successful key exchange, then rejects
/// changes on later connections. `Pinned` compares the complete public key.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum HostKeyPolicy {
    KnownHosts { path: PathBuf },
    TrustOnFirstUse { path: PathBuf },
    Pinned(PublicKey),
}

impl HostKeyPolicy {
    /// Verify one server key and, for TOFU, persist an initially unseen key.
    pub fn check(
        &self,
        host: &str,
        port: u16,
        server_key: &PublicKeyOrCertificate,
    ) -> Result<bool, SshError> {
        let server_key = server_key.public_key();
        match self {
            Self::Pinned(pinned) => {
                if pinned.algorithm() == server_key.algorithm() && pinned == &server_key {
                    Ok(true)
                } else {
                    Err(SshError::HostKeyRejected {
                        host: host.to_owned(),
                        reason: "pinned key mismatch".to_owned(),
                    })
                }
            }
            Self::KnownHosts { path } => {
                let known = check_known_hosts(host, port, &server_key, path)?;
                if known {
                    Ok(true)
                } else {
                    Err(SshError::HostKeyRejected {
                        host: host.to_owned(),
                        reason: "key is not present in known_hosts".to_owned(),
                    })
                }
            }
            Self::TrustOnFirstUse { path } => {
                let known = check_known_hosts(host, port, &server_key, path)?;
                if known {
                    return Ok(true);
                }

                keys::known_hosts::learn_known_hosts_path(host, port, &server_key, path)
                    .map_err(|error| SshError::HostKeyStore(error.to_string()))?;
                Ok(true)
            }
        }
    }
}

/// SSH connection settings.
pub struct SshConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    pub host_key_policy: HostKeyPolicy,
    pub connect_timeout: Duration,
    /// Optional idle timeout for an established SSH session. Keep `None` for
    /// long-lived commands such as `tail -f`; cancellation is driven by
    /// dropping the command future/channel.
    pub inactivity_timeout: Option<Duration>,
}

impl SshConfig {
    pub fn new(
        host: impl Into<String>,
        username: impl Into<String>,
        password: impl Into<String>,
        host_key_policy: HostKeyPolicy,
    ) -> Self {
        Self {
            host: host.into(),
            port: 22,
            username: username.into(),
            password: password.into(),
            host_key_policy,
            connect_timeout: Duration::from_secs(15),
            inactivity_timeout: None,
        }
    }
}

impl fmt::Debug for SshConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SshConfig")
            .field("host", &self.host)
            .field("port", &self.port)
            .field("username", &self.username)
            .field("password", &"[redacted]")
            .field("host_key_policy", &self.host_key_policy)
            .field("connect_timeout", &self.connect_timeout)
            .finish()
    }
}

/// Errors returned by the SSH/SFTP feasibility API.
#[derive(Debug, Error)]
pub enum SshError {
    #[error("SSH protocol error: {0}")]
    Protocol(#[from] russh::Error),
    #[error("SSH authentication failed")]
    Authentication,
    #[error("SSH connection timed out")]
    ConnectTimeout,
    #[error("SSH host key rejected for {host}: {reason}")]
    HostKeyRejected { host: String, reason: String },
    #[error("SSH host-key store failed: {0}")]
    HostKeyStore(String),
    #[error("SFTP error: {0}")]
    Sftp(String),
    #[error("invalid remote SFTP path: {0}")]
    InvalidRemotePath(String),
    #[error("I/O error: {0}")]
    Io(#[from] io::Error),
    #[error("SSH command cancelled")]
    Cancelled,
}

/// A connected SSH session.
pub struct SshConnection {
    session: russh::client::Handle<PolicyHandler>,
}

impl SshConnection {
    /// Establish and password-authenticate a connection.
    pub async fn connect(config: SshConfig) -> Result<Self, SshError> {
        let handler = PolicyHandler {
            host: config.host.clone(),
            port: config.port,
            policy: config.host_key_policy.clone(),
        };
        let client_config = Arc::new(russh::client::Config {
            inactivity_timeout: config.inactivity_timeout,
            ..Default::default()
        });

        let username = config.username;
        let password = config.password;
        let address = (config.host, config.port);
        let session = tokio::time::timeout(config.connect_timeout, async move {
            let mut session = russh::client::connect(client_config, address, handler).await?;
            let authentication = session.authenticate_password(username, password).await?;
            if !authentication.success() {
                return Err(SshError::Authentication);
            }
            Ok::<_, SshError>(session)
        })
        .await
        .map_err(|_| SshError::ConnectTimeout)??;

        Ok(Self { session })
    }

    /// Execute command, collecting stdout and stderr separately.
    pub async fn exec(&self, command: &str) -> Result<ExecOutput, SshError> {
        self.exec_streaming(command, None, |_, _| {}).await
    }

    /// Execute command after writing stdin and sending SSH EOF.
    ///
    /// Sending EOF is required for `bash -s`; waiting for the command's exit
    /// status before closing stdin can deadlock scripts that read until EOF.
    pub async fn exec_with_stdin(
        &self,
        command: &str,
        stdin: &[u8],
    ) -> Result<ExecOutput, SshError> {
        self.exec_streaming(command, Some(stdin), |_, _| {}).await
    }

    /// Execute a shell script through `bash -s`, closing script stdin first.
    pub async fn exec_bash_script(&self, script: &[u8]) -> Result<ExecOutput, SshError> {
        self.exec_with_stdin("bash -s", script).await
    }

    /// Execute command while receiving output incrementally.
    ///
    /// Dropping this future closes its channel handle, which is the
    /// cancellation primitive used by the caller for long-lived commands such
    /// as `tail -f`.
    pub async fn exec_streaming<F>(
        &self,
        command: &str,
        stdin: Option<&[u8]>,
        mut on_chunk: F,
    ) -> Result<ExecOutput, SshError>
    where
        F: FnMut(OutputStream, &[u8]) + Send,
    {
        let mut channel = self.session.channel_open_session().await?;
        channel.exec(true, command).await?;
        if let Some(stdin) = stdin {
            channel.data_bytes(stdin.to_vec()).await?;
            channel.eof().await?;
        }

        let mut output = ExecOutput::default();
        while let Some(message) = channel.wait().await {
            match message {
                ChannelMsg::Data { data } => {
                    on_chunk(OutputStream::Stdout, &data);
                    output.stdout.extend_from_slice(&data);
                }
                ChannelMsg::ExtendedData { data, .. } => {
                    on_chunk(OutputStream::Stderr, &data);
                    output.stderr.extend_from_slice(&data);
                }
                ChannelMsg::ExitStatus { exit_status } => {
                    output.exit_code = Some(exit_status);
                }
                ChannelMsg::ExitSignal { signal_name, .. } => {
                    output.exit_signal = Some(format!("{signal_name:?}"));
                }
                ChannelMsg::Close => break,
                _ => {}
            }
        }

        // Server normally sends Close. Best-effort close also covers servers
        // that finish with EOF but leave the channel open.
        let _ = channel.close().await;
        Ok(output)
    }

    /// Upload one local file through SFTP, truncating/replacing remote file.
    pub async fn upload_file(
        &self,
        local_path: impl AsRef<Path>,
        remote_path: &str,
    ) -> Result<u64, SshError> {
        if remote_path.is_empty() {
            return Err(SshError::InvalidRemotePath(
                "path cannot be empty".to_owned(),
            ));
        }

        let mut local = tokio::fs::File::open(local_path).await?;
        let channel = self.session.channel_open_session().await?;
        channel.request_subsystem(true, "sftp").await?;
        let sftp = SftpSession::new(channel.into_stream())
            .await
            .map_err(|error| SshError::Sftp(error.to_string()))?;
        let mut remote = sftp
            .create(remote_path)
            .await
            .map_err(|error| SshError::Sftp(error.to_string()))?;
        let copied = tokio::io::copy(&mut local, &mut remote).await?;
        remote
            .shutdown()
            .await
            .map_err(|error| SshError::Sftp(error.to_string()))?;
        sftp.close()
            .await
            .map_err(|error| SshError::Sftp(error.to_string()))?;
        Ok(copied)
    }

    /// Request graceful SSH disconnect.
    pub async fn close(&self) -> Result<(), SshError> {
        self.session
            .disconnect(Disconnect::ByApplication, "closed by application", "en")
            .await?;
        Ok(())
    }
}

/// Russh callback that applies host-key policy during key exchange.
pub struct PolicyHandler {
    host: String,
    port: u16,
    policy: HostKeyPolicy,
}

impl Handler for PolicyHandler {
    type Error = SshError;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        self.policy.check(&self.host, self.port, server_public_key)
    }
}

fn check_known_hosts(
    host: &str,
    port: u16,
    key: &PublicKey,
    path: &Path,
) -> Result<bool, SshError> {
    keys::known_hosts::check_known_hosts_path(host, port, key, path).map_err(|error| match error {
        keys::Error::KeyChanged { .. } => SshError::HostKeyRejected {
            host: host.to_owned(),
            reason: "known_hosts key changed".to_owned(),
        },
        other => SshError::HostKeyStore(other.to_string()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    const ED25519_KEY: &str =
        "AAAAC3NzaC1lZDI1NTE5AAAAIJdD7y3aLq454yWBdwLWbieU1ebz9/cu7/QEXn9OIeZJ";
    const OTHER_ED25519_KEY: &str =
        "AAAAC3NzaC1lZDI1NTE5AAAAILIG2T/B0l0gaqj3puu510tu9N1OkQ4znY3LYuEm5zCF";

    fn key(encoded: &str) -> PublicKey {
        keys::parse_public_key_base64(encoded).expect("fixture public key parses")
    }

    fn temporary_path(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock after epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("dartsnut-ssh-{label}-{nonce}"))
    }

    #[test]
    fn pinned_policy_accepts_exact_key_and_rejects_changed_key() {
        let policy = HostKeyPolicy::Pinned(key(ED25519_KEY));
        let accepted = PublicKeyOrCertificate::from(key(ED25519_KEY));
        let changed = PublicKeyOrCertificate::from(key(OTHER_ED25519_KEY));

        assert!(policy
            .check("example.test", 22, &accepted)
            .expect("key accepted"));
        assert!(matches!(
            policy.check("example.test", 22, &changed),
            Err(SshError::HostKeyRejected { .. })
        ));
    }

    #[test]
    fn known_hosts_policy_rejects_unknown_key() {
        let path = temporary_path("known");
        fs::write(&path, b"").expect("create empty known_hosts");
        let policy = HostKeyPolicy::KnownHosts { path: path.clone() };
        let server_key = PublicKeyOrCertificate::from(key(ED25519_KEY));

        assert!(matches!(
            policy.check("example.test", 22, &server_key),
            Err(SshError::HostKeyRejected { .. })
        ));
        fs::remove_file(path).expect("remove test known_hosts");
    }

    #[test]
    fn known_hosts_policy_accepts_matching_key_and_rejects_changed_key() {
        let path = temporary_path("known-match");
        let known_key = key(ED25519_KEY);
        fs::write(
            &path,
            format!(
                "example.test {}\n",
                known_key.to_openssh().expect("key encodes")
            ),
        )
        .expect("create known_hosts fixture");
        let policy = HostKeyPolicy::KnownHosts { path: path.clone() };
        let matching = PublicKeyOrCertificate::from(known_key);
        let changed = PublicKeyOrCertificate::from(key(OTHER_ED25519_KEY));

        assert!(policy
            .check("example.test", 22, &matching)
            .expect("known key accepted"));
        assert!(matches!(
            policy.check("example.test", 22, &changed),
            Err(SshError::HostKeyRejected { .. })
        ));
        fs::remove_file(path).expect("remove test known_hosts");
    }

    #[test]
    fn tofu_records_unknown_key_then_accepts_it() {
        let path = temporary_path("tofu");
        let policy = HostKeyPolicy::TrustOnFirstUse { path: path.clone() };
        let server_key = PublicKeyOrCertificate::from(key(ED25519_KEY));

        assert!(policy
            .check("example.test", 2222, &server_key)
            .expect("TOFU records key"));
        assert!(path.exists());
        assert!(policy
            .check("example.test", 2222, &server_key)
            .expect("known TOFU key"));
        fs::remove_file(path).expect("remove test known_hosts");
    }

    #[test]
    fn config_debug_redacts_password() {
        let config = SshConfig::new(
            "example.test",
            "dartsnut",
            "super-secret",
            HostKeyPolicy::Pinned(key(ED25519_KEY)),
        );
        let debug = format!("{config:?}");
        assert!(!debug.contains("super-secret"));
        assert!(debug.contains("[redacted]"));
    }

    #[test]
    fn output_stream_is_explicitly_separated() {
        assert_ne!(OutputStream::Stdout, OutputStream::Stderr);
        assert_eq!(OutputStream::Stdout, OutputStream::Stdout);
    }
}
