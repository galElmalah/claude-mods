import type { Elements, EngineInterface, Register, RenderElement } from 'claude-code'
import { layoutOf, type Row, type Span } from './markdown.ts'
import { promptOf, type Note } from './notes.ts'
import { DRAWN_KINDS, fitLines, kindOf, leftToRightOf, pickLayout, renderOf, withoutPseudoStates } from './vendor/diagrams.js'
import type { ViewerMessage, ViewerProps } from './viewer.ts'

// A markdown file drawn in a pane of its own: /md <path>, or the button a
// Read, Write or Edit of a .md file gets in the transcript. The hooks module
// reads and lays the file out; hooks/viewer.ts draws it and takes the
// clicks. Notes made there come back here to be put in the prompt box.

const COMMAND = 'md'
/** the model's tool, `mcp__claude-markdown__view`: opens the pane on a file */
const TOOL = 'view'
const TOOL_FULL = `mcp__claude-markdown__${TOOL}`
const PANE = 'markdown'
const VIEWER = 'viewer'
const LAST_KEY = 'last'
/** rows handed to the viewer at once; it asks again near the edge */
const WINDOW = 400
const POLL_MS = 1000
// rows the viewer takes above the prompt, where the pane grows to its tree
// and so cannot tell us a height of its own
const INLINE_ROWS = 24

type Doc = {
  path: string
  lines: string[]
  mtimeMs: number
  version: number
  width: number
  rows: Row[]
}

let doc: Doc | null = null
let notes: Note[] = []
let windowTop = 0
/** bumps when this module changes the notes (send, clear): the viewer adopts them */
let notesVersion = 0
let viewerHeight = 3
let isOpen = false
let poll: { cancel: () => void } | null = null

const isMarkdown = (path: unknown): path is string => typeof path === 'string' && /\.(md|markdown|mdx)$/i.test(path)
const nameOf = (path: string) => path.split('/').pop() ?? path
const gutterOf = (d: Doc) => Math.max(2, String(d.lines.length).length)

const drawDiagram = (source: string, width: number): Span[][] | null => {
  if (!DRAWN_KINDS.has(kindOf(source))) return null
  const prepared = withoutPseudoStates(source)
  const base = renderOf(prepared, false)
  const sideways = leftToRightOf(prepared)
  const art = sideways ? pickLayout(base, renderOf(sideways, false), width) : base
  if (!('lines' in art)) return null
  return fitLines(art.lines, width).lines.map(line => line.map(s => (s.role ? { t: s.text, s: s.role } : { t: s.text })))
}

const layout = (lines: string[], width: number): Row[] => layoutOf(lines.join('\n'), { width, diagram: drawDiagram })

const load = async ($: EngineInterface, path: string): Promise<Doc> => {
  const [text, stat] = await Promise.all([$.fs.read(path), $.fs.stat(path)])
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const width = doc?.path === path ? doc.width : 0
  return { path, lines, mtimeMs: stat.mtimeMs, version: (doc?.version ?? 0) + 1, width, rows: width ? layout(lines, width) : [] }
}

const viewerProps = (): ViewerProps | null => {
  if (!doc) return null
  const start = Math.max(0, Math.min(windowTop - WINDOW / 4, doc.rows.length - WINDOW))
  return {
    path: doc.path,
    total: doc.rows.length,
    srcTotal: doc.lines.length,
    start: Math.floor(start),
    rows: doc.rows.slice(Math.floor(start), Math.floor(start) + WINDOW),
    height: viewerHeight,
    notes,
    notesVersion,
    version: doc.version,
  }
}

const markdownPathOf = (tool: string, input: unknown): string | null => {
  if (tool !== 'Read' && tool !== 'Write' && tool !== 'Edit') return null
  const path = (input as { file_path?: unknown } | null)?.file_path
  return isMarkdown(path) ? path : null
}

const withViewButtons = (
  $: EngineInterface,
  { Box, Button }: Pick<Elements['terminal'], 'Box' | 'Button'>,
  tree: RenderElement,
  paths: string[],
  id: string,
): RenderElement =>
  Box({
    flexDirection: 'column',
    children: [
      tree,
      Box({ flexDirection: 'row', marginLeft: 2, gap: 1, children: paths.map(path => Button({ key: `view:${id}:${path}`, label: `View ${nameOf(path)}`, onPress: () => void open($, path) })) }),
    ],
  })

const resolvePath = (cwd: string, arg: string): string => {
  if (arg.startsWith('/')) return arg
  if (arg.startsWith('~/')) return arg
  return `${cwd.replace(/\/$/, '')}/${arg.replace(/^\.\//, '')}`
}

const open = async ($: EngineInterface, path: string): Promise<string> => {
  try {
    const fresh = await load($, path)
    if (doc?.path !== path) notes = []
    doc = fresh
    windowTop = 0
  } catch (err) {
    return `md: cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`
  }
  await $.store.set(LAST_KEY, path).catch(() => undefined)
  await $.ui.open({ id: PANE, title: nameOf(path), focus: true })
  isOpen = true
  $.ui.invalidate('ui.render')
  watch($)
  return `md: ${nameOf(path)} open in the pane · click a line to note it`
}

// the file on disk changes under an editor or a tool: reload, keep the view
const watch = ($: EngineInterface) => {
  poll?.cancel()
  const tick = async () => {
    poll = null
    if (!isOpen || !doc) return
    const stat = await $.fs.stat(doc.path).catch(() => null)
    if (stat && stat.mtimeMs !== doc.mtimeMs) await reload($)
    if (isOpen) poll = $.clock.after(POLL_MS, () => void tick())
  }
  poll = $.clock.after(POLL_MS, () => void tick())
}

const reload = async ($: EngineInterface) => {
  if (!doc) return
  try {
    doc = await load($, doc.path)
    $.ui.invalidate('ui.render')
  } catch {}
}

const send = async ($: EngineInterface) => {
  if (!doc || notes.length === 0) return
  const text = promptOf(doc.path, doc.lines, notes)
  const filled = await $.prompt.fill({ text }).catch(() => ({ isFilled: false }))
  if (!filled.isFilled) {
    $.ui.toast('md: the prompt box is busy; notes kept')
    return
  }
  notes = []
  notesVersion++
  $.ui.invalidate('ui.render')
  $.ui.toast('md: notes are in the prompt box · Esc, then Enter sends them')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await $.command
      .register({
        name: COMMAND,
        description: 'Markdown viewer in a pane: /md <file>, /md (last file), /md close (claude-markdown)',
        argumentHint: '[path | close]',
        immediate: true,
      })
      .catch(err => $.ui.log(`md: /${COMMAND} not registered: ${err}`))
    await $.tool
      .register({
        name: TOOL,
        description:
          'Open a markdown file in the markdown viewer pane beside the transcript, so the person can read it and leave line notes. Use when asked to show, open or display a .md file (or a doc, README, plan, spec written in markdown), or after writing one the person will want to read.',
        inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'The markdown file, absolute or relative to the working directory' } }, required: ['path'] },
      })
      .catch(err => $.ui.log(`md: tool not registered: ${err}`))
    return r
  })



  on('command.run', { command: COMMAND }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'close') {
      await $.ui.close({ id: PANE }).catch(() => undefined)
      return { text: 'md: closed' }
    }
    if (arg) return { text: await open($, resolvePath(await $.session.cwd(), arg)) }
    const last = doc?.path ?? (await $.store.get(LAST_KEY).catch(() => undefined))
    if (typeof last === 'string') return { text: await open($, last) }
    return { text: 'md: /md <path> opens a markdown file in a pane · Read/Write/Edit rows of .md files get a view button' }
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    const r = await next(e)
    isOpen = false
    poll?.cancel()
    poll = null
    return r
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE || !doc || e.surface === 'mobile') return next(e)
    const { Client } = $.ui.resolve(e)
    // the viewer's gutter (line numbers and a note mark) comes off the text width
    const width = Math.max(20, e.props.bodyColumns - gutterOf(doc) - 1)
    if (doc.width !== width) doc = { ...doc, width, rows: layout(doc.lines, width) }
    viewerHeight = e.props.placement === 'inline'
      ? Math.min(INLINE_ROWS, doc.rows.length + 3)
      : Math.max(4, e.props.scroll.bodyRows)
    // the viewer draws its own title and buttons: the pane's tree stays the
    // same while the person works, so the instance keeps the keyboard
    return Client({ key: VIEWER, module: './viewer.ts', props: viewerProps()! })
  })

  on('ui.message', { element: VIEWER }, async ($, e) => {
    const data = e.data as ViewerMessage
    if (data.type === 'window') {
      windowTop = data.top
      const props = viewerProps()
      return props ? { props } : {}
    }
    if (data.type === 'notes') {
      notes = data.notes
      return {}
    }
    if (data.type === 'send') await send($)
    if (data.type === 'close') await $.ui.close({ id: PANE }).catch(() => undefined)
    return {}
  })

  // a Read, Write or Edit of a .md file: a button under its row opens it;
  // reads fold into a group line, which gets one button per file
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const tree = await next(e)
    const path = markdownPathOf(e.props.tool, e.props.input)
    return path ? withViewButtons($, $.ui.resolve(e), tree, [path], e.props.tool_use_id) : tree
  })

  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    const tree = await next(e)
    if (e.props.isExpanded) return tree
    const paths = [...new Set(e.props.calls.map(c => markdownPathOf(c.tool, c.input)).filter((p): p is string => p !== null))]
    return paths.length ? withViewButtons($, $.ui.resolve(e), tree, paths, e.requestId) : tree
  })

  // the model's own tool opens the pane; a Write or Edit of the file on
  // screen redraws it at once
  on('tool.call', async ($, e, next) => {
    if ((e.tool as string) === TOOL_FULL) {
      const path = (e as { path?: unknown }).path
      if (typeof path !== 'string' || !path) return { deny: 'md: a path is required' }
      const text = await open($, resolvePath(await $.session.cwd(), path))
      return text.startsWith('md: cannot') ? { deny: text } : { result: `${text}. The pane shows it now; the person may send notes on its lines.` }
    }
    const r = await next(e)
    if (doc && isOpen && (e.tool === 'Write' || e.tool === 'Edit') && (e as { file_path?: unknown }).file_path === doc.path) await reload($)
    return r
  })
}
