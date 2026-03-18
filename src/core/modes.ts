/**
 * Mode handlers — one function per test mode (happy-path, feature-test, chaos-monkey).
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  StoryRunContext,
  StoryResult,
  FeatureResult,
  TestResult,
} from '../types.js'
import {
  buildFeaturePrompt,
  buildStepsPrompt,
  buildChaosPrompt,
  buildChaosFollowUpPrompt,
} from '../prompt/prompt-builder.js'
import { parseChaosOutput } from '../prompt/output-parser.js'
import { runTest, waitForMcpDrain } from './driver.js'
import { runFeatureWithRetries } from './runner.js'
import { writeReportJson, countArtifacts, logArtifacts, printFeatureResult } from './reporter.js'

// ---------------------------------------------------------------------------
// Mode: happy-path with explicit steps
// ---------------------------------------------------------------------------

export async function runSteps(rc: StoryRunContext): Promise<StoryResult> {
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

export async function runFeatures(rc: StoryRunContext): Promise<StoryResult> {
  const { story, setupCtx, driverOptions, maxRetries, resultsDir } = rc

  const featureResults: FeatureResult[] = []
  const features = story.features ?? []

  if (features.length === 0) {
    console.warn(`[warn] Story "${story.id}" has no features defined, skipping.`)
    return { story, featureResults: [], overallPassed: true }
  }

  for (let fi = 0; fi < features.length; fi++) {
    const feat = features[fi]

    if (fi > 0) {
      console.log(`\n[drain] Waiting for previous MCP session to release...`)
      await waitForMcpDrain()
    }

    console.log(`\n> Running feature [${fi + 1}/${features.length}]: ${feat}...`)

    const featDir = resolve(resultsDir, 'feature-test', story.id, feat)
    await mkdir(featDir, { recursive: true })

    const prompt = await buildFeaturePrompt({
      projectDir: setupCtx.projectDir,
      featureName: feat,
      baseUrl: setupCtx.baseUrl,
      skipNavigation: !!driverOptions.mcpConfigPath,
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

export async function runChaosMonkey(rc: StoryRunContext): Promise<StoryResult> {
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
