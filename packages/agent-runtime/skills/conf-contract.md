# conf.json contract (games and widgets)

Load this **before** `write_file` on root **`conf.json`**. Use recorded intake metadata (`read_workspace_conf` / host context) for `type`, `size`, and widget display size when available.

## Required top-level keys

`id`, `type`, `name`, `author`, `version`, `description`, `size`, `fields`

- **`preview`:** include for new projects as **`[""]`** unless the user omits it explicitly.
- **`type`:** `"game"` or `"widget"` per intake metadata when present.
- **`size`:** two-element integer array **`[width, height]`** — never a string like `"128x160"`.
- **`fields`:** JSON array; use **`[]`** when no custom fields.

## Widget fields

Each widget field uses canonical keys **`id`**, **`name`**, **`type`**, optional **`desc`**, optional **`required`**, and **`default`**. Write canonical keys for new or edited fields. Existing configs may use compatibility aliases `field_key`, `field_name`, `field_type`, and `description`; preserve unrelated metadata while normalizing fields you materially change.

Supported types and runtime values in `dartsnut.widget_params[field.id]`:

| Type | Definition | Runtime/default value |
|------|------------|-----------------------|
| `text` | optional integer `max` | string |
| `number` | optional numeric `min`, `max`, positive `step` | number |
| `slider` | numeric `min`, `max`, optional positive `step` | number |
| `toggle` | — | boolean |
| `dropdown` | non-empty `options`: `{ "display": string, "value": JSON scalar }[]` | one option `value` |
| `checkbox` | non-empty `options` as above | array of option values |
| `color` | — | `#RRGGBB` string |
| `location` | — | `{ "name": string, "lat": number|string, "lng": number|string, "timezone": string }` |
| `image` | optional extension list `accept` | `{ "image": string, "cropbox": [left, top, right, bottom], "image_width"?: number, "image_height"?: number }` |

Rules:

- Field ids are non-empty and unique. `default` must match the runtime value shape and dropdown/checkbox options.
- Use `required: true` only when the widget cannot operate with an empty text/selection/location name/image source.
- When user intent adds, removes, renames, or changes a widget field, update both `conf.json.fields` and every matching `dartsnut.widget_params` consumer in `main.py`. A renamed id must not leave reads of the old key; a removed field must not leave required runtime access.
- Preserve unrelated field definitions and top-level config. Use safe `main.py` fallbacks equal to the field defaults so missing params remain runnable.
- Intent examples: “make the color configurable” adds a `color` field and consumes it; “add a speed slider” adds bounded numeric schema and rendering behavior; “remove the forecast option” updates options/default and runtime branches; “rename this setting” updates schema id/name and runtime lookup.

## Defaults when missing from user text

| Key | Default |
|-----|---------|
| `id` | kebab-case slug from project name |
| `author` | `"Dartsnut Team"` or `"Unknown"` |
| `version` | `"0.1.0"` or `"1.0.0"` (pick one scheme per project) |
| `description` | one-sentence summary of what it does |

## Size

- **Games:** default **`[128, 160]`** unless context overrides.
- **Widgets:** **`size` must match** the recorded widget display size when intake provided one.

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

For widgets, set `"type": "widget"` and `size` from intake metadata (e.g. `[128, 128]`).

After creating or materially changing **`conf.json`**, run **`check_python`** when Python changed, then call **`reload_emulator`**, **`observe_emulator`**, and **`get_emulator_logs`** so the preview sees the new config, renders the intended behavior, and Python started cleanly.
