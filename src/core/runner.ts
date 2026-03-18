/**
 * Test runner / orchestrator.
 * Loads stories, runs setup hooks, dispatches to mode handlers, collects results.
 */
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type {
  RunOptions,
  Story,
  SetupContext,
  TestResult,
  DriverOptions,
  StoryResult,
  StoryRunContext,
  SuiteResult,
  SummaryStoryEntry,
  SummaryFeatureEntry,
} from '../types.js'
import { loadStories } from '../loader/story-loader.js'
import { runHooks } from '../loader/hook-loader.js'
import {
  buildSystemPrompt,
  buildStepsPrompt,
  buildFeaturePrompt,
  buildChaosPrompt,
} from '../prompt/prompt-builder.js'
import { runTest } from './driver.js'
import { computeSessionCost } from '../utils/cost-helper.js'
import { resolveRunId } from '../utils/run-id.js'
import { runSteps, runFeatures, runChaosMonkey } from './modes.js'
import { reportRelPath, printSummary, printResultsTree } from './reporter.js'
import { uploadArtifacts } from './upload.js'

// ---------------------------------------------------------------------------
// Retry wrapper
// ---------------------------------------------------------------------------

export type RunTestFn = (prompt: string, options: DriverOptions) => Promise<TestResult>
export type ComputeCostFn = (sessionId: string) => Promise<import('../types.js').CostInfo | null>

export async function runFeatureWithRetries(
  basePrompt: string,
  driverOptions: DriverOptions,
  maxRetries: number,
  _runTest: RunTestFn = runTest,
  _computeCost: ComputeCostFn = computeSessionCost,
): Promise<TestResult> {
  if (maxRetries < 1) {
    return {
      passed: false,
      reason: 'maxRetries must be >= 1',
      steps: [],
      bugs: [],
      rawOutput: '',
      durationMs: 0,
    }
  }

  let lastResult!: TestResult

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    let prompt = basePrompt

    if (attempt > 1 && !lastResult.passed) {
      const ctx = [
        `## Previous Attempt (${attempt - 1}/${maxRetries}) Failed`,
        '',
        `Reason: ${lastResult.reason}`,
        ...(lastResult.steps.length > 0
          ? ['', 'Steps taken:', ...lastResult.steps.map((s) => `- ${s}`)]
          : []),
        '',
        'Avoid repeating the same approach. Try a different strategy.',
      ].join('\n')
      prompt = `${ctx}\n\n${basePrompt}`
      console.log(`    Retry ${attempt}/${maxRetries} (with failure context)...`)
    }

    try {
      lastResult = await _runTest(prompt, driverOptions)
    } catch (err) {
      lastResult = {
        passed: false,
        reason: `Runner error: ${err instanceof Error ? err.message : String(err)}`,
        steps: [],
        bugs: [],
        rawOutput: '',
        durationMs: 0,
      }
    }

    if (lastResult.sessionId) {
      const cost = await _computeCost(lastResult.sessionId)
      if (cost) {
        lastResult.cost = cost
        console.log(`  [cost] $${cost.totalCostUsd.toFixed(4)} (in: ${cost.inputTokens}, out: ${cost.outputTokens}, cache-w: ${cost.cacheCreationTokens}, cache-r: ${cost.cacheReadTokens}, model: ${cost.model})`)
      }
    }

    if (lastResult.passed) break
  }

  return lastResult
}

// ---------------------------------------------------------------------------
// Build StoryRunContext
// ---------------------------------------------------------------------------

async function buildStoryRunContext(
  story: Story,
  opts: RunOptions,
  systemPrompt: string,
  resultsDir: string,
  budget: number,
): Promise<StoryRunContext> {
  const effectiveBaseUrl = story.baseUrl ?? opts.baseUrl

  const setupCtx: SetupContext = {
    baseUrl: effectiveBaseUrl,
    env: process.env as Record<string, string | undefined>,
    store: new Map(),
    projectDir: opts.projectDir,
  }

  setupCtx.store.set('qagentRecord', !!opts.record)

  const driverOptions: DriverOptions = {
    verbose: opts.verbose,
    model: opts.model,
    systemPrompt,
    maxBudgetUsd: budget,
    record: opts.record,
    headless: opts.headless,
  }

  return {
    story,
    setupCtx,
    driverOptions,
    maxRetries: opts.maxRetries,
    resultsDir,
  }
}

function applyStoreOverrides(rc: StoryRunContext): void {
  const { store } = rc.setupCtx
  if (store.has('mcpConfigPath')) {
    rc.driverOptions.mcpConfigPath = store.get('mcpConfigPath') as string
  }
  if (store.has('baseUrl')) {
    rc.setupCtx.baseUrl = store.get('baseUrl') as string
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

async function dispatchStory(rc: StoryRunContext): Promise<StoryResult> {
  const { story } = rc

  switch (story.mode) {
    case 'chaos-monkey':
      return runChaosMonkey(rc)
    case 'happy-path':
      if (!story.steps) {
        throw new Error(`Story "${story.id}" is mode: happy-path but has no "steps" field.`)
      }
      return runSteps(rc)
    case 'feature-test':
      return runFeatures(rc)
    default:
      throw new Error(`Story "${story.id}" has unknown mode: ${story.mode}`)
  }
}

// ---------------------------------------------------------------------------
// Main run function
// ---------------------------------------------------------------------------

export async function run(opts: RunOptions): Promise<SuiteResult> {
  const {
    filter,
    verbose,
    baseUrl,
    budgetOverride,
    projectDir,
    record,
    append = false,
    upload = false,
  } = opts

  const budget = budgetOverride ?? 5
  const runId = resolveRunId()

  console.log('=== QAgent Test Runner ===\n')
  console.log(`Project dir: ${projectDir}`)
  console.log(`Run ID:      ${runId}`)
  if (record) console.log(`Record:      enabled`)
  if (opts.headless) console.log(`Headless:    enabled`)
  console.log(`Base URL:    ${baseUrl}`)
  console.log(`Max retries: ${opts.maxRetries}`)
  console.log(`Verbose:     ${verbose}`)
  console.log(`Budget:      $${budget}/test\n`)

  const stories = await loadStories(projectDir, filter)

  if (stories.length === 0) {
    console.log('No stories match the given filters.')
    return emptySuiteResult()
  }

  console.log(`Found ${stories.length} story/stories:\n`)
  for (const s of stories) {
    console.log(`  - [${s.id}] ${s.name} (mode: ${s.mode})`)
  }
  console.log()

  const systemPrompt = await buildSystemPrompt(projectDir)

  if (opts.dryRun) {
    await printDryRun(stories, projectDir, baseUrl, systemPrompt)
    return emptySuiteResult()
  }

  const baseResultsDir = resolve(projectDir, 'results')
  const resultsDir = await resolveRunDir(baseResultsDir, runId, append)

  const suiteStart = Date.now()
  const allResults: StoryResult[] = []

  for (const story of stories) {
    console.log(`\n${'─'.repeat(60)}`)
    console.log(`> [${story.id}] ${story.name} (${story.mode})`)
    console.log(`${'─'.repeat(60)}`)

    const rc = await buildStoryRunContext(story, opts, systemPrompt, resultsDir, budget)
    let setupOk = true
    try {
      if (story.setup && story.setup.length > 0) {
        console.log(`\n[setup] ${story.setup.join(', ')}`)
        try {
          await runHooks(story.setup, rc.setupCtx, 'setup', () => applyStoreOverrides(rc))
        } catch (err) {
          setupOk = false
          const reason = `Setup failed: ${err instanceof Error ? err.message : String(err)}`
          console.error(`[setup] ${reason}`)
          allResults.push({ story, featureResults: [], overallPassed: false })
        }
      }

      if (setupOk) {
        const result = await dispatchStory(rc)
        allResults.push(result)
      }
    } finally {
      if (story.teardown && story.teardown.length > 0) {
        console.log(`\n[teardown] ${story.teardown.join(', ')}`)
        try {
          await runHooks(story.teardown, rc.setupCtx, 'teardown')
        } catch (err) {
          console.warn(`[teardown] Warning: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }
  }

  // --- Summary ---
  const suiteEnd = Date.now()
  const totalDurationSec = round2((suiteEnd - suiteStart) / 1000)

  const allFeatureResults = allResults.flatMap((r) => r.featureResults)
  const totalCostUsd = allFeatureResults.reduce((sum, fr) => sum + (fr.result.cost?.totalCostUsd ?? 0), 0)

  const summaryResults: SummaryStoryEntry[] = allResults.map((r) => {
    const storyCost = r.featureResults.reduce((s, fr) => s + (fr.result.cost?.totalCostUsd ?? 0), 0)
    const storyDuration = r.featureResults.reduce((s, fr) => s + fr.result.durationMs, 0)
    const base: SummaryStoryEntry = {
      storyId: r.story.id,
      storyName: r.story.name,
      mode: r.story.mode,
      passed: r.overallPassed,
      durationSec: round2(storyDuration / 1000),
      costUsd: round2(storyCost),
    }
    if (r.story.mode === 'feature-test') {
      base.features = r.featureResults.map((fr): SummaryFeatureEntry => ({
        feature: fr.feature,
        passed: fr.result.passed,
        reportPath: reportRelPath(r.story.mode, r.story.id, fr.feature),
      }))
    } else if (r.featureResults.length > 0) {
      base.reportPath = reportRelPath(r.story.mode, r.story.id, r.featureResults[0].feature)
    }
    return base
  })

  const summary: SuiteResult = {
    startedAt: new Date(suiteStart).toISOString(),
    finishedAt: new Date(suiteEnd).toISOString(),
    totalDurationSec,
    totalStories: allResults.length,
    passedStories: allResults.filter((r) => r.overallPassed).length,
    failedStories: allResults.filter((r) => !r.overallPassed).length,
    totalFeatures: allFeatureResults.length,
    passedFeatures: allFeatureResults.filter((fr) => fr.result.passed).length,
    failedFeatures: allFeatureResults.filter((fr) => !fr.result.passed).length,
    totalCostUsd: round2(totalCostUsd),
    results: summaryResults,
  }

  const summaryPath = resolve(resultsDir, 'summary.json')
  await writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf-8')

  printSummary(summary, allResults, summaryPath, totalDurationSec)
  printResultsTree(resultsDir, summaryResults)

  if (upload) {
    await uploadArtifacts(resultsDir, runId)
  }

  return summary
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptySuiteResult(): SuiteResult {
  const now = new Date().toISOString()
  return {
    startedAt: now,
    finishedAt: now,
    totalDurationSec: 0,
    totalStories: 0,
    passedStories: 0,
    failedStories: 0,
    totalFeatures: 0,
    passedFeatures: 0,
    failedFeatures: 0,
    totalCostUsd: 0,
    results: [],
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

async function resolveRunDir(baseResultsDir: string, runId: string, append: boolean): Promise<string> {
  const target = resolve(baseResultsDir, runId)
  if (!append) {
    await rm(target, { recursive: true, force: true })
    await mkdir(target, { recursive: true })
    return target
  }
  if (!existsSync(target)) {
    await mkdir(target, { recursive: true })
    return target
  }
  for (let i = 1; i <= 99; i++) {
    const candidate = resolve(baseResultsDir, `${runId}_${i}`)
    if (!existsSync(candidate)) {
      await mkdir(candidate, { recursive: true })
      return candidate
    }
  }
  throw new Error(`Too many append runs for "${runId}" (max 99)`)
}

async function printDryRun(
  stories: Story[],
  projectDir: string,
  baseUrl: string,
  systemPrompt: string,
): Promise<void> {
  console.log(`[dry-run] Would execute ${stories.length} story/stories. No tests will run.\n`)

  if (systemPrompt) {
    console.log('─── System Prompt ───')
    console.log(systemPrompt.length > 200 ? systemPrompt.slice(0, 200) + '...' : systemPrompt)
    console.log()
  }

  for (const story of stories) {
    console.log(`${'─'.repeat(60)}`)
    console.log(`Story: [${story.id}] ${story.name}`)
    console.log(`Mode:  ${story.mode}`)
    if (story.baseUrl) console.log(`URL:   ${story.baseUrl}`)
    if (story.setup?.length) console.log(`Setup: ${story.setup.join(', ')}`)
    if (story.teardown?.length) console.log(`Teardown: ${story.teardown.join(', ')}`)

    try {
      switch (story.mode) {
        case 'happy-path':
          if (story.steps) {
            const prompt = await buildStepsPrompt({
              projectDir,
              steps: story.steps,
              featureNames: story.features,
            })
            console.log(`\n[prompt] (${prompt.length} chars)`)
            console.log(prompt.slice(0, 500) + (prompt.length > 500 ? '\n...' : ''))
          } else {
            console.log('\n[warn] No "steps" field defined.')
          }
          break
        case 'feature-test':
          for (const feat of story.features ?? []) {
            const prompt = await buildFeaturePrompt({ projectDir, featureName: feat, baseUrl: story.baseUrl ?? baseUrl })
            console.log(`\n[prompt: ${feat}] (${prompt.length} chars)`)
            console.log(prompt.slice(0, 500) + (prompt.length > 500 ? '\n...' : ''))
          }
          if (!story.features?.length) console.log('\n[warn] No features defined.')
          break
        case 'chaos-monkey': {
          const prompt = await buildChaosPrompt({ projectDir, baseUrl: story.baseUrl ?? baseUrl })
          console.log(`\n[prompt] (${prompt.length} chars)`)
          console.log(prompt.slice(0, 500) + (prompt.length > 500 ? '\n...' : ''))
          break
        }
      }
    } catch (err) {
      console.log(`\n[error] ${err instanceof Error ? err.message : String(err)}`)
    }
    console.log()
  }
}
