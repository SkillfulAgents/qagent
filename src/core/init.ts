/**
 * Scaffolds a new qagent project directory.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve, join, relative } from 'node:path'

const SMOKE_STORY = `id: smoke
name: "Smoke test"
mode: happy-path
steps: |
  1. Navigate to http://localhost:3000
  2. Verify the page loads successfully and the main heading is visible
  3. Take a screenshot
`

const EXAMPLE_FEATURE = `# Login

## Overview
The login page allows users to authenticate with email and password.

## Elements
- Email input field
- Password input field
- "Sign In" button
- "Forgot password?" link
- Error message banner (shown on invalid credentials)

## Flows
1. Enter valid email and password, click Sign In → redirects to dashboard
2. Enter invalid credentials → error banner appears
3. Leave fields empty, click Sign In → validation messages shown
`

const SYSTEM_PROMPT = `You are a QA automation engineer performing end-to-end tests via browser automation.

Be thorough but efficient. Take screenshots after each key action. Report bugs clearly.
`

const ENV_TEMPLATE = `# Required: Anthropic API key for the Claude CLI
ANTHROPIC_API_KEY=
`

interface InitResult {
  projectDir: string
  created: string[]
  skipped: string[]
}

export async function initProject(projectDir: string): Promise<InitResult> {
  const absDir = resolve(projectDir)
  const created: string[] = []
  const skipped: string[] = []

  const dirs = ['stories', 'features', 'hooks']
  for (const dir of dirs) {
    const full = join(absDir, dir)
    if (!existsSync(full)) {
      await mkdir(full, { recursive: true })
      created.push(`${dir}/`)
    }
  }

  const files: [string, string][] = [
    ['stories/smoke.yaml', SMOKE_STORY],
    ['features/login.md', EXAMPLE_FEATURE],
    ['system-prompt.md', SYSTEM_PROMPT],
    ['.env.local', ENV_TEMPLATE],
  ]

  for (const [relPath, content] of files) {
    const full = join(absDir, relPath)
    if (existsSync(full)) {
      skipped.push(relPath)
    } else {
      await writeFile(full, content, 'utf-8')
      created.push(relPath)
    }
  }

  return { projectDir: absDir, created, skipped }
}

export function printInitResult(result: InitResult): void {
  const rel = relative(process.cwd(), result.projectDir) || '.'

  console.log(`\n✔ Project initialized at ${rel}/\n`)

  if (result.created.length > 0) {
    console.log('  Created:')
    for (const f of result.created) {
      console.log(`    ${rel}/${f}`)
    }
  }

  if (result.skipped.length > 0) {
    console.log('\n  Skipped (already exist):')
    for (const f of result.skipped) {
      console.log(`    ${rel}/${f}`)
    }
  }

  console.log(`
Next steps:
  1. Add your ANTHROPIC_API_KEY to ${rel}/.env.local
  2. Edit ${rel}/stories/smoke.yaml with your app's URL
  3. Run: npx qagent run --project-dir ${rel}
`)
}
