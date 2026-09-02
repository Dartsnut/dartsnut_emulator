use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::Rng;
use sha2::{Digest, Sha256};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;
use thiserror::Error;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::oneshot;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum OAuthError {
    #[error("invalid OAuth state")]
    InvalidState,
    #[error("OAuth callback timed out")]
    Timeout,
    #[error("OAuth callback I/O error: {0}")]
    Io(String),
    #[error("OAuth callback missing authorization code")]
    MissingCode,
    #[error("OAuth callback cancelled")]
    Cancelled,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PkcePair {
    pub verifier: String,
    pub challenge: String,
    pub state: String,
}

pub fn generate_pkce() -> PkcePair {
    let mut bytes = [0u8; 32];
    rand::rng().fill(&mut bytes);
    let verifier = URL_SAFE_NO_PAD.encode(bytes);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let mut state_bytes = [0u8; 24];
    rand::rng().fill(&mut state_bytes);
    PkcePair {
        verifier,
        challenge,
        state: URL_SAFE_NO_PAD.encode(state_bytes),
    }
}

pub async fn callback_once(
    expected_state: &str,
    timeout: Duration,
) -> Result<(String, String), OAuthError> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| OAuthError::Io(e.to_string()))?;
    let result = tokio::time::timeout(timeout, async {
        let (mut stream, _) = listener.accept().await.map_err(|e| OAuthError::Io(e.to_string()))?;
        let mut buffer = [0u8; 8192];
        let size = stream.read(&mut buffer).await.map_err(|e| OAuthError::Io(e.to_string()))?;
        let request = String::from_utf8_lossy(&buffer[..size]);
        let target = request.lines().next().and_then(|line| line.strip_prefix("GET ")).and_then(|line| line.split_whitespace().next()).ok_or(OAuthError::MissingCode)?;
        let (code, state) = parse_callback_query(target);
        if state.as_deref() != Some(expected_state) { return Err(OAuthError::InvalidState); }
        let code = code.ok_or(OAuthError::MissingCode)?;
        stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nAuthentication complete. You may close this window.").await.map_err(|e| OAuthError::Io(e.to_string()))?;
        Ok::<_, OAuthError>((code, listener.local_addr().map_err(|e| OAuthError::Io(e.to_string()))?.port().to_string()))
    }).await.map_err(|_| OAuthError::Timeout)??;
    Ok(result)
}

pub struct CallbackHandle {
    pub port: u16,
    receiver: oneshot::Receiver<Result<String, OAuthError>>,
    cancel_flag: Arc<AtomicBool>,
}

impl CallbackHandle {
    pub async fn wait(self) -> Result<String, OAuthError> {
        self.receiver
            .await
            .map_err(|_| OAuthError::Io("OAuth callback task stopped".to_owned()))?
    }

    pub fn cancel(&self) {
        self.cancel_flag.store(true, Ordering::SeqCst);
    }

    pub fn cancellation_flag(&self) -> Arc<AtomicBool> {
        self.cancel_flag.clone()
    }
}

pub async fn start_callback(
    expected_state: String,
    timeout: Duration,
) -> Result<CallbackHandle, OAuthError> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| OAuthError::Io(e.to_string()))?;
    let port = listener
        .local_addr()
        .map_err(|e| OAuthError::Io(e.to_string()))?
        .port();
    let (sender, receiver) = oneshot::channel();
    let cancel_flag = Arc::new(AtomicBool::new(false));
    let task_cancel = cancel_flag.clone();
    tokio::spawn(async move {
        let result: Result<String, OAuthError> = match tokio::time::timeout(timeout, async {
            let (mut stream, _) = loop {
                if task_cancel.load(Ordering::SeqCst) {
                    return Err(OAuthError::Cancelled);
                }
                tokio::select! {
                    accepted = listener.accept() => break accepted.map_err(|e| OAuthError::Io(e.to_string()))?,
                    _ = tokio::time::sleep(Duration::from_millis(50)) => {}
                }
            };
            let mut buffer = [0u8; 8192];
            let size = tokio::select! {
                read = stream.read(&mut buffer) => read.map_err(|e| OAuthError::Io(e.to_string()))?,
                _ = wait_cancelled(task_cancel.clone()) => return Err(OAuthError::Cancelled),
            };
            let request = String::from_utf8_lossy(&buffer[..size]);
            let target = request
                .lines()
                .next()
                .and_then(|line| line.strip_prefix("GET "))
                .and_then(|line| line.split_whitespace().next())
                .ok_or(OAuthError::MissingCode)?;
            let (code, state) = parse_callback_query(target);
            if state.as_deref() != Some(expected_state.as_str()) {
                return Err(OAuthError::InvalidState);
            }
            let code = code.ok_or(OAuthError::MissingCode)?;
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nAuthentication complete. You may close this window.")
                .await
                .map_err(|e| OAuthError::Io(e.to_string()))?;
            Ok(code)
        })
        .await
        {
            Ok(result) => result,
            Err(_) => Err(OAuthError::Timeout),
        };
        let _ = sender.send(result);
    });
    Ok(CallbackHandle {
        port,
        receiver,
        cancel_flag,
    })
}

async fn wait_cancelled(flag: Arc<AtomicBool>) {
    while !flag.load(Ordering::SeqCst) {
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

fn parse_callback_query(target: &str) -> (Option<String>, Option<String>) {
    let query = target.split_once('?').map(|(_, q)| q).unwrap_or("");
    let mut code = None;
    let mut state = None;
    for part in query.split('&') {
        let Some((key, value)) = part.split_once('=') else {
            continue;
        };
        let key = percent_decode(key);
        let value = percent_decode(value);
        match key.as_str() {
            "code" => code = Some(value),
            "state" => state = Some(value),
            _ => {}
        }
    }
    (code, state)
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(high), Some(low)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push(high * 16 + low);
                i += 3;
                continue;
            }
        }
        out.push(if bytes[i] == b'+' { b' ' } else { bytes[i] });
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pkce_is_url_safe_and_state_unique() {
        let one = generate_pkce();
        let two = generate_pkce();
        assert_ne!(one.state, two.state);
        assert!(!one.verifier.contains('='));
        assert_eq!(
            one.challenge,
            URL_SAFE_NO_PAD.encode(Sha256::digest(one.verifier.as_bytes()))
        );
    }

    #[test]
    fn callback_query_decodes_percent_escaped_values() {
        let (code, state) = parse_callback_query("/oauth?code=abc%2B123&state=state%2Fvalue");
        assert_eq!(code.as_deref(), Some("abc+123"));
        assert_eq!(state.as_deref(), Some("state/value"));
    }
}
