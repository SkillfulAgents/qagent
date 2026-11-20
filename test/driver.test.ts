import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runTest, type SpawnFn } from '../src/core/driver.ts'

interface Call {
  command: string
  session: string | undefined
  cdp: string | undefined
  mcpConfig?: { mcpServers: Record<string, { args: string[] }> }
}

function fakeSpawn(failOn?: string) {
  const calls: Call[] = []
  const spawnFn: SpawnFn = (cmd: string, args: string[], opts: SpawnOptions) => {
    const env = opts.env ?? {}
    const isClaude = cmd === 'claude'
    const command = isClaude ? 'claude' : args.slice(1).join(' ')
    const call: Call = { command, session: env.AGENT_BROWSER_SESSION, cdp: env.AGENT_BROWSER_CDP }
    if (isClaude) {
      call.mcpConfig = JSON.parse(readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf-8'))
    }
    calls.push(call)

    const proc = new EventEmitter() as ChildProcess
    const stdout = new PassThrough()
    Object.assign(proc, { stdout, stderr: new PassThrough(), pid: undefined, kill: () => true })
    setImmediate(() => {
      if (isClaude) stdout.write('[TEST_PASS]\n[REASON] Sign-in works.\n')
      stdout.end()
      proc.emit('close', failOn && command.startsWith(failOn) ? 1 : 0)
    })
    return proc
  }
  return { spawnFn, calls }
}

describe('runTest browser lifecycle', () => {
  beforeEach(() => {
    vi.stubEnv('OPENAI_API_KEY', '')
  })

  it('opens, records and closes one agent-browser session around the claude run', async () => {
    const { spawnFn, calls } = fakeSpawn()

    const result = await runTest('test prompt', {
      outputDir: '/tmp/qagent-out',
      startUrl: 'http://localhost:3000',
      record: true,
      headless: true,
    }, spawnFn)

    expect(result.passed).toBe(true)
    expect(calls.map((c) => c.command)).toEqual([
      'open http://localhost:3000',
      'set viewport 1280 720',
      'record start /tmp/qagent-out/video.webm',
      'claude',
      'record stop',
      'close',
    ])
    const session = calls[0].session
    expect(session).toMatch(/^qagent-/)
    expect(calls.every((c) => c.session === session)).toBe(true)
    expect(calls[3].mcpConfig?.mcpServers['agent-browser'].args.slice(1)).toEqual(['mcp', '--tools', 'core,tabs'])
  })

  it('attaches over CDP without opening a page, and still closes the session', async () => {
    const { spawnFn, calls } = fakeSpawn()

    await runTest('test prompt', { outputDir: '/tmp/qagent-out', cdpUrl: '9222' }, spawnFn)

    expect(calls.map((c) => c.command)).toEqual(['claude', 'close'])
    expect(calls.every((c) => c.cdp === '9222')).toBe(true)
  })

  it('does not run claude or close when the browser fails to open', async () => {
    const { spawnFn, calls } = fakeSpawn('open')

    await expect(runTest('test prompt', { outputDir: '/tmp/qagent-out', startUrl: 'http://localhost:3000' }, spawnFn))
      .rejects.toThrow(/agent-browser open http:\/\/localhost:3000 exited with code 1/)
    expect(calls.map((c) => c.command)).toEqual(['open http://localhost:3000'])
  })
})
