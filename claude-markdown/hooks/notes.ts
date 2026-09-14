// What Claude reads when notes are sent: the file, then each note with the
// lines it is about quoted, in file order. Long quotes are cut in the middle
// so a note on a whole section costs little context.

export type Note = { a: number; b: number; text: string }

const MAX_QUOTE_LINES = 12

export const rangeOf = (note: Note): string => (note.a === note.b ? `L${note.a + 1}` : `L${note.a + 1}-${note.b + 1}`)

const quoted = (lines: readonly string[], note: Note): string => {
  const picked = lines.slice(note.a, note.b + 1)
  const shown =
    picked.length <= MAX_QUOTE_LINES
      ? picked
      : [...picked.slice(0, MAX_QUOTE_LINES / 2), `… ${picked.length - MAX_QUOTE_LINES} lines …`, ...picked.slice(-MAX_QUOTE_LINES / 2)]
  return shown.map(l => `> ${l}`).join('\n')
}

/** the prompt text for `notes` on `path`, whose lines are `lines` */
export const promptOf = (path: string, lines: readonly string[], notes: readonly Note[]): string => {
  const sorted = [...notes].sort((x, y) => x.a - y.a || x.b - y.b)
  const body = sorted.map(note => `${rangeOf(note)}:\n${quoted(lines, note)}\n\n${note.text}`).join('\n\n')
  return `Notes on ${path}:\n\n${body}\n`
}
