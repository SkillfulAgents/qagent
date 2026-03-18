/**
 * Report writing, summary printing, and artifact counting.
 */
import { writeFile, readdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import type {
  TestResult,
  ReportJson,
  StoryResult,
  SuiteResult,
  SummaryStoryEntry,
} from '../types.js'

// ---------------------------------------------------------------------------
// Artifact counting
// ---------------------------------------------------------------------------

export async function countArtifacts(dir: string): Promise<{ screenshots: number; videos: number }> {
  let screenshots = 0, videos = 0
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const sub = await countArtifacts(join(dir, entry.name))
        screenshots += sub.screenshots
        videos += sub.videos
      } else if (entry.name.endsWith('.png')) {
        screenshots++
      } else if (entry.name.endsWith('.webm')) {
        videos++
      }
    }
  } catch { /* dir may not exist */ }
  return { screenshots, videos }
}

export function logArtifacts(artifacts: { screenshots: number; videos: number }) {
  if (artifacts.screenshots > 0) console.log(`  [screenshots] ${artifacts.screenshots} saved`)
  if (artifacts.videos > 0) console.log(`  [videos] ${artifacts.videos} saved`)
}

// ---------------------------------------------------------------------------
// Feature result printing
// ---------------------------------------------------------------------------

export function printFeatureResult(feature: string, result: TestResult) {
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
// Report JSON
// ---------------------------------------------------------------------------

export function reportRelPath(mode: string, storyId: string, feature: string): string {
  if (mode === 'happy-path') return `happy-path/${storyId}/report.json`
  if (mode === 'chaos-monkey') return `chaos-monkey/${storyId}/${feature}/report.json`
  return `feature-test/${storyId}/${feature}/report.json`
}

export async function writeReportJson(dir: string, storyId: string, feature: string | null, result: TestResult): Promise<void> {
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

// ---------------------------------------------------------------------------
// Summary printing
// ---------------------------------------------------------------------------

export function printSummary(
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

export function printResultsTree(resultsDir: string, stories: SummaryStoryEntry[]): void {
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
