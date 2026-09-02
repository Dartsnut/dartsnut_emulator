//! Rig agent construction boundary.
//!
//! The production transport keeps Dartsnut's Responses adapter for arbitrary
//! gateways, while this module validates and constructs Rig's native agent
//! runtime for compatible OpenAI endpoints.

use base64::Engine;
use futures_util::StreamExt;
use rig_agent::prelude::{CompletionClient, MultiTurnStreamItem, StreamingPrompt};
use rig_agent::{
    core::streaming::{StreamedAssistantContent, StreamedUserContent},
    tool::{DynamicTool, ToolExecutionError, ToolOutput},
    Agent, AgentBuilder,
};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Manager};
use tokio::time::{sleep, Duration};

/// Production agent turn budget. Matches legacy @openai/agents loop limit.
pub const MAX_TURNS: usize = 128;

/// Events emitted by Rig's native multi-turn stream. Keep provider payloads out
/// of renderer events; only normalized text/tool metadata crosses this boundary.
#[derive(Debug, Clone, PartialEq)]
pub enum StreamEvent {
    TextDelta(String),
    ToolCall { name: String, arguments: Value },
    ToolResult { name: String },
}

#[derive(Debug, Clone, PartialEq)]
pub struct StreamOutcome {
    pub output: String,
    pub response_id: Option<String>,
}

/// Build Rig's native agent runtime for an OpenAI Responses-compatible gateway.
///
/// Hosted tools are intentionally not registered: web search and code
/// interpreter were removed from the revised feature set. Dartsnut-local tools
/// can be attached by callers through Rig's dynamic tool APIs before execution.
pub fn build_agent(
    base_url: &str,
    api_key: &str,
    model: &str,
    preamble: Option<&str>,
) -> Result<Agent, String> {
    build_agent_with_tools(base_url, api_key, model, preamble, None)
}

/// Build an agent and attach the local workspace tools used by Dartsnut.
/// `workspace_root` is optional for configuration-only callers and mandatory
/// at execution time for tools to become useful.
pub fn build_agent_with_tools(
    base_url: &str,
    api_key: &str,
    model: &str,
    preamble: Option<&str>,
    workspace_root: Option<PathBuf>,
) -> Result<Agent, String> {
    build_agent_with_context(base_url, api_key, model, preamble, workspace_root, None)
}

pub fn build_agent_with_context(
    base_url: &str,
    api_key: &str,
    model: &str,
    preamble: Option<&str>,
    workspace_root: Option<PathBuf>,
    app: Option<AppHandle>,
) -> Result<Agent, String> {
    crate::ensure_rustls_crypto_provider();
    let http_client = crate::proxy::client_for_url(base_url)?;
    build_agent_with_http_client(
        base_url,
        api_key,
        model,
        preamble,
        workspace_root,
        app,
        http_client,
    )
}

/// Async agent construction used by production execution. Allows remote PAC
/// scripts to be fetched before Rig starts its provider stream.
pub async fn build_agent_with_context_async(
    base_url: &str,
    api_key: &str,
    model: &str,
    preamble: Option<&str>,
    workspace_root: Option<PathBuf>,
    app: Option<AppHandle>,
) -> Result<Agent, String> {
    crate::ensure_rustls_crypto_provider();
    let http_client = crate::proxy::client_for_url_async(base_url).await?;
    build_agent_with_http_client(
        base_url,
        api_key,
        model,
        preamble,
        workspace_root,
        app,
        http_client,
    )
}

fn build_agent_with_http_client(
    base_url: &str,
    api_key: &str,
    model: &str,
    preamble: Option<&str>,
    workspace_root: Option<PathBuf>,
    app: Option<AppHandle>,
    http_client: reqwest::Client,
) -> Result<Agent, String> {
    let client = rig_agent::core::providers::openai::Client::builder()
        .api_key(api_key)
        .base_url(base_url)
        .http_client(http_client)
        .build()
        .map_err(|error| error.to_string())?;
    let mut builder = AgentBuilder::new(client.completion_model(model))
        .name("dartsnut-agent")
        .default_max_turns(MAX_TURNS);
    if let Some(preamble) = preamble.filter(|value| !value.trim().is_empty()) {
        builder = builder.preamble(preamble);
    }
    Ok(match workspace_root {
        Some(root) => builder
            .dynamic_tools(workspace_tools_with_context(root, app))
            .build(),
        None => builder.build(),
    })
}

fn workspace_tools_with_context(root: PathBuf, app: Option<AppHandle>) -> Vec<DynamicTool> {
    let schemas = |name: &str| match name {
        "list_files" => {
            serde_json::json!({"type":"object","properties":{"path":{"type":"string"},"max_results":{"type":"number"}}})
        }
        "read_file" => {
            serde_json::json!({"type":"object","properties":{"path":{"type":"string"},"offset":{"type":"number"},"limit":{"type":"number"}},"required":["path"]})
        }
        "write_file" => {
            serde_json::json!({"type":"object","properties":{"path":{"type":"string"},"content":{"type":"string"}},"required":["path","content"]})
        }
        "replace_in_file" => {
            serde_json::json!({"type":"object","properties":{"path":{"type":"string"},"find":{"type":"string"},"replace":{"type":"string"},"replace_all":{"type":"boolean"}},"required":["path","find","replace"]})
        }
        "grep_files" => {
            serde_json::json!({"type":"object","properties":{"pattern":{"type":"string"},"glob":{"type":"string"},"path":{"type":"string"},"ignore_case":{"type":"boolean"},"max_results":{"type":"number"}},"required":["pattern"],"additionalProperties":false})
        }
        "glob_files" => {
            serde_json::json!({"type":"object","properties":{"pattern":{"type":"string"},"path":{"type":"string"},"max_results":{"type":"number"}},"required":["pattern"]})
        }
        "get_dartsnut_skill" => {
            serde_json::json!({"type":"object","properties":{"skill_id":{"type":"string","enum":["dartsnut-core","dartsnut-game","dartsnut-widget","dartsnut-assets"]}},"required":["skill_id"],"additionalProperties":false})
        }
        "check_python" => {
            serde_json::json!({"type":"object","properties":{"paths":{"type":"array","items":{"type":"string"}}},"additionalProperties":false})
        }
        "copy_asset_file" => {
            serde_json::json!({"type":"object","properties":{"source":{"type":"string"},"path":{"type":"string"}},"required":["source","path"]})
        }
        "copy_chat_attachment" => {
            serde_json::json!({"type":"object","properties":{"attachment_id":{"type":"string"},"path":{"type":"string"},"overwrite":{"type":"boolean"}},"required":["attachment_id","path"]})
        }
        _ => serde_json::json!({"type":"object"}),
    };
    let names = [
        "list_files",
        "read_file",
        "write_file",
        "replace_in_file",
        "grep_files",
        "glob_files",
        "get_dartsnut_skill",
        "check_python",
        "copy_asset_file",
        "copy_chat_attachment",
    ];
    let app_for_workspace = app.clone();
    let mut tools = names
        .into_iter()
        .map(|name| {
            let root = root.clone();
            let app = app_for_workspace.clone();
            let description = match name {
                "list_files" => "List files inside the workspace recursively.",
                "read_file" => "Read a UTF-8 workspace file, optionally selecting line ranges.",
                "write_file" => "Write UTF-8 content to a workspace file.",
                "replace_in_file" => "Replace text in an existing workspace file.",
                "grep_files" => "Search workspace files for matching text.",
                "glob_files" => "List workspace files matching a glob pattern.",
                "get_dartsnut_skill" => "Load one bundled Dartsnut domain skill by ID.",
                "check_python" => {
                    "Run Python syntax checks on workspace files without executing them."
                }
                "copy_asset_file" => "Copy a binary asset into the workspace.",
                "copy_chat_attachment" => "Copy a chat attachment into the workspace.",
                _ => "Dartsnut workspace tool.",
            };
            DynamicTool::new(name, description, schemas(name), move |_ctx, args| {
                let root = root.clone();
                let app = app.clone();
                Box::pin(async move {
                    if name == "check_python" {
                        execute_check_python(&root, args).await
                    } else if name == "get_dartsnut_skill" {
                        execute_get_skill(&root, args)
                    } else {
                        execute_workspace_tool_with_app(name, &root, args, app.as_ref())
                    }
                    .map(ToolOutput::json)
                    .map_err(ToolExecutionError::other)
                })
            })
        })
        .collect::<Vec<_>>();
    if let Some(app) = app {
        let app_for_tool = app.clone();
        tools.push(DynamicTool::new(
            "ask_user_question",
            "Ask the user one concise question and wait for their answer.",
            serde_json::json!({
                "type":"object",
                "properties": {
                    "question":{"type":"string"},
                    "options":{"type":"array","items":{"type":"object","properties":{"value":{"type":"string"},"label":{"type":"string"}},"required":["value","label"]}},
                    "allow_free_text":{"type":"boolean"},
                    "free_text_placeholder":{"type":"string"}
                },
                "required":["question"]
            }),
            move |_ctx, args| {
                let app = app_for_tool.clone();
                Box::pin(async move {
                    let question = args
                        .get("question")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .ok_or_else(|| ToolExecutionError::other("Question is required."))?
                        .to_owned();
                    let options = args.get("options").and_then(Value::as_array).map(|entries| {
                        entries
                            .iter()
                            .filter_map(|entry| {
                                Some(crate::pending_inputs::AgentQuestionOption {
                                    value: entry.get("value")?.as_str()?.trim().to_owned(),
                                    label: entry.get("label")?.as_str()?.trim().to_owned(),
                                })
                            })
                            .filter(|entry| !entry.value.is_empty() && !entry.label.is_empty())
                            .take(3)
                            .collect::<Vec<_>>()
                    }).filter(|entries| !entries.is_empty());
                    let prompt = crate::pending_inputs::AgentQuestionPrompt {
                        question,
                        options,
                        allow_free_text: args.get("allow_free_text").and_then(Value::as_bool),
                        free_text_placeholder: args.get("free_text_placeholder").and_then(Value::as_str).map(str::trim).filter(|value| !value.is_empty()).map(str::to_owned),
                    };
                    let state = app.state::<crate::commands::AppState>();
                    let answer = crate::pending_inputs::ask_user_question(&app, &state, prompt).await;
                    Ok(ToolOutput::json(serde_json::json!(match answer {
                        Some(answer) => { serde_json::json!({"ok":true,"answer":answer}) },
                        None => { serde_json::json!({"ok":false,"cancelled":true}) },
                    })))
                })
            },
        ));
        let host_tools = [
            (
                "reload_emulator",
                "Reload emulator widget and re-read conf.json.",
            ),
            (
                "observe_emulator",
                "Observe latest emulator frame and state.",
            ),
            ("control_emulator_input", "Drive emulator input actions."),
            ("run_emulator_scenario", "Run bounded emulator scenario."),
            ("get_emulator_logs", "Read recent emulator logs."),
            (
                "dartsnut_machine_mcp",
                "Interact with connected Dartsnut machine MCP.",
            ),
            (
                "pixellab_generate",
                "Generate pixel art through hosted PixelLab bridge.",
            ),
        ];
        for (name, description) in host_tools {
            let app_for_tool = app.clone();
            let root_for_tool = root.clone();
            let schema = match name {
                "reload_emulator" => {
                    serde_json::json!({"type":"object","properties":{"params":{"type":"object"},"clear_inputs":{"type":"boolean"},"wait_for_frame_ms":{"type":"number"}}})
                }
                "observe_emulator" => {
                    serde_json::json!({"type":"object","properties":{"include_png":{"type":"boolean"},"include_hardware_mockup":{"type":"boolean"},"wait_for_frame_ms":{"type":"number"},"max_log_lines":{"type":"number"}}})
                }
                "control_emulator_input" => {
                    serde_json::json!({"type":"object","properties":{"action":{"type":"object"}},"required":["action"]})
                }
                "run_emulator_scenario" => {
                    serde_json::json!({"type":"object","properties":{"steps":{"type":"array"},"timeout_ms":{"type":"number"}},"required":["steps"]})
                }
                "get_emulator_logs" => {
                    serde_json::json!({"type":"object","properties":{"max_lines":{"type":"number"}}})
                }
                "dartsnut_machine_mcp" => {
                    serde_json::json!({"type":"object","properties":{"action":{"type":"string","enum":["connect","list_tools","call_tool","disconnect"]},"tool_name":{"type":"string"},"arguments":{"type":"object"}},"required":["action"]})
                }
                "pixellab_generate" => serde_json::json!({"type":"object"}),
                _ => serde_json::json!({"type":"object"}),
            };
            tools.push(DynamicTool::new(
                name,
                description,
                schema,
                move |_ctx, args| {
                    let app = app_for_tool.clone();
                    let root = root_for_tool.clone();
                    Box::pin(async move {
                        execute_host_tool(name, &app, &root, args)
                            .await
                            .map(ToolOutput::json)
                            .map_err(ToolExecutionError::other)
                    })
                },
            ));
        }
    }
    tools
}

async fn execute_host_tool(
    name: &str,
    app: &AppHandle,
    workspace_root: &Path,
    args: Value,
) -> Result<Value, String> {
    let state = app.state::<crate::commands::AppState>();
    match name {
        "reload_emulator" => {
            if args
                .get("clear_inputs")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                let _ = state
                    .emulator
                    .send(
                        app,
                        Some(workspace_root),
                        serde_json::json!({"type":"clear_darts"}),
                    )
                    .await;
            }
            let path = state
                .emulator
                .last_path()
                .unwrap_or_else(|| workspace_root.to_string_lossy().into_owned());
            state
                .emulator
                .send(
                    app,
                    Some(workspace_root),
                    serde_json::json!({"type":"set_path","path":path}),
                )
                .await?;
            if let Some(params) = args.get("params") {
                state
                    .emulator
                    .send(
                        app,
                        Some(workspace_root),
                        serde_json::json!({"type":"set_params","params":params}),
                    )
                    .await?;
            }
            state
                .emulator
                .send(
                    app,
                    Some(workspace_root),
                    serde_json::json!({"type":"reload_widget"}),
                )
                .await?;
            Ok(serde_json::json!({"ok":true,"message":"Emulator reloaded"}))
        }
        "control_emulator_input" => {
            let action = args.get("action").cloned().ok_or("action is required")?;
            let action_type = action.get("type").and_then(Value::as_str).unwrap_or("");
            let command = match action_type {
                "throw_dart" => {
                    serde_json::json!({"type":"throw_dart","index":action.get("index"),"x":action.get("x"),"y":action.get("y")})
                }
                "remove_dart" => {
                    serde_json::json!({"type":"remove_dart_at","x":action.get("x"),"y":action.get("y")})
                }
                "clear_darts" => serde_json::json!({"type":"clear_darts"}),
                "set_button" => {
                    serde_json::json!({"type":"set_button","button":action.get("button"),"pressed":action.get("pressed")})
                }
                "tap_button" => {
                    serde_json::json!({"type":"set_button","button":action.get("button"),"pressed":true})
                }
                _ => return Ok(serde_json::json!({"ok":false,"error":"unsupported input action"})),
            };
            state
                .emulator
                .send(app, Some(workspace_root), command)
                .await?;
            Ok(serde_json::json!({"ok":true}))
        }
        "run_emulator_scenario" => {
            let steps = args
                .get("steps")
                .and_then(Value::as_array)
                .ok_or("steps is required")?;
            if steps.len() > 30 {
                return Ok(serde_json::json!({"ok":false,"error":"scenario exceeds 30 steps"}));
            }
            let mut results = Vec::new();
            for step in steps {
                let kind = step.get("type").and_then(Value::as_str).unwrap_or("");
                let result = match kind {
                    "reload" => execute_reload_emulator(app, workspace_root, step).await?,
                    "input" => execute_control_emulator_input(app, workspace_root, step).await?,
                    "delay" => {
                        sleep(Duration::from_millis(
                            step.get("ms")
                                .and_then(Value::as_u64)
                                .unwrap_or(0)
                                .min(30_000),
                        ))
                        .await;
                        serde_json::json!({"ok":true})
                    }
                    "logs" | "observe" | "wait_frame" => {
                        serde_json::json!({"ok":true,"message":"event emitted by emulator bridge"})
                    }
                    _ => {
                        serde_json::json!({"ok":false,"error":format!("unsupported scenario step: {kind}")})
                    }
                };
                results.push(result);
            }
            Ok(serde_json::json!({"ok":true,"results":results}))
        }
        "observe_emulator" => Ok(
            serde_json::json!({"ok":true,"running":state.emulator.last_path().is_some(),"widgetPath":state.emulator.last_path(),"message":"Frame state emitted via emulator events"}),
        ),
        "get_emulator_logs" => Ok(
            serde_json::json!({"ok":true,"logs":[],"running":state.emulator.last_path().is_some(),"message":"Logs emitted via emulator events"}),
        ),
        "dartsnut_machine_mcp" => execute_machine_mcp(app, args).await,
        "pixellab_generate" => execute_pixellab(app, workspace_root, args).await,
        _ => Ok(serde_json::json!({"ok":false,"error":format!("unsupported tool: {name}")})),
    }
}

#[derive(Clone, Debug)]
struct MachineMcpSession {
    url: String,
    tools: Value,
}

static MACHINE_MCP_SESSION: OnceLock<Mutex<Option<MachineMcpSession>>> = OnceLock::new();

fn machine_mcp_session() -> &'static Mutex<Option<MachineMcpSession>> {
    MACHINE_MCP_SESSION.get_or_init(|| Mutex::new(None))
}

async fn machine_mcp_rpc(url: &str, method: &str, params: Option<Value>) -> Result<Value, String> {
    let client = crate::proxy::client_for_url(url)?;
    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": uuid::Uuid::new_v4().to_string(),
        "method": method,
        "params": params.unwrap_or_else(|| serde_json::json!({}))
    });
    let response = client
        .post(url)
        .header("Accept", "application/json, text/event-stream")
        .json(&body)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let status = response.status();
    let raw = response.text().await.map_err(|error| error.to_string())?;
    if !status.is_success() {
        return Err(format!("machine MCP HTTP {}", status.as_u16()));
    }
    let value: Value = match serde_json::from_str(&raw) {
        Ok(value) => value,
        Err(error) => {
            let data = raw
                .lines()
                .filter_map(|line| line.strip_prefix("data:"))
                .map(str::trim)
                .find(|line| !line.is_empty() && *line != "[DONE]")
                .ok_or_else(|| format!("invalid machine MCP response: {error}"))?;
            serde_json::from_str(data)
                .map_err(|error| format!("invalid machine MCP response: {error}"))?
        }
    };
    if let Some(error) = value.get("error") {
        return Err(format!("machine MCP error: {error}"));
    }
    Ok(value.get("result").cloned().unwrap_or(value))
}

async fn execute_machine_mcp(app: &AppHandle, args: Value) -> Result<Value, String> {
    let action = args.get("action").and_then(Value::as_str).unwrap_or("");
    match action {
        "connect" => {
            let machines = match crate::parity::community_list_deploy_devices(app.clone()).await {
                Ok(value) => value
                    .get("devices")
                    .and_then(Value::as_array)
                    .map(|rows| {
                        rows.iter()
                            .filter_map(|row| {
                                Some(crate::pending_inputs::MachineMcpQuestionMachine {
                                    device_id: row.get("deviceId")?.as_str()?.to_owned(),
                                    name: row
                                        .get("name")
                                        .and_then(Value::as_str)
                                        .unwrap_or_default()
                                        .to_owned(),
                                    model: row
                                        .get("model")
                                        .and_then(Value::as_str)
                                        .unwrap_or_default()
                                        .to_owned(),
                                    ip_address: row.get("ipAddress")?.as_str()?.to_owned(),
                                    ssid: row
                                        .get("ssid")
                                        .and_then(Value::as_str)
                                        .unwrap_or_default()
                                        .to_owned(),
                                    updated_at: row
                                        .get("updatedAt")
                                        .and_then(Value::as_str)
                                        .map(str::to_owned),
                                })
                            })
                            .filter(|machine| !machine.ip_address.is_empty())
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default(),
                Err(_) => Vec::new(),
            };
            let answer = crate::pending_inputs::ask_machine(
                app,
                &app.state::<crate::commands::AppState>(),
                machines,
            )
            .await
            .ok_or_else(|| "Machine selection cancelled.".to_owned())?;
            let host = answer.host.trim().trim_end_matches('/');
            let url = machine_mcp_url(host);
            let _ = machine_mcp_rpc(
                &url,
                "initialize",
                Some(serde_json::json!({
                "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": {"name":"dartsnut-agent","version":env!("CARGO_PKG_VERSION")}
                })),
            )
            .await?;
            let tools = machine_mcp_rpc(&url, "tools/list", None).await?;
            *machine_mcp_session()
                .lock()
                .map_err(|_| "machine MCP state unavailable")? = Some(MachineMcpSession {
                url: url.clone(),
                tools: tools.clone(),
            });
            Ok(serde_json::json!({"ok":true,"host":host,"url":url,"tools":tools}))
        }
        "list_tools" => {
            let session = machine_mcp_session()
                .lock()
                .map_err(|_| "machine MCP state unavailable")?
                .clone()
                .ok_or_else(|| "Machine MCP is not connected.".to_owned())?;
            let tools = machine_mcp_rpc(&session.url, "tools/list", None).await?;
            if let Ok(mut slot) = machine_mcp_session().lock() {
                if let Some(current) = slot.as_mut() {
                    current.tools = tools.clone();
                }
            }
            Ok(serde_json::json!({"ok":true,"tools":tools}))
        }
        "call_tool" => {
            let session = machine_mcp_session()
                .lock()
                .map_err(|_| "machine MCP state unavailable")?
                .clone()
                .ok_or_else(|| "Machine MCP is not connected.".to_owned())?;
            let name = args
                .get("tool_name")
                .and_then(Value::as_str)
                .filter(|v| !v.trim().is_empty())
                .ok_or_else(|| "tool_name is required".to_owned())?;
            let known = session
                .tools
                .get("tools")
                .and_then(Value::as_array)
                .is_some_and(|tools| {
                    tools
                        .iter()
                        .any(|tool| tool.get("name").and_then(Value::as_str) == Some(name))
                });
            if !known {
                return Ok(
                    serde_json::json!({"ok":false,"error":"tool_name was not returned by tools/list"}),
                );
            }
            let result = machine_mcp_rpc(&session.url, "tools/call", Some(serde_json::json!({"name":name,"arguments":args.get("arguments").cloned().unwrap_or_else(|| serde_json::json!({}))}))).await?;
            Ok(serde_json::json!({"ok":true,"result":result}))
        }
        "disconnect" => {
            if let Ok(mut slot) = machine_mcp_session().lock() {
                *slot = None;
            }
            Ok(serde_json::json!({"ok":true}))
        }
        _ => Ok(
            serde_json::json!({"ok":false,"error":"action must be connect, list_tools, call_tool, or disconnect"}),
        ),
    }
}

async fn execute_pixellab(
    app: &AppHandle,
    workspace_root: &Path,
    args: Value,
) -> Result<Value, String> {
    let token = crate::parity::community_token(app)
        .ok_or_else(|| "Sign in to use PixelLab generation.".to_owned())?;
    let base = format!("{}/agent/pixellab", crate::parity::community_base_url());
    let generation_id = args
        .get("generation_id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_owned();
    let mut pending = if generation_id.is_empty() {
        let operation = args.get("operation").and_then(Value::as_str).unwrap_or("");
        if operation != "image" && operation != "animation" {
            return Ok(
                serde_json::json!({"ok":false,"code":"INVALID_REQUEST","error":"operation must be image or animation."}),
            );
        }
        let prompt = args
            .get("prompt")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        if prompt.is_empty() {
            return Ok(
                serde_json::json!({"ok":false,"code":"INVALID_REQUEST","error":"prompt is required."}),
            );
        }
        let width = positive_u64(args.get("width"), "width")?;
        let height = positive_u64(args.get("height"), "height")?;
        let mut request = serde_json::json!({"operation":operation,"width":width,"height":height,"no_background":args.get("no_background").and_then(Value::as_bool).unwrap_or(true)});
        if let Some(seed) = args.get("seed").and_then(Value::as_i64) {
            request["seed"] = serde_json::json!(seed);
        }
        if operation == "image" {
            request["description"] = serde_json::json!(prompt);
        } else {
            let reference = args
                .get("reference_path")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            if reference.is_empty() {
                return Ok(
                    serde_json::json!({"ok":false,"code":"INVALID_REQUEST","error":"reference_path is required for animation."}),
                );
            }
            let path = safe_path(workspace_root, Some(&Value::String(reference.to_owned())))?;
            let bytes = std::fs::read(&path)
                .map_err(|_| "reference_path must be a readable PNG or JPEG image.")?;
            let (mime, rw, rh) = image_info(&bytes)
                .ok_or_else(|| "reference_path must be a readable PNG or JPEG image.".to_owned())?;
            request["action"] = serde_json::json!(prompt);
            request["reference_image"] = serde_json::json!(format!(
                "data:{mime};base64,{}",
                base64::engine::general_purpose::STANDARD.encode(bytes)
            ));
            request["reference_width"] = serde_json::json!(rw);
            request["reference_height"] = serde_json::json!(rh);
            request["view"] =
                serde_json::json!(args.get("view").and_then(Value::as_str).unwrap_or("none"));
            request["direction"] = serde_json::json!(args
                .get("direction")
                .and_then(Value::as_str)
                .unwrap_or("none"));
        }
        let (status, data) =
            pixellab_http(&format!("{base}/generate"), &token, Some(request)).await?;
        if status != 202 || data.get("status").and_then(Value::as_str) != Some("processing") {
            return Err("PixelLab bridge did not accept the generation.".to_owned());
        }
        data
    } else {
        let (_, data) = pixellab_http(
            &format!("{base}/generations/{}", encode_path_segment(&generation_id)),
            &token,
            None,
        )
        .await?;
        if data.get("status").and_then(Value::as_str) == Some("completed") {
            return write_pixellab_assets(workspace_root, &args, data);
        }
        data
    };
    let deadline = tokio::time::Instant::now() + Duration::from_secs(600);
    loop {
        if tokio::time::Instant::now() >= deadline {
            return Ok(
                serde_json::json!({"ok":false,"code":"PIXELLAB_PENDING","error":"PixelLab generation is still processing. Resume with this generation_id.","generation_id":pending.get("generation_id"),"operation":pending.get("operation"),"width":pending.get("width"),"height":pending.get("height"),"quota":pending.get("quota")}),
            );
        }
        sleep(Duration::from_millis(
            pending
                .get("poll_after_ms")
                .and_then(Value::as_u64)
                .unwrap_or(5_000)
                .clamp(500, 30_000),
        ))
        .await;
        let id = pending
            .get("generation_id")
            .and_then(Value::as_str)
            .ok_or("PixelLab response missing generation_id")?;
        let (_, next) = pixellab_http(
            &format!("{base}/generations/{}", encode_path_segment(id)),
            &token,
            None,
        )
        .await?;
        if next.get("status").and_then(Value::as_str) == Some("completed") {
            return write_pixellab_assets(workspace_root, &args, next);
        }
        pending = next;
    }
}

fn positive_u64(value: Option<&Value>, name: &str) -> Result<u64, String> {
    let value = value
        .and_then(Value::as_u64)
        .filter(|value| *value > 0)
        .ok_or_else(|| format!("{name} must be a positive integer."))?;
    Ok(value)
}

fn encode_path_segment(value: &str) -> String {
    value.bytes().fold(String::new(), |mut out, byte| {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(byte as char);
        } else {
            out.push('%');
            out.push_str(&format!("{byte:02X}"));
        }
        out
    })
}

fn image_info(bytes: &[u8]) -> Option<(&'static str, u32, u32)> {
    if bytes.len() >= 24 && bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some((
            "image/png",
            u32::from_be_bytes(bytes[16..20].try_into().ok()?),
            u32::from_be_bytes(bytes[20..24].try_into().ok()?),
        ));
    }
    if bytes.len() >= 4 && bytes[..2] == [0xff, 0xd8] {
        let mut offset = 2;
        while offset + 9 < bytes.len() {
            if bytes[offset] != 0xff {
                offset += 1;
                continue;
            }
            let marker = bytes[offset + 1];
            let len = u16::from_be_bytes([bytes[offset + 2], bytes[offset + 3]]) as usize;
            if matches!(marker, 0xc0..=0xc3 | 0xc5..=0xc7 | 0xc9..=0xcb | 0xcd..=0xcf)
                && offset + 9 < bytes.len()
            {
                return Some((
                    "image/jpeg",
                    u16::from_be_bytes([bytes[offset + 5], bytes[offset + 6]]) as u32,
                    u16::from_be_bytes([bytes[offset + 7], bytes[offset + 8]]) as u32,
                ));
            }
            if len < 2 {
                break;
            }
            offset += 2 + len;
        }
    }
    None
}

async fn pixellab_http(
    url: &str,
    token: &str,
    body: Option<Value>,
) -> Result<(u16, Value), String> {
    let client = crate::proxy::client_for_url(url)?;
    let mut request = client
        .post(url)
        .header("Accept", "application/json")
        .header("token", token)
        .header("x-dartsnut-source", "desktop-tauri");
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request
        .send()
        .await
        .map_err(|_| "Could not reach the Dartsnut PixelLab bridge.".to_owned())?;
    let status = response.status().as_u16();
    let raw = response.text().await.map_err(|error| error.to_string())?;
    let envelope: Value = serde_json::from_str(&raw)
        .map_err(|_| "PixelLab bridge returned an invalid response.".to_owned())?;
    if status != 202 && !((200..300).contains(&status)) {
        return Err(envelope
            .get("desc")
            .or_else(|| envelope.get("msg"))
            .and_then(Value::as_str)
            .unwrap_or("PixelLab generation failed.")
            .to_owned());
    }
    if envelope.get("code").and_then(Value::as_i64) != Some(1001) {
        return Err(envelope
            .get("desc")
            .or_else(|| envelope.get("msg"))
            .and_then(Value::as_str)
            .unwrap_or("PixelLab generation failed.")
            .to_owned());
    }
    Ok((
        status,
        envelope
            .get("data")
            .cloned()
            .ok_or_else(|| "PixelLab bridge returned invalid data.".to_owned())?,
    ))
}

fn write_pixellab_assets(
    workspace_root: &Path,
    args: &Value,
    result: Value,
) -> Result<Value, String> {
    let assets = result
        .get("assets")
        .and_then(Value::as_array)
        .ok_or("PixelLab bridge returned invalid assets.")?;
    let operation = result
        .get("operation")
        .and_then(Value::as_str)
        .unwrap_or("image");
    let generation_id = result
        .get("generation_id")
        .and_then(Value::as_str)
        .unwrap_or("generation");
    let destination = args
        .get("output_path")
        .and_then(Value::as_str)
        .filter(|v| !v.trim().is_empty())
        .unwrap_or("");
    let fallback = format!(
        "assets/pixellab/{}-{}",
        operation,
        &generation_id[..generation_id.len().min(8)]
    );
    let destination = if destination.is_empty() {
        fallback
    } else {
        destination.replace('\\', "/")
    };
    let requested_ext = Path::new(&destination)
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mut paths = Vec::new();
    for (index, asset) in assets.iter().enumerate() {
        let mime = asset.get("mime_type").and_then(Value::as_str).unwrap_or("");
        let extension = match mime {
            "image/png" => "png",
            "image/jpeg" => "jpg",
            "image/gif" => "gif",
            "image/webp" => "webp",
            _ => return Err("Unsupported PixelLab asset type.".to_owned()),
        };
        let encoded = asset
            .get("data_base64")
            .and_then(Value::as_str)
            .ok_or("PixelLab bridge returned invalid asset bytes.")?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|_| "PixelLab bridge returned invalid asset bytes.")?;
        if asset.get("byte_length").and_then(Value::as_u64) != Some(bytes.len() as u64) {
            return Err("PixelLab bridge returned invalid asset bytes.".to_owned());
        }
        let relative = if matches!(
            requested_ext.as_str(),
            "png" | "jpg" | "jpeg" | "gif" | "webp"
        ) {
            if index == 0 {
                destination.clone()
            } else {
                format!(
                    "{}-{:02}.{}",
                    destination.trim_end_matches(&format!(".{requested_ext}")),
                    index + 1,
                    extension
                )
            }
        } else {
            format!(
                "{destination}/{}-{:02}.{}",
                if operation == "animation" {
                    "frame"
                } else {
                    "image"
                },
                index + 1,
                extension
            )
        };
        let path = safe_path(workspace_root, Some(&Value::String(relative.clone())))?;
        if args.get("overwrite").and_then(Value::as_bool) != Some(true) && path.exists() {
            return Err(format!(
                "Destination already exists: {relative}. Set overwrite=true to replace it."
            ));
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        std::fs::write(path, bytes).map_err(|error| error.to_string())?;
        paths.push(relative);
    }
    Ok(
        serde_json::json!({"ok":true,"generation_id":generation_id,"operation":operation,"width":result.get("width"),"height":result.get("height"),"frame_count":result.get("frame_count"),"paths":paths,"quota":result.get("quota")}),
    )
}

fn machine_mcp_url(host: &str) -> String {
    if host.starts_with("http://") || host.starts_with("https://") {
        format!("{host}/mcp")
    } else if host
        .rsplit_once(':')
        .is_some_and(|(_, port)| port.parse::<u16>().is_ok())
    {
        format!("http://{host}/mcp")
    } else {
        format!("http://{host}:9252/mcp")
    }
}

async fn execute_reload_emulator(
    app: &AppHandle,
    workspace_root: &Path,
    args: &Value,
) -> Result<Value, String> {
    let state = app.state::<crate::commands::AppState>();
    if args
        .get("clear_inputs")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        let _ = state
            .emulator
            .send(
                app,
                Some(workspace_root),
                serde_json::json!({"type":"clear_darts"}),
            )
            .await;
    }
    let path = state
        .emulator
        .last_path()
        .unwrap_or_else(|| workspace_root.to_string_lossy().into_owned());
    state
        .emulator
        .send(
            app,
            Some(workspace_root),
            serde_json::json!({"type":"set_path","path":path}),
        )
        .await?;
    if let Some(params) = args.get("params") {
        state
            .emulator
            .send(
                app,
                Some(workspace_root),
                serde_json::json!({"type":"set_params","params":params}),
            )
            .await?;
    }
    state
        .emulator
        .send(
            app,
            Some(workspace_root),
            serde_json::json!({"type":"reload_widget"}),
        )
        .await?;
    Ok(serde_json::json!({"ok":true,"message":"Emulator reloaded"}))
}

async fn execute_control_emulator_input(
    app: &AppHandle,
    workspace_root: &Path,
    args: &Value,
) -> Result<Value, String> {
    let state = app.state::<crate::commands::AppState>();
    let action = args.get("action").cloned().unwrap_or_else(|| args.clone());
    let action_type = action.get("type").and_then(Value::as_str).unwrap_or("");
    let command = match action_type {
        "throw_dart" => {
            serde_json::json!({"type":"throw_dart","index":action.get("index"),"x":action.get("x"),"y":action.get("y")})
        }
        "remove_dart" => {
            serde_json::json!({"type":"remove_dart_at","x":action.get("x"),"y":action.get("y")})
        }
        "clear_darts" => serde_json::json!({"type":"clear_darts"}),
        "set_button" => {
            serde_json::json!({"type":"set_button","button":action.get("button"),"pressed":action.get("pressed")})
        }
        "tap_button" => {
            serde_json::json!({"type":"set_button","button":action.get("button"),"pressed":true})
        }
        _ => return Ok(serde_json::json!({"ok":false,"error":"unsupported input action"})),
    };
    state
        .emulator
        .send(app, Some(workspace_root), command)
        .await?;
    Ok(serde_json::json!({"ok":true}))
}

const SKILL_IDS: &[&str] = &[
    "dartsnut-core",
    "dartsnut-game",
    "dartsnut-widget",
    "dartsnut-assets",
];

fn skill_directory(workspace_root: &Path) -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("DARTSNUT_SKILLS_DIR") {
        let path = PathBuf::from(path);
        if path.is_dir() {
            return Some(path);
        }
    }
    let mut candidates = Vec::new();
    candidates.push(workspace_root.join("packages/agent-runtime/skills"));
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../packages/agent-runtime/skills"),
    );
    if let Ok(current) = std::env::current_dir() {
        candidates.push(current.join("packages/agent-runtime/skills"));
        candidates.push(current.join("apps/desktop/../..//packages/agent-runtime/skills"));
    }
    let mut parent = workspace_root.to_path_buf();
    for _ in 0..6 {
        candidates.push(parent.join("packages/agent-runtime/skills"));
        if !parent.pop() {
            break;
        }
    }
    candidates.into_iter().find(|path| path.is_dir())
}

fn execute_get_skill(workspace_root: &Path, args: Value) -> Result<Value, String> {
    let skill_id = args
        .get("skill_id")
        .and_then(Value::as_str)
        .ok_or("skill_id is required")?;
    if !SKILL_IDS.contains(&skill_id) {
        return Ok(serde_json::json!({"ok":false,"error":format!("Unknown skill_id: {skill_id}")}));
    }
    let skills = skill_directory(workspace_root)
        .ok_or_else(|| "Skill library is not configured.".to_owned())?;
    let path = skills.join(format!("{skill_id}.md"));
    let content = std::fs::read_to_string(&path).map_err(|error| error.to_string())?;
    Ok(serde_json::json!({"ok":true,"skill_id":skill_id,"content":content}))
}

async fn execute_check_python(workspace_root: &Path, args: Value) -> Result<Value, String> {
    let paths = args
        .get("paths")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .unwrap_or_else(|| vec!["main.py".to_owned()]);
    if paths.is_empty() {
        return Ok(
            serde_json::json!({"ok":false,"errors":[{"message":"paths must contain at least one file"}]}),
        );
    }
    let root = std::fs::canonicalize(workspace_root).map_err(|e| e.to_string())?;
    let mut resolved = Vec::with_capacity(paths.len());
    for value in &paths {
        let path = safe_path(&root, Some(&Value::String(value.clone())))?;
        if !path.is_file() {
            return Ok(
                serde_json::json!({"ok":false,"errors":[{"path":value,"message":"file not found"}]}),
            );
        }
        resolved.push(path);
    }
    let python = crate::runtime::discover_python(Some(&root))
        .ok_or_else(|| "Python runtime unavailable".to_owned())?;
    let output = tokio::process::Command::new(python)
        .arg("-m")
        .arg("py_compile")
        .args(&resolved)
        .current_dir(&root)
        .env_clear()
        .envs(crate::runtime::sanitized_environment())
        .output()
        .await
        .map_err(|error| error.to_string())?;
    if output.status.success() {
        return Ok(serde_json::json!({"ok":true,"errors":[]}));
    }
    let message = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    Ok(
        serde_json::json!({"ok":false,"errors":[{"message":if message.is_empty() { "Python syntax check failed".to_owned() } else { message }}]}),
    )
}

fn safe_path(root: &Path, value: Option<&Value>) -> Result<PathBuf, String> {
    let rel = value.and_then(Value::as_str).unwrap_or(".");
    let path = Path::new(rel);
    if path.is_absolute()
        || path
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err("path escapes workspace root".into());
    }
    let root = std::fs::canonicalize(root).map_err(|e| e.to_string())?;
    let candidate = root.join(path);
    if candidate.exists() {
        let canonical = std::fs::canonicalize(&candidate).map_err(|e| e.to_string())?;
        if !canonical.starts_with(&root) {
            return Err("path escapes workspace root".into());
        }
        return Ok(canonical);
    }
    let mut existing = candidate.clone();
    let mut suffix = Vec::new();
    while !existing.exists() {
        if let Some(name) = existing.file_name() {
            suffix.push(name.to_owned());
        }
        if !existing.pop() {
            return Err("path escapes workspace root".into());
        }
    }
    let canonical_existing = std::fs::canonicalize(&existing).map_err(|e| e.to_string())?;
    if !canonical_existing.starts_with(&root) {
        return Err("path escapes workspace root".into());
    }
    let mut output = canonical_existing;
    for component in suffix.iter().rev() {
        output.push(component);
    }
    Ok(output)
}

#[allow(dead_code)]
fn execute_workspace_tool(name: &str, root: &Path, args: Value) -> Result<Value, String> {
    execute_workspace_tool_with_app(name, root, args, None)
}

fn execute_workspace_tool_with_app(
    name: &str,
    root: &Path,
    args: Value,
    app: Option<&AppHandle>,
) -> Result<Value, String> {
    let root = std::fs::canonicalize(root).map_err(|e| e.to_string())?;
    match name {
        "read_file" => {
            let path = safe_path(&root, args.get("path"))?;
            let content = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
            let offset = args
                .get("offset")
                .and_then(Value::as_u64)
                .unwrap_or(1)
                .max(1) as usize;
            let limit = args
                .get("limit")
                .and_then(Value::as_u64)
                .unwrap_or(2000)
                .max(1) as usize;
            if args.get("offset").is_none() && args.get("limit").is_none() {
                return Ok(serde_json::json!({"ok":true,"content":content}));
            }
            let lines: Vec<_> = content.lines().collect();
            let start = offset.min(lines.len().saturating_add(1));
            let end = (start.saturating_sub(1) + limit).min(lines.len());
            let selected = lines[start.saturating_sub(1)..end]
                .iter()
                .enumerate()
                .map(|(i, line)| format!("{}\t{}", start + i, line))
                .collect::<Vec<_>>()
                .join("\n");
            Ok(
                serde_json::json!({"ok":true,"content":selected,"startLine":start,"endLine":end,"lineCount":lines.len()}),
            )
        }
        "write_file" => {
            let path = safe_path(&root, args.get("path"))?;
            let content = args
                .get("content")
                .and_then(Value::as_str)
                .ok_or("content is required")?;
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::write(path, content).map_err(|e| e.to_string())?;
            Ok(serde_json::json!({"ok":true}))
        }
        "replace_in_file" => {
            let path = safe_path(&root, args.get("path"))?;
            let find = args
                .get("find")
                .and_then(Value::as_str)
                .ok_or("find is required")?;
            if find.is_empty() {
                return Err("find must be non-empty".into());
            }
            let replace = args.get("replace").and_then(Value::as_str).unwrap_or("");
            let replace_all = args
                .get("replace_all")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
            let count = content.matches(find).count();
            if count == 0 {
                return Ok(
                    serde_json::json!({"ok":false,"error":"find target not present in file"}),
                );
            }
            if count > 1 && !replace_all {
                return Ok(
                    serde_json::json!({"ok":false,"error":format!("find matches {count} times; set replace_all to true") }),
                );
            }
            let next = if replace_all {
                content.replace(find, replace)
            } else {
                content.replacen(find, replace, 1)
            };
            std::fs::write(path, next).map_err(|e| e.to_string())?;
            Ok(serde_json::json!({"ok":true,"replaced":if replace_all {count} else {1}}))
        }
        "grep_files" => {
            let pattern = args
                .get("pattern")
                .and_then(Value::as_str)
                .ok_or("pattern is required")?;
            if pattern.is_empty() {
                return Err("pattern is required".into());
            }
            let regex = regex::RegexBuilder::new(pattern)
                .case_insensitive(
                    args.get("ignore_case")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                )
                .build()
                .map_err(|error| format!("Invalid regex: {error}"))?;
            let glob = args
                .get("glob")
                .and_then(Value::as_str)
                .filter(|v| !v.trim().is_empty());
            let start = safe_path(&root, args.get("path"))?;
            let cap = args
                .get("max_results")
                .and_then(Value::as_u64)
                .unwrap_or(200)
                .clamp(1, 1000) as usize;
            let mut files = Vec::new();
            collect_files(&root, &start, None, &mut files, 10_000)?;
            let mut matches = Vec::new();
            for rel in files {
                if matches.len() >= cap {
                    break;
                }
                if glob.is_some_and(|pattern| !glob_match(pattern, &rel)) {
                    continue;
                }
                let path = root.join(&rel);
                let Ok(content) = std::fs::read_to_string(path) else {
                    continue;
                };
                for (line_no, line) in content.lines().enumerate() {
                    if regex.is_match(line) {
                        matches.push(serde_json::json!({"path":rel,"line":line_no + 1,"text":line.chars().take(500).collect::<String>()}));
                        if matches.len() >= cap {
                            break;
                        }
                    }
                }
            }
            Ok(serde_json::json!({"ok":true,"matches":matches,"truncated":matches.len() >= cap}))
        }
        "list_files" | "glob_files" => {
            let start = safe_path(&root, args.get("path"))?;
            let pattern = args.get("pattern").and_then(Value::as_str);
            let cap = args
                .get("max_results")
                .and_then(Value::as_u64)
                .unwrap_or(500)
                .clamp(1, 2000) as usize;
            let mut files = Vec::new();
            collect_files(&root, &start, pattern, &mut files, cap + 1)?;
            files.sort();
            let truncated = files.len() > cap;
            files.truncate(cap);
            Ok(serde_json::json!({"ok":true,"files":files,"truncated":truncated}))
        }
        "copy_asset_file" => {
            let source = args
                .get("source")
                .and_then(Value::as_str)
                .ok_or("source is required")?;
            let destination = safe_path(&root, args.get("path"))?;
            let source_name = Path::new(source)
                .file_name()
                .and_then(|v| v.to_str())
                .ok_or("invalid source")?;
            let mut candidate = None;
            let mut files = Vec::new();
            collect_files(&root, &root, None, &mut files, 20_000)?;
            for rel in files {
                if Path::new(&rel).file_name().and_then(|v| v.to_str()) == Some(source_name) {
                    candidate = Some(root.join(rel));
                    break;
                }
            }
            let source_path = candidate.ok_or_else(|| "asset source not found".to_owned())?;
            if destination.exists() {
                return Ok(serde_json::json!({"ok":false,"error":"destination exists"}));
            }
            if let Some(parent) = destination.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::copy(source_path, destination).map_err(|e| e.to_string())?;
            Ok(serde_json::json!({"ok":true}))
        }
        "copy_chat_attachment" => {
            let attachment_id = args
                .get("attachment_id")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or("attachment_id is required")?;
            let destination = safe_path(&root, args.get("path"))?;
            let overwrite = args
                .get("overwrite")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if destination.exists() && !overwrite {
                return Ok(serde_json::json!({"ok":false,"error":"destination exists"}));
            }
            let relative = app
                .and_then(|handle| {
                    handle
                        .state::<crate::commands::AppState>()
                        .chat_attachments
                        .lock()
                        .ok()
                        .and_then(|map| map.get(attachment_id).cloned())
                })
                .ok_or_else(|| "attachment not found".to_owned())?;
            let source_value = Value::String(relative.clone());
            let source = safe_path(&root, Some(&source_value))?;
            if !source.is_file() {
                return Err("attachment source not found".to_owned());
            }
            if source == destination {
                return Ok(serde_json::json!({"ok":true,"path":relative}));
            }
            if let Some(parent) = destination.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::copy(&source, &destination).map_err(|e| e.to_string())?;
            let output = destination
                .strip_prefix(root)
                .unwrap_or(&destination)
                .to_string_lossy()
                .replace('\\', "/");
            Ok(serde_json::json!({"ok":true,"path":output,"source":relative}))
        }
        _ => Err(format!("unknown workspace tool: {name}")),
    }
}

fn collect_files(
    root: &Path,
    dir: &Path,
    pattern: Option<&str>,
    out: &mut Vec<String>,
    cap: usize,
) -> Result<(), String> {
    if out.len() >= cap {
        return Ok(());
    }
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if entry.file_type().map_err(|e| e.to_string())?.is_dir()
            && [".git", "node_modules", ".venv", "venv", ".dartsnut"].contains(&name.as_ref())
        {
            continue;
        }
        let path = entry.path();
        if path.is_dir() {
            collect_files(root, &path, pattern, out, cap)?;
        } else if path.is_file() {
            let rel = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            if pattern.map(|p| glob_match(p, &rel)).unwrap_or(true) {
                out.push(rel);
            }
        }
        if out.len() >= cap {
            break;
        }
    }
    Ok(())
}

fn glob_match(pattern: &str, value: &str) -> bool {
    fn rec(p: &[u8], v: &[u8]) -> bool {
        if p.is_empty() {
            return v.is_empty();
        }
        if p[0] == b'*' {
            if p.get(1) == Some(&b'*') {
                return rec(&p[2..], v) || (!v.is_empty() && rec(p, &v[1..]));
            }
            return rec(&p[1..], v) || (!v.is_empty() && v[0] != b'/' && rec(p, &v[1..]));
        }
        !v.is_empty() && (p[0] == b'?' || p[0] == v[0]) && rec(&p[1..], &v[1..])
    }
    rec(pattern.as_bytes(), value.as_bytes())
}

pub fn validate_agent_configuration(
    base_url: &str,
    api_key: &str,
    model: &str,
) -> Result<(), String> {
    crate::ensure_rustls_crypto_provider();
    // Configuration validation must stay side-effect free. In particular, do
    // not resolve PAC here: production execution performs async PAC fetch
    // immediately before constructing its proxy-aware client.
    crate::provider::normalize_base_url(base_url).map_err(|error| error.to_string())?;
    let client = reqwest::Client::builder()
        .build()
        .map_err(|error| error.to_string())?;
    let _agent = build_agent_with_http_client(base_url, api_key, model, None, None, None, client)?;
    Ok(())
}

/// Execute one production agent turn through Rig's Responses provider and
/// multi-turn runner. `previous_response_id` is forwarded as provider-specific
/// Responses metadata, while Rig owns stream assembly, retries, and tool turns.
#[allow(clippy::too_many_arguments)]
pub async fn stream_prompt<F>(
    base_url: &str,
    api_key: &str,
    model: &str,
    prompt: &str,
    previous_response_id: Option<String>,
    workspace_root: Option<PathBuf>,
    cancel: Arc<AtomicBool>,
    on_event: F,
) -> Result<StreamOutcome, String>
where
    F: FnMut(StreamEvent) + Send,
{
    stream_prompt_with_app(
        base_url,
        api_key,
        model,
        prompt,
        previous_response_id,
        workspace_root,
        cancel,
        None,
        on_event,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub async fn stream_prompt_with_app<F>(
    base_url: &str,
    api_key: &str,
    model: &str,
    prompt: &str,
    previous_response_id: Option<String>,
    workspace_root: Option<PathBuf>,
    cancel: Arc<AtomicBool>,
    app: Option<AppHandle>,
    mut on_event: F,
) -> Result<StreamOutcome, String>
where
    F: FnMut(StreamEvent) + Send,
{
    let agent =
        build_agent_with_context_async(base_url, api_key, model, None, workspace_root, app).await?;
    let mut request = agent.stream_prompt(prompt).max_turns(MAX_TURNS);
    if let Some(previous_response_id) = previous_response_id {
        request = request.replace_additional_params(
            serde_json::json!({"previous_response_id": previous_response_id}),
        );
    }
    let mut stream = request.await;
    let mut output = String::new();
    let mut response_id = None;
    loop {
        let item = tokio::select! {
            item = stream.next() => item,
            _ = sleep(Duration::from_millis(50)) => {
                if cancel.load(Ordering::Relaxed) {
                    return Ok(StreamOutcome { output, response_id });
                }
                continue;
            }
        };
        let Some(item) = item else { break };
        match item.map_err(|error| error.to_string())? {
            MultiTurnStreamItem::StreamAssistantItem(content) => match content {
                StreamedAssistantContent::Text(text) => {
                    if !text.text.is_empty() {
                        output.push_str(&text.text);
                        on_event(StreamEvent::TextDelta(text.text));
                    }
                }
                StreamedAssistantContent::ToolCall { tool_call, .. } => {
                    on_event(StreamEvent::ToolCall {
                        name: tool_call.function.name,
                        arguments: tool_call.function.arguments,
                    });
                }
                _ => {}
            },
            MultiTurnStreamItem::StreamUserItem(content) => {
                let StreamedUserContent::ToolResult { tool_result, .. } = content;
                on_event(StreamEvent::ToolResult {
                    name: tool_result.name,
                });
            }
            // The corresponding `StreamUserItem::ToolResult` is the single
            // completion signal for renderer consumers; avoid duplicate tool
            // lifecycle events for Rig's commit marker.
            MultiTurnStreamItem::ToolExecutionCommitted { .. } => {}
            MultiTurnStreamItem::CompletionCall(call) => {
                response_id = call.response_id.or(response_id);
            }
            MultiTurnStreamItem::FinalResponse(final_response) => {
                if output.is_empty() {
                    output = final_response.output.clone();
                }
            }
            MultiTurnStreamItem::ModelTurnRetried { .. } => {}
        }
        if cancel.load(Ordering::Relaxed) {
            return Ok(StreamOutcome {
                output,
                response_id,
            });
        }
    }
    Ok(StreamOutcome {
        output,
        response_id,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_openai_compatible_base_url_without_key_for_custom_gateways() {
        assert!(validate_agent_configuration("http://localhost:4000/v1", "", "model").is_ok());
    }

    #[test]
    fn builds_native_agent_with_preamble_and_turn_budget() {
        let agent = build_agent(
            "https://gateway.example/v1",
            "",
            "model",
            Some("You are Dartsnut agent."),
        );
        assert!(agent.is_ok());
        assert_eq!(MAX_TURNS, 128);
    }

    #[test]
    fn machine_mcp_url_preserves_explicit_ports() {
        assert_eq!(
            machine_mcp_url("192.168.1.10"),
            "http://192.168.1.10:9252/mcp"
        );
        assert_eq!(
            machine_mcp_url("192.168.1.10:9300"),
            "http://192.168.1.10:9300/mcp"
        );
        assert_eq!(
            machine_mcp_url("https://machine.local"),
            "https://machine.local/mcp"
        );
    }

    #[test]
    fn pixellab_asset_writer_enforces_workspace_and_writes_outputs() {
        let root = std::env::temp_dir().join(format!("dartsnut-pixellab-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let bytes = b"pixel";
        let result = serde_json::json!({
            "generation_id":"generation-12345678",
            "status":"completed",
            "operation":"image",
            "width":16,
            "height":16,
            "frame_count":null,
            "assets":[{"mime_type":"image/png","data_base64":base64::engine::general_purpose::STANDARD.encode(bytes),"byte_length":bytes.len()}],
            "quota":{}
        });
        let written = write_pixellab_assets(&root, &serde_json::json!({}), result).unwrap();
        assert_eq!(written["ok"], true);
        assert_eq!(
            written["paths"][0],
            "assets/pixellab/image-generati/image-01.png"
        );
        assert_eq!(
            std::fs::read(root.join("assets/pixellab/image-generati/image-01.png")).unwrap(),
            bytes
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn workspace_glob_and_path_boundary_are_enforced() {
        assert!(glob_match("**/*.rs", "src/main.rs"));
        assert!(glob_match("assets/*", "assets/icon.png"));
        assert!(!glob_match("assets/*", "assets/ui/icon.png"));
        let root = std::env::temp_dir().join(format!("dartsnut-rig-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/main.rs"), "hello\nworld").unwrap();
        let listed = execute_workspace_tool(
            "glob_files",
            &root,
            serde_json::json!({"pattern":"**/*.rs"}),
        )
        .unwrap();
        assert_eq!(listed["files"][0], "src/main.rs");
        let read = execute_workspace_tool(
            "read_file",
            &root,
            serde_json::json!({"path":"src/main.rs","offset":2,"limit":1}),
        )
        .unwrap();
        assert_eq!(read["content"], "2\tworld");
        let regex_matches = execute_workspace_tool(
            "grep_files",
            &root,
            serde_json::json!({"pattern":"WORL.","ignore_case":true,"glob":"**/*.rs"}),
        )
        .unwrap();
        assert_eq!(regex_matches["matches"][0]["path"], "src/main.rs");
        assert!(execute_workspace_tool(
            "read_file",
            &root,
            serde_json::json!({"path":"../secret"})
        )
        .is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(std::env::temp_dir(), root.join("escape")).unwrap();
            assert!(execute_workspace_tool(
                "read_file",
                &root,
                serde_json::json!({"path":"escape"})
            )
            .is_err());
        }
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn bundled_skill_tool_validates_ids_and_returns_markdown() {
        let root = std::env::temp_dir().join(format!("dartsnut-skill-{}", uuid::Uuid::new_v4()));
        let skills = root.join("packages/agent-runtime/skills");
        std::fs::create_dir_all(&skills).unwrap();
        std::fs::write(skills.join("dartsnut-core.md"), "# Core skill\n").unwrap();
        let value =
            execute_get_skill(&root, serde_json::json!({"skill_id":"dartsnut-core"})).unwrap();
        assert_eq!(value["ok"], true);
        assert_eq!(value["content"], "# Core skill\n");
        let unknown = execute_get_skill(&root, serde_json::json!({"skill_id":"unknown"})).unwrap();
        assert_eq!(unknown["ok"], false);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn check_python_compiles_only_workspace_files() {
        let root = std::env::temp_dir().join(format!("dartsnut-python-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("main.py"), "print('ok')\n").unwrap();
        let valid = execute_check_python(&root, serde_json::json!({}))
            .await
            .unwrap();
        assert_eq!(valid["ok"], true);
        std::fs::write(root.join("bad.py"), "def broken(:\n").unwrap();
        let invalid = execute_check_python(&root, serde_json::json!({"paths":["bad.py"]}))
            .await
            .unwrap();
        assert_eq!(invalid["ok"], false);
        assert!(invalid["errors"][0]["message"]
            .as_str()
            .unwrap()
            .contains("SyntaxError"));
        assert!(
            execute_check_python(&root, serde_json::json!({"paths":["../bad.py"]}))
                .await
                .is_err()
        );
        let _ = std::fs::remove_dir_all(root);
    }
}
