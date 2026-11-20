/**
 * Parses structured markers from the agent's raw output.
 *
 * Supported marker formats:
 *   [TEST_PASS] / [TEST_FAIL]  — feature-test / happy-path mode
 *   [REASON] <text>
 *   [BUG_FOUND] <text>         — all modes
 *   [NO_BUG_FOUND]             — chaos-monkey mode
 *   [STEP] <text>
 *   [ACTION] / [EXPECTED] / [ACTUAL]  — chaos-monkey detail lines
 *
 * The verdict markers are used only when the Decisions API is not configured
 * (see judge.ts); the detail lines are read in both cases.
 */

export interface ParsedOutput {
  passed: boolean
  reason: string
  steps: string[]
  bugs: string[]
}

export interface ReportDetails {
  earlyStop: string | null
  reason: string
  steps: string[]
  bugs: string[]
}

function markerLines(output: string, marker: string): string[] {
  return [...output.matchAll(new RegExp(`^\\[${marker}\\]\\s*(.+)$`, 'gm'))].map((m) => m[1].trim())
}

export function extractReportDetails(output: string): ReportDetails {
  return {
    earlyStop: markerLines(output, 'EARLY_STOP')[0] ?? null,
    reason: markerLines(output, 'REASON')[0] ?? '',
    steps: markerLines(output, 'STEP'),
    bugs: markerLines(output, 'BUG_FOUND'),
  }
}

export function withBugList(reason: string, bugs: string[]): string {
  if (bugs.length === 0) return reason
  return `${reason}\n  Bugs found:\n${bugs.map((b) => `    - ${b}`).join('\n')}`
}

export function parseFeatureOutput(output: string): ParsedOutput {
  const details = extractReportDetails(output)
  if (details.earlyStop) {
    return { passed: false, reason: `Early stop: ${details.earlyStop}`, steps: details.steps, bugs: [] }
  }

  const passMatch = output.match(/^\[TEST_PASS\]/m)
  const failMatch = output.match(/^\[TEST_FAIL\]/m)

  if (passMatch || failMatch) {
    if (passMatch && failMatch) {
      console.warn('[parser] Both [TEST_PASS] and [TEST_FAIL] markers found — treating as FAIL.')
    }
    const passed = !!passMatch && !failMatch
    return { passed, reason: withBugList(details.reason, details.bugs), steps: details.steps, bugs: details.bugs }
  }

  return {
    passed: false,
    reason: `No [TEST_PASS] or [TEST_FAIL] marker found. Tail: ${output.slice(-300)}`,
    steps: [],
    bugs: [],
  }
}

export interface ChaosRoundResult {
  bugFound: string | null
  noBug: boolean
}

export function parseChaosOutput(output: string): ChaosRoundResult {
  return {
    bugFound: markerLines(output, 'BUG_FOUND')[0] ?? null,
    noBug: /^\[NO_BUG_FOUND\]/m.test(output),
  }
}
