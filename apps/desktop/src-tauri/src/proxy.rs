use std::{env, fs};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProxyConfig {
    pub url: String,
    pub username: Option<String>,
    pub password: Option<String>,
}

impl ProxyConfig {
    pub fn redacted(&self) -> String {
        match (&self.username, &self.password) {
            (Some(user), Some(_)) => format!(
                "{}://{}:[REDACTED]@{}",
                scheme(&self.url),
                user,
                authority(&self.url)
            ),
            _ => self.url.clone(),
        }
    }
}

pub fn resolve_from_environment() -> Option<ProxyConfig> {
    for key in ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"] {
        if let Ok(value) = env::var(key) {
            if let Some(proxy) = parse_proxy(&value) {
                return Some(proxy);
            }
        }
    }
    None
}

/// Resolve a proxy for a destination using environment variables and PAC.
///
/// `NO_PROXY`/`no_proxy` is honored before selecting an environment proxy. PAC
/// URLs are supported for local `file://` and inline `data:` scripts. Remote
/// PAC URLs are deliberately rejected here because synchronous resolution
/// cannot safely perform network I/O; async callers should fetch the script,
/// then use [`resolve_from_pac_script`].
pub fn resolve_for_url(url: &str) -> Result<Option<ProxyConfig>, String> {
    let destination = url.trim();
    if destination.is_empty() {
        return Err("destination URL is required".to_owned());
    }

    if no_proxy_matches(destination) {
        return Ok(None);
    }

    if let Ok(pac) = env::var("AUTO_PROXY_URL").or_else(|_| env::var("PROXY_PAC_URL")) {
        let pac = pac.trim();
        if !pac.is_empty() {
            let script = if let Some(path) = pac.strip_prefix("file://") {
                fs::read_to_string(path).map_err(|_| {
                    "PAC file could not be read; refusing direct connection".to_owned()
                })?
            } else if let Some(encoded) = pac.strip_prefix("data:") {
                decode_data_url(encoded).ok_or_else(|| {
                    "PAC data URL is invalid; refusing direct connection".to_owned()
                })?
            } else {
                return Err(
                    "remote PAC URL requires asynchronous fetch; refusing direct connection"
                        .to_owned(),
                );
            };
            return resolve_from_pac_script(destination, &script);
        }
    }
    Ok(resolve_from_environment())
}

/// Async PAC-aware resolver for request paths that can perform network I/O.
/// Remote PAC scripts are fetched with an explicit no-proxy client, then
/// evaluated by the same fail-closed parser used for local/data scripts.
pub async fn resolve_for_url_async(url: &str) -> Result<Option<ProxyConfig>, String> {
    let destination = url.trim();
    if destination.is_empty() {
        return Err("destination URL is required".to_owned());
    }
    if no_proxy_matches(destination) {
        return Ok(None);
    }
    let pac = env::var("AUTO_PROXY_URL")
        .or_else(|_| env::var("PROXY_PAC_URL"))
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    let Some(pac) = pac else {
        return Ok(resolve_from_environment());
    };
    let script = if let Some(path) = pac.strip_prefix("file://") {
        fs::read_to_string(path)
            .map_err(|_| "PAC file could not be read; refusing direct connection".to_owned())?
    } else if let Some(encoded) = pac.strip_prefix("data:") {
        decode_data_url(encoded)
            .ok_or_else(|| "PAC data URL is invalid; refusing direct connection".to_owned())?
    } else {
        crate::ensure_rustls_crypto_provider();
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .map_err(|error| error.to_string())?;
        client
            .get(&pac)
            .send()
            .await
            .map_err(|_| "PAC script fetch failed; refusing direct connection".to_owned())?
            .error_for_status()
            .map_err(|_| "PAC script fetch failed; refusing direct connection".to_owned())?
            .text()
            .await
            .map_err(|_| "PAC script fetch failed; refusing direct connection".to_owned())?
    };
    resolve_from_pac_script(destination, &script)
}

/// Build reqwest client with explicit proxy policy. `no_proxy()` disables
/// reqwest's implicit environment lookup so PAC/NO_PROXY decisions above are
/// authoritative and fail-closed errors cannot silently become direct calls.
pub fn client_for_url(url: &str) -> Result<reqwest::Client, String> {
    crate::ensure_rustls_crypto_provider();
    let mut builder = reqwest::Client::builder().no_proxy();
    if let Some(proxy) = resolve_for_url(url)? {
        let mut configured = reqwest::Proxy::all(&proxy.url).map_err(|e| e.to_string())?;
        if let (Some(username), Some(password)) = (proxy.username, proxy.password) {
            configured = configured.basic_auth(&username, &password);
        }
        builder = builder.proxy(configured);
    }
    builder.build().map_err(|e| e.to_string())
}

/// Async counterpart used by streaming HTTP paths so remote PAC files can be
/// fetched before constructing the request client.
pub async fn client_for_url_async(url: &str) -> Result<reqwest::Client, String> {
    crate::ensure_rustls_crypto_provider();
    let mut builder = reqwest::Client::builder().no_proxy();
    if let Some(proxy) = resolve_for_url_async(url).await? {
        let mut configured = reqwest::Proxy::all(&proxy.url).map_err(|error| error.to_string())?;
        if let (Some(username), Some(password)) = (proxy.username, proxy.password) {
            configured = configured.basic_auth(&username, &password);
        }
        builder = builder.proxy(configured);
    }
    builder.build().map_err(|error| error.to_string())
}

pub async fn client_for_url_with_headers_async(
    url: &str,
    headers: reqwest::header::HeaderMap,
) -> Result<reqwest::Client, String> {
    crate::ensure_rustls_crypto_provider();
    let mut builder = reqwest::Client::builder()
        .no_proxy()
        .default_headers(headers);
    if let Some(proxy) = resolve_for_url_async(url).await? {
        let mut configured = reqwest::Proxy::all(&proxy.url).map_err(|error| error.to_string())?;
        if let (Some(username), Some(password)) = (proxy.username, proxy.password) {
            configured = configured.basic_auth(&username, &password);
        }
        builder = builder.proxy(configured);
    }
    builder.build().map_err(|error| error.to_string())
}

/// Evaluate common PAC `return` directives without embedding a JavaScript
/// runtime. This covers scripts generated by standard enterprise PAC files
/// when they return a literal `PROXY`, `HTTPS`, `SOCKS5`, or `DIRECT` value.
pub fn resolve_from_pac_script(url: &str, script: &str) -> Result<Option<ProxyConfig>, String> {
    if no_proxy_matches(url) {
        return Ok(None);
    }
    let lower = script.to_ascii_lowercase();
    let return_pos = lower.find("return").ok_or_else(|| {
        "PAC script has no return directive; refusing direct connection".to_owned()
    })?;
    let tail = &script[return_pos + "return".len()..];
    let quoted = tail.split(['\'', '"']).nth(1).ok_or_else(|| {
        "PAC return directive is malformed; refusing direct connection".to_owned()
    })?;
    for directive in quoted.split(';').map(str::trim) {
        if directive.eq_ignore_ascii_case("DIRECT") {
            return Ok(None);
        }
        let proxy = directive
            .strip_prefix("PROXY ")
            .or_else(|| directive.strip_prefix("HTTPS "))
            .or_else(|| directive.strip_prefix("HTTP "))
            .map(|host| format!("http://{host}"))
            .or_else(|| {
                directive
                    .strip_prefix("SOCKS5 ")
                    .map(|host| format!("socks5://{host}"))
            });
        if let Some(proxy) = proxy {
            return parse_proxy(&proxy).map(Some).ok_or_else(|| {
                "PAC proxy directive is malformed; refusing direct connection".to_owned()
            });
        }
    }
    Err("PAC script yielded no supported proxy directive; refusing direct connection".to_owned())
}

fn decode_data_url(value: &str) -> Option<String> {
    let (meta, data) = value.split_once(',')?;
    if meta.to_ascii_lowercase().contains(";base64") {
        let bytes =
            base64::Engine::decode(&base64::engine::general_purpose::STANDARD, data).ok()?;
        String::from_utf8(bytes).ok()
    } else {
        Some(
            data.replace("%20", " ")
                .replace("%0A", "\n")
                .replace("%22", "\""),
        )
    }
}

fn no_proxy_matches(url: &str) -> bool {
    let value = env::var("NO_PROXY")
        .or_else(|_| env::var("no_proxy"))
        .unwrap_or_default();
    if value.trim().is_empty() {
        return false;
    }
    let authority = url
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(url)
        .split(['/', '?', '#'])
        .next()
        .unwrap_or("")
        .rsplit_once('@')
        .map(|(_, host)| host)
        .unwrap_or_else(|| {
            url.split_once("://")
                .map(|(_, rest)| rest)
                .unwrap_or(url)
                .split(['/', '?', '#'])
                .next()
                .unwrap_or("")
        });
    let (host, port) = authority
        .rsplit_once(':')
        .filter(|(_, p)| p.chars().all(|c| c.is_ascii_digit()))
        .map(|(h, p)| (h.trim_matches(['[', ']']), Some(p)))
        .unwrap_or((authority.trim_matches(['[', ']']), None));
    value.split(',').map(str::trim).any(|entry| {
        if entry == "*" {
            return true;
        }
        let (pattern, pattern_port) = entry
            .rsplit_once(':')
            .filter(|(_, p)| p.chars().all(|c| c.is_ascii_digit()))
            .map(|(h, p)| (h, Some(p)))
            .unwrap_or((entry, None));
        if pattern_port.is_some() && pattern_port != port {
            return false;
        }
        let pattern = pattern.trim_start_matches('.').to_ascii_lowercase();
        let host = host.to_ascii_lowercase();
        host == pattern || host.ends_with(&format!(".{pattern}"))
    })
}

pub fn parse_proxy(raw: &str) -> Option<ProxyConfig> {
    let value = raw.trim();
    let (scheme_name, rest) = value.split_once("://")?;
    if !matches!(
        scheme_name.to_ascii_lowercase().as_str(),
        "http" | "https" | "socks5"
    ) {
        return None;
    }
    let (credentials, host) = match rest.rsplit_once('@') {
        Some((credentials, host)) => (Some(credentials), host),
        None => (None, rest),
    };
    if host.is_empty() || host.chars().any(char::is_whitespace) {
        return None;
    }
    let (username, password) = credentials
        .and_then(|value| value.split_once(':'))
        .map(|(user, pass)| (Some(user.to_owned()), Some(pass.to_owned())))
        .unwrap_or((None, None));
    Some(ProxyConfig {
        url: format!("{scheme_name}://{host}"),
        username,
        password,
    })
}

fn scheme(url: &str) -> &str {
    url.split_once("://")
        .map(|(value, _)| value)
        .unwrap_or("http")
}
fn authority(url: &str) -> &str {
    url.split_once("://").map(|(_, value)| value).unwrap_or(url)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, OnceLock};

    fn env_lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(())).lock().unwrap()
    }

    #[test]
    fn parses_authenticated_proxy_and_redacts_password() {
        let proxy = parse_proxy("http://alice:secret@proxy.example:8080").unwrap();
        assert_eq!(proxy.username.as_deref(), Some("alice"));
        assert_eq!(proxy.password.as_deref(), Some("secret"));
        assert_eq!(
            proxy.redacted(),
            "http://alice:[REDACTED]@proxy.example:8080"
        );
    }

    #[test]
    fn rejects_unsupported_or_malformed_proxy() {
        assert!(parse_proxy("file:///tmp/proxy").is_none());
        assert!(parse_proxy("http://proxy host").is_none());
    }

    #[test]
    fn rejects_empty_destination() {
        assert!(resolve_for_url("").is_err());
    }

    #[test]
    fn reqwest_client_builder_has_crypto_provider() {
        crate::ensure_rustls_crypto_provider();
        reqwest::Client::builder()
            .build()
            .expect("rustls crypto provider must be installed");
    }

    #[test]
    fn pac_literal_proxy_and_direct_are_supported() {
        let _guard = env_lock();
        let old_no_proxy = env::var_os("NO_PROXY");
        env::remove_var("NO_PROXY");
        let script =
            r#"function FindProxyForURL(url, host) { return "PROXY proxy.example:8080; DIRECT"; }"#;
        let proxy = resolve_from_pac_script("https://example.com", script)
            .unwrap()
            .unwrap();
        assert_eq!(proxy.url, "http://proxy.example:8080");
        let direct = resolve_from_pac_script(
            "https://example.com",
            r#"function FindProxyForURL() { return "DIRECT"; }"#,
        )
        .unwrap();
        assert!(direct.is_none());
        if let Some(value) = old_no_proxy {
            env::set_var("NO_PROXY", value);
        }
    }

    #[test]
    fn no_proxy_bypasses_environment_proxy() {
        let _guard = env_lock();
        let old_proxy = env::var_os("HTTPS_PROXY");
        let old_no_proxy = env::var_os("NO_PROXY");
        env::set_var("HTTPS_PROXY", "http://proxy.example:8080");
        env::set_var("NO_PROXY", ".example.com,localhost:3000");
        assert!(resolve_for_url("https://api.example.com/v1")
            .unwrap()
            .is_none());
        assert!(resolve_for_url("http://localhost:3000/x")
            .unwrap()
            .is_none());
        env::remove_var("HTTPS_PROXY");
        env::remove_var("NO_PROXY");
        if let Some(value) = old_proxy {
            env::set_var("HTTPS_PROXY", value);
        }
        if let Some(value) = old_no_proxy {
            env::set_var("NO_PROXY", value);
        }
    }

    #[test]
    fn remote_pac_fails_closed() {
        let _guard = env_lock();
        let old = env::var_os("AUTO_PROXY_URL");
        env::set_var("AUTO_PROXY_URL", "https://proxy.example/pac.js");
        let result = resolve_for_url("https://example.com");
        assert!(result.is_err());
        env::remove_var("AUTO_PROXY_URL");
        if let Some(value) = old {
            env::set_var("AUTO_PROXY_URL", value);
        }
    }

    #[tokio::test]
    async fn async_resolver_supports_inline_pac() {
        let (old_pac, old_no_proxy) = {
            let _guard = env_lock();
            let old_pac = env::var_os("AUTO_PROXY_URL");
            let old_no_proxy = env::var_os("NO_PROXY");
            env::remove_var("NO_PROXY");
            env::set_var(
                "AUTO_PROXY_URL",
                "data:text/plain,function%20FindProxyForURL()%20%7B%20return%20%22DIRECT%22;%20%7D",
            );
            (old_pac, old_no_proxy)
        };
        let result = resolve_for_url_async("https://example.com").await.unwrap();
        assert!(result.is_none());
        let _guard = env_lock();
        env::remove_var("AUTO_PROXY_URL");
        env::remove_var("NO_PROXY");
        if let Some(value) = old_pac {
            env::set_var("AUTO_PROXY_URL", value);
        }
        if let Some(value) = old_no_proxy {
            env::set_var("NO_PROXY", value);
        }
    }
}
