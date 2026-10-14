# Pill Architecture — Dynamic Island Pattern

## Decision: Single morphing window (not two windows)

Dae Captain uses **one Tauri window** that morphs between pill and expanded states,
following Apple's Dynamic Island pattern.

### Window configuration (tauri.conf.json)
- `transparent: true` — no window background, only the pill/chat is visible
- `decorations: false` — no title bar or borders
- `alwaysOnTop: true` — floats above other windows
- `skipTaskbar: true` — doesn't appear in taskbar
- `focus: false` — doesn't steal focus on appear
- Size: 480×76 (pill) → up to 720×900 (expanded)

### Why not two windows?

1. **State synchronization is trivial** — one window means one DOM, one JS state.
   Two windows would require IPC for every state change (task status, transcript,
   workspace, approvals).

2. **Dynamic Island pattern** — Apple's Dynamic Island is ONE element that expands
   and contracts, not two separate windows. Our implementation matches this.

3. **Simplicity = reliability** — Fewer moving parts, fewer bugs. The directive
   says "Use the simplest reliable native implementation available."

### States
- **Idle**: 76px height, shows mascot + status dot. Click to expand.
- **Working**: Pill shows spinner + "Working..." label. Click to see details.
- **Approval**: Pill expands automatically (amber), shows approval card.
- **Expanded**: Full chat UI (up to 900px height).

### Implementation
- `renderPill()` updates the pill content based on `state.runs`
- `expand()` / `collapse()` toggle the `expanded` class and resize via
  `WINDOW_SET_SIZE_CMD` (Tauri command)
- CSS transitions handle the smooth morph (`.island` → `.island.expanded`)
