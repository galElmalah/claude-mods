# claude-markdown

A markdown viewer inside Claude Code. `/md README.md` opens the file in a
pane docked beside the transcript, drawn locally the moment you ask:
headings, lists, quotes, code, tables as box art, mermaid diagrams as box
art too (the renderer is [claude-mermaid](../README.md)'s). Click a line,
write a note, and send it back to Claude with the lines quoted, the way a
review comment works in Codex.

```
❯ /md docs/design.md                             │design.md · 212 lines · 2 notes         ✕
  ⎿  md: design.md open in the pane              │ 1 Design
                                                 │   ═══════════════════════════════════
                                                 │ 2
                                                 │ 3 The service keeps one connection
                                                 │   per tenant and multiplexes …
                                                 │ 4
                                                 │ 5 Goals
                                                 │   ───────────────────────────────────
                                                 │ 6
                                                 │ 7▌• Low latency on the hot path
                                                 │ 8▌• One writer per shard
                                                 │       ✎ contradicts §3, pick one
                                                 │ 9
                                                 │10 ┌────────┬────────┐
                                                 │   │ Model  │   p95  │
                                                 │12 ├────────┼────────┤
                                                 │13 │ Haiku  │  40 ms │
                                                 │   └────────┴────────┘
                                                 │L7–8 · Enter note · d delete · s send
❯                                                │[ Send to Claude ] [ Clear ] [ Close ]
```

Nothing costs a token until you send: the file is read and laid out by the
plugin, and the pane draws only the rows on screen, so a 6,000-line file
opens as fast as a 60-line one.

## What you get

- **`/md <path>`** opens a file (relative to the working directory); `/md`
  alone reopens the last one; `/md close` closes the pane.
- **A `[ View x.md ]` button** under every Read, Write or Edit of a `.md`
  file in the transcript, folded reads included. Click it.
- **Live reload**: when Claude edits the file you are looking at, or
  anything else changes it on disk, the pane redraws within a second and
  keeps your place.
- **Notes**: click a line (drag, or shift-click, for a range), press Enter,
  type, Enter again. The note sits under its lines with a `▌` mark in the
  gutter. `d` deletes it, clicking it edits it.
- **Send to Claude**: `s`, or the button, puts every note in the prompt box:

  ```
  Notes on /Users/me/project/docs/design.md:

  L7-8:
  > - Low latency on the hot path
  > - One writer per shard

  contradicts §3, pick one
  ```

  Press Esc to get the keyboard back from the pane, then Enter to send.
  Long quotes keep their first and last lines only.

## Keys

The pane takes the keyboard after a click in it; Esc gives it back.

| Key | Does |
|---|---|
| `↑` `↓` `j` `k` | scroll a row |
| `PgUp` `PgDn` `b` `f` `Space` | scroll a page |
| `Home` `End` `g` `G` | top, bottom |
| click, drag, shift-click | select a line, a range |
| `Enter` `c` | write (or edit) the note on the selection |
| `d` | delete the note on the selection |
| `x` | clear the selection |
| `s` | send the notes to the prompt box |
| while writing: `Enter` saves, `Tab` cancels, `Ctrl-U` clears | |

## Requirements

- Claude Code 2.1.270 or later with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`.
- A terminal at least 110 columns wide with `CLAUDE_CODE_NO_FLICKER=1`, so
  the pane docks beside the transcript; narrower, or without the
  fullscreen renderer, it opens above the prompt.
- A mouse the terminal reports (every modern one does; inside tmux add
  `set -g mouse on`). Everything also works from the keyboard.

## Quick start

1. In `~/.claude/settings.json`:

   ```json
   { "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1", "CLAUDE_CODE_NO_FLICKER": "1" } }
   ```

2. Install from the repository, which is its own marketplace:

   ```sh
   claude plugin marketplace add galElmalah/claude-mermaid
   claude plugin install claude-markdown@claude-mermaid
   ```

   Or run it from a clone: `claude --plugin-dir path/to/claude-mermaid/claude-markdown`.

3. `/md README.md`.

## How it is built

A mod: TypeScript that runs inside Claude Code through function hooks.

- `hooks/register.ts` — the hooks module. Registers `/md`, reads and lays
  the file out (`hooks/markdown.ts`), hands the viewer a window of rows,
  watches the file, rewrites Read/Write/Edit rows to carry the button, and
  turns notes into the prompt text (`hooks/notes.ts`).
- `hooks/viewer.ts` — a surface module (`Client`): draws the rows, takes
  the pointer and the keys on the drawing thread, keeps the selection and
  the notes, and posts to the hooks module only to ask for more rows, to
  hand over notes, or to send.
- `hooks/vendor/diagrams.js` — claude-mermaid's renderer, bundled by
  `npm run build:vendor` so an installed copy of this folder stands alone.

## Development

```sh
bun install            # from the repository root
bun test               # unit tests: the layout and the prompt text
bun run test:e2e       # a real Claude Code in tmux, its model scripted by aimock
bun run typecheck
```

Types come from `/plugin-types` at the repository root (`.claude/types`).

## License

MIT
