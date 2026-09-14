import { describe, expect, test } from 'bun:test'
import { cellWidth, inlineOf, layoutOf, plainOf, wrapSpans, type Row } from '../hooks/markdown.ts'

const rows = (text: string, width = 40) => layoutOf(text, { width })
const plain = (text: string, width = 40) => rows(text, width).map(plainOf)
const styles = (row: Row) => row.spans.map(s => s.s ?? '')

describe('inline', () => {
  test('emphasis, code, strike and links become styled spans', () => {
    const spans = inlineOf('a **b** *c* `d` ~~e~~ [f](https://x.y)')
    expect(spans.map(s => [s.t, s.s ?? ''])).toEqual([
      ['a ', ''],
      ['b', 'b'],
      [' ', ''],
      ['c', 'i'],
      [' ', ''],
      ['d', 'code'],
      [' ', ''],
      ['e', 's'],
      [' ', ''],
      ['f', 'link'],
      [' (https://x.y)', 'url'],
    ])
  })

  test('bold inside italic is both; an unclosed marker is text', () => {
    expect(inlineOf('*a **b** c*').map(s => s.s)).toEqual(['i', 'bi', 'i'])
    expect(inlineOf('2 * 3 and a_b').map(s => s.t).join('')).toBe('2 * 3 and a_b')
  })

  test('escapes, images, autolinks and bare urls', () => {
    expect(inlineOf('\\*not\\* ![pic](p.png) <https://a.b> see https://c.d/e.').map(s => s.t).join('')).toBe(
      '*not* [image: pic] https://a.b see https://c.d/e.',
    )
    expect(inlineOf('see https://c.d/e.').at(-2)?.s).toBe('link')
  })
})

describe('wrapping', () => {
  test('breaks at spaces and keeps the style of each piece', () => {
    const out = wrapSpans([{ t: 'one two ' }, { t: 'three four', s: 'b' }], 9)
    expect(out.map(r => r.map(s => s.t).join(''))).toEqual(['one two', 'three', 'four'])
    expect(out[1]![0]!.s).toBe('b')
  })

  test('a row never starts with the space that broke it', () => {
    const out = wrapSpans([{ t: 'link', s: 'link' }, { t: ' and then some words' }], 12)
    expect(out.map(r => r.map(s => s.t).join(''))).toEqual(['link and', 'then some', 'words'])
  })

  test('a word wider than the row is cut where the cells end', () => {
    expect(wrapSpans([{ t: 'abcdefghij' }], 4).map(r => r[0]!.t)).toEqual(['abcd', 'efgh', 'ij'])
  })

  test('wide characters take two cells', () => {
    expect(cellWidth('日本語')).toBe(6)
    expect(cellWidth('á')).toBe(1)
    expect(wrapSpans([{ t: '日本語 日本語' }], 7).length).toBe(2)
  })
})

describe('blocks', () => {
  test('headings: hashes and setext, underlined at levels 1 and 2', () => {
    const out = rows('# One\n\nTwo\n---\n\n### Three')
    expect(out.map(plainOf)).toEqual(['One', '═'.repeat(40), '', 'Two', '─'.repeat(40), '', '### Three'])
    expect(styles(out[0]!)).toEqual(['h1'])
    expect(styles(out[3]!)).toEqual(['h2'])
    expect(styles(out[6]!)).toEqual(['dim', 'h3'])
  })

  test('paragraphs join their lines, wrap, and honour hard breaks', () => {
    expect(plain('one\ntwo  \nthree\\\nfour', 20)).toEqual(['one two', 'three', 'four'])
  })

  test('lists: bullets, numbers, tasks, nesting and continuation lines', () => {
    const out = plain('- a\n- b\n  more\n  - c\n1. x\n2. y\n- [ ] t\n- [x] d', 40)
    expect(out).toEqual(['• a', '• b more', '  • c', '1. x', '2. y', '☐ t', '☑ d'])
  })

  test('a wrapped list item indents its continuation under the text', () => {
    expect(plain('- one two three four five', 14)).toEqual(['• one two', '  three four', '  five'])
  })

  test('quotes prefix every row, nested blocks included', () => {
    expect(plain('> a\n> - b\n> c')).toEqual(['▎ a', '▎ • b', '▎ c'])
  })

  test('fences keep their lines verbatim, the info string dim', () => {
    const out = rows('```ts\nconst  x = 1\n\n  y\n```')
    expect(out.map(plainOf)).toEqual(['ts', '▏const  x = 1', '▏ ', '▏  y'])
    expect(styles(out[1]!)).toEqual(['dim', 'fence'])
  })

  test('a mermaid fence is drawn by the diagram callback when one is given', () => {
    const drawn = layoutOf('```mermaid\nflowchart LR\n  A --> B\n```', { width: 40, diagram: () => [[{ t: '[A]->[B]', s: 'border' }]] })
    expect(drawn.map(plainOf)).toEqual(['[A]->[B]'])
    expect(plain('```mermaid\nflowchart LR\n```')).toEqual(['mermaid', '▏flowchart LR'])
  })

  test('tables are box art when they fit, one card per row when they do not', () => {
    const table = '| A | B |\n|---|---:|\n| x | 1 |\n| yy | 22 |'
    expect(plain(table)).toEqual(['┌────┬────┐', '│ A  │  B │', '├────┼────┤', '│ x  │  1 │', '│ yy │ 22 │', '└────┴────┘'])
    expect(plain(table, 9)).toEqual(['A: x', 'B: 1', '', 'A: yy', 'B: 22'])
  })

  test('rules, html and blank runs', () => {
    expect(plain('a\n\n\n\n---\n<div>x</div>\n\n')).toEqual(['a', '', '─'.repeat(40), '<div>x</div>'])
  })

  test('every row names the source line it draws', () => {
    const out = rows('# T\n\npara one\nline two\n\n- item\n\n```\ncode\n```')
    expect(out.map(r => [plainOf(r), r.src + 1])).toEqual([
      ['T', 1],
      ['═'.repeat(40), 1],
      ['', 2],
      ['para one line two', 3],
      ['', 5],
      ['• item', 6],
      ['', 7],
      ['▏code', 9],
    ])
  })

  test('lays out a long document quickly', () => {
    const doc = Array.from({ length: 400 }, (_, i) => `## Section ${i}\n\nSome **text** with \`code\` and a [link](https://x.y/${i}).\n\n- a\n- b\n\n| k | v |\n|---|---|\n| ${i} | ${i * 2} |\n`).join('\n')
    const t0 = performance.now()
    const out = rows(doc, 60)
    expect(performance.now() - t0).toBeLessThan(200)
    expect(out.length).toBeGreaterThan(4000)
  })
})
