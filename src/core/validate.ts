/**
 * Validates project configuration: stories, features, hooks, environment.
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { execSync } from 'node:child_process'
import type { Story, TestMode } from '../types.js'
import { loadStories } from '../loader/story-loader.js'

const VALID_MODES: TestMode[] = ['happy-path', 'feature-test', 'chaos-monkey']

export interface ValidationIssue {
  level: 'error' | 'warn'
  storyId?: string
  message: string
}

export interface ValidationResult {
  issues: ValidationIssue[]
  storyCount: number
  ok: boolean
}

function checkStory(story: Story, projectDir: string): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const id = story.id

  if (!story.name) {
    issues.push({ level: 'error', storyId: id, message: 'missing "name" field' })
  }

  if (!VALID_MODES.includes(story.mode)) {
    const suggestion = VALID_MODES.find((m) => m.startsWith(story.mode?.slice(0, 3) ?? ''))
    const hint = suggestion ? ` Did you mean "${suggestion}"?` : ''
    issues.push({ level: 'error', storyId: id, message: `unknown mode "${story.mode}".${hint}` })
  }

  if (story.mode === 'happy-path' && !story.steps) {
    issues.push({ level: 'error', storyId: id, message: 'mode is "happy-path" but no "steps" field defined' })
  }

  if (story.mode === 'feature-test' && (!story.features || story.features.length === 0)) {
    issues.push({ level: 'warn', storyId: id, message: 'mode is "feature-test" but no "features" defined — will be skipped at runtime' })
  }

  if (story.features) {
    for (const feat of story.features) {
      const featPath = resolve(projectDir, 'features', `${feat}.md`)
      if (!existsSync(featPath)) {
        issues.push({ level: 'error', storyId: id, message: `feature file not found: features/${feat}.md` })
      }
    }
  }

  const hooksDir = resolve(projectDir, 'hooks')
  for (const hookName of [...(story.setup ?? []), ...(story.teardown ?? [])]) {
    const tsPath = resolve(hooksDir, `${hookName}.ts`)
    const jsPath = resolve(hooksDir, `${hookName}.js`)
    if (!existsSync(tsPath) && !existsSync(jsPath)) {
      issues.push({ level: 'error', storyId: id, message: `hook file not found: hooks/${hookName}.{ts,js}` })
    }
  }

  return issues
}

function checkEnvironment(projectDir: string): ValidationIssue[] {
  const issues: ValidationIssue[] = []

  try {
    execSync('claude --version', { stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    issues.push({ level: 'error', message: '"claude" CLI not found. Install it: https://docs.anthropic.com/en/docs/claude-cli' })
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    const envPath = resolve(projectDir, '.env.local')
    if (!existsSync(envPath)) {
      issues.push({ level: 'warn', message: 'ANTHROPIC_API_KEY not set and no .env.local found' })
    }
  }

  return issues
}

export async function validate(projectDir: string): Promise<ValidationResult> {
  const issues: ValidationIssue[] = []

  issues.push(...checkEnvironment(projectDir))

  let stories: Story[] = []
  try {
    stories = await loadStories(projectDir)
  } catch (err) {
    issues.push({ level: 'error', message: err instanceof Error ? err.message : String(err) })
    return { issues, storyCount: 0, ok: false }
  }

  for (const story of stories) {
    issues.push(...checkStory(story, projectDir))
  }

  const ok = issues.every((i) => i.level !== 'error')
  return { issues, storyCount: stories.length, ok }
}

export function printValidation(result: ValidationResult): void {
  console.log(`\nValidated ${result.storyCount} story/stories.\n`)

  if (result.issues.length === 0) {
    console.log('  All checks passed.\n')
    return
  }

  const errors = result.issues.filter((i) => i.level === 'error')
  const warns = result.issues.filter((i) => i.level === 'warn')

  for (const issue of errors) {
    const prefix = issue.storyId ? `[${issue.storyId}] ` : ''
    console.log(`  ERROR  ${prefix}${issue.message}`)
  }
  for (const issue of warns) {
    const prefix = issue.storyId ? `[${issue.storyId}] ` : ''
    console.log(`  WARN   ${prefix}${issue.message}`)
  }

  console.log(`\n  ${errors.length} error(s), ${warns.length} warning(s)\n`)
}
