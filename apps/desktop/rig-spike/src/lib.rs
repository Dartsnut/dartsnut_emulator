//! Feasibility harness for the planned Rig-backed Dartsnut agent.
//!
//! This crate deliberately has no network dependencies.  The current checkout
//! has no cached `rig` crate and crates.io is unreachable, so the harness keeps
//! the contracts executable while making the missing Rig integration explicit.
//! It is not production agent code.

use std::collections::BTreeMap;
use std::fmt;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

pub const MAX_TURNS: usize = 128;

#[derive(Clone, Debug)]
pub struct CancellationToken(Arc<AtomicBool>);

impl CancellationToken {
    pub fn new() -> Self {
        Self(Arc::new(AtomicBool::new(false)))
    }

    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

impl Default for CancellationToken {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AgentEvent {
    RunStarted {
        run_id: String,
        model: String,
    },
    TurnStarted {
        turn: usize,
        model: String,
    },
    Retry {
        model: String,
        attempt: usize,
        reason: String,
    },
    ToolCallStarted {
        turn: usize,
        call_id: String,
        name: String,
        input: String,
    },
    ToolCallFinished {
        turn: usize,
        call_id: String,
        output: String,
    },
    TextDelta {
        turn: usize,
        text: String,
    },
    RunSaved {
        turn: usize,
    },
    Completed {
        turn: usize,
        text: String,
    },
    Cancelled {
        turn: usize,
    },
}

pub trait DartsnutTool: Send {
    fn name(&self) -> &str;
    fn call(&mut self, input: &str) -> Result<String, String>;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ToolResult {
    pub call_id: String,
    pub name: String,
    pub input: String,
    pub output: Result<String, String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelRequest {
    pub turn: usize,
    pub input: String,
    pub previous_response_id: Option<String>,
    pub history: Vec<TranscriptItem>,
    pub tool_result: Option<ToolResult>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ModelReply {
    ToolCall {
        call_id: String,
        name: String,
        input: String,
        response_id: Option<String>,
    },
    Text {
        text: String,
        response_id: Option<String>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ModelError {
    Transient(String),
    Permanent(String),
}

impl fmt::Display for ModelError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Transient(reason) => write!(f, "transient model error: {reason}"),
            Self::Permanent(reason) => write!(f, "model error: {reason}"),
        }
    }
}

pub trait CompletionModel: Send {
    fn name(&self) -> &str;
    fn complete(
        &mut self,
        request: &ModelRequest,
        cancellation: &CancellationToken,
    ) -> Result<ModelReply, ModelError>;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TranscriptItem {
    User(String),
    ToolCall {
        call_id: String,
        name: String,
        input: String,
    },
    ToolResult(ToolResult),
    Assistant(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RunStatus {
    Running,
    Completed,
    Cancelled,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RunState {
    pub run_id: String,
    pub model: String,
    pub turn: usize,
    pub previous_response_id: Option<String>,
    pub transcript: Vec<TranscriptItem>,
    pub status: RunStatus,
}

pub trait RunStateStore {
    fn save(&mut self, state: &RunState) -> Result<(), String>;
    fn load(&self, run_id: &str) -> Option<RunState>;
}

#[derive(Default)]
pub struct MemoryRunStateStore {
    states: BTreeMap<String, RunState>,
}

impl MemoryRunStateStore {
    pub fn latest(&self) -> Option<&RunState> {
        self.states.values().next()
    }
}

impl RunStateStore for MemoryRunStateStore {
    fn save(&mut self, state: &RunState) -> Result<(), String> {
        self.states.insert(state.run_id.clone(), state.clone());
        Ok(())
    }

    fn load(&self, run_id: &str) -> Option<RunState> {
        self.states.get(run_id).cloned()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RetryPolicy {
    pub max_retries: usize,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self { max_retries: 2 }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum AgentError {
    UnknownModel(String),
    ToolNotFound(String),
    ToolFailed(String),
    ModelFailed(String),
    StoreFailed(String),
    TurnLimit(usize),
}

impl fmt::Display for AgentError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnknownModel(model) => write!(f, "unknown model: {model}"),
            Self::ToolNotFound(tool) => write!(f, "tool not found: {tool}"),
            Self::ToolFailed(error) => write!(f, "tool failed: {error}"),
            Self::ModelFailed(error) => write!(f, "model failed: {error}"),
            Self::StoreFailed(error) => write!(f, "run state store failed: {error}"),
            Self::TurnLimit(limit) => write!(f, "turn limit reached: {limit}"),
        }
    }
}

pub struct Agent {
    run_id: String,
    active_model: String,
    models: BTreeMap<String, Box<dyn CompletionModel>>,
    tools: BTreeMap<String, Box<dyn DartsnutTool>>,
    retry_policy: RetryPolicy,
    max_turns: usize,
}

impl Agent {
    pub fn new(run_id: impl Into<String>, model: Box<dyn CompletionModel>) -> Self {
        let model_name = model.name().to_owned();
        let mut models = BTreeMap::new();
        models.insert(model_name.clone(), model);
        Self {
            run_id: run_id.into(),
            active_model: model_name,
            models,
            tools: BTreeMap::new(),
            retry_policy: RetryPolicy::default(),
            max_turns: MAX_TURNS,
        }
    }

    pub fn add_model(&mut self, model: Box<dyn CompletionModel>) {
        self.models.insert(model.name().to_owned(), model);
    }

    pub fn switch_model(&mut self, model: &str) -> Result<(), AgentError> {
        if self.models.contains_key(model) {
            self.active_model = model.to_owned();
            Ok(())
        } else {
            Err(AgentError::UnknownModel(model.to_owned()))
        }
    }

    pub fn register_tool(&mut self, tool: Box<dyn DartsnutTool>) {
        self.tools.insert(tool.name().to_owned(), tool);
    }

    pub fn set_retry_policy(&mut self, policy: RetryPolicy) {
        self.retry_policy = policy;
    }

    pub fn set_max_turns(&mut self, max_turns: usize) {
        self.max_turns = max_turns.min(MAX_TURNS);
    }

    pub fn run(
        &mut self,
        input: impl Into<String>,
        store: &mut dyn RunStateStore,
        cancellation: &CancellationToken,
        mut emit: impl FnMut(AgentEvent),
    ) -> Result<RunState, AgentError> {
        let input = input.into();
        let mut state = RunState {
            run_id: self.run_id.clone(),
            model: self.active_model.clone(),
            turn: 0,
            previous_response_id: None,
            transcript: vec![TranscriptItem::User(input.clone())],
            status: RunStatus::Running,
        };
        emit(AgentEvent::RunStarted {
            run_id: state.run_id.clone(),
            model: self.active_model.clone(),
        });

        let mut next_input = input;
        let mut next_tool_result = None;
        for turn in 1..=self.max_turns {
            if cancellation.is_cancelled() {
                state.turn = turn - 1;
                state.status = RunStatus::Cancelled;
                self.save(&state, store, &mut emit)?;
                emit(AgentEvent::Cancelled { turn: state.turn });
                return Ok(state);
            }

            state.turn = turn;
            state.model = self.active_model.clone();
            emit(AgentEvent::TurnStarted {
                turn,
                model: self.active_model.clone(),
            });

            let request = ModelRequest {
                turn,
                input: next_input,
                previous_response_id: state.previous_response_id.clone(),
                history: state.transcript.clone(),
                tool_result: next_tool_result.take(),
            };
            let reply = self.complete_with_retry(&request, cancellation, &mut emit)?;
            match reply {
                ModelReply::ToolCall {
                    call_id,
                    name,
                    input,
                    response_id,
                } => {
                    state.previous_response_id = response_id;
                    state.transcript.push(TranscriptItem::ToolCall {
                        call_id: call_id.clone(),
                        name: name.clone(),
                        input: input.clone(),
                    });
                    emit(AgentEvent::ToolCallStarted {
                        turn,
                        call_id: call_id.clone(),
                        name: name.clone(),
                        input: input.clone(),
                    });
                    let tool = self
                        .tools
                        .get_mut(&name)
                        .ok_or_else(|| AgentError::ToolNotFound(name.clone()))?;
                    let output = tool.call(&input);
                    emit(AgentEvent::ToolCallFinished {
                        turn,
                        call_id: call_id.clone(),
                        output: output
                            .clone()
                            .unwrap_or_else(|error| format!("error: {error}")),
                    });
                    let result = ToolResult {
                        call_id,
                        name,
                        input,
                        output,
                    };
                    state
                        .transcript
                        .push(TranscriptItem::ToolResult(result.clone()));
                    next_tool_result = Some(result);
                    next_input = String::new();
                    self.save(&state, store, &mut emit)?;
                }
                ModelReply::Text { text, response_id } => {
                    state.previous_response_id = response_id;
                    state
                        .transcript
                        .push(TranscriptItem::Assistant(text.clone()));
                    emit(AgentEvent::TextDelta {
                        turn,
                        text: text.clone(),
                    });
                    state.status = RunStatus::Completed;
                    self.save(&state, store, &mut emit)?;
                    emit(AgentEvent::Completed { turn, text });
                    return Ok(state);
                }
            }
        }

        state.status = RunStatus::Failed;
        self.save(&state, store, &mut emit)?;
        Err(AgentError::TurnLimit(self.max_turns))
    }

    fn complete_with_retry(
        &mut self,
        request: &ModelRequest,
        cancellation: &CancellationToken,
        emit: &mut impl FnMut(AgentEvent),
    ) -> Result<ModelReply, AgentError> {
        let mut attempt = 0;
        loop {
            if cancellation.is_cancelled() {
                return Err(AgentError::ModelFailed("cancelled".to_owned()));
            }
            let model = self
                .models
                .get_mut(&self.active_model)
                .ok_or_else(|| AgentError::UnknownModel(self.active_model.clone()))?;
            match model.complete(request, cancellation) {
                Ok(reply) => return Ok(reply),
                Err(ModelError::Permanent(error)) => return Err(AgentError::ModelFailed(error)),
                Err(ModelError::Transient(reason)) if attempt < self.retry_policy.max_retries => {
                    attempt += 1;
                    emit(AgentEvent::Retry {
                        model: self.active_model.clone(),
                        attempt,
                        reason,
                    });
                }
                Err(ModelError::Transient(error)) => return Err(AgentError::ModelFailed(error)),
            }
        }
    }

    fn save(
        &self,
        state: &RunState,
        store: &mut dyn RunStateStore,
        emit: &mut impl FnMut(AgentEvent),
    ) -> Result<(), AgentError> {
        store.save(state).map_err(AgentError::StoreFailed)?;
        emit(AgentEvent::RunSaved { turn: state.turn });
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResponsesRequest {
    pub model: String,
    pub input: String,
    pub previous_response_id: Option<String>,
    pub stream: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HttpRequest {
    pub url: String,
    pub headers: BTreeMap<String, String>,
    pub body: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AdapterError {
    InvalidBaseUrl(String),
    InvalidResponseStatus(u16),
}

impl fmt::Display for AdapterError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidBaseUrl(url) => write!(f, "invalid provider base URL: {url}"),
            Self::InvalidResponseStatus(status) => write!(f, "provider returned HTTP {status}"),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OpenAiCompatibleAdapter {
    base_url: String,
    api_key: String,
    model: String,
}

impl OpenAiCompatibleAdapter {
    pub fn new(
        base_url: impl Into<String>,
        api_key: impl Into<String>,
        model: impl Into<String>,
    ) -> Result<Self, AdapterError> {
        let base_url = normalize_base_url(&base_url.into())?;
        Ok(Self {
            base_url,
            api_key: api_key.into(),
            model: model.into(),
        })
    }

    pub fn endpoint(&self) -> String {
        if self.base_url.ends_with("/responses") {
            self.base_url.clone()
        } else {
            format!("{}/responses", self.base_url)
        }
    }

    pub fn request(
        &self,
        input: impl Into<String>,
        previous_response_id: Option<String>,
    ) -> HttpRequest {
        let request = ResponsesRequest {
            model: self.model.clone(),
            input: input.into(),
            previous_response_id,
            stream: true,
        };
        let mut headers = BTreeMap::from([
            ("content-type".to_owned(), "application/json".to_owned()),
            ("accept".to_owned(), "text/event-stream".to_owned()),
        ]);
        if !self.api_key.is_empty() {
            headers.insert(
                "authorization".to_owned(),
                format!("Bearer {}", self.api_key),
            );
        }
        HttpRequest {
            url: self.endpoint(),
            headers,
            body: request.to_json(),
        }
    }

    pub fn parse_stream(&self, status: u16, body: &str) -> Result<Vec<SseEvent>, AdapterError> {
        if !(200..300).contains(&status) {
            return Err(AdapterError::InvalidResponseStatus(status));
        }
        Ok(parse_sse(body))
    }
}

impl ResponsesRequest {
    pub fn to_json(&self) -> String {
        let mut fields = vec![
            format!("\"model\":\"{}\"", escape_json(&self.model)),
            format!(
                "\"input\":[{{\"role\":\"user\",\"content\":[{{\"type\":\"input_text\",\"text\":\"{}\"}}]}}]",
                escape_json(&self.input)
            ),
            format!("\"stream\":{}", self.stream),
        ];
        if let Some(previous_response_id) = &self.previous_response_id {
            fields.push(format!(
                "\"previous_response_id\":\"{}\"",
                escape_json(previous_response_id)
            ));
        }
        format!("{{{}}}", fields.join(","))
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SseEvent {
    pub event: Option<String>,
    pub id: Option<String>,
    pub data: String,
}

impl SseEvent {
    pub fn response_type(&self) -> Option<String> {
        self.event
            .clone()
            .or_else(|| json_string_field(&self.data, "type"))
    }
}

pub fn parse_sse(input: &str) -> Vec<SseEvent> {
    let normalized = input.replace("\r\n", "\n");
    normalized
        .split("\n\n")
        .filter_map(|record| {
            let mut event = None;
            let mut id = None;
            let mut data = Vec::new();
            for line in record.lines() {
                if line.starts_with(':') {
                    continue;
                }
                if let Some(value) = line.strip_prefix("event:") {
                    event = Some(value.trim_start().to_owned());
                } else if let Some(value) = line.strip_prefix("id:") {
                    id = Some(value.trim_start().to_owned());
                } else if let Some(value) = line.strip_prefix("data:") {
                    data.push(value.trim_start().to_owned());
                }
            }
            if data.is_empty() {
                None
            } else {
                Some(SseEvent {
                    event,
                    id,
                    data: data.join("\n"),
                })
            }
        })
        .collect()
}

fn normalize_base_url(input: &str) -> Result<String, AdapterError> {
    let trimmed = input.trim().trim_end_matches('/');
    let Some(scheme_end) = trimmed.find("://") else {
        return Err(AdapterError::InvalidBaseUrl(input.to_owned()));
    };
    let scheme = &trimmed[..scheme_end];
    if !matches!(scheme, "http" | "https") {
        return Err(AdapterError::InvalidBaseUrl(input.to_owned()));
    }
    let authority_start = scheme_end + 3;
    let authority_end = trimmed[authority_start..]
        .find('/')
        .map(|offset| authority_start + offset)
        .unwrap_or(trimmed.len());
    if authority_end == authority_start {
        return Err(AdapterError::InvalidBaseUrl(input.to_owned()));
    }
    if trimmed[authority_start..].contains('?') || trimmed[authority_start..].contains('#') {
        return Err(AdapterError::InvalidBaseUrl(input.to_owned()));
    }
    if trimmed[authority_end..].is_empty() {
        Ok(format!("{trimmed}/v1"))
    } else {
        Ok(trimmed.to_owned())
    }
}

fn escape_json(input: &str) -> String {
    let mut escaped = String::with_capacity(input.len());
    for character in input.chars() {
        match character {
            '"' => escaped.push_str("\\\""),
            '\\' => escaped.push_str("\\\\"),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            '\t' => escaped.push_str("\\t"),
            character if character.is_control() => {
                escaped.push_str(&format!("\\u{:04x}", character as u32))
            }
            character => escaped.push(character),
        }
    }
    escaped
}

fn json_string_field(input: &str, field: &str) -> Option<String> {
    let marker = format!("\"{field}\":\"");
    let start = input.find(&marker)? + marker.len();
    let remainder = &input[start..];
    let mut value = String::new();
    let mut escaped = false;
    for character in remainder.chars() {
        if escaped {
            value.push(match character {
                'n' => '\n',
                'r' => '\r',
                't' => '\t',
                character => character,
            });
            escaped = false;
        } else if character == '\\' {
            escaped = true;
        } else if character == '"' {
            return Some(value);
        } else {
            value.push(character);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    struct EchoTool;

    impl DartsnutTool for EchoTool {
        fn name(&self) -> &str {
            "echo"
        }

        fn call(&mut self, input: &str) -> Result<String, String> {
            Ok(format!("echo:{input}"))
        }
    }

    struct ScriptedModel {
        name: String,
        replies: VecDeque<Result<ModelReply, ModelError>>,
        requests: Vec<ModelRequest>,
    }

    impl ScriptedModel {
        fn new(
            name: &str,
            replies: impl IntoIterator<Item = Result<ModelReply, ModelError>>,
        ) -> Self {
            Self {
                name: name.to_owned(),
                replies: replies.into_iter().collect(),
                requests: Vec::new(),
            }
        }
    }

    impl CompletionModel for ScriptedModel {
        fn name(&self) -> &str {
            &self.name
        }

        fn complete(
            &mut self,
            request: &ModelRequest,
            _cancellation: &CancellationToken,
        ) -> Result<ModelReply, ModelError> {
            self.requests.push(request.clone());
            self.replies
                .pop_front()
                .unwrap_or_else(|| Err(ModelError::Permanent("script exhausted".to_owned())))
        }
    }

    #[test]
    fn tool_call_streams_events_and_persists_previous_response() {
        let model = ScriptedModel::new(
            "spike-model",
            [
                Ok(ModelReply::ToolCall {
                    call_id: "call-1".to_owned(),
                    name: "echo".to_owned(),
                    input: "dart".to_owned(),
                    response_id: Some("resp-1".to_owned()),
                }),
                Ok(ModelReply::Text {
                    text: "done".to_owned(),
                    response_id: Some("resp-2".to_owned()),
                }),
            ],
        );
        let mut agent = Agent::new("run-1", Box::new(model));
        agent.register_tool(Box::new(EchoTool));
        let token = CancellationToken::new();
        let mut store = MemoryRunStateStore::default();
        let mut events = Vec::new();

        let state = agent
            .run("make dart", &mut store, &token, |event| events.push(event))
            .expect("scripted agent completes");

        assert_eq!(state.status, RunStatus::Completed);
        assert_eq!(state.previous_response_id.as_deref(), Some("resp-2"));
        assert!(events.iter().any(|event| matches!(
            event,
            AgentEvent::ToolCallStarted { name, input, .. }
                if name == "echo" && input == "dart"
        )));
        assert!(events.iter().any(|event| matches!(
            event,
            AgentEvent::ToolCallFinished { output, .. } if output == "echo:dart"
        )));
        assert!(events.iter().any(|event| matches!(
            event,
            AgentEvent::Completed { text, .. } if text == "done"
        )));
        assert_eq!(store.load("run-1"), Some(state));
    }

    #[test]
    fn retries_transient_model_errors_and_emits_diagnostics() {
        let model = ScriptedModel::new(
            "retry-model",
            [
                Err(ModelError::Transient("gateway timeout".to_owned())),
                Ok(ModelReply::Text {
                    text: "recovered".to_owned(),
                    response_id: None,
                }),
            ],
        );
        let mut agent = Agent::new("run-retry", Box::new(model));
        agent.set_retry_policy(RetryPolicy { max_retries: 1 });
        let token = CancellationToken::new();
        let mut store = MemoryRunStateStore::default();
        let mut events = Vec::new();
        agent
            .run("retry", &mut store, &token, |event| events.push(event))
            .expect("retry succeeds");

        assert!(events.iter().any(|event| matches!(
            event,
            AgentEvent::Retry { attempt, reason, .. }
                if *attempt == 1 && reason == "gateway timeout"
        )));
    }

    #[test]
    fn cancellation_stops_before_model_call_and_persists_state() {
        let model = ScriptedModel::new(
            "cancel-model",
            [Ok(ModelReply::Text {
                text: "must not run".to_owned(),
                response_id: None,
            })],
        );
        let mut agent = Agent::new("run-cancel", Box::new(model));
        let token = CancellationToken::new();
        token.cancel();
        let mut store = MemoryRunStateStore::default();
        let state = agent
            .run("cancel", &mut store, &token, |_| {})
            .expect("cancellation is a terminal run state");

        assert_eq!(state.status, RunStatus::Cancelled);
        assert_eq!(state.turn, 0);
        assert_eq!(store.load("run-cancel"), Some(state));
    }

    #[test]
    fn model_switching_changes_run_route() {
        let first = ScriptedModel::new(
            "first",
            [Ok(ModelReply::Text {
                text: "first".to_owned(),
                response_id: None,
            })],
        );
        let second = ScriptedModel::new(
            "second",
            [Ok(ModelReply::Text {
                text: "second".to_owned(),
                response_id: None,
            })],
        );
        let mut agent = Agent::new("run-switch", Box::new(first));
        agent.add_model(Box::new(second));
        agent.switch_model("second").expect("model registered");
        let mut store = MemoryRunStateStore::default();
        let state = agent
            .run("switch", &mut store, &CancellationToken::new(), |_| {})
            .expect("second model completes");

        assert_eq!(state.model, "second");
    }

    #[test]
    fn turn_limit_is_bounded_at_128() {
        let replies = std::iter::repeat_with(|| {
            Ok(ModelReply::ToolCall {
                call_id: "call".to_owned(),
                name: "echo".to_owned(),
                input: "loop".to_owned(),
                response_id: None,
            })
        })
        .take(MAX_TURNS);
        let mut agent = Agent::new("run-limit", Box::new(ScriptedModel::new("loop", replies)));
        agent.set_max_turns(MAX_TURNS + 1);
        agent.register_tool(Box::new(EchoTool));
        let mut store = MemoryRunStateStore::default();
        let error = agent
            .run("loop", &mut store, &CancellationToken::new(), |_| {})
            .expect_err("loop reaches turn limit");

        assert_eq!(error, AgentError::TurnLimit(MAX_TURNS));
        assert_eq!(
            store.load("run-limit").expect("saved state").turn,
            MAX_TURNS
        );
    }

    #[test]
    fn adapter_normalizes_bare_origin_and_preserves_previous_response_id() {
        let adapter =
            OpenAiCompatibleAdapter::new("https://gateway.example.test/", "secret", "model-x")
                .expect("valid provider URL");
        let request = adapter.request("continue", Some("resp-1".to_owned()));

        assert_eq!(request.url, "https://gateway.example.test/v1/responses");
        assert_eq!(request.headers["authorization"], "Bearer secret");
        assert!(request.body.contains("\"stream\":true"));
        assert!(request.body.contains("\"previous_response_id\":\"resp-1\""));
    }

    #[test]
    fn adapter_accepts_versioned_and_responses_endpoints() {
        let versioned = OpenAiCompatibleAdapter::new("http://localhost:4000/v1", "", "m")
            .expect("versioned URL");
        let responses =
            OpenAiCompatibleAdapter::new("http://localhost:4000/custom/responses", "", "m")
                .expect("responses URL");

        assert_eq!(versioned.endpoint(), "http://localhost:4000/v1/responses");
        assert_eq!(
            responses.endpoint(),
            "http://localhost:4000/custom/responses"
        );
    }

    #[test]
    fn sse_parser_preserves_event_order_and_multiline_data() {
        let events = parse_sse(
            &("event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"Hi\"}\n\n"
                .to_owned()
                + "id: 2\ndata: {\"type\":\"response.completed\"}\n\n"),
        );

        assert_eq!(events.len(), 2);
        assert_eq!(
            events[0].response_type().as_deref(),
            Some("response.output_text.delta")
        );
        assert_eq!(events[1].id.as_deref(), Some("2"));
        assert_eq!(
            events[1].response_type().as_deref(),
            Some("response.completed")
        );
    }

    #[test]
    fn adapter_rejects_invalid_status_and_urls() {
        assert!(OpenAiCompatibleAdapter::new("gateway.example.test", "", "m").is_err());
        let adapter = OpenAiCompatibleAdapter::new("http://gateway.example.test/v1", "", "m")
            .expect("valid URL");
        assert_eq!(
            adapter.parse_stream(502, ""),
            Err(AdapterError::InvalidResponseStatus(502))
        );
    }

    #[test]
    fn actual_rig_agent_builder_compiles_with_tool_runtime() {
        use rig_agent::agent::AgentBuilder;
        use rig_agent::test_utils::MockCompletionModel;

        let _agent = AgentBuilder::new(MockCompletionModel::text("ok"))
            .preamble("Dartsnut tool runtime")
            .build();
    }
}
