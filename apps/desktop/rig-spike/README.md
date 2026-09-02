# Rig feasibility spike

This crate is an executable contract harness for the planned Rust agent layer.
It proves, without production wiring:

- Dartsnut-style tool registration and tool-call event streaming.
- A bounded 128-turn loop, cancellation, retry diagnostics, model switching,
  and persisted run state through a store interface.
- OpenAI-compatible Responses request shape for arbitrary HTTP(S) base URLs,
  streaming, and `previous_response_id`.
- Ordered SSE event parsing and non-2xx handling.

The harness includes `rig-agent` test utilities and compiles a real
`AgentBuilder` in `actual_rig_agent_builder_compiles_with_tool_runtime`. The
production app uses Rig's OpenAI-compatible provider with a proxy-aware
`reqwest` client and keeps the standalone Responses adapter for gateways that
need exact payload/SSE normalization.

Run:

```sh
cargo test --manifest-path apps/desktop/rig-spike/Cargo.toml
```

Run production checks with the Tauri crate tests; they cover tool dispatch,
streaming normalization, cancellation, retries, model replacement, and
serialized run restoration.
