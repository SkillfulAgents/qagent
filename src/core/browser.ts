/**
 * agent-browser session lifecycle. qagent opens, records and closes the
 * browser; the agent drives it in between through `agent-browser mcp`.
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

export type SpawnFn = (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess

export const VIEWPORT = { width: 1280, height: 720 }
export const MCP_TOOL_PROFILES = 'core,tabs'

export interface BrowserSessionOptions {
  outputDir: string
  headless?: boolean
  /** Attach to a running browser or Electron app instead of launching one. */
  cdpUrl?: string
}

export interface BrowserSession {
  /** Environment that points the CLI and the MCP server at this session. */
  env: Record<string, string>
  start(opts: { url?: string; record?: boolean }): Promise<void>
  stop(): Promise<void>
  mcpConfig(): { mcpServers: Record<string, { command: string; args: string[] }> }
}

export function createBrowserSession(opts: BrowserSessionOptions, spawnFn: SpawnFn = spawn): BrowserSession {
  const bin = resolveAgentBrowserBin()
  const env: Record<string, string> = {
    AGENT_BROWSER_SESSION: `qagent-${randomUUID()}`,
    AGENT_BROWSER_SCREENSHOT_DIR: opts.outputDir,
  }
  if (!opts.headless) env.AGENT_BROWSER_HEADED = '1'
  if (opts.cdpUrl) env.AGENT_BROWSER_CDP = opts.cdpUrl

  let opened = !!opts.cdpUrl
  let recording = false
  const run = (...args: string[]) => runAgentBrowser(bin, args, env, spawnFn)

  return {
    env,
    async start({ url, record }) {
      if (!opts.cdpUrl) {
        await run('open', url ?? 'about:blank')
        opened = true
        await run('set', 'viewport', String(VIEWPORT.width), String(VIEWPORT.height))
      }
      if (record) {
        await run('record', 'start', resolve(opts.outputDir, 'video.webm'))
        recording = true
      }
    },
    async stop() {
      // `close` on a session whose browser never launched starts a new launch.
      if (!opened) return
      if (recording) {
        recording = false
        await run('record', 'stop').catch(warn)
      }
      await run('close').catch(warn)
    },
    mcpConfig() {
      return { mcpServers: { 'agent-browser': { command: process.execPath, args: [bin, 'mcp', '--tools', MCP_TOOL_PROFILES] } } }
    },
  }
}

function warn(err: unknown) {
  console.warn(`[browser] ${err instanceof Error ? err.message : String(err)}`)
}

function runAgentBrowser(bin: string, args: string[], env: Record<string, string>, spawnFn: SpawnFn): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    let output = ''
    const proc = spawnFn(process.execPath, [bin, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    })
    proc.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString() })
    proc.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString() })
    proc.on('error', (err) => reject(new Error(`agent-browser ${args.join(' ')}: ${err.message}`)))
    proc.on('close', (code) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`agent-browser ${args.join(' ')} exited with code ${code}: ${output.trim().slice(0, 500)}`))
    })
  })
}

function resolveAgentBrowserBin(): string {
  const require = createRequire(import.meta.url)
  const bin = resolve(dirname(require.resolve('agent-browser/package.json')), 'bin', 'agent-browser.js')
  if (!existsSync(bin)) throw new Error('Cannot resolve agent-browser. Run "npm install" in qagent.')
  return bin
}
