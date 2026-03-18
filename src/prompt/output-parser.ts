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
 */

export interface ParsedOutput {
  passed: boolean
  reason: string
  steps: string[]
  bugs: string[]
}

export function parseFeatureOutput(output: string): ParsedOutput {
  const earlyStopMatch = output.match(/^\[EARLY_STOP\]\s*(.+)$/m)
  if (earlyStopMatch) {
    const stepLines = [...output.matchAll(/^\[STEP\]\s*(.+)$/gm)].map((m) => m[1].trim())
    return {
      passed: false,
      reason: `Early stop: ${earlyStopMatch[1].trim()}`,
      steps: stepLines,
      bugs: [],
    }
  }

  const passMatch = output.match(/^\[TEST_PASS\]/m)
  const failMatch = output.match(/^\[TEST_FAIL\]/m)
  const reasonMatch = output.match(/^\[REASON\]\s*(.+)$/m)
  const bugLines = [...output.matchAll(/^\[BUG_FOUND\]\s*(.+)$/gm)].map((m) => m[1].trim())
  const stepLines = [...output.matchAll(/^\[STEP\]\s*(.+)$/gm)].map((m) => m[1].trim())

  if (passMatch || failMatch) {
    if (passMatch && failMatch) {
      console.warn('[parser] Both [TEST_PASS] and [TEST_FAIL] markers found — treating as FAIL.')
    }
    const passed = !!passMatch && !failMatch
    let reason = reasonMatch ? reasonMatch[1].trim() : ''
    if (bugLines.length > 0) {
      reason += `\n  Bugs found:\n${bugLines.map((b) => `    - ${b}`).join('\n')}`
    }
    return { passed, reason, steps: stepLines, bugs: bugLines }
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
  noBugMarker: boolean
}

export function parseChaosOutput(output: string): ChaosRoundResult {
  const bugMatch = output.match(/^\[BUG_FOUND\]\s*(.+)$/m)
  const noBugMatch = output.match(/^\[NO_BUG_FOUND\]/m)

  return {
    bugFound: bugMatch ? bugMatch[1].trim() : null,
    noBugMarker: !!noBugMatch,
  }
}
