/**
 * Generic Electron launcher — discovers the CDP WebSocket endpoint
 * and generates a temporary Playwright MCP config file pointing at it.
 *
 * Consumers provide their own Electron binary and main JS paths via options.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

export interface ElectronLaunchOptions {
  electronBin: string
  mainJs: string
  cwd?: string
  cdpPort?: number
  env?: Record<string, string>
  /** Regex to extract the API port from stdout. Must have a capture group for the port number. */
  apiPortPattern?: RegExp
  /** Timeout in ms to wait for CDP + API readiness. */
  timeoutMs?: number
}

export interface ElectronHandle {
  cdpEndpoint: string
  apiPort: number
  mcpConfigPath: string
  kill: () => void
}

const DEFAULT_CDP_PORT = 9222
const DEFAULT_TIMEOUT_MS = 30_000

let electronProc: ChildProcess | null = null

export async function launchElectron(opts: ElectronLaunchOptions): Promise<ElectronHandle> {
  const {
    electronBin,
    mainJs,
    cwd,
    cdpPort = DEFAULT_CDP_PORT,
    env = {},
    apiPortPattern = /API server running on http:\/\/localhost:(\d+)/,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = opts

  let resolveApiPort: (port: number) => void
  const apiPortPromise = new Promise<number>((r) => { resolveApiPort = r })
  let apiPortResolved = false

  electronProc = spawn(electronBin, [mainJs, `--remote-debugging-port=${cdpPort}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env, DISPLAY: process.env.DISPLAY || ':99' },
    cwd,
  })

  electronProc.stdout?.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim()
    if (text) console.log(`  [electron][stdout] ${text}`)
    if (!apiPortResolved) {
      const match = text.match(apiPortPattern)
      if (match) {
        apiPortResolved = true
        resolveApiPort!(parseInt(match[1], 10))
      }
    }
  })

  electronProc.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim()
    if (text) console.log(`  [electron][stderr] ${text}`)
  })

  electronProc.on('exit', (code) => {
    console.log(`  [electron] Process exited with code ${code}`)
    electronProc = null
  })

  const [cdpEndpoint, apiPort] = await Promise.all([
    waitForCdp(cdpPort, timeoutMs),
    Promise.race([
      apiPortPromise,
      new Promise<number>((_, reject) =>
        setTimeout(() => reject(new Error('Timed out waiting for Electron API port')), timeoutMs),
      ),
    ]),
  ])

  console.log(`  [electron] CDP endpoint ready: ${cdpEndpoint}`)
  console.log(`  [electron] API server port: ${apiPort}`)

  await waitForApi(apiPort, timeoutMs)
  console.log(`  [electron] API is ready`)

  const mcpConfigPath = await writeCdpMcpConfig(cdpEndpoint)

  return {
    cdpEndpoint,
    apiPort,
    mcpConfigPath,
    kill: killElectron,
  }
}

export function killElectron(): void {
  if (electronProc) {
    console.log('  [electron] Killing Electron process...')
    electronProc.kill('SIGTERM')
    setTimeout(() => electronProc?.kill('SIGKILL'), 5000)
    electronProc = null
  }
}

async function writeCdpMcpConfig(cdpEndpoint: string): Promise<string> {
  const config = {
    mcpServers: {
      playwright: {
        command: 'npx',
        args: ['@playwright/mcp@latest', '--cdp-endpoint', cdpEndpoint],
      },
    },
  }
  const tmpPath = resolve(tmpdir(), `playwright-mcp-cdp-${randomUUID()}.json`)
  await writeFile(tmpPath, JSON.stringify(config, null, 2), 'utf-8')
  return tmpPath
}

async function waitForCdp(port: number, timeoutMs: number): Promise<string> {
  const start = Date.now()
  const url = `http://127.0.0.1:${port}/json/version`

  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url)
      if (res.ok) {
        const data = (await res.json()) as { webSocketDebuggerUrl?: string }
        if (data.webSocketDebuggerUrl) return data.webSocketDebuggerUrl
      }
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`CDP endpoint not available on port ${port} after ${timeoutMs}ms`)
}

async function waitForApi(port: number, timeoutMs: number): Promise<void> {
  const start = Date.now()
  const url = `http://localhost:${port}/api/settings`

  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`API not ready at http://localhost:${port} after ${timeoutMs}ms`)
}
