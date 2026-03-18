#!/usr/bin/env node
/**
 * CLI entry point for qagent.
 *
 * Usage:
 *   npx qagent run [--filter <pattern>] [--verbose]
 *                   [--retries <n>] [--base-url <url>]
 *                   [--model <model>] [--budget <usd>] [--project-dir <path>]
 */
import { resolveProjectDir, loadEnvFile } from './core/config.js'
import { run } from './core/runner.js'
import type { RunOptions } from './types.js'

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
  --model <model>         Claude model to use (default: sonnet)
  --budget <usd>          Per-test spending cap in USD
  --project-dir <path>    Path to the qagent project directory
  --record                Record video of browser sessions
  --headless              Force headless browser (no visible window)
  --append                Append results instead of overwriting same run ID
  --upload                Upload results to GitHub Artifacts (requires GITHUB_ACTIONS env)
  --help                  Show this help message
`)
}

function requireArg(args: string[], i: number, flag: string): string {
  if (i >= args.length || args[i].startsWith('--')) {
    throw new Error(`Missing value for ${flag}`)
  }
  return args[i]
}

export function parseArgs(argv: string[] = process.argv.slice(2)): { command: string; options: RunOptions } {
  const args = argv
  const command = args[0] ?? 'run'

  let filter: string | undefined
  let verbose = false
  let maxRetries = 1
  let baseUrl = 'http://localhost:3000'
  let model: string | undefined
  let budgetOverride: number | undefined
  let projectDirArg: string | undefined
  let record = false
  let headless: boolean | undefined
  let append = false
  let upload = false

  for (let i = 1; i < args.length; i++) {
    switch (args[i]) {
      case '--filter':
        filter = requireArg(args, ++i, '--filter')
        break
      case '--verbose':
        verbose = true
        break
      case '--retries':
        maxRetries = parseInt(requireArg(args, ++i, '--retries'), 10) || 1
        break
      case '--base-url':
        baseUrl = requireArg(args, ++i, '--base-url')
        break
      case '--model':
        model = requireArg(args, ++i, '--model')
        break
      case '--budget':
        budgetOverride = parseFloat(requireArg(args, ++i, '--budget'))
        break
      case '--project-dir':
        projectDirArg = requireArg(args, ++i, '--project-dir')
        break
      case '--record':
        record = true
        break
      case '--headless':
        headless = true
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
    options: { filter, verbose, maxRetries, baseUrl, model, budgetOverride, projectDir, record, headless, append, upload },
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

const isCLI = process.argv[1]?.endsWith('cli.js') || process.argv[1]?.endsWith('cli.ts')
if (isCLI) {
  main().catch((err) => {
    console.error('Fatal error:', err)
    process.exit(2)
  })
}
