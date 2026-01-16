# Dartsnut Emulator

A development tool that allows developers to create and test widgets and games on desktop platforms, simulating the environment of Dartsnut hardware. This emulator streamlines development and debugging workflows before deploying to actual devices.

## Features

- **Hardware Simulation**: Emulates Dartsnut display, dart detection, and button inputs
- **Interactive Testing**: Test dart hits, button presses, and widget interactions
- **Multiple Display Sizes**: Supports various widget sizes (128x128, 128x160, etc.)
- **Shared Memory Communication**: Uses shared memory for efficient widget communication
- **Screenshot Capture**: Automatically captures widget screenshots for documentation

## Installation

### Prerequisites

- Python 3.x
- pip package manager

### Install Dependencies

```bash
pip install -r requirement.txt
```

The required dependencies are:
- `pydartsnut` - Dartsnut SDK for Python
- `pygame` - Graphics and input handling
- `numpy` - Numerical operations

**Note**: Also install any additional Python dependencies required by your specific widget or game.

## Quick Start

### Basic Usage

```bash
python emulator.py --path <your_app_relative_path> --params <your_app_params_json>
```

### Arguments

- `--path` (required): Relative path to your widget/game directory containing `main.py` and `conf.json`
- `--params` (optional): JSON string containing widget parameters (default: `{}`)

### Example

```bash
python emulator.py --path "example/simple_clock_128_128" --params '{"city":"chicago"}'
```

## Project Structure

Your widget/game directory should follow this structure:

```
your_widget/
├── conf.json      # Widget configuration (size, fields, metadata)
└── main.py        # Main widget code
```

The `conf.json` file should include:
- `id`: Widget identifier
- `type`: Widget type (e.g., "widget" or "game")
- `name`: Display name
- `size`: Display dimensions `[width, height]`
- `fields`: Array of configurable parameters

## Controls

### Dart Simulation

- **Left Click**: Emulate a dart hit at the clicked position (default: dart index 1)
- **F1–F12**: Select dart index (1–12) before clicking to simulate different darts
- **Right Click**: Remove the dart at the clicked position
- **Double Right Click**: Remove all darts from the board

### Button Controls

Use keyboard keys to emulate Pixel Dart buttons:

| Key | Button |
|-----|--------|
| `W` | Up |
| `A` | Left |
| `S` | Down |
| `D` | Right |
| `K` | Button A |
| `L` | Button B |

## Examples

### Simple Clock Widget (128x128)

```bash
python emulator.py --path "example/simple_clock_128_128" --params '{"city":"chicago"}'
```

![Simple Clock Widget](example/simple_clock_demo_image.png)

### Simple Weather Widget (128x160)

```bash
python emulator.py --path "example/simple_weather_128_160" --params '{"city":"chicago"}'
```

![Simple Weather Widget](example/simple_weather_demo_image.png)

## How It Works

1. **Shared Memory**: The emulator creates shared memory segments for:
   - Display buffer (`shmpdi`): Pixel data for rendering
   - Dart/Button state (`pdoshm`): Dart positions and button states

2. **Widget Process**: Launches your widget's `main.py` as a subprocess with:
   - Widget parameters
   - Shared memory name
   - Data store path (for persistent storage)

3. **Rendering**: Pygame renders the display buffer in a scaled window for easy viewing

4. **Input Handling**: Mouse and keyboard events are translated to dart hits and button presses

## Data Storage

Widget data is stored in:
```
user/guest/<widget_id>/
```

This directory is automatically created for each widget instance.

## Screenshots

Screenshots are automatically saved to the `capture/` directory with the format:
```
<Widget_Name>_YYYY-MM-DD_HH-MM-SS.png
```

## Troubleshooting

- **Shared Memory Errors**: If you encounter shared memory conflicts, ensure no other emulator instances are running
- **Import Errors**: Make sure all widget dependencies are installed in your Python environment
- **Path Issues**: Use relative paths from the project root directory

## License

[Add license information if applicable]

