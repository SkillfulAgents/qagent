#!/usr/bin/env node

/**
 * QAgent CLI wrapper.
 *
 * Node.js cannot `import()` TypeScript files natively. User-defined hooks
 * (e.g. `.qagent/hooks/seed-db.ts`) are loaded at runtime via dynamic import.
 *
 * We spawn a child process with tsx's --import loader to register TypeScript
 * support before the CLI runs. This avoids the ESM require() cycle issue that
 * occurs with tsx's register() API on Node 22+.
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const entryPath = resolve(__dirname, 'qagent-entry.mjs')

const child = spawn(
  process.execPath,
  ['--import', 'tsx/esm', entryPath, ...process.argv.slice(2)],
  { stdio: 'inherit', env: process.env },
)

child.on('close', (code) => process.exit(code ?? 1))
