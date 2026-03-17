/**
 * Test runner / orchestrator.
 * Loads stories, runs setup hooks, builds prompts, invokes the driver, collects results.
 */
import { mkdir, writeFile, readdir, copyFile, rm, unlink } from 'node:fs/promises'
import { resolve, join, relative } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  RunOptions,
  Story,
  SetupContext,
  TestResult,
  DriverOptions,
  FeatureResult,
  StoryResult,
  SuiteResult,
} from '../types.js'
import { loadStories } from '../loader/story-loader.js'
import { runHooks } from '../loader/setup-loader.js'
import {
  buildFeaturePrompt,
  buildStepsPrompt,
  buildChaosPrompt,
  buildChaosFollowUpPrompt,
  buildSystemPrompt,
} from '../prompt/prompt-builder.js'
import { parseChaosOutput } from '../prompt/output-parser.js'
import { runTest } from './driver.js'
import { computeSessionCost, getSessionJsonlPath } from '../utils/cost-helper.js'
import { resolveRunId } from '../utils/run-id.js'

// ---------------------------------------------------------------------------
// Artifact collection (screenshots + videos)
// ---------------------------------------------------------------------------

async function listFiles(dir: string, ext: string): Promise<Set<string>> {
  try {
    const files = await readdir(dir)
    return new Set(files.filter((f) => f.endsWith(ext)))
  } catch {
    return new Set()
  }
}

interface ArtifactSnapshot {
  screenshots: Set<string>
  videos: Set<string>
}

async function snapshotArtifacts(screenshotDir: string, videosDir: string): Promise<ArtifactSnapshot> {
  return {
    screenshots: await listFiles(screenshotDir, '.png'),
    videos: await listFiles(videosDir, '.webm'),
  }
}

async function collectArtifacts(
  screenshotDir: string,
  videosDir: string,
  before: ArtifactSnapshot,
  destDir: string,
): Promise<{ screenshots: string[]; videos: string[] }> {
  const screenshotsOut = resolve(destDir, 'screenshots')
  const videosOut = resolve(destDir, 'videos')

  const ts = new Date().toISOString().replace(/[:.]/g, '-')

  const newScreenshots = [...await listFiles(screenshotDir, '.png')]
    .filter((f) => !before.screenshots.has(f)).sort()
  const renamedScreenshots: string[] = []
  if (newScreenshots.length > 0) {
    await mkdir(screenshotsOut, { recursive: true })
    for (const file of newScreenshots) {
      const dest = `${ts}_${file}`
      await copyFile(resolve(screenshotDir, file), resolve(screenshotsOut, dest))
      renamedScreenshots.push(dest)
    }
  }

  const newVideos = [...await listFiles(videosDir, '.webm')]
    .filter((f) => !before.videos.has(f)).sort()
  const renamedVideos: string[] = []
  if (newVideos.length > 0) {
    await mkdir(videosOut, { recursive: true })
    for (const file of newVideos) {
      const dest = `${ts}_${file}`
      await copyFile(resolve(videosDir, file), resolve(videosOut, dest))
      renamedVideos.push(dest)
    }
  }

  return { screenshots: renamedScreenshots, videos: renamedVideos }
}

// ---------------------------------------------------------------------------
// Retry wrapper
// ---------------------------------------------------------------------------

async function runFeatureWithRetries(
  basePrompt: string,
  driverOptions: DriverOptions,
  maxRetries: number,
): Promise<TestResult> {
  let lastResult: TestResult | null = null

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    let prompt = basePrompt

    if (attempt > 1 && lastResult && !lastResult.passed) {
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
      lastResult = await runTest(prompt, driverOptions)
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
      const cost = await computeSessionCost(lastResult.sessionId)
      if (cost) {
        lastResult.cost = cost
        console.log(`  [cost] $${cost.totalCostUsd.toFixed(4)} (in: ${cost.inputTokens}, out: ${cost.outputTokens}, cache-w: ${cost.cacheCreationTokens}, cache-r: ${cost.cacheReadTokens}, model: ${cost.model})`)
      }
    }

    if (lastResult.passed) break
  }

  return lastResult!
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
// Main run function
// ---------------------------------------------------------------------------

export async function run(opts: RunOptions): Promise<SuiteResult> {
  const {
    filter,
    tag,
    verbose,
    maxRetries,
    baseUrl,
    target,
    model,
    budgetOverride,
    projectDir,
    record,
    append = false,
    noClean = false,
    upload = false,
  } = opts

  const BUDGET_FEATURE = budgetOverride ?? 5
  const BUDGET_CHAOS = budgetOverride ?? 3

  const runId = resolveRunId()

  console.log('=== QAgent Test Runner ===\n')
  console.log(`Project dir: ${projectDir}`)
  console.log(`Run ID:      ${runId}`)
  console.log(`Target:      ${target}`)
  if (record) console.log(`Record:      enabled`)
  console.log(`Base URL:    ${baseUrl}`)
  console.log(`Max retries: ${maxRetries}`)
  console.log(`Verbose:     ${verbose}`)
  console.log(`Budget:      feature=$${BUDGET_FEATURE}, chaos=$${BUDGET_CHAOS}\n`)

  const stories = await loadStories(projectDir, filter, tag)

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

  // Resolve resultsDir with runId, handling overwrite vs append
  const baseResultsDir = resolve(projectDir, 'results')
  const resultsDir = await resolveRunDir(baseResultsDir, runId, append)

  const cwd = process.cwd()
  const screenshotDir = cwd
  const videosDir = resolve(cwd, 'videos')
  const suiteStart = Date.now()
  const allResults: StoryResult[] = []
  const sessionIds = new Set<string>()

  for (const story of stories) {
    console.log(`\n${'─'.repeat(60)}`)
    console.log(`> [${story.id}] ${story.name} (${story.mode})`)
    console.log(`${'─'.repeat(60)}`)

    const ctx: SetupContext = {
      baseUrl,
      env: process.env as Record<string, string | undefined>,
      store: new Map(),
      projectDir,
    }

    // --- Setup hooks ---
    if (story.setup && story.setup.length > 0) {
      console.log(`\n[setup] ${story.setup.join(', ')}`)
      try {
        await runHooks(story.setup, ctx, 'setup')
      } catch (err) {
        const reason = `Setup failed: ${err instanceof Error ? err.message : String(err)}`
        console.error(`[setup] ${reason}`)
        allResults.push({ story, featureResults: [], overallPassed: false })
        continue
      }
    }

    const driverOptions: DriverOptions = {
      verbose,
      model,
      systemPrompt,
      maxBudgetUsd: story.mode === 'chaos-monkey' ? BUDGET_CHAOS : BUDGET_FEATURE,
      record,
    }

    if (story.mode === 'chaos-monkey') {
      await runChaosMonkey(story, ctx, driverOptions, screenshotDir, videosDir, resultsDir, allResults)
    } else if (story.mode === 'happy-path' && story.steps) {
      await runSteps(story, ctx, driverOptions, maxRetries, screenshotDir, videosDir, resultsDir, allResults)
    } else {
      if (story.mode === 'happy-path') {
        console.warn(`[warn] Story "${story.id}" is happy-path but has no steps, falling back to feature-test mode.`)
      }
      await runFeatures(story, ctx, driverOptions, maxRetries, screenshotDir, videosDir, resultsDir, allResults)
    }

    // --- Teardown hooks ---
    if (story.teardown && story.teardown.length > 0) {
      console.log(`\n[teardown] ${story.teardown.join(', ')}`)
      try {
        await runHooks(story.teardown, ctx, 'teardown')
      } catch (err) {
        console.warn(`[teardown] Warning: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    // Collect session IDs for targeted cleanup later
    const lastStoryResult = allResults[allResults.length - 1]
    if (lastStoryResult) {
      for (const fr of lastStoryResult.featureResults) {
        if (fr.result.sessionId) sessionIds.add(fr.result.sessionId)
      }
    }
  }

  // --- Summary ---
  const suiteEnd = Date.now()
  const totalDurationMs = suiteEnd - suiteStart

  const allFeatureResults = allResults.flatMap((r) => r.featureResults)
  const totalCostUsd = allFeatureResults.reduce((sum, fr) => sum + (fr.result.cost?.totalCostUsd ?? 0), 0)
  const summary: SuiteResult = {
    startedAt: new Date(suiteStart).toISOString(),
    finishedAt: new Date(suiteEnd).toISOString(),
    totalDurationMs,
    totalStories: allResults.length,
    passedStories: allResults.filter((r) => r.overallPassed).length,
    failedStories: allResults.filter((r) => !r.overallPassed).length,
    totalFeatures: allFeatureResults.length,
    passedFeatures: allFeatureResults.filter((fr) => fr.result.passed).length,
    failedFeatures: allFeatureResults.filter((fr) => !fr.result.passed).length,
    totalCostUsd: Math.round(totalCostUsd * 1_000_000) / 1_000_000,
    results: allResults.map((r) => ({
      ...r,
      featureResults: r.featureResults.map((fr) => ({
        ...fr,
        result: {
          ...fr.result,
          rawOutput: storyReportRef(r.story.mode, r.story.id, fr.feature),
        },
      })),
    })),
  }

  const summaryPath = resolve(resultsDir, 'summary.json')
  await writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf-8')

  // Cleanup temp artifacts
  if (!noClean) {
    await cleanupTempArtifacts(cwd, sessionIds)
  }

  printSummary(summary, allResults, summaryPath, totalDurationMs)
  await printResultsTree(resultsDir)

  if (upload) {
    await uploadArtifacts(resultsDir, runId)
  }

  return summary
}

// ---------------------------------------------------------------------------
// Mode: happy-path with explicit steps
// ---------------------------------------------------------------------------

async function runSteps(
  story: Story,
  ctx: SetupContext,
  driverOptions: DriverOptions,
  maxRetries: number,
  screenshotDir: string,
  videosDir: string,
  resultsDir: string,
  allResults: StoryResult[],
): Promise<void> {
  console.log(`\n> Running steps for story: ${story.id}...`)
  const before = await snapshotArtifacts(screenshotDir, videosDir)

  const prompt = await buildStepsPrompt({
    projectDir: ctx.projectDir,
    steps: story.steps!,
    featureNames: story.features,
    testData: story.testData,
  })

  if (driverOptions.verbose) {
    console.log('[prompt]\n' + prompt + '\n')
  }

  const result = await runFeatureWithRetries(prompt, driverOptions, maxRetries)
  const featureLabel = 'steps'
  const featureResults: FeatureResult[] = [{ feature: featureLabel, result }]

  const storyDir = resolve(resultsDir, 'happy-path', story.id)
  await mkdir(storyDir, { recursive: true })
  await writeFile(resolve(storyDir, 'report.md'), result.rawOutput, 'utf-8')

  const artifacts = await collectArtifacts(screenshotDir, videosDir, before, storyDir)
  if (artifacts.screenshots.length > 0) {
    console.log(`  [screenshots] ${artifacts.screenshots.length} saved to happy-path/${story.id}/screenshots/`)
  }
  if (artifacts.videos.length > 0) {
    console.log(`  [videos] ${artifacts.videos.length} saved to happy-path/${story.id}/videos/`)
  }

  printFeatureResult(story.id, result)

  const overallPassed = result.passed
  allResults.push({ story, featureResults, overallPassed })
}

// ---------------------------------------------------------------------------
// Mode: feature-test (per-feature loop)
// ---------------------------------------------------------------------------

async function runFeatures(
  story: Story,
  ctx: SetupContext,
  driverOptions: DriverOptions,
  maxRetries: number,
  screenshotDir: string,
  videosDir: string,
  resultsDir: string,
  allResults: StoryResult[],
): Promise<void> {
  const featureResults: FeatureResult[] = []
  const features = story.features ?? []

  if (features.length === 0) {
    console.warn(`[warn] Story "${story.id}" has no features defined, skipping.`)
    allResults.push({ story, featureResults: [], overallPassed: true })
    return
  }

  for (const feat of features) {
    console.log(`\n> Running feature: ${feat}...`)
    const before = await snapshotArtifacts(screenshotDir, videosDir)

    const prompt = await buildFeaturePrompt({
      projectDir: ctx.projectDir,
      featureName: feat,
      baseUrl: ctx.baseUrl,
      target: driverOptions.mcpConfigPath ? 'electron' : 'web',
      mode: story.mode,
      testData: story.testData?.[feat],
    })

    if (driverOptions.verbose) {
      console.log('[prompt]\n' + prompt + '\n')
    }

    const result = await runFeatureWithRetries(prompt, driverOptions, maxRetries)
    featureResults.push({ feature: feat, result })

    const featDir = resolve(resultsDir, 'feature-test', story.id, feat)
    await mkdir(featDir, { recursive: true })
    await writeFile(resolve(featDir, 'report.md'), result.rawOutput, 'utf-8')

    const artifacts = await collectArtifacts(screenshotDir, videosDir, before, featDir)
    if (artifacts.screenshots.length > 0) {
      console.log(`  [screenshots] ${artifacts.screenshots.length} saved to feature-test/${story.id}/${feat}/screenshots/`)
    }
    if (artifacts.videos.length > 0) {
      console.log(`  [videos] ${artifacts.videos.length} saved to feature-test/${story.id}/${feat}/videos/`)
    }

    printFeatureResult(feat, result)
  }

  const overallPassed = featureResults.length > 0 && featureResults.every((fr) => fr.result.passed)
  allResults.push({ story, featureResults, overallPassed })
}

// ---------------------------------------------------------------------------
// Mode: chaos-monkey
// ---------------------------------------------------------------------------

async function runChaosMonkey(
  story: Story,
  ctx: SetupContext,
  driverOptions: DriverOptions,
  screenshotDir: string,
  videosDir: string,
  resultsDir: string,
  allResults: StoryResult[],
): Promise<void> {
  const MAX_ROUNDS = 100
  const bugsFound: string[] = []
  const chaosResults: FeatureResult[] = []
  const sessionId = randomUUID()

  console.log(`\n> Unleashing the chaos monkey (max ${MAX_ROUNDS} rounds)...`)
  console.log(`[chaos-monkey] Session: ${sessionId}`)

  const initialPrompt = await buildChaosPrompt({
    projectDir: ctx.projectDir,
    baseUrl: ctx.baseUrl,
  })

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    console.log(`\n> [chaos-monkey] Round ${round}/${MAX_ROUNDS}...`)
    const before = await snapshotArtifacts(screenshotDir, videosDir)

    const isFirstRound = round === 1
    const prompt = isFirstRound ? initialPrompt : buildChaosFollowUpPrompt(bugsFound)

    if (driverOptions.verbose) {
      console.log('[prompt]\n' + prompt + '\n')
    }

    let result: TestResult
    try {
      result = await runTest(prompt, {
        ...driverOptions,
        sessionId: isFirstRound ? sessionId : undefined,
        resumeSessionId: isFirstRound ? undefined : sessionId,
      })
    } catch (err) {
      console.warn(`[chaos-monkey] Round ${round} error: ${err instanceof Error ? err.message : String(err)}`)
      break
    }

    const roundDir = resolve(resultsDir, 'chaos-monkey', story.id, `round-${round}`)
    await mkdir(roundDir, { recursive: true })
    await writeFile(resolve(roundDir, 'report.md'), result.rawOutput, 'utf-8')

    const artifacts = await collectArtifacts(screenshotDir, videosDir, before, roundDir)
    if (artifacts.screenshots.length > 0) {
      console.log(`  [screenshots] ${artifacts.screenshots.length} saved to chaos-monkey/${story.id}/round-${round}/screenshots/`)
    }
    if (artifacts.videos.length > 0) {
      console.log(`  [videos] ${artifacts.videos.length} saved to chaos-monkey/${story.id}/round-${round}/videos/`)
    }

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
  allResults.push({ story, featureResults: chaosResults, overallPassed })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptySuiteResult(): SuiteResult {
  const now = new Date().toISOString()
  return {
    startedAt: now,
    finishedAt: now,
    totalDurationMs: 0,
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

function storyReportRef(mode: string, storyId: string, feature: string): string {
  if (mode === 'happy-path') return `[see happy-path/${storyId}/report.md]`
  if (mode === 'chaos-monkey') return `[see chaos-monkey/${storyId}/${feature}/report.md]`
  return `[see feature-test/${storyId}/${feature}/report.md]`
}

async function resolveRunDir(baseResultsDir: string, runId: string, append: boolean): Promise<string> {
  const target = resolve(baseResultsDir, runId)
  if (!append) {
    // Overwrite: remove existing run dir if present
    await rm(target, { recursive: true, force: true })
    await mkdir(target, { recursive: true })
    return target
  }
  // Append mode: find a free slot (1), (2), ...
  try {
    await readdir(target)
    // Exists — find next available suffix
    for (let i = 1; i < 100; i++) {
      const candidate = resolve(baseResultsDir, `${runId}(${i})`)
      try {
        await readdir(candidate)
      } catch {
        await mkdir(candidate, { recursive: true })
        return candidate
      }
    }
  } catch {
    // Does not exist yet
    await mkdir(target, { recursive: true })
  }
  return target
}

async function cleanupTempArtifacts(cwd: string, sessionIds: Set<string>): Promise<void> {
  // Delete loose .png files in cwd (Playwright MCP screenshots)
  try {
    const files = await readdir(cwd)
    for (const f of files) {
      if (f.endsWith('.png')) {
        await unlink(resolve(cwd, f)).catch(() => {})
      }
    }
  } catch { /* ignore */ }

  // Delete cwd/videos/ (Playwright MCP video output)
  await rm(resolve(cwd, 'videos'), { recursive: true, force: true })

  // Delete only the JSONL session files produced by this run (not the entire projects dir)
  for (const sid of sessionIds) {
    const jsonlPath = getSessionJsonlPath(sid, cwd)
    await unlink(jsonlPath).catch(() => {})
  }
}

async function printResultsTree(resultsDir: string): Promise<void> {
  console.log(`\nResults tree:`)
  console.log(`  ${resultsDir}/`)
  console.log(`    summary.json`)

  const modes = ['happy-path', 'feature-test', 'chaos-monkey']
  for (const mode of modes) {
    const modeDir = resolve(resultsDir, mode)
    let storyIds: string[]
    try {
      storyIds = await readdir(modeDir)
    } catch {
      continue
    }
    console.log(`    ${mode}/`)
    for (const storyId of storyIds) {
      const storyDir = resolve(modeDir, storyId)
      console.log(`      ${storyId}/`)
      // List direct entries (sub-features or round-N for chaos, or files for happy-path)
      try {
        const entries = await readdir(storyDir)
        for (const entry of entries) {
          if (entry === 'report.md') {
            console.log(`        report.md`)
          } else if (entry === 'screenshots' || entry === 'videos') {
            const subFiles = await readdir(resolve(storyDir, entry)).catch(() => [])
            console.log(`        ${entry}/ (${subFiles.length} file${subFiles.length !== 1 ? 's' : ''})`)
          } else {
            // Sub-directory (feature or round)
            const subDir = resolve(storyDir, entry)
            console.log(`        ${entry}/`)
            const subEntries = await readdir(subDir).catch(() => [])
            for (const sub of subEntries) {
              if (sub === 'screenshots' || sub === 'videos') {
                const subFiles = await readdir(resolve(subDir, sub)).catch(() => [])
                console.log(`          ${sub}/ (${subFiles.length} file${subFiles.length !== 1 ? 's' : ''})`)
              } else {
                console.log(`          ${sub}`)
              }
            }
          }
        }
      } catch { /* ignore */ }
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
  totalDurationMs: number,
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
  console.log(`Duration:   ${(totalDurationMs / 1000).toFixed(1)}s`)
  console.log(`Cost:       $${summary.totalCostUsd.toFixed(4)}`)
  console.log(`Results:    ${summaryPath}`)
  console.log(`${'═'.repeat(60)}\n`)
}
