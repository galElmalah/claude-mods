import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { LLMock } from '@copilotkit/aimock'

// Drives a real interactive Claude Code in a tmux pane, its model answered by
// aimock from fixtures, the plugin loaded from this repository with
// --plugin-dir. Screens are read with capture-pane; `-e` keeps the SGR codes
// so a test can see colour.

export const REPO = dirname(dirname(import.meta.dir))

export type Fixture = { prompt: string; reply: string }

export type Session = {
  send: (text: string) => void
  keys: (...keys: string[]) => void
  screen: (withColor?: boolean) => string
  waitFor: (pattern: RegExp | string, timeoutMs?: number) => Promise<string>
  waitForGone: (pattern: RegExp | string, timeoutMs?: number) => Promise<string>
  stop: () => Promise<void>
}

const tmux = (...args: string[]) => execFileSync('tmux', args, { encoding: 'utf8' })

export const hasTmux = () => spawnSync('tmux', ['-V']).status === 0
export const hasClaude = () => spawnSync('claude', ['--version']).status === 0

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// patterns read the plain screen; what is returned keeps the colour
const matches = (screen: string, pattern: RegExp | string) => {
  const plain = stripAnsi(screen)
  return typeof pattern === 'string' ? plain.includes(pattern) : pattern.test(plain)
}

export type SessionOptions = {
  columns?: number
  rows?: number
  /** the fullscreen renderer, where panes dock beside the transcript from 110 columns */
  fullscreen?: boolean
  /** ms between streamed chunks of `chunkSize` characters; instant by default */
  latency?: number
  chunkSize?: number
}

export async function startSession(fixtures: Fixture[], options: SessionOptions = {}): Promise<Session> {
  const { columns = 170, rows = 80, fullscreen = false, latency, chunkSize } = options
  const mock = new LLMock({ port: 0, latency, chunkSize })
  for (const { prompt, reply } of fixtures) mock.onMessage(prompt, { content: reply })
  await mock.start()

  const name = `mermaid-e2e-${process.pid}-${Date.now().toString(36)}`
  const debugLog = join(mkdtempSync(join(tmpdir(), 'mermaid-e2e-')), 'debug.log')
  const env = [
    `ANTHROPIC_BASE_URL=${mock.url}`,
    'ANTHROPIC_API_KEY=mock',
    'CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1',
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1',
    `CLAUDE_CODE_NO_FLICKER=${fullscreen ? '1' : '0'}`,
  ].join(' ')
  const command = `${env} claude --plugin-dir ${REPO} --model claude-sonnet-5 --debug-file ${debugLog}`
  // the repository is the cwd: a folder Claude Code already trusts, so no dialog
  tmux('new-session', '-d', '-s', name, '-x', String(columns), '-y', String(rows), '-c', REPO, command)

  const screen = (withColor = false) => tmux('capture-pane', '-t', name, '-p', ...(withColor ? ['-e'] : []))

  const waitFor = async (pattern: RegExp | string, timeoutMs = 30_000) => {
    const deadline = Date.now() + timeoutMs
    let last = ''
    while (Date.now() < deadline) {
      last = screen(true)
      if (matches(last, pattern)) return last
      await sleep(250)
    }
    throw new Error(`waited ${timeoutMs}ms for ${pattern} · debug log ${debugLog} · screen:\n${screen()}`)
  }

  const waitForGone = async (pattern: RegExp | string, timeoutMs = 30_000) => {
    const deadline = Date.now() + timeoutMs
    let last = ''
    while (Date.now() < deadline) {
      last = screen(true)
      if (!matches(last, pattern)) return last
      await sleep(250)
    }
    throw new Error(`waited ${timeoutMs}ms for ${pattern} to go · screen:\n${last}`)
  }

  const session: Session = {
    // typed literally so a long prompt never lands as several lines
    send: text => {
      tmux('send-keys', '-t', name, '-l', text)
      tmux('send-keys', '-t', name, 'Enter')
    },
    keys: (...keys) => void tmux('send-keys', '-t', name, ...keys),
    screen,
    waitFor,
    waitForGone,
    stop: async () => {
      try {
        tmux('kill-session', '-t', name)
      } catch {}
      await mock.stop()
      rmSync(dirname(debugLog), { recursive: true, force: true })
    },
  }

  // the composer's empty prompt marks a ready session
  try {
    await waitFor(/^❯\s*$/m, 40_000)
  } catch (error) {
    await session.stop()
    throw error
  }
  return session
}

/** the plain screen: no SGR codes (tmux -e keeps them), no-break spaces as spaces */
export const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, '').replace(/\u00a0/g, ' ')

/** the fenced reply an assistant would write for a mermaid source */
export const replyWith = (lead: string, ...sources: string[]) =>
  `${lead}\n\n${sources.map(source => '```mermaid\n' + source + '\n```').join('\n\nand\n\n')}\n`
