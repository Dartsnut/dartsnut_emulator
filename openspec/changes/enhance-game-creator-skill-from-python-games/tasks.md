## 1. Corpus Audit and Guidance Extraction

- [ ] 1.1 Inventory all game projects in `../python_games` and confirm canonical folders by presence of `conf.json`
- [ ] 1.2 Extract and document common `conf.json` keys/formats, runtime loop structure, and library usage patterns
- [ ] 1.3 Cross-reference `packages/agent-runtime/skills/widget-creator.md` to reuse proven template structure sections

## 2. Expand Game Creator Template

- [ ] 2.1 Rewrite `packages/agent-runtime/skills/game-creator.md` with structured sections: process, required outputs, game contract, implementation pattern, dos/don'ts, and follow-up edit behavior
- [ ] 2.2 Add explicit game `conf.json` rules (required keys, `size` format, sensible defaults, and preview handling)
- [ ] 2.3 Add reusable code snippets for `pygame` loop, `Dartsnut` input integration, and `update_frame_buffer` synchronization

## 3. Validation and Fit Check

- [ ] 3.1 Review updated `game-creator.md` against the new spec requirements to ensure all SHALL items are covered
- [ ] 3.2 Verify guidance balances strict contract requirements with flexibility for game-specific mechanics
- [ ] 3.3 Run a final pass for clarity and consistency with existing agent-runtime skill style
