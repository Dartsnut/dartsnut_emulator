---
title: "Dartsnut Emulator"
---

# Dartsnut Emulator

The **Dartsnut Emulator** is a desktop application that lets you run and test Dartsnut widgets and games locally. It renders the board, handles input, and talks to your widget/game over shared memory, so you can iterate quickly without hardware.

This site provides a quickstart for installing and running the emulator from this repository.

## Prerequisites

- **Python**: 3.10+ (any recent CPython 3.x that supports the listed dependencies should work)
- **OS**: macOS, Linux, or Windows with a desktop environment
- **Git**: to clone this repository

## Installation

1. **Clone the repository**

   ```bash
   git clone https://github.com/your-user/dartsnut_emulator.git
   cd dartsnut_emulator
   ```

2. **(Recommended) Create and activate a virtual environment**

   ```bash
   python -m venv .venv
   source .venv/bin/activate  # On Windows: .venv\Scripts\activate
   ```

3. **Install Python dependencies**

   The emulator depends on `numpy`, `pillow`, `pygame-ce`, `pydartsnut` and a few networking/utility libraries, all pinned in `requirement.txt`.

   ```bash
   pip install -r requirement.txt
   ```

## Running the emulator

From the repository root (and with your virtual environment active, if you created one):

```bash
python emulator.py
```

This will open the **Dartsnut Emulator** window. Initially, no program is loaded.

### Loading a widget or game

Your Dartsnut widget/game should live in a directory that contains at least:

- `conf.json` – widget/game configuration (including `id`, `name`, and `size`)
- `main.py` – the entrypoint script for your widget/game

To load it into the emulator:

1. Start the emulator:

   ```bash
   python emulator.py
   ```

2. In the emulator window, use the menu:

   - **File → Open program…**
   - Select the directory containing `conf.json` and `main.py`.

3. Optionally, provide JSON **params** when prompted (for example, `{}` to accept defaults).

The emulator will launch your program in a separate process and begin rendering frames from shared memory.

### Command-line options

You can also pass options when starting `emulator.py`:

- `--path PATH`: path to your widget/game directory (relative or absolute). If provided, the emulator will try to load this program immediately on startup.
- `--params JSON`: JSON string with program parameters to pass through to your widget/game.

Examples:

```bash
python emulator.py --path ./examples/my-widget --params "{}"
python emulator.py --path /absolute/path/to/game --params '{"difficulty": "hard"}'
```

If no `--path` is given, the emulator starts with a placeholder screen and you can open a program via the **File → Open program…** menu.

## Controls & interaction

- **Mouse left-click / drag** on the main board area: place or move a dart for the selected dart index.
- **Mouse right-click** on the board:
  - Single click: toggle/remove a dart at the clicked position.
  - Double click (within a short interval): clear all darts.
- **Keyboard**:
  - `W`, `A`, `S`, `D`: directional buttons (up/left/down/right).
  - `K`, `L`: button A / button B.
  - `R`: restart the currently loaded program.
  - `P`: take a screenshot (when a program is running).
  - `Ctrl+O` (and `Cmd+O` on macOS): open program dialog.
  - `Ctrl+Q`: exit the emulator.

Screenshots are saved into the `capture/` directory in the repository (created automatically if needed). For certain widget sizes, device-frame and grid overlays are added.

## Repository layout (high level)

Some key items in this repository:

- `emulator.py` – main desktop emulator application.
- `requirement.txt` – pinned Python dependencies for the emulator.
- `capture/` – screenshots taken from the emulator (auto-created, ignored by git).
- `.emulator_last.json` – last-opened program state (auto-created, ignored by git).
- `docs/` – documentation site (this page) for GitHub Pages.

## Using these docs with GitHub Pages

This `docs/` folder is structured to work with **GitHub Pages** using Jekyll:

- GitHub Pages can be configured (in the repository settings) to use the **`docs` folder** as the site source.
- The `_config.yml` file configures the site metadata and the `jekyll-theme-cayman` theme.
- This `index.md` file is the homepage.

Once GitHub Pages is enabled and pointed at `docs/`, the rendered documentation will be available at your repository’s Pages URL.

## Contributing / development notes

- To extend the emulator itself, start by exploring `emulator.py`.
- If you add new dependencies, update `requirement.txt` accordingly.
- If you add more documentation pages, create additional `.md` files under `docs/` and link them from this `index.md`.

