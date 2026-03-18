/**
 * Test runner / orchestrator.
 * Loads stories, runs setup hooks, builds prompts, invokes the driver, collects results.
 */
import { mkdir, writeFile, readdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  RunOptions,
  Story,
  SetupContext,
  TestResult,
  DriverOptions,
  FeatureResult,
  StoryResult,
  StoryRunContext,
  SuiteResult,
  ReportJson,
  SummaryStoryEntry,
  SummaryFeatureEntry,
} from '../types.js'
import { loadStories } from '../loader/story-loader.js'
import { runHooks } from '../loader/hook-loader.js'
import {
  buildFeaturePrompt,
  buildStepsPrompt,
  buildChaosPrompt,
  buildChaosFollowUpPrompt,
  buildSystemPrompt,
} from '../prompt/prompt-builder.js'
import { parseChaosOutput } from '../prompt/output-parser.js'
import { runTest } from './driver.js'
import { computeSessionCost } from '../utils/cost-helper.js'
import { resolveRunId } from '../utils/run-id.js'

// ---------------------------------------------------------------------------
// Artifact count — screenshots/videos written directly to resultsDir by MCP
// ---------------------------------------------------------------------------

async function countArtifacts(dir: string): Promise<{ screenshots: number; videos: number }> {
  let screenshots = 0, videos = 0
  try {
    for (const f of await readdir(dir)) {
      if (f.endsWith('.png')) screenshots++
      else if (f.endsWith('.webm')) videos++
    }
  } catch { /* dir may not exist */ }
  return { screenshots, videos }
}

function logArtifacts(artifacts: { screenshots: number; videos: number }) {
  if (artifacts.screenshots > 0) console.log(`  [screenshots] ${artifacts.screenshots} saved`)
  if (artifacts.videos > 0) console.log(`  [videos] ${artifacts.videos} saved`)
}

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
// Print helpers
// ---------------------------------------------------------------------------

function printFeatureResult(feature: string, result: TestResult) {
  const status = result.passed ? 'PASSED' : 'FAILED'
  console.log(`  [${status}] ${feature} (${(result.durationMs / 1000).toFixed(1)}s)`)
  if (!result.passed) {
    console.log(`    Reason: ${result.reason}`)
  }
  for (const step of result.steps) {
    console.log(`    - ${step}`)
  }
}

// ---------------------------------------------------------------------------
// Build StoryRunContext — centralises all per-story config resolution
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

/**
 * After setup hooks run, pull well-known keys from store into driverOptions.
 * This is how hooks like launch-electron feed config back into the runner.
 */
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
// Dispatch — route to the right mode handler
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
      // --- Setup hooks ---
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
      // Always attempt teardown for cleanup, even if setup/story execution failed.
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
// Mode: happy-path with explicit steps
// ---------------------------------------------------------------------------

async function runSteps(rc: StoryRunContext): Promise<StoryResult> {
  const { story, setupCtx, driverOptions, maxRetries, resultsDir } = rc

  console.log(`\n> Running steps for story: ${story.id}...`)

  const storyDir = resolve(resultsDir, 'happy-path', story.id)
  await mkdir(storyDir, { recursive: true })

  const prompt = await buildStepsPrompt({
    projectDir: setupCtx.projectDir,
    steps: story.steps!,
    featureNames: story.features,
  })

  if (driverOptions.verbose) console.log('[prompt]\n' + prompt + '\n')

  const result = await runFeatureWithRetries(prompt, { ...driverOptions, outputDir: storyDir }, maxRetries)

  await writeFile(resolve(storyDir, 'report.md'), result.rawOutput, 'utf-8')
  await writeReportJson(storyDir, story.id, null, result)
  logArtifacts(await countArtifacts(storyDir))

  printFeatureResult(story.id, result)
  return { story, featureResults: [{ feature: 'steps', result }], overallPassed: result.passed }
}

// ---------------------------------------------------------------------------
// Mode: feature-test (per-feature loop)
// ---------------------------------------------------------------------------

async function runFeatures(rc: StoryRunContext): Promise<StoryResult> {
  const { story, setupCtx, driverOptions, maxRetries, resultsDir } = rc

  const featureResults: FeatureResult[] = []
  const features = story.features ?? []

  if (features.length === 0) {
    console.warn(`[warn] Story "${story.id}" has no features defined, skipping.`)
    return { story, featureResults: [], overallPassed: true }
  }

  for (const feat of features) {
    console.log(`\n> Running feature: ${feat}...`)

    const featDir = resolve(resultsDir, 'feature-test', story.id, feat)
    await mkdir(featDir, { recursive: true })

    const prompt = await buildFeaturePrompt({
      projectDir: setupCtx.projectDir,
      featureName: feat,
      baseUrl: setupCtx.baseUrl,
    })

    if (driverOptions.verbose) console.log('[prompt]\n' + prompt + '\n')

    const result = await runFeatureWithRetries(prompt, { ...driverOptions, outputDir: featDir }, maxRetries)
    featureResults.push({ feature: feat, result })

    await writeFile(resolve(featDir, 'report.md'), result.rawOutput, 'utf-8')
    await writeReportJson(featDir, story.id, feat, result)
    logArtifacts(await countArtifacts(featDir))

    printFeatureResult(feat, result)
  }

  const overallPassed = featureResults.length > 0 && featureResults.every((fr) => fr.result.passed)
  return { story, featureResults, overallPassed }
}

// ---------------------------------------------------------------------------
// Mode: chaos-monkey
// ---------------------------------------------------------------------------

async function runChaosMonkey(rc: StoryRunContext): Promise<StoryResult> {
  const { story, setupCtx, driverOptions, resultsDir } = rc
  const MAX_ROUNDS = 100
  const bugsFound: string[] = []
  const chaosResults: FeatureResult[] = []
  const sessionId = randomUUID()

  console.log(`\n> Unleashing the chaos monkey (max ${MAX_ROUNDS} rounds)...`)
  console.log(`[chaos-monkey] Session: ${sessionId}`)

  const initialPrompt = await buildChaosPrompt({
    projectDir: setupCtx.projectDir,
    baseUrl: setupCtx.baseUrl,
  })

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    console.log(`\n> [chaos-monkey] Round ${round}/${MAX_ROUNDS}...`)

    // Two complementary mechanisms avoid redundant exploration:
    // 1. Session resume preserves browser state so the agent continues where it left off.
    // 2. Follow-up prompt lists already-found bugs so the agent skips known issues.
    const isFirstRound = round === 1
    const prompt = isFirstRound ? initialPrompt : buildChaosFollowUpPrompt(bugsFound)

    if (driverOptions.verbose) {
      console.log('[prompt]\n' + prompt + '\n')
    }

    const roundDir = resolve(resultsDir, 'chaos-monkey', story.id, `round-${round}`)
    await mkdir(roundDir, { recursive: true })

    let result: TestResult
    try {
      result = await runTest(prompt, {
        ...driverOptions,
        outputDir: roundDir,
        sessionId: isFirstRound ? sessionId : undefined,
        resumeSessionId: isFirstRound ? undefined : sessionId,
      })
    } catch (err) {
      console.warn(`[chaos-monkey] Round ${round} error: ${err instanceof Error ? err.message : String(err)}`)
      break
    }

    await writeFile(resolve(roundDir, 'report.md'), result.rawOutput, 'utf-8')
    await writeReportJson(roundDir, story.id, `round-${round}`, result)

    const parsed = parseChaosOutput(result.rawOutput)

    if (!parsed.bugFound && !parsed.noBugMarker) {
      console.log(`  [WARN] No [BUG_FOUND] or [NO_BUG_FOUND] marker found, continuing...`)
      chaosResults.push({ feature: `round-${round}`, result })
      continue
    }

    if (parsed.bugFound) {
      bugsFound.push(parsed.bugFound)
      console.log(`  [BUG #${bugsFound.length}] ${parsed.bugFound}`)
    } else {
      console.log(`  [NO BUG] Agent found no new bugs this round.`)
    }

    chaosResults.push({ feature: `round-${round}`, result })

    if (!parsed.bugFound) {
      console.log(`[chaos-monkey] No more bugs found, stopping.`)
      break
    }
  }

  console.log(`\n[chaos-monkey] Total bugs found: ${bugsFound.length}`)
  for (let i = 0; i < bugsFound.length; i++) {
    console.log(`  ${i + 1}. ${bugsFound[i]}`)
  }

  const overallPassed = bugsFound.length === 0
  return { story, featureResults: chaosResults, overallPassed }
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

function reportRelPath(mode: string, storyId: string, feature: string): string {
  if (mode === 'happy-path') return `happy-path/${storyId}/report.json`
  if (mode === 'chaos-monkey') return `chaos-monkey/${storyId}/${feature}/report.json`
  return `feature-test/${storyId}/${feature}/report.json`
}

async function writeReportJson(dir: string, storyId: string, feature: string | null, result: TestResult): Promise<void> {
  const report: ReportJson = {
    storyId,
    ...(feature && { feature }),
    passed: result.passed,
    reason: result.reason,
    steps: result.steps,
    bugs: result.bugs,
    durationMs: result.durationMs,
    ...(result.sessionId && { sessionId: result.sessionId }),
    ...(result.cost && { cost: result.cost }),
  }
  await writeFile(resolve(dir, 'report.json'), JSON.stringify(report, null, 2), 'utf-8')
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

function printResultsTree(resultsDir: string, stories: SummaryStoryEntry[]): void {
  console.log(`\nResults tree:`)
  console.log(`  ${resultsDir}/`)
  console.log(`    summary.json`)

  for (const s of stories) {
    if (s.features && s.features.length > 0) {
      for (const f of s.features) {
        console.log(`    ${f.reportPath.replace(/\/report\.(json|md)$/, '/')}`)
        console.log(`      report.md`)
        console.log(`      report.json`)
      }
    } else if (s.reportPath) {
      console.log(`    ${s.reportPath.replace(/\/report\.(json|md)$/, '/')}`)
      console.log(`      report.md`)
      console.log(`      report.json`)
    }
  }
  console.log()
}

async function uploadArtifacts(resultsDir: string, runId: string): Promise<void> {
  if (!process.env.GITHUB_ACTIONS) {
    console.log('[upload] Not running in GitHub Actions, skipping upload.')
    return
  }
  try {
    const { DefaultArtifactClient } = await import('@actions/artifact' as any)
    const client = new DefaultArtifactClient()
    const files = await getAllFiles(resultsDir)
    await client.uploadArtifact(runId, files, resultsDir)
    console.log(`[upload] Uploaded artifact: ${runId}`)
  } catch (err) {
    console.warn(`[upload] Failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function getAllFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const files: string[] = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...await getAllFiles(full))
    } else {
      files.push(full)
    }
  }
  return files
}

function printSummary(
  summary: SuiteResult,
  allResults: StoryResult[],
  summaryPath: string,
  totalDurationSec: number,
): void {
  console.log(`\n${'═'.repeat(60)}`)
  console.log('SUMMARY')
  console.log(`${'═'.repeat(60)}`)

  for (const sr of allResults) {
    const status = sr.overallPassed ? 'PASSED' : 'FAILED'
    console.log(`\n  [${status}] ${sr.story.id}`)
    for (const fr of sr.featureResults) {
      const frStatus = fr.result.passed ? 'PASSED' : 'FAILED'
      const costStr = fr.result.cost ? ` · $${fr.result.cost.totalCostUsd.toFixed(4)}` : ''
      console.log(`    ${frStatus}  ${fr.feature} (${(fr.result.durationMs / 1000).toFixed(1)}s${costStr})`)
    }
  }

  console.log(`\n${'─'.repeat(60)}`)
  console.log(`Stories:    ${summary.passedStories}/${summary.totalStories} passed`)
  console.log(`Features:   ${summary.passedFeatures}/${summary.totalFeatures} passed`)
  console.log(`Duration:   ${totalDurationSec.toFixed(1)}s`)
  console.log(`Cost:       $${summary.totalCostUsd.toFixed(2)}`)
  console.log(`Results:    ${summaryPath}`)
  console.log(`${'═'.repeat(60)}\n`)
}
