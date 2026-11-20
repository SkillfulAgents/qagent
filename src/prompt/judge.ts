/**
 * Decides the verdict of an agent report. With OPENAI_API_KEY set, OpenAI
 * Decisions reads the free-form report, so a prompt change cannot break the
 * verdict. Without it, the [TEST_PASS] / [BUG_FOUND] markers decide.
 * Reason, steps and bug text always come from the detail marker lines.
 */
import { decideYesNo, type FetchFn } from '../decision/openai-decisions.js'
import {
  extractReportDetails,
  parseChaosOutput,
  parseFeatureOutput,
  withBugList,
  type ChaosRoundResult,
  type ParsedOutput,
} from './output-parser.js'

const REPORT_CONTEXT = 'The text is the final report of a QA agent that tested a web app in a real browser.'

const FEATURE_QUESTIONS = {
  early_stop: `${REPORT_CONTEXT} Did the agent stop early because the app could not be tested at all (error or blank page, login wall without credentials, feature missing, app crashed or unresponsive)?`,
  passed: `${REPORT_CONTEXT} Did the test pass: every tested step worked as expected and the agent reported no bugs?`,
}

const CHAOS_QUESTIONS = {
  bug_found: `${REPORT_CONTEXT} The agent explored the app to find a bug. Does the report say the agent found a new bug?`,
}

const YES = 0.5
const MAX_SUMMARY_CHARS = 200

export interface JudgeDeps {
  env?: Record<string, string | undefined>
  fetchFn?: FetchFn
}

async function decide(output: string, questions: Record<string, string>, deps: JudgeDeps): Promise<Record<string, boolean> | null> {
  const env = deps.env ?? process.env
  const apiKey = env.OPENAI_API_KEY
  if (!apiKey) return null

  try {
    const answers = await decideYesNo(output, questions, { apiKey, baseUrl: env.OPENAI_BASE_URL, fetchFn: deps.fetchFn })
    const refused = Object.keys(answers).filter((name) => answers[name] === null)
    if (refused.length > 0) throw new Error(`no answer for ${refused.join(', ')}`)
    return Object.fromEntries(Object.entries(answers).map(([name, p]) => [name, p! >= YES]))
  } catch (err) {
    console.warn(`[judge] Decisions API failed, using output markers: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

function summary(output: string): string {
  const text = output.trim()
  const firstLine = text.split('\n').find((line) => line.trim())?.trim() ?? ''
  return (firstLine || text).slice(0, MAX_SUMMARY_CHARS)
}

export async function judgeFeatureOutput(output: string, deps: JudgeDeps = {}): Promise<ParsedOutput> {
  const verdict = await decide(output, FEATURE_QUESTIONS, deps)
  if (!verdict) return parseFeatureOutput(output)

  const details = extractReportDetails(output)
  if (verdict.early_stop) {
    return { passed: false, reason: `Early stop: ${details.earlyStop ?? summary(output)}`, steps: details.steps, bugs: [] }
  }
  return {
    passed: verdict.passed,
    reason: withBugList(details.reason || summary(output), details.bugs),
    steps: details.steps,
    bugs: details.bugs,
  }
}

export async function judgeChaosOutput(output: string, deps: JudgeDeps = {}): Promise<ChaosRoundResult> {
  const verdict = await decide(output, CHAOS_QUESTIONS, deps)
  if (!verdict) return parseChaosOutput(output)

  if (!verdict.bug_found) return { bugFound: null, noBug: true }
  return { bugFound: extractReportDetails(output).bugs[0] ?? summary(output), noBug: false }
}
