# Dartsnut Agent Plugin

This plugin is generated from `packages/agent-runtime/skills`.

Do not edit generated skill files directly. Update the source Markdown files and run:

```bash
pnpm run export:agent-plugin
```

## Components

- Codex manifest: `.codex-plugin/plugin.json`
- Claude manifest: `.claude-plugin/plugin.json`
- Skills: `skills/<skill-id>/SKILL.md`
- Firmware MCP server config: `.mcp.json`

## Firmware MCP server

The plugin includes an MCP server named `dartsnut-firmware`. Before starting
the agent, set `DARTSNUT_MACHINE_URL` to the base URL of the Dartsnut machine
you want to control. Use the Dartsnut machine IP address:

```bash
export DARTSNUT_MACHINE_URL=http://192.168.1.42:9252
```

The MCP endpoint is resolved as `${DARTSNUT_MACHINE_URL}/mcp`.
