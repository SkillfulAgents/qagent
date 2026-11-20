/**
 * Claude Code CLI driver — opens an agent-browser session, spawns the
 * `claude` CLI against it and captures output.
 * Prompt construction lives in prompt-builder.ts.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { writeFile, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import type { DriverOptions, TestResult } from '../types.js'
import { judgeFeatureOutput } from '../prompt/judge.js'
import { createBrowserSession, type BrowserSession, type SpawnFn } from './browser.js'

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000
const DEFAULT_MODEL = 'sonnet'
const DEFAULT_MAX_BUDGET_USD = 5

export type { SpawnFn }

export async function runTest(
  testPrompt: string,
  options: DriverOptions = {},
  spawnFn: SpawnFn = spawn,
): Promise<TestResult> {
  const browser = createBrowserSession({
    outputDir: options.outputDir ?? process.cwd(),
    headless: options.headless,
    cdpUrl: options.cdpUrl,
  }, spawnFn)
  try {
    await browser.start({ url: options.startUrl, record: options.record })
    return await runClaude(testPrompt, options, browser, spawnFn)
  } finally {
    await browser.stop()
  }
}

async function runClaude(
  testPrompt: string,
  options: DriverOptions,
  browser: BrowserSession,
  spawnFn: SpawnFn,
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

  const mcpConfigPath = resolve(tmpdir(), `qagent-mcp-${randomUUID()}.json`)
  await writeFile(mcpConfigPath, JSON.stringify(browser.mcpConfig(), null, 2), 'utf-8')

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
  console.log(`[driver] Browser session: ${browser.env.AGENT_BROWSER_SESSION}`)
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
      env: { ...process.env, ...browser.env, DISABLE_INTERACTIVITY: '1' },
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
      if (systemPromptFile) unlink(systemPromptFile).catch(() => {})
      unlink(mcpConfigPath).catch(() => {})
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

      judgeFeatureOutput(stdout).then((parsed) => resolvePromise({ ...parsed, rawOutput: stdout, durationMs, sessionId }))
    })
  })
}
