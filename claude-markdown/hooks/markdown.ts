// Markdown to rows of styled spans, laid out for a width: the model the
// viewer draws from. Block parsing is line-based (CommonMark's common
// subset: headings, lists, quotes, fences, tables, rules), inline parsing a
// small scanner. Every row remembers the source line it came from so an
// annotation on screen names lines in the file.

export type Style =
  | 'h1' | 'h2' | 'h3' | 'h4'
  | 'b' | 'i' | 'bi' | 's' | 'code' | 'link' | 'url' | 'dim'
  | 'bullet' | 'quote' | 'fence' | 'rule' | 'check' | 'html'
  | 'border' | 'line' | 'arrow' | 'corner' | 'junction' | 'accent' | 'text'

export type Span = { t: string; s?: Style }

export type Row = {
  /** 0-based line of the source the row draws (a wrapped row keeps its first line's) */
  src: number
  spans: Span[]
}

export type Diagram = (source: string, width: number) => Span[][] | null

export type LayoutOptions = {
  width: number
  /** draws a ```mermaid fence; absent, the fence stays source */
  diagram?: Diagram
}

// ---------------------------------------------------------------- widths

const WIDE = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6\u{1f300}-\u{1faff}\u{20000}-\u{3fffd}]/u
const ZERO = /[\u0300-\u036f\u200b-\u200f\ufe0f]/u

export const cellWidth = (text: string): number => {
  let w = 0
  for (const ch of text) w += ZERO.test(ch) ? 0 : WIDE.test(ch) ? 2 : 1
  return w
}

export const spansWidth = (spans: readonly Span[]): number => spans.reduce((w, s) => w + cellWidth(s.t), 0)

// ---------------------------------------------------------------- inline

const LINK = /^\[((?:[^\[\]]|\\.)*)\]\(\s*(?:<([^>]*)>|([^\s)]*))(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/
const AUTOLINK = /^<((?:https?|mailto):[^>\s]+)>/
const BARE_URL = /^https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/
const ESCAPABLE = /[\\`*_{}\[\]()#+\-.!~<>|]/

const merge = (spans: Span[], span: Span): void => {
  if (!span.t) return
  const last = spans[spans.length - 1]
  if (last && last.s === span.s) last.t += span.t
  else spans.push(span)
}

const combine = (base: Style | undefined, add: Style): Style => {
  if (base === undefined || base === add) return add
  if ((base === 'b' && add === 'i') || (base === 'i' && add === 'b') || base === 'bi') return 'bi'
  // a heading, link or strike keeps its own look over emphasis inside it
  return base
}

export const inlineOf = (text: string, base?: Style): Span[] => {
  const out: Span[] = []
  const stack: string[] = []
  let i = 0
  const push = (t: string, s = base) => merge(out, s ? { t, s } : { t })
  const styleAt = (): Style | undefined =>
    stack.reduce<Style | undefined>((s, mark) => combine(s, mark === '~~' ? 's' : mark.length === 2 ? 'b' : 'i'), base)

  while (i < text.length) {
    const ch = text[i]!
    const rest = text.slice(i)
    if (ch === '\\' && i + 1 < text.length && ESCAPABLE.test(text[i + 1]!)) {
      push(text[i + 1]!, styleAt())
      i += 2
      continue
    }
    if (ch === '`') {
      const ticks = /^`+/.exec(rest)![0]
      const close = text.indexOf(ticks, i + ticks.length)
      if (close > 0) {
        push(text.slice(i + ticks.length, close).replace(/^ (?=\S)/, '').replace(/(?<=\S) $/, ''), 'code')
        i = close + ticks.length
        continue
      }
    }
    if (ch === '!' && text[i + 1] === '[') {
      const m = LINK.exec(rest.slice(1))
      if (m) {
        push(`[image: ${m[1] || m[2] || m[3] || ''}]`, 'dim')
        i += 1 + m[0].length
        continue
      }
    }
    if (ch === '[') {
      const m = LINK.exec(rest)
      if (m) {
        for (const span of inlineOf(m[1]!, 'link')) merge(out, span)
        const href = m[2] ?? m[3] ?? ''
        if (href && href !== m[1]) push(` (${href})`, 'url')
        i += m[0].length
        continue
      }
    }
    if (ch === '<') {
      const m = AUTOLINK.exec(rest)
      if (m) {
        push(m[1]!, 'link')
        i += m[0].length
        continue
      }
    }
    if (ch === 'h' && (rest.startsWith('http://') || rest.startsWith('https://'))) {
      const m = BARE_URL.exec(rest)
      if (m) {
        push(m[0], 'link')
        i += m[0].length
        continue
      }
    }
    if (ch === '*' || ch === '_' || ch === '~') {
      const run = /^([*_~])\1?/.exec(rest)![0]
      const mark = ch === '~' ? (run.length === 2 ? '~~' : '') : run
      if (mark) {
        const prev = text[i - 1] ?? ' '
        const next = text[i + mark.length] ?? ' '
        const open = stack.lastIndexOf(mark)
        const canClose = open >= 0 && !/\s/.test(prev)
        const canOpen = !/\s/.test(next) && (ch !== '_' || !/\w/.test(prev))
        if (canClose) {
          stack.splice(open)
          i += mark.length
          continue
        }
        if (canOpen && text.indexOf(mark, i + mark.length) > 0) {
          stack.push(mark)
          i += mark.length
          continue
        }
      }
    }
    push(ch, styleAt())
    i++
  }
  return out
}

// ---------------------------------------------------------------- wrapping

export const wrapSpans = (spans: readonly Span[], width: number): Span[][] => {
  const rows: Span[][] = []
  let row: Span[] = []
  let used = 0
  const flush = () => {
    rows.push(row)
    row = []
    used = 0
  }
  for (const span of spans) {
    for (const word of span.t.split(/(?<= )/)) {
      const w = cellWidth(word)
      if (used + w <= width || (used === 0 && w <= width)) {
        merge(row, { ...span, t: word })
        used += w
        continue
      }
      if (used > 0 && cellWidth(word.trim()) <= width) {
        flush()
        // the space that separated it from the row above is the break itself
        const led = word.trimStart()
        merge(row, { ...span, t: led })
        used = cellWidth(led)
        continue
      }
      // a word wider than the row breaks where the cells run out
      let piece = ''
      let pieceWidth = 0
      for (const ch of word) {
        const cw = cellWidth(ch)
        if (used + pieceWidth + cw > width && used + pieceWidth > 0) {
          merge(row, { ...span, t: piece })
          flush()
          piece = ''
          pieceWidth = 0
        }
        piece += ch
        pieceWidth += cw
      }
      merge(row, { ...span, t: piece })
      used += pieceWidth
    }
  }
  if (row.length || rows.length === 0) rows.push(row)
  return rows.map(r => {
    const last = r[r.length - 1]
    if (last) last.t = last.t.replace(/ +$/, '')
    return r.filter(s => s.t.length > 0)
  })
}

// ---------------------------------------------------------------- blocks

type Ctx = {
  width: number
  diagram?: Diagram
  rows: Row[]
  prefix: Span[]
  contPrefix: Span[]
  /** the prefix draws once (a list bullet), then the continuation takes over */
  once?: true
}

const drew = (ctx: Ctx): void => {
  if (ctx.once) ctx.prefix = ctx.contPrefix
}

const room = (ctx: Ctx) => Math.max(4, ctx.width - spansWidth(ctx.prefix))

const emit = (ctx: Ctx, src: number, spans: readonly Span[], first = ctx.prefix, cont = ctx.contPrefix): void => {
  const wrapped = wrapSpans(spans, Math.max(4, ctx.width - spansWidth(first)))
  wrapped.forEach((line, i) => ctx.rows.push({ src, spans: [...(i === 0 ? first : cont), ...line] }))
  drew(ctx)
}

const emitRaw = (ctx: Ctx, src: number, spans: readonly Span[]): void => {
  ctx.rows.push({ src, spans: [...ctx.prefix, ...spans] })
  drew(ctx)
}

const blank = (ctx: Ctx, src: number): void => {
  const last = ctx.rows[ctx.rows.length - 1]
  if (!last || last.spans.some(s => s.t.trim())) ctx.rows.push({ src, spans: [...ctx.prefix] })
}

const underline = (ctx: Ctx, src: number, level: number): void =>
  emitRaw(ctx, src, [{ t: (level === 1 ? '═' : '─').repeat(room(ctx)), s: level === 1 ? 'h1' : 'rule' }])

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/
const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/
const QUOTE = /^ {0,3}>\s?(.*)$/
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/
const SETEXT = /^ {0,3}(=+|-+)\s*$/
const HTML_OPEN = /^ {0,3}<(\/?[a-zA-Z][\w-]*|!--)/

const headingStyle = (level: number): Style => (level <= 1 ? 'h1' : level === 2 ? 'h2' : level === 3 ? 'h3' : 'h4')

const opensBlock = (line: string) => FENCE.test(line) || HEADING.test(line) || QUOTE.test(line) || LIST.test(line) || RULE.test(line) || HTML_OPEN.test(line)

const cells = (line: string): string[] => {
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  const out: string[] = []
  let cur = ''
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!
    if (ch === '\\' && body[i + 1] === '|') {
      cur += '|'
      i++
    } else if (ch === '|') {
      out.push(cur.trim())
      cur = ''
    } else cur += ch
  }
  out.push(cur.trim())
  return out
}

const parseBlocks = (lines: readonly string[], from: number, ctx: Ctx): void => {
  let i = 0
  const n = lines.length
  while (i < n) {
    const line = lines[i]!
    const src = from + i
    if (!line.trim()) {
      blank(ctx, src)
      i++
      continue
    }
    let m: RegExpExecArray | null
    if ((m = FENCE.exec(line))) {
      const fence = m[1]!
      const info = m[2]!.toLowerCase()
      const body: string[] = []
      let j = i + 1
      while (j < n && !(lines[j]!.trim().startsWith(fence) && /^[`~]+$/.test(lines[j]!.trim()))) body.push(lines[j++]!)
      const drawn = info === 'mermaid' && ctx.diagram ? ctx.diagram(body.join('\n'), room(ctx)) : null
      if (drawn) {
        drawn.forEach((spans, k) => emitRaw(ctx, src + 1 + Math.min(k, Math.max(0, body.length - 1)), spans))
      } else {
        if (info) emitRaw(ctx, src, [{ t: info, s: 'dim' }])
        body.forEach((code, k) => emitRaw(ctx, src + 1 + k, [{ t: '▏', s: 'dim' }, { t: code.replace(/\t/g, '    ') || ' ', s: 'fence' }]))
      }
      i = j + 1
      continue
    }
    if ((m = HEADING.exec(line))) {
      const level = m[1]!.length
      const marker = level <= 2 ? '' : '#'.repeat(level) + ' '
      emit(ctx, src, [...(marker ? [{ t: marker, s: 'dim' as Style }] : []), ...inlineOf(m[2]!, headingStyle(level))])
      if (level <= 2) underline(ctx, src, level)
      i++
      continue
    }
    if (RULE.test(line)) {
      emitRaw(ctx, src, [{ t: '─'.repeat(room(ctx)), s: 'rule' }])
      i++
      continue
    }
    if (QUOTE.test(line)) {
      const inner: string[] = []
      let j = i
      while (j < n && (m = QUOTE.exec(lines[j]!))) inner.push(m[1]!), j++
      const prefix = [...ctx.prefix, { t: '▎ ', s: 'quote' as Style }]
      parseBlocks(inner, src, { ...ctx, prefix, contPrefix: prefix })
      i = j
      continue
    }
    if ((m = LIST.exec(line))) {
      const indent = m[1]!.length
      const ordered = /^\d/.test(m[2]!)
      const items: { src: number; lines: string[]; marker: string }[] = []
      let j = i
      while (j < n) {
        const l = lines[j]!
        const lm = LIST.exec(l)
        if (lm && lm[1]!.length === indent && !RULE.test(l) && /^\d/.test(lm[2]!) === ordered) {
          items.push({ src: from + j, lines: [lm[3]!], marker: lm[2]! })
          j++
          continue
        }
        const item = items[items.length - 1]!
        const contentAt = indent + item.marker.length + 1
        if (!l.trim()) {
          // a blank stays in the item only when an indented line follows
          const next = lines[j + 1]
          if (next !== undefined && next.search(/\S/) >= contentAt) {
            item.lines.push('')
            j++
            continue
          }
          break
        }
        const at = l.search(/\S/)
        if (at > indent && !(lm && lm[1]!.length <= indent)) {
          item.lines.push(l.slice(Math.min(contentAt, at)))
          j++
          continue
        }
        break
      }
      for (const item of items) {
        const label = ordered ? `${item.marker.replace(/[.)]$/, '')}. ` : '• '
        const task = /^\[([ xX])\]\s+(.*)$/.exec(item.lines[0]!)
        const bullet: Span = task ? { t: task[1] === ' ' ? '☐ ' : '☑ ', s: 'check' } : { t: label, s: 'bullet' }
        if (task) item.lines[0] = task[2]!
        const prefix = [...ctx.prefix, bullet]
        const cont = [...ctx.prefix, { t: ' '.repeat(cellWidth(bullet.t)) }]
        parseBlocks(item.lines, item.src, { ...ctx, prefix, contPrefix: cont, once: true })
      }
      i = j
      continue
    }
    if (line.includes('|') && i + 1 < n && TABLE_SEP.test(lines[i + 1]!)) {
      const header = cells(line)
      const aligns = cells(lines[i + 1]!).map(c => (c.startsWith(':') && c.endsWith(':') ? 'c' : c.endsWith(':') ? 'r' : 'l'))
      const body: string[][] = []
      let j = i + 2
      while (j < n && lines[j]!.trim() && lines[j]!.includes('|')) body.push(cells(lines[j++]!))
      table(ctx, src, header, aligns, body)
      i = j
      continue
    }
    if (HTML_OPEN.test(line)) {
      emit(ctx, src, [{ t: line.trim(), s: 'html' }])
      i++
      continue
    }
    // a paragraph runs to a blank or a block opener; a setext underline makes it a heading
    const para: string[] = [line.trimStart()]
    let j = i + 1
    let setext = 0
    while (j < n) {
      const l = lines[j]!
      if (SETEXT.test(l)) {
        setext = l.trim()[0] === '=' ? 1 : 2
        j++
        break
      }
      if (!l.trim() || opensBlock(l)) break
      para.push(l.trimStart())
      j++
    }
    if (setext) {
      emit(ctx, src, inlineOf(para.join(' '), headingStyle(setext)))
      underline(ctx, src, setext)
    } else {
      // two trailing spaces or a backslash hard-break the line
      const parts = para.join('\n').replace(/( {2,}|\\)\n/g, '\u0001').split('\u0001')
      parts.forEach((part, k) => emit(ctx, src, inlineOf(part.replace(/\n/g, ' ').trim()), k === 0 ? ctx.prefix : ctx.contPrefix, ctx.contPrefix))
    }
    i = j
  }
}

const table = (ctx: Ctx, src: number, header: string[], aligns: string[], body: string[][]): void => {
  const cols = Math.max(header.length, ...body.map(r => r.length))
  const rows = [header, ...body].map(r => Array.from({ length: cols }, (_, c) => inlineOf(r[c] ?? '')))
  const widths = Array.from({ length: cols }, (_, c) => Math.max(1, ...rows.map(r => spansWidth(r[c]!))))
  const total = widths.reduce((a, b) => a + b + 3, 1)
  if (total > room(ctx)) {
    // too wide for the pane: one card per row, header names as labels
    body.forEach((r, k) => {
      if (k > 0) blank(ctx, src + 2 + k)
      for (let c = 0; c < cols; c++) {
        emit(ctx, src + 2 + k, [{ t: `${header[c] ?? ''}: `, s: 'b' }, ...inlineOf(r[c] ?? '')], ctx.prefix, [...ctx.prefix, { t: '  ' }])
      }
    })
    return
  }
  const pad = (spans: Span[], width: number, align: string): Span[] => {
    const gap = width - spansWidth(spans)
    const left = align === 'r' ? gap : align === 'c' ? Math.floor(gap / 2) : 0
    return [{ t: ' '.repeat(left) }, ...spans, { t: ' '.repeat(gap - left) }]
  }
  const rule = (l: string, m: string, r: string): Span[] => [{ t: l + widths.map(w => '─'.repeat(w + 2)).join(m) + r, s: 'border' }]
  const line = (cellsOf: Span[][]): Span[] => {
    const out: Span[] = [{ t: '│ ', s: 'border' }]
    cellsOf.forEach((c, k) => {
      out.push(...pad(c, widths[k]!, aligns[k] ?? 'l'))
      out.push({ t: k === cellsOf.length - 1 ? ' │' : ' │ ', s: 'border' })
    })
    return out
  }
  emitRaw(ctx, src, rule('┌', '┬', '┐'))
  emitRaw(ctx, src, line(rows[0]!.map(c => c.map(s => ({ ...s, s: s.s ?? 'b' })))))
  emitRaw(ctx, src + 1, rule('├', '┼', '┤'))
  rows.slice(1).forEach((r, k) => emitRaw(ctx, src + 2 + k, line(r)))
  emitRaw(ctx, src + 1 + body.length, rule('└', '┴', '┘'))
}

/** the rows a markdown text lays out to for a width */
export const layoutOf = (text: string, options: LayoutOptions): Row[] => {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const ctx: Ctx = { width: Math.max(8, options.width), diagram: options.diagram, rows: [], prefix: [], contPrefix: [] }
  parseBlocks(lines, 0, ctx)
  while (ctx.rows.length && !ctx.rows[ctx.rows.length - 1]!.spans.some(s => s.t.trim())) ctx.rows.pop()
  return ctx.rows
}

/** the plain text of a row */
export const plainOf = (row: Row): string => row.spans.map(s => s.t).join('')
