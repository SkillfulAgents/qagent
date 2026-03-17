#!/usr/bin/env node
/**
 * CLI entry point for qagent.
 *
 * Usage:
 *   npx qagent run [--filter <pattern>] [--verbose]
 *                   [--retries <n>] [--base-url <url>] [--target web|electron]
 *                   [--model <model>] [--budget <usd>] [--project-dir <path>]
 */
import { resolveProjectDir, loadEnvFile } from './core/config.js'
import { run } from './core/runner.js'
import type { RunOptions, TestTarget } from './types.js'

function printHelp(): void {
  console.log(`
qagent — Agentic E2E testing framework

Usage:
  qagent run [options]

Options:
  --filter <pattern>      Filter stories by id, name, or path (substring match)
  --verbose               Show full agent output
  --retries <n>           Max retries per feature (default: 1)
  --base-url <url>        Application base URL (default: http://localhost:3000)
  --target <web|electron> Test target (default: web)
  --model <model>         Claude model to use (default: sonnet)
  --budget <usd>          Per-test spending cap in USD
  --project-dir <path>    Path to the qagent project directory
  --record                Record video of browser sessions
  --append                Append results instead of overwriting same run ID
  --upload                Upload results to GitHub Artifacts (requires GITHUB_ACTIONS env)
  --help                  Show this help message
`)
}

function parseArgs(): { command: string; options: RunOptions } {
  const args = process.argv.slice(2)
  const command = args[0] ?? 'run'

  let filter: string | undefined
  let verbose = false
  let maxRetries = 1
  let baseUrl = 'http://localhost:3000'
  let target: TestTarget = 'web'
  let model: string | undefined
  let budgetOverride: number | undefined
  let projectDirArg: string | undefined
  let record = false
  let append = false
  let upload = false

  for (let i = 1; i < args.length; i++) {
    switch (args[i]) {
      case '--filter':
        filter = args[++i]
        break
      case '--verbose':
        verbose = true
        break
      case '--retries':
        maxRetries = parseInt(args[++i], 10) || 1
        break
      case '--base-url':
        baseUrl = args[++i]
        break
      case '--target':
        target = args[++i] as TestTarget
        if (target !== 'web' && target !== 'electron') {
          console.error(`Invalid target: ${target}. Must be "web" or "electron".`)
          process.exit(1)
        }
        break
      case '--model':
        model = args[++i]
        break
      case '--budget':
        budgetOverride = parseFloat(args[++i])
        break
      case '--project-dir':
        projectDirArg = args[++i]
        break
      case '--record':
        record = true
        break
      case '--append':
        append = true
        break
      case '--upload':
        upload = true
        break
      case '--help':
      case '-h':
        printHelp()
        process.exit(0)
    }
  }

  const projectDir = resolveProjectDir(projectDirArg)

  return {
    command,
    options: { filter, verbose, maxRetries, baseUrl, target, model, budgetOverride, projectDir, record, append, upload },
  }
}

async function main() {
  const { command, options } = parseArgs()

  if (command === 'help' || command === '--help') {
    printHelp()
    process.exit(0)
  }

  if (command !== 'run') {
    console.error(`Unknown command: ${command}. Use "qagent run" or "qagent --help".`)
    process.exit(1)
  }

  loadEnvFile(options.projectDir)

  const result = await run(options)
  process.exit(result.failedStories > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(2)
})
