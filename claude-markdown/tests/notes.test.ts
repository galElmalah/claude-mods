import { describe, expect, test } from 'bun:test'
import { promptOf, rangeOf } from '../hooks/notes.ts'

const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`)

describe('promptOf', () => {
  test('names the file, quotes each note\'s lines and follows with the note, in file order', () => {
    const text = promptOf('/docs/a.md', lines, [
      { a: 9, b: 10, text: 'merge these' },
      { a: 2, b: 2, text: 'typo' },
    ])
    expect(text).toBe('Notes on /docs/a.md:\n\nL3:\n> line 3\n\ntypo\n\nL10-11:\n> line 10\n> line 11\n\nmerge these\n')
  })

  test('a long quote keeps its head and tail', () => {
    const text = promptOf('a.md', lines, [{ a: 0, b: 29, text: 'all of it' }])
    expect(text).toContain('> line 6\n> … 18 lines …\n> line 25')
    expect(text).not.toContain('line 12')
  })

  test('rangeOf is 1-based', () => {
    expect(rangeOf({ a: 0, b: 0, text: '' })).toBe('L1')
    expect(rangeOf({ a: 4, b: 6, text: '' })).toBe('L5-7')
  })
})
