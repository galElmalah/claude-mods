import type { Register } from 'claude-code'
import { ANSI_PALETTE, ansiLineOf, fitLines, inlineTextOf, mermaidBlocksOf, renderOf, type Rendered } from './diagrams.ts'

// Every ```mermaid block Claude writes is drawn as box art where the fence
// was, in the transcript. /mermaid sets the glyph set and the colours.

const COMMAND = 'mermaid'
const PREFS_KEY = 'prefs'
// the transcript's code block has a gutter and margins the art must clear
const INLINE_MARGIN = 6

type Prefs = { ascii: boolean; color: boolean }
const DEFAULT_PREFS: Prefs = { ascii: false, color: true }

let prefs: Prefs = DEFAULT_PREFS
const cache = new Map<string, Rendered>()

const isPrefs = (value: unknown): value is Partial<Prefs> => typeof value === 'object' && value !== null

const rendered = (source: string): Rendered => {
  const key = `${prefs.ascii ? 'a' : 'u'}:${source}`
  let out = cache.get(key)
  if (!out) {
    out = renderOf(source, prefs.ascii)
    cache.set(key, out)
  }
  return out
}

const onOff = (word: string): boolean | undefined =>
  word === 'on' || word === 'true' ? true : word === 'off' || word === 'false' ? false : undefined

const status = () => `mermaid: ascii ${prefs.ascii ? 'on' : 'off'} · color ${prefs.color ? 'on' : 'off'}`

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    const saved = await $.store.get(PREFS_KEY).catch(() => undefined)
    if (isPrefs(saved)) prefs = { ...DEFAULT_PREFS, ...saved }
    await $.command
      .register({
        name: COMMAND,
        description: 'Mermaid diagrams drawn in the transcript: ascii|color on|off, reset (claude-mermaid)',
        argumentHint: '[ascii|color on|off | reset]',
        immediate: true,
      })
      .catch(err => $.ui.log(`mermaid: /${COMMAND} not registered: ${err}`))
    return r
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const blocks = mermaidBlocksOf(e.props.text)
    if (blocks.length === 0) return next(e)
    const columns = (e.viewport?.columns ?? 80) - INLINE_MARGIN
    // colours ride on ANSI escapes in the drawn code block; only the terminal reads them
    const palette = prefs.color && e.surface === 'terminal' ? ANSI_PALETTE : null
    const text = inlineTextOf(e.props.text, blocks, block => {
      const art = rendered(block.source)
      if (!('lines' in art)) return null
      const fit = fitLines(art.lines, columns - block.indent.length)
      const lines = fit.lines.map(line => ansiLineOf(line, palette))
      if (fit.overflow > 0) lines.push(ansiLineOf([{ text: `… ${fit.overflow} columns cut · widen the terminal`, role: 'line' }], palette))
      return lines
    })
    return next({ ...e, props: { ...e.props, text } })
  })

  on('command.run', { command: COMMAND }, async ($, e, next) => {
    const [word = '', value = ''] = e.args.trim().toLowerCase().split(/\s+/)
    const save = async () => {
      await $.store.set(PREFS_KEY, prefs).catch(err => $.ui.log(`mermaid: store write failed: ${err}`))
      cache.clear()
      $.ui.invalidate('ui.render')
    }
    if (word === 'reset') {
      prefs = DEFAULT_PREFS
      await save()
      return { text: status() }
    }
    if (word === 'ascii' || word === 'color') {
      const flag = onOff(value)
      prefs = { ...prefs, [word]: flag ?? !prefs[word] }
      await save()
      const why = { ascii: 'plain ASCII art', color: 'borders, lines and arrows coloured' }[word]
      return { text: `mermaid ${word} ${prefs[word] ? 'on' : 'off'} · ${why}` }
    }
    return { text: `${status()} · /mermaid ascii|color on|off · reset` }
  })
}
