import type { ClientModule, ClientPointerEvent, ClientKeyEvent, RenderElement } from 'claude-code'
import type { Row, Span, Style } from './markdown.ts'

// The pane's body: a surface module, so every scroll, click and keystroke is
// handled on the drawing thread with no hop to the hooks module. It draws
// the rows it holds (a window of the document) and asks for another window
// only when the view nears the edge. Notes live here while the pane is open
// and are posted to the hooks module, which composes what Claude reads.

export type Note = { a: number; b: number; text: string }

export type ViewerProps = {
  path: string
  /** rows the whole document lays out to */
  total: number
  /** lines in the source, for the gutter width */
  srcTotal: number
  /** the rows held: `rows[0]` is document row `start` */
  start: number
  rows: Row[]
  /** rows to draw, footer included */
  height: number
  /** the hooks module's notes: taken when the instance is new or `notesVersion` moved */
  notes: Note[]
  notesVersion: number
  /** bumps when the file changed on disk */
  version: number
}

export type ViewerMessage =
  | { type: 'window'; top: number }
  | { type: 'notes'; notes: Note[] }
  | { type: 'send' }
  | { type: 'close' }

type Sel = { a: number; b: number }

type State = {
  top: number
  sel: Sel | null
  /** the source line a drag started on, while the button is down */
  anchor: number | null
  editing: { sel: Sel; text: string } | null
  notes: Note[]
  notesVersion: number
  version: number
  askedFor: number | null
}

type Entry = { kind: 'row'; row: Row } | { kind: 'note'; note: Note; spans: Span[] } | { kind: 'blank' }

const STYLE: Record<Style, Record<string, string | boolean>> = {
  h1: { bold: true, color: 'cyan' },
  h2: { bold: true, color: 'cyan' },
  h3: { bold: true },
  h4: { bold: true, dimColor: true },
  b: { bold: true },
  i: { italic: true },
  bi: { bold: true, italic: true },
  s: { strikethrough: true },
  code: { color: 'yellow' },
  link: { color: 'blue', underline: true },
  url: { dimColor: true },
  dim: { dimColor: true },
  bullet: { color: 'magenta' },
  quote: { color: 'green' },
  fence: { color: 'yellow' },
  rule: { dimColor: true },
  check: { color: 'green' },
  html: { dimColor: true, italic: true },
  border: { color: 'cyan' },
  line: { dimColor: true },
  arrow: { color: 'yellow' },
  corner: { dimColor: true },
  junction: { color: 'cyan' },
  accent: { color: 'magenta' },
  text: {},
}

const norm = (sel: Sel): Sel => (sel.a <= sel.b ? sel : { a: sel.b, b: sel.a })
const sameSel = (x: Sel, y: Sel) => x.a === y.a && x.b === y.b
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

const noteAt = (notes: Note[], sel: Sel): Note | undefined => notes.find(n => n.a === sel.a && n.b === sel.b)

type ButtonSpec = { key: 'send' | 'clear' | 'close'; label: string; from: number; to: number }

/** the buttons row: `[ label ]` cells, each knowing the columns it spans */
const buttonsOf = (notes: Note[]): ButtonSpec[] => {
  const labels: [ButtonSpec['key'], string][] = [
    ...(notes.length ? ([['send', 'Send to Claude'], ['clear', 'Clear']] as [ButtonSpec['key'], string][]) : []),
    ['close', 'Close'],
  ]
  let at = 0
  return labels.map(([key, label]) => {
    const text = `[ ${label} ]`
    const spec = { key, label: text, from: at, to: at + text.length }
    at += text.length + 1
    return spec
  })
}

const wrapPlain = (text: string, width: number): string[] => {
  const out: string[] = []
  let line = ''
  for (const word of text.split(' ')) {
    if (line && line.length + 1 + word.length > width) {
      out.push(line)
      line = word
    } else line = line ? `${line} ${word}` : word
  }
  out.push(line)
  return out
}

/** the screen's entries from `top`: document rows, a note under the last row of its range */
const entriesOf = (props: ViewerProps, state: State, count: number, width: number): Entry[] => {
  const out: Entry[] = []
  const end = props.start + props.rows.length
  for (let r = state.top; out.length < count; r++) {
    if (r >= props.total) {
      out.push({ kind: 'blank' })
      continue
    }
    const row = r >= props.start && r < end ? props.rows[r - props.start] : undefined
    if (!row) {
      out.push({ kind: 'blank' })
      continue
    }
    out.push({ kind: 'row', row })
    const next = r + 1 < end && r + 1 >= props.start ? props.rows[r + 1 - props.start] : undefined
    if (next && next.src === row.src) continue
    for (const note of state.notes) {
      if (note.b !== row.src) continue
      for (const line of wrapPlain(`✎ ${note.text}`, Math.max(8, width - 4))) {
        if (out.length >= count) break
        out.push({ kind: 'note', note, spans: [{ t: '    ' }, { t: line, s: 'accent' }] })
      }
    }
  }
  return out.slice(0, count)
}

// the listeners are set once and outlive the render they were set in: they
// read the latest props and state from here, never from a closure
type Frame = { props: ViewerProps; body: number; textWidth: number; maxTop: number; state: State }
const frame: Frame = {
  props: { path: '', total: 0, srcTotal: 0, start: 0, rows: [], height: 3, notes: [], notesVersion: 0, version: 0 },
  body: 2,
  textWidth: 10,
  maxTop: 0,
  state: { top: 0, sel: null, anchor: null, editing: null, notes: [], notesVersion: 0, version: 0, askedFor: null },
}

const viewer: ClientModule<ViewerProps, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  let state: State = surface.state ?? { top: 0, sel: null, anchor: null, editing: null, notes: props.notes, notesVersion: props.notesVersion, version: props.version, askedFor: null }

  const height = Math.max(4, props.height)
  // a title row above the rows, the hint row and the buttons row below
  const body = height - 3
  const gutter = Math.max(2, String(props.srcTotal).length)
  const width = Math.max(10, surface.columns || 40)
  const maxTop = Math.max(0, props.total - body)
  Object.assign(frame, { props, body, textWidth: width - gutter - 2, maxTop, state })

  if (state.version !== props.version || state.notesVersion !== props.notesVersion) {
    if (state.version !== props.version) state = { ...state, version: props.version, top: clamp(state.top, 0, maxTop), askedFor: null }
    if (state.notesVersion !== props.notesVersion) state = { ...state, notesVersion: props.notesVersion, notes: props.notes, editing: null }
    frame.state = state
    surface.setState(state)
  }

  const set = (next: Partial<State>) => {
    state = { ...frame.state, ...next }
    frame.state = state
    surface.setState(state)
  }
  const setNotes = (notes: Note[]) => {
    set({ notes })
    surface.post({ type: 'notes', notes })
  }
  const scrollTo = (top: number) => set({ top: clamp(top, 0, frame.maxTop) })

  if (surface.state === undefined) {
    surface.setState(state)
    surface.onPointer(ev => onPointer(ev))
    surface.onKey(ev => onKey(ev))
  }

  // rows outside the held window: ask once per target, the hooks module answers with props
  const needFrom = state.top
  const needTo = Math.min(props.total, state.top + body)
  const held = needFrom >= props.start && needTo <= props.start + props.rows.length
  if (!held && state.askedFor !== state.top) {
    set({ askedFor: state.top })
    surface.post({ type: 'window', top: state.top })
  }

  const entries = entriesOf(props, state, body, width - gutter - 2)

  function onPointer(ev: ClientPointerEvent) {
    const live = frame.state
    if (ev.type === 'down' && ev.button === 'left' && ev.y === frame.body + 2) {
      const button = buttonsOf(live.notes).find(b => ev.x >= b.from && ev.x < b.to)
      if (button?.key === 'send') surface.post({ type: 'send' })
      if (button?.key === 'clear') setNotes([])
      if (button?.key === 'close') surface.post({ type: 'close' })
      return
    }
    if (ev.type === 'down' && ev.button === 'left') {
      const entry = entriesOf(frame.props, live, frame.body, frame.textWidth)[ev.y - 1]
      if (!entry || entry.kind === 'blank') return
      if (entry.kind === 'note') {
        const sel = { a: entry.note.a, b: entry.note.b }
        set({ sel, anchor: null, editing: { sel, text: entry.note.text } })
        return
      }
      const src = entry.row.src
      if (ev.shift && live.sel) set({ sel: norm({ a: live.sel.a, b: src }), anchor: live.sel.a, editing: null })
      else set({ sel: { a: src, b: src }, anchor: src, editing: null })
      return
    }
    if (ev.type === 'move' && ev.button === 'left' && live.anchor !== null) {
      const entry = entriesOf(frame.props, live, frame.body, frame.textWidth)[clamp(ev.y - 1, 0, frame.body - 1)]
      if (entry?.kind !== 'row') return
      const sel = norm({ a: live.anchor, b: entry.row.src })
      if (!live.sel || !sameSel(live.sel, sel)) set({ sel })
      return
    }
    if (ev.type === 'up') set({ anchor: null })
  }

  function onKey(ev: ClientKeyEvent) {
    const live = frame.state
    const editing = live.editing
    if (editing) {
      if (ev.key === 'return') {
        const text = editing.text.trim()
        const rest = live.notes.filter(n => !sameSel(n, editing.sel))
        setNotes(text ? [...rest, { ...editing.sel, text }].sort((x, y) => x.a - y.a) : rest)
        set({ editing: null })
        return
      }
      if (ev.key === 'backspace' || ev.key === 'delete') return set({ editing: { ...editing, text: editing.text.slice(0, -1) } })
      if (ev.key === 'space') return set({ editing: { ...editing, text: editing.text + ' ' } })
      if (ev.key === 'u' && ev.ctrl) return set({ editing: { ...editing, text: '' } })
      if (ev.key === 'tab') return set({ editing: null })
      if (ev.key.length === 1 && !ev.ctrl && !ev.meta) return set({ editing: { ...editing, text: editing.text + ev.key } })
      return
    }
    switch (ev.key) {
      case 'up':
      case 'k':
        return scrollTo(live.top - 1)
      case 'down':
      case 'j':
        return scrollTo(live.top + 1)
      case 'pageup':
      case 'b':
        return scrollTo(live.top - (frame.body - 1))
      case 'pagedown':
      case 'space':
      case 'f':
        return scrollTo(live.top + (frame.body - 1))
      case 'home':
      case 'g':
        return scrollTo(0)
      case 'end':
      case 'G':
        return scrollTo(frame.maxTop)
      case 'return':
      case 'c':
        if (live.sel) set({ editing: { sel: live.sel, text: noteAt(live.notes, live.sel)?.text ?? '' } })
        return
      case 'd':
      case 'backspace':
      case 'delete':
        if (live.sel) setNotes(live.notes.filter(n => !sameSel(n, live.sel!)))
        return
      case 'x':
        return set({ sel: null })
      case 's':
        if (live.notes.length) surface.post({ type: 'send' })
        return
    }
  }

  const selected = (src: number) => state.sel !== null && src >= state.sel.a && src <= state.sel.b
  const noted = (src: number) => state.notes.some(n => src >= n.a && src <= n.b)

  const name = props.path.split('/').pop() ?? props.path
  const drawn: RenderElement[] = [
    Box({
      flexDirection: 'row',
      children: [
        Text({ bold: true, wrap: 'truncate-end', children: [name] }),
        Text({ dimColor: true, wrap: 'truncate-end', children: [` · ${props.srcTotal} lines`] }),
        ...(state.notes.length ? [Text({ color: 'magenta', wrap: 'truncate-end', children: [` · ${state.notes.length} note${state.notes.length === 1 ? '' : 's'}`] })] : []),
      ],
    }),
  ]
  let lastSrc = -1
  for (const entry of entries) {
    if (entry.kind === 'blank') {
      drawn.push(Text({ children: [' '] }))
      continue
    }
    if (entry.kind === 'note') {
      drawn.push(Box({ flexDirection: 'row', children: [Text({ children: [' '.repeat(gutter + 1)] }), ...entry.spans.map(s => Text({ ...(s.s ? STYLE[s.s] : {}), wrap: 'truncate-end', children: [s.t] }))] }))
      continue
    }
    const { row } = entry
    const isSel = selected(row.src)
    const number = row.src === lastSrc ? ' '.repeat(gutter) : String(row.src + 1).padStart(gutter)
    lastSrc = row.src
    const mark = noted(row.src) ? '▌' : ' '
    const children: RenderElement[] = [
      Text({ dimColor: !isSel, inverse: isSel, children: [number] }),
      Text({ color: 'magenta', bold: true, children: [mark] }),
    ]
    if (row.spans.length === 0) children.push(Text({ inverse: isSel, children: [isSel ? ' '.repeat(Math.max(1, width - gutter - 1)) : ' '] }))
    for (const span of row.spans) children.push(Text({ ...(span.s ? STYLE[span.s] : {}), inverse: isSel, wrap: 'truncate-end', children: [span.t] }))
    drawn.push(Box({ flexDirection: 'row', children }))
  }

  const at = props.total ? `${Math.min(props.total, state.top + body)}/${props.total}` : '0/0'
  const range = (s: Sel) => (s.a === s.b ? `L${s.a + 1}` : `L${s.a + 1}–${s.b + 1}`)
  const footer = state.editing
    ? [Text({ color: 'magenta', bold: true, children: [`✎ ${range(state.editing.sel)} `] }), Text({ wrap: 'truncate-start', children: [state.editing.text] }), Text({ inverse: true, children: [' '] })]
    : state.sel
      ? [Text({ color: 'magenta', bold: true, children: [range(state.sel)] }), Text({ dimColor: true, wrap: 'truncate-end', children: [` · Enter note · d delete · s send · x clear · ${at}`] })]
      : [Text({ dimColor: true, wrap: 'truncate-end', children: [`click a line · ↑↓ PgUp PgDn scroll${state.notes.length ? ' · s send' : ''} · ${at}`] })]
  drawn.push(Box({ flexDirection: 'row', children: footer }))
  drawn.push(
    Box({
      flexDirection: 'row',
      gap: 1,
      children: buttonsOf(state.notes).map(b => Text({ color: b.key === 'send' ? 'magenta' : undefined, bold: b.key === 'send', wrap: 'truncate-end', children: [b.label] })),
    }),
  )

  return Box({ flexDirection: 'column', width: '100%', children: drawn })
}

export default viewer
