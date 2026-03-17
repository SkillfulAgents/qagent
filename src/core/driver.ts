/**
 * Claude Code CLI driver — spawns the `claude` CLI and captures output.
 * This is a thin wrapper; prompt construction lives in prompt-builder.ts.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { writeFile, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import type { DriverOptions, TestResult } from '../types.js'
import { parseFeatureOutput } from '../prompt/output-parser.js'

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000
const DEFAULT_MODEL = 'sonnet'
const DEFAULT_MAX_BUDGET_USD = 5

export async function runTest(
  testPrompt: string,
  options: DriverOptions = {},
): Promise<TestResult> {
  const {
    model = DEFAULT_MODEL,
    verbose = false,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    resumeSessionId,
    maxTurns,
    maxBudgetUsd = DEFAULT_MAX_BUDGET_USD,
  } = options

  const effectiveSessionId = options.sessionId ?? randomUUID()

  const startTime = Date.now()

  let systemPromptFile: string | undefined
  let generatedMcpConfig: string | undefined

  const mcpConfigPath = options.mcpConfigPath ?? await ensureDefaultMcpConfig(options.record)
  generatedMcpConfig = options.mcpConfigPath ? undefined : mcpConfigPath

  const args: string[] = [
    '-p', testPrompt,
    '--output-format', 'text',
    '--model', model,
    '--max-budget-usd', String(maxBudgetUsd),
    '--mcp-config', mcpConfigPath,
    '--dangerously-skip-permissions',
    '--session-id', effectiveSessionId,
  ]

  if (resumeSessionId) {
    args.push('--resume', resumeSessionId)
  } else if (options.systemPrompt) {
    systemPromptFile = resolve(tmpdir(), `qagent-system-${randomUUID()}.md`)
    await writeFile(systemPromptFile, options.systemPrompt, 'utf-8')
    args.push('--system-prompt', systemPromptFile)
  }

  if (maxTurns) {
    args.push('--max-turns', String(maxTurns))
  }

  if (options.mcpConfigPath) {
    console.log(`[driver] MCP config: ${options.mcpConfigPath}`)
  }
  if (resumeSessionId) {
    console.log(`[driver] Resuming session ${resumeSessionId} (model: ${model})...`)
  } else {
    console.log(`[driver] Spawning claude (model: ${model})...`)
  }

  return new Promise<TestResult>((resolvePromise, reject) => {
    let stdout = ''
    let stderr = ''
    let killed = false

    const proc: ChildProcess = spawn('claude', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DISABLE_INTERACTIVITY: '1' },
    })

    if (proc.pid) {
      console.log(`[driver] Process spawned, PID: ${proc.pid}`)
    }

    const timer = setTimeout(() => {
      killed = true
      console.log(`[driver] TIMEOUT after ${Math.round(timeoutMs / 1000)}s, killing process...`)
      proc.kill('SIGTERM')
      setTimeout(() => proc.kill('SIGKILL'), 5000)
    }, timeoutMs)

    const activityCheck = setInterval(() => {
      if (!proc.pid || proc.killed) {
        clearInterval(activityCheck)
        return
      }
      try {
        process.kill(proc.pid, 0)
      } catch {
        clearInterval(activityCheck)
        return
      }
      const elapsedMs = Date.now() - startTime
      console.log(`[health] agent processing... (${Math.round(elapsedMs / 1000)}s)`)
    }, 60000)

    proc.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      stdout += text
      if (verbose) process.stdout.write(text)
    })

    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      stderr += text
      console.log(`[driver][stderr] ${text.trimEnd()}`)
    })

    const cleanup = () => {
      clearInterval(activityCheck)
      if (systemPromptFile) unlink(systemPromptFile).catch(() => {})
      if (generatedMcpConfig) unlink(generatedMcpConfig).catch(() => {})
    }

    proc.on('error', (err) => {
      clearTimeout(timer)
      cleanup()
      console.log(`[driver] SPAWN ERROR: ${err.message}`)
      reject(new Error(`Failed to spawn claude CLI: ${err.message}`))
    })

    proc.on('close', (code) => {
      clearTimeout(timer)
      cleanup()
      const durationMs = Date.now() - startTime
      console.log(`[driver] Process exited with code ${code} after ${(durationMs / 1000).toFixed(1)}s`)
      console.log(`[driver] stdout: ${stdout.length} bytes, stderr: ${stderr.length} bytes`)
      if (stderr && !verbose) {
        console.log(`[driver] stderr tail: ${stderr.slice(-500)}`)
      }

      if (killed) {
        resolvePromise({
          passed: false,
          reason: `Timed out after ${Math.round(timeoutMs / 1000)}s`,
          steps: [],
          bugs: [],
          rawOutput: stdout,
          durationMs,
          sessionId: effectiveSessionId,
        })
        return
      }

      if (code !== 0 && !stdout.match(/\[TEST_PASS\]|\[TEST_FAIL\]|\[BUG_FOUND\]/)) {
        resolvePromise({
          passed: false,
          reason: `claude CLI exited with code ${code}. stderr: ${stderr.slice(0, 500)}`,
          steps: [],
          bugs: [],
          rawOutput: stdout,
          durationMs,
          sessionId: effectiveSessionId,
        })
        return
      }

      const parsed = parseFeatureOutput(stdout)
      resolvePromise({
        ...parsed,
        rawOutput: stdout,
        durationMs,
        sessionId: effectiveSessionId,
      })
    })
  })
}

async function ensureDefaultMcpConfig(record?: boolean): Promise<string> {
  const mcpArgs = ['@playwright/mcp@latest']
  if (record) {
    mcpArgs.push('--save-video=1280x720', `--output-dir=${process.cwd()}`)
  }

  const config = {
    mcpServers: {
      playwright: {
        command: 'npx',
        args: mcpArgs,
      },
    },
  }

  const tmpPath = resolve(tmpdir(), `qagent-mcp-${randomUUID()}.json`)
  const configJson = JSON.stringify(config, null, 2)
  console.log(`[driver] MCP config:\n${configJson}`)
  await writeFile(tmpPath, configJson, 'utf-8')
  return tmpPath
}
