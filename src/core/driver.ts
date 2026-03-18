/**
 * Claude Code CLI driver — spawns the `claude` CLI and captures output.
 * Prompt construction lives in prompt-builder.ts.
 */
import { spawn, execSync, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { writeFile, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { DriverOptions, TestResult } from '../types.js'
import { parseFeatureOutput } from '../prompt/output-parser.js'

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000
const DEFAULT_MODEL = 'sonnet'
const DEFAULT_MAX_BUDGET_USD = 5

export type SpawnFn = (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess

export async function runTest(
  testPrompt: string,
  options: DriverOptions = {},
  spawnFn: SpawnFn = spawn,
): Promise<TestResult> {
  const {
    model = DEFAULT_MODEL,
    verbose = false,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    resumeSessionId,
    maxTurns,
    maxBudgetUsd = DEFAULT_MAX_BUDGET_USD,
  } = options

  const sessionId = options.sessionId ?? randomUUID()
  const startTime = Date.now()

  const mcpConfigPath = options.mcpConfigPath ?? await ensureDefaultMcpConfig(options.record, options.outputDir, options.headless)
  const ownsMcpConfig = !options.mcpConfigPath

  const args: string[] = [
    '-p', testPrompt,
    '--output-format', 'text',
    '--model', model,
    '--max-budget-usd', String(maxBudgetUsd),
    '--mcp-config', mcpConfigPath,
    '--dangerously-skip-permissions',
  ]

  let systemPromptFile: string | undefined
  if (resumeSessionId) {
    args.push('--resume', resumeSessionId)
  } else {
    args.push('--session-id', sessionId)
    if (options.systemPrompt) {
      systemPromptFile = resolve(tmpdir(), `qagent-system-${randomUUID()}.md`)
      await writeFile(systemPromptFile, options.systemPrompt, 'utf-8')
      args.push('--system-prompt', systemPromptFile)
    }
  }

  if (maxTurns) args.push('--max-turns', String(maxTurns))

  console.warn(`[driver] Running with --dangerously-skip-permissions (required for non-interactive automation)`)
  if (options.mcpConfigPath) console.log(`[driver] MCP config: ${options.mcpConfigPath}`)
  if (resumeSessionId) {
    console.log(`[driver] Resuming session ${resumeSessionId} (model: ${model})...`)
  } else {
    console.log(`[driver] Spawning claude (model: ${model})...`)
  }

  return new Promise<TestResult>((resolvePromise, reject) => {
    let stdout = ''
    let stderr = ''
    let killed = false

    const proc: ChildProcess = spawnFn('claude', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: options.cwd ?? options.outputDir,
      env: { ...process.env, DISABLE_INTERACTIVITY: '1' },
    })

    if (proc.pid) console.log(`[driver] Process spawned, PID: ${proc.pid}`)

    const timer = setTimeout(() => {
      killed = true
      console.log(`[driver] TIMEOUT after ${Math.round(timeoutMs / 1000)}s, killing process...`)
      proc.kill('SIGTERM')
      setTimeout(() => proc.kill('SIGKILL'), 5000)
    }, timeoutMs)

    const activityCheck = setInterval(() => {
      console.log(`[health] agent processing... (${Math.round((Date.now() - startTime) / 1000)}s)`)
    }, 30000)

    let firstOutputLogged = false
    proc.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      stdout += text
      if (!firstOutputLogged) {
        firstOutputLogged = true
        console.log(`[driver] First output after ${((Date.now() - startTime) / 1000).toFixed(1)}s`)
      }
      if (verbose) process.stderr.write(text)
    })

    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      stderr += text
      process.stderr.write(`[driver][stderr] ${text.trimEnd()}\n`)
    })

    const cleanup = () => {
      clearInterval(activityCheck)
      if (proc.pid) killOrphanMcpProcesses(proc.pid)
      if (systemPromptFile) unlink(systemPromptFile).catch(() => {})
      if (ownsMcpConfig) unlink(mcpConfigPath).catch(() => {})
    }

    proc.on('error', (err) => {
      clearTimeout(timer)
      cleanup()
      reject(new Error(`Failed to spawn claude CLI: ${err.message}`))
    })

    proc.on('close', (code) => {
      clearTimeout(timer)
      cleanup()
      const durationMs = Date.now() - startTime
      console.log(`[driver] Process exited with code ${code} after ${(durationMs / 1000).toFixed(1)}s`)
      console.log(`[driver] stdout: ${stdout.length} bytes, stderr: ${stderr.length} bytes`)

      if (killed) {
        resolvePromise({ passed: false, reason: `Timed out after ${Math.round(timeoutMs / 1000)}s`, steps: [], bugs: [], rawOutput: stdout, durationMs, sessionId })
        return
      }

      if (code !== 0 && !stdout.match(/\[TEST_PASS\]|\[TEST_FAIL\]|\[BUG_FOUND\]/)) {
        resolvePromise({ passed: false, reason: `claude CLI exited with code ${code}. stderr: ${stderr.slice(0, 500)}`, steps: [], bugs: [], rawOutput: stdout, durationMs, sessionId })
        return
      }

      resolvePromise({ ...parseFeatureOutput(stdout), rawOutput: stdout, durationMs, sessionId })
    })
  })
}

async function ensureDefaultMcpConfig(record?: boolean, outputDir?: string, headless?: boolean): Promise<string> {
  const effectiveHeadless = headless ?? false
  const mcpArgs = [resolvePlaywrightMcpBin(), `--output-dir=${outputDir ?? process.cwd()}`]
  if (effectiveHeadless) mcpArgs.push('--headless')
  if (record) mcpArgs.push('--save-video=1280x720')

  const config = { mcpServers: { playwright: { command: 'node', args: mcpArgs } } }
  const tmpPath = resolve(tmpdir(), `qagent-mcp-${randomUUID()}.json`)
  const configJson = JSON.stringify(config, null, 2)
  console.log(`[driver] MCP config:\n${configJson}`)
  await writeFile(tmpPath, configJson, 'utf-8')
  return tmpPath
}

function resolvePlaywrightMcpBin(): string {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const local = resolve(packageRoot, 'node_modules', '@playwright', 'mcp', 'cli.js')
  if (existsSync(local)) return local
  const hoisted = resolve(packageRoot, '..', '@playwright', 'mcp', 'cli.js')
  if (existsSync(hoisted)) return hoisted
  throw new Error('Cannot resolve @playwright/mcp/cli.js. Run "npm install" in qagent.')
}

/**
 * After a Claude CLI process exits, its MCP server child (Playwright) may
 * linger as an orphan. If multiple MCP instances attach to the same CDP
 * endpoint they fight over the browser and crash Electron.
 *
 * We use `pgrep -P <pid>` to find direct children of the Claude process
 * and kill them. This is best-effort — if the process tree is already
 * cleaned up, we silently ignore errors.
 */
function killOrphanMcpProcesses(claudePid: number): void {
  try {
    const children = execSync(`pgrep -P ${claudePid}`, { encoding: 'utf-8' }).trim()
    if (!children) return
    for (const pidStr of children.split('\n')) {
      const pid = parseInt(pidStr, 10)
      if (!pid || pid === claudePid) continue
      try {
        process.kill(pid, 'SIGTERM')
        console.log(`[driver] Killed orphan child process ${pid} (parent: ${claudePid})`)
      } catch { /* already exited */ }
    }
  } catch { /* pgrep failed = no children, fine */ }
}

/**
 * Waits for any MCP/Playwright processes attached to a CDP endpoint to
 * fully exit. Called between features to avoid overlapping sessions.
 */
export async function waitForMcpDrain(delayMs = 1500): Promise<void> {
  await new Promise((r) => setTimeout(r, delayMs))
}
