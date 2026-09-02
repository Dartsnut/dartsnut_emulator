use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum UpdateKind {
    Idle,
    Checking,
    Available,
    Downloading,
    Ready,
    NotAvailable,
    Error,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateState {
    pub kind: UpdateKind,
    pub current_version: String,
    pub available_version: Option<String>,
    pub percent: Option<u8>,
    pub message: Option<String>,
}

impl UpdateState {
    pub fn idle(version: impl Into<String>) -> Self {
        Self {
            kind: UpdateKind::Idle,
            current_version: version.into(),
            available_version: None,
            percent: None,
            message: None,
        }
    }
    pub fn error(version: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            kind: UpdateKind::Error,
            current_version: version.into(),
            available_version: None,
            percent: None,
            message: Some(message.into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn state_serializes_for_renderer_contract() {
        let state = UpdateState {
            kind: UpdateKind::Available,
            current_version: "1.0.0".into(),
            available_version: Some("1.1.0".into()),
            percent: None,
            message: None,
        };
        let json = serde_json::to_value(state).unwrap();
        assert_eq!(json["kind"], "available");
        assert_eq!(json["currentVersion"], "1.0.0");
    }
}
