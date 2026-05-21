# conf.json contract (games and widgets)

Load this **before** `write_file` on root **`conf.json`**. Use **Creation context** JSON for `type`, `size`, and widget display size.

## Required top-level keys

`id`, `type`, `name`, `author`, `version`, `description`, `size`, `fields`

- **`preview`:** include for new projects as **`[""]`** unless the user omits it explicitly.
- **`type`:** `"game"` or `"widget"` per Creation context (do not guess against intake).
- **`size`:** two-element integer array **`[width, height]`** — never a string like `"128x160"`.
- **`fields`:** JSON array; use **`[]`** when no custom fields.

## Defaults when missing from user text

| Key | Default |
|-----|---------|
| `id` | kebab-case slug from project name |
| `author` | `"Dartsnut Team"` or `"Unknown"` |
| `version` | `"0.1.0"` or `"1.0.0"` (pick one scheme per project) |
| `description` | one-sentence summary of what it does |

## Size

- **Games:** default **`[128, 160]`** unless context overrides.
- **Widgets:** **`size` must match** Creation context display size exactly.

## Example (adjust all values)

```json
{
  "id": "<slug>",
  "type": "game",
  "name": "<Title>",
  "author": "Dartsnut Team",
  "version": "0.1.0",
  "description": "<one sentence>",
  "size": [128, 160],
  "fields": [],
  "preview": [""]
}
```

For widgets, set `"type": "widget"` and `size` from context (e.g. `[128, 128]`).

After creating or materially changing **`conf.json`**, call **`reload_emulator`** so the preview sees the new config.
