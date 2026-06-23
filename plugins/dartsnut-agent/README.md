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
- Firmware MCP bridge stub: `mcp/dartsnut-firmware-bridge.js`

## Firmware MCP bridge

The repository includes an MCP config template for a local server named `dartsnut-firmware`, but
the plugin manifest does not enable it by default until the bridge is implemented. To export a
manifest that declares the MCP server, run:

```bash
DARTSNUT_EXPORT_FIRMWARE_MCP=1 pnpm run export:agent-plugin
```

The bridge entrypoint is `mcp/dartsnut-firmware-bridge.js` and reads
`DARTSNUT_MACHINE_URL` when the firmware bridge is implemented.
