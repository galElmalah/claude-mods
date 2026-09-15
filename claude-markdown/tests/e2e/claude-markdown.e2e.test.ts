import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { copyFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { hasClaude, hasTmux, startSession, stripAnsi, type Session } from '../../../tests/e2e/harness.ts'

// End to end: a real Claude Code in tmux (fullscreen, so the pane docks),
// its replies scripted by aimock, this plugin loaded from its folder. Mouse
// reports and keys go straight to the terminal. Needs tmux and claude on
// PATH; skipped otherwise. Run with `bun test tests/e2e`.

const PLUGIN = dirname(dirname(import.meta.dir))

const DOC = `# Sample

A **fast** viewer with \`code\` and a [link](https://example.com).

## Lists

- first item with **bold**
- second item
- third item

| Model | In |
|---|---:|
| Haiku | 1.00 |

\`\`\`mermaid
flowchart LR
  A[Prompt] --> B[Reply]
\`\`\`

The end.
`

const ready = hasTmux() && hasClaude()
const TURN_MS = 40_000

describe.skipIf(!ready)('claude-markdown in Claude Code', () => {
  let s: Session
  // inside the repository: a Read elsewhere asks before it runs
  const file = join(import.meta.dir, 'sample.tmp.md')

  beforeAll(async () => {
    writeFileSync(file, DOC)
    s = await startSession(
      [
        { prompt: 'e2e read please', reply: 'READ-DONE', tool: { name: 'Read', arguments: { file_path: file } } },
        { prompt: 'e2e plain please', reply: 'No file here, just words.' },
        { prompt: 'Notes on', reply: 'NOTES-RECEIVED' },
        { prompt: 'e2e show please', reply: 'SHOWN', tool: { name: 'mcp__claude-markdown__view', arguments: { path: 'claude-markdown/tests/e2e/sample.tmp.md' } } },
      ],
      { fullscreen: true, columns: 200, rows: 45, pluginDir: PLUGIN },
    )
  }, 60_000)

  afterAll(async () => {
    if (process.env.E2E_LOG) copyFileSync(s.debugLog, process.env.E2E_LOG)
    await s?.stop()
    rmSync(file, { force: true })
  })

  /** the pane's rows, without the transcript to their left */
  const pane = (screen = stripAnsi(s.screen())) => {
    const lines = screen.split('\n')
    const at = lines.find(l => l.includes('│'))?.indexOf('│') ?? -1
    return at < 0 ? [] : lines.map(l => l.slice(at + 1))
  }
  /** the 1-based terminal row whose pane text contains `text` */
  const rowOf = (text: string) => pane().findIndex(l => l.includes(text)) + 1
  const paneColumn = () => (stripAnsi(s.screen()).split('\n').find(l => l.includes('│'))?.indexOf('│') ?? 0) + 8
  const click = async (row: number) => {
    await s.mouse('down', paneColumn(), row)
    await s.mouse('up', paneColumn(), row)
  }
  const composer = () => stripAnsi(s.screen()).split('\n').filter(l => /^❯ /.test(l) || /^  /.test(l))

  test('/md <path> opens the file in a docked pane, drawn as styled rows with a line gutter', async () => {
    s.send(`/md ${file}`)
    await s.waitFor('open in the pane')
    await s.waitFor('first item with bold')
    const rows = pane().join('\n')
    expect(rows).toContain('sample.tmp.md · 21 lines')
    expect(rows).toMatch(/ 1 Sample/)
    expect(rows).toContain('═══')
    expect(rows).toContain('• first item with bold')
    expect(rows).toMatch(/┌─+┬─+┐/)
    expect(rows).toContain('Prompt')
    expect(rows).toContain('The end.')
    expect(rows).not.toContain('```')
    expect(rows).not.toContain('**bold**')
  }, TURN_MS)

  test('rows keep their colours: the heading is drawn bold and coloured', async () => {
    const colored = s.screen(true).split('\n').find(l => stripAnsi(l).includes(' 1 Sample'))!
    expect(colored).toMatch(/\x1b\[1m/)
  })

  test('a click selects the line under the pointer', async () => {
    await click(rowOf('• second item'))
    await s.waitFor(/L8 · Enter note/)
    const selected = s.screen(true).split('\n').find(l => stripAnsi(l).includes('second item'))!
    expect(selected).toMatch(/\x1b\[[0-9;]*7m/)
  }, TURN_MS)

  test('a drag extends the selection over a range of lines', async () => {
    const column = paneColumn()
    await s.mouse('down', column, rowOf('• first item'))
    await s.mouse('drag', column, rowOf('• second item'))
    await s.mouse('drag', column, rowOf('• third item'))
    await s.mouse('up', column, rowOf('• third item'))
    await s.waitFor(/L7–9 · Enter note/)
  }, TURN_MS)

  test('Enter opens a note on the selection; typing and Enter keep it under the lines', async () => {
    s.keys('Enter')
    await s.waitFor(/✎ L7–9/)
    await s.type('tighten these')
    await s.waitFor('tighten these')
    s.keys('Enter')
    await s.waitFor('✎ tighten these')
    const rows = pane().join('\n')
    expect(rows).toContain('sample.tmp.md · 21 lines · 1 note')
    expect(rows).toMatch(/ 9▌/)
    expect(rows).toContain('[ Send to Claude ] [ Clear ] [ Close ]')
  }, TURN_MS)

  test('s puts the notes in the prompt box, the lines quoted, and clears them from the pane', async () => {
    // a key within ~100ms of the last one reads as one burst (a paste), which the pane drops
    await Bun.sleep(200)
    s.keys('s')
    await s.waitFor('notes are in the prompt box')
    const box = composer().join('\n')
    expect(box).toContain(`Notes on ${file}:`)
    expect(box).toContain('L7-9:')
    expect(box).toContain('> - first item with **bold**')
    expect(box).toContain('> - third item')
    expect(box).toContain('tighten these')
    expect(pane().join('\n')).not.toContain('· 1 note')
    // the pane keeps the keyboard; Esc hands it back, and Enter sends the notes as the person's prompt
    s.keys('Escape')
    await Bun.sleep(200)
    s.keys('Enter')
    await s.waitFor('NOTES-RECEIVED')
  }, TURN_MS)

  test('the file changing on disk redraws the pane within a second', async () => {
    writeFileSync(file, DOC.replace('The end.', 'The very end.'))
    await s.waitFor('The very end.', 5_000)
  }, TURN_MS)

  test('a Read of a .md file gets a View button that opens it', async () => {
    s.send('/md close')
    await s.waitFor('md: closed')
    await s.waitForGone('• first item')
    s.send('e2e read please')
    // the turn's end (the machine's own PostToolUse hooks may hold it) settles the layout
    await s.waitFor('READ-DONE', 90_000)
    const screen = stripAnsi(s.screen())
    expect(screen).toContain('[ View sample.tmp.md ]')
    const line = screen.split('\n').findIndex(l => l.includes('[ View sample.tmp.md ]')) + 1
    const column = screen.split('\n')[line - 1]!.indexOf('[ View') + 3
    await s.mouse('down', column, line)
    await s.mouse('up', column, line)
    await s.waitFor('• first item with bold')
  }, 120_000)

  test('the model opens the pane itself through the view tool, with a relative path', async () => {
    s.send('/md close')
    await s.waitFor('md: closed')
    await s.waitForGone('• first item')
    s.send('e2e show please')
    await s.waitFor('• first item with bold')
    await s.waitFor('SHOWN', 90_000)
  }, 120_000)

  test('a reply that touches no file leaves the transcript alone', async () => {
    s.send('e2e plain please')
    const screen = stripAnsi(await s.waitFor('just words'))
    const after = screen.slice(screen.lastIndexOf('e2e plain please'))
    expect(after).not.toContain('[ View')
  }, TURN_MS)
})
