import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildChaosFollowUpPrompt,
  buildChaosPrompt,
  buildStepsPrompt,
  buildSystemPrompt,
} from '../src/prompt/prompt-builder.ts'
import { parseChaosOutput, parseFeatureOutput } from '../src/prompt/output-parser.ts'

const tempDirs: string[] = []

async function createTempProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qagent-test-'))
  tempDirs.push(dir)
  await mkdir(join(dir, 'features'), { recursive: true })
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('parseFeatureOutput', () => {
  it('parses pass/fail markers, reason, steps, and bug lines', () => {
    const output = [
      '[TEST_FAIL]',
      '[REASON] Login flow has regressions',
      '[BUG_FOUND] submit button not clickable',
      '[BUG_FOUND] error toast is invisible',
      '[STEP] open login page',
      '[STEP] fill credentials and click sign in',
    ].join('\n')

    const parsed = parseFeatureOutput(output)

    expect(parsed.passed).toBe(false)
    expect(parsed.reason).toContain('Login flow has regressions')
    expect(parsed.reason).toContain('submit button not clickable')
    expect(parsed.reason).toContain('error toast is invisible')
    expect(parsed.steps).toEqual(['open login page', 'fill credentials and click sign in'])
    expect(parsed.bugs).toEqual(['submit button not clickable', 'error toast is invisible'])
  })

  it('treats mixed TEST_PASS and TEST_FAIL as fail', () => {
    const output = ['[TEST_PASS]', '[TEST_FAIL]', '[REASON] inconsistent report'].join('\n')
    const parsed = parseFeatureOutput(output)
    expect(parsed.passed).toBe(false)
  })

  it('returns fallback reason when no markers exist', () => {
    const parsed = parseFeatureOutput('plain text without markers')
    expect(parsed.passed).toBe(false)
    expect(parsed.reason).toContain('No [TEST_PASS] or [TEST_FAIL] marker found')
  })
})

describe('parseChaosOutput', () => {
  it('extracts bug and no-bug marker status', () => {
    const bug = parseChaosOutput('[BUG_FOUND] dashboard crashes on refresh')
    expect(bug.bugFound).toBe('dashboard crashes on refresh')
    expect(bug.noBugMarker).toBe(false)

    const noBug = parseChaosOutput('[NO_BUG_FOUND]')
    expect(noBug.bugFound).toBeNull()
    expect(noBug.noBugMarker).toBe(true)
  })
})

describe('prompt builders', () => {
  it('buildStepsPrompt includes steps and existing UI references', async () => {
    const projectDir = await createTempProject()
    await writeFile(join(projectDir, 'features', 'login.md'), '# Login\n\nLogin flow details.', 'utf-8')

    const prompt = await buildStepsPrompt({
      projectDir,
      steps: '1. Open app\n2. Sign in',
      contextHint: 'Use test account',
      featureNames: ['login', 'missing-feature'],
    })

    expect(prompt).toContain('Execute the following steps **exactly as written**')
    expect(prompt).toContain('## Steps')
    expect(prompt).toContain('1. Open app\n2. Sign in')
    expect(prompt).toContain('## Context')
    expect(prompt).toContain('Use test account')
    expect(prompt).toContain('### login')
    expect(prompt).toContain('Login flow details.')
    expect(prompt).not.toContain('missing-feature')
  })

  it('buildChaosPrompt includes avoid rules and discovered features', async () => {
    const projectDir = await createTempProject()
    await writeFile(join(projectDir, 'features', 'alpha.md'), '# Alpha\n\nAlpha behavior.', 'utf-8')
    await writeFile(join(projectDir, 'features', 'beta.md'), '# Beta\n\nBeta behavior.', 'utf-8')

    const prompt = await buildChaosPrompt({
      projectDir,
      baseUrl: 'http://localhost:3000',
      appName: 'DemoApp',
      avoidRules: ['Do not delete production-like data', 'Avoid logout flow'],
    })

    expect(prompt).toContain('DemoApp')
    expect(prompt).toContain('http://localhost:3000')
    expect(prompt).toContain('Off-limits (DO NOT do these)')
    expect(prompt).toContain('Do not delete production-like data')
    expect(prompt).toContain('### alpha')
    expect(prompt).toContain('### beta')
  })

  it('buildChaosFollowUpPrompt enumerates previous bugs', () => {
    const prompt = buildChaosFollowUpPrompt(['bug one', 'bug two'])
    expect(prompt).toContain('Good, you found 2 bug(s) so far')
    expect(prompt).toContain('1. bug one')
    expect(prompt).toContain('2. bug two')
  })

  it('buildSystemPrompt prefers consumer prompt over builtin prompt', async () => {
    const projectDir = await createTempProject()
    await writeFile(join(projectDir, 'system-prompt.md'), 'custom prompt', 'utf-8')

    const prompt = await buildSystemPrompt(projectDir)
    expect(prompt).toBe('custom prompt')
  })
})
