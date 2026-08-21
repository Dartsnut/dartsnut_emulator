# PixelLab Agent Tool

Creator sessions expose `pixellab_generate`. Asset-applier sessions do not.

The tool calls the authenticated Dartsnut API bridge and never receives a PixelLab API key. Generation submission returns quickly, then the host polls Dartsnut every five seconds for up to ten minutes. Generated assets are validated and written under the selected workspace. Default destinations are:

```text
assets/pixellab/image-<generation>/image-01.png
assets/pixellab/animation-<generation>/frame-01.png
```

`output_path` may select another workspace-relative file or directory. Paths outside the workspace are rejected before the bridge request. Existing files require `overwrite: true`.

If PixelLab is still processing after ten minutes, the tool returns `PIXELLAB_PENDING` with a `generation_id` and writes no files. Call `pixellab_generate` again with that ID to resume the existing job without consuming another quota reservation.

Use existing bound assets when available. Use image generation for new pixel-art sprites, objects, tiles, icons, backgrounds, UI art, and character concepts. Animation requires a workspace-relative PNG/JPEG `reference_path`. Draw directly in code only for simple geometric shapes and basic UI primitives; do not approximate art-bearing assets with procedural graphics.
