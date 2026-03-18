import { readFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadFeatureFile, loadAllFeatures } from '../loader/story-loader.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

/**
 * If the consumer provides `system-prompt.md` in their project directory,
 * it **replaces** the built-in default entirely.
 * Otherwise the built-in default is used.
 */
export async function buildSystemPrompt(projectDir: string): Promise<string> {
  const consumerPath = resolve(projectDir, 'system-prompt.md')
  if (existsSync(consumerPath)) {
    return (await readFile(consumerPath, 'utf-8')).trim()
  }

  const builtinPath = resolve(__dirname, 'system-prompt.md')
  try {
    return (await readFile(builtinPath, 'utf-8')).trim()
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------
// Output marker instructions
// ---------------------------------------------------------------------------

const EARLY_STOP_INSTRUCTIONS = `
## Early Stop

If any of the following occur, **stop immediately** — do not retry or work around the problem. Output your report right away to avoid wasting budget:

- The target URL returns an error (404, 500, connection refused) or a blank page.
- You are redirected to a login page and have no credentials.
- The feature under test clearly does not exist (all expected elements are missing, the page structure is completely different from the description).
- The app has crashed or is unresponsive (multiple consecutive actions fail with errors).

When stopping early, begin your output with:

[EARLY_STOP] One-line reason why you stopped

Then continue with the normal report format below.`

const FEATURE_OUTPUT_INSTRUCTIONS = `
${EARLY_STOP_INSTRUCTIONS}

## Final Output

After testing, end your response with a structured report. The very first line of your report MUST be one of:

[TEST_PASS]
[TEST_FAIL]
[EARLY_STOP] reason

Then continue with:

[REASON] One-line summary of what was tested
[BUG_FOUND] Description of bug 1
[BUG_FOUND] Description of bug 2
[STEP] What you did first — result
[STEP] What you did next — result

Use [TEST_FAIL] if you found any bugs. Each marker must be on its own line. Do NOT reference screenshot filenames you invented — only reference what you actually see on screen.

**IMPORTANT: You MUST write one [STEP] line for every step you executed, even if it passed. Do NOT summarise or skip steps. The runner cannot verify the test without them.**`

const CHAOS_OUTPUT_INSTRUCTIONS = `
## Output

As soon as you find a bug, **take a screenshot first**, then STOP and output a report. The very first line MUST be one of:

[BUG_FOUND] Short description of the bug
[NO_BUG_FOUND]

If you found a bug, continue with:

[ACTION] What you did
[EXPECTED] What you expected
[ACTUAL] What actually happened
[STEP] What you did first — result
[STEP] What you did next — result

**CRITICAL: The first line of your output MUST start with [BUG_FOUND] or [NO_BUG_FOUND]. This is how the runner detects your findings.**`

// ---------------------------------------------------------------------------
// Mode-specific prompt builders
// ---------------------------------------------------------------------------

export interface FeaturePromptOptions {
  projectDir: string
  featureName: string
  baseUrl: string
  appName?: string
  contextHint?: string
}

export async function buildFeaturePrompt(opts: FeaturePromptOptions): Promise<string> {
  const {
    projectDir,
    featureName,
    baseUrl,
    appName = 'the application',
    contextHint = '',
  } = opts

  const featureContent = await loadFeatureFile(projectDir, featureName)

  const appDescription = `a web app called ${appName} at ${baseUrl}`
  const navigationInstruction = `Navigate to ${baseUrl}.`

  const taskInstructions = `Test the following feature area thoroughly. The description below is a **hint and reference** — it tells you what exists and roughly how to find it, but it is NOT a rigid script. You should:

- Use the hints as a starting point, then **explore beyond them**.
- Think like a real user: what would they try? What could go wrong?
- Test the **complete surface area** — not just the happy path.
- Take a screenshot after each key action.
- If you find unexpected behavior, document it as a bug and keep going.`

  const contextSection = contextHint ? `\n## Context\n\n${contextHint}\n` : ''

  return `You are a senior QA engineer testing ${appDescription}.
${contextSection}
## Task

${navigationInstruction}

${taskInstructions}

### Feature: ${featureName}

${featureContent}

## Bug Reporting

For each bug, record:
- **What you did** (action)
- **What you expected** (expected result)
- **What actually happened** (actual result)
${FEATURE_OUTPUT_INSTRUCTIONS}`
}

// ---------------------------------------------------------------------------
// Happy-path with explicit steps
// ---------------------------------------------------------------------------

export interface StepsPromptOptions {
  projectDir: string
  steps: string
  contextHint?: string
  /** Optional feature names whose specs are included as UI reference. */
  featureNames?: string[]
}

/**
 * Builds a prompt for happy-path mode with explicit steps.
 * Steps contain all navigation/action instructions — no baseUrl/target needed.
 * Feature specs (if any) are included as background UI reference only.
 */
export async function buildStepsPrompt(opts: StepsPromptOptions): Promise<string> {
  const {
    projectDir,
    steps,
    contextHint = '',
    featureNames = [],
  } = opts

  const contextSection = contextHint ? `\n## Context\n\n${contextHint}\n` : ''

  let uiReference = ''
  if (featureNames.length > 0) {
    const parts: string[] = []
    for (const name of featureNames) {
      try {
        const content = await loadFeatureFile(projectDir, name)
        parts.push(`### ${name}\n\n${content}`)
      } catch {
        // feature file missing — skip silently
      }
    }
    if (parts.length > 0) {
      uiReference = `\n## UI Reference\n\nThe following feature descriptions explain the UI elements and their locations. Use them as context when executing the steps.\n\n${parts.join('\n\n---\n\n')}\n`
    }
  }

  return `You are a senior QA engineer. You MUST use the Playwright browser tools (browser_navigate, browser_click, browser_type, browser_snapshot, browser_take_screenshot, etc.) to perform all actions in a real browser. Do NOT use WebFetch, WebSearch, or any non-browser tool.
${contextSection}
## Task

Execute the following steps **exactly as written** using the Playwright browser tools. Do not explore beyond them. Do not improvise additional actions. Take a screenshot after each key step.

If a step fails or produces unexpected results, document it as a bug and **continue with the remaining steps**.

## Steps

${steps.trim()}
${uiReference}
## Bug Reporting

For each bug, record:
- **What you did** (action)
- **What you expected** (expected result)
- **What actually happened** (actual result)
${FEATURE_OUTPUT_INSTRUCTIONS}`
}

export interface ChaosPromptOptions {
  projectDir: string
  baseUrl: string
  appName?: string
  avoidRules?: string[]
}

export async function buildChaosPrompt(opts: ChaosPromptOptions): Promise<string> {
  const { projectDir, baseUrl, appName = 'the application', avoidRules = [] } = opts
  const reference = await loadAllFeatures(projectDir)

  const avoidSection =
    avoidRules.length > 0
      ? `\n**Off-limits (DO NOT do these):**\n${avoidRules.map((r) => `- ${r}`).join('\n')}\n`
      : ''

  return `You are an exploration QA tester for a web application called ${appName} at ${baseUrl}.

Your goal: **find one bug**. Explore the app freely — try unexpected flows, edge cases, weird inputs, anything that might break things. As soon as you find a bug, stop and report it.

## Rules
- Navigate to ${baseUrl} first.
- You are NOT required to follow any specific order. Do whatever you think is most likely to surface bugs.
- Try things like: creating items with empty/special-character names, clicking buttons rapidly, navigating away mid-operation, etc.
- After each interesting action, take a screenshot.
- As soon as you find a bug (error message, crash, unexpected behavior, UI glitch, broken state), **take a screenshot first**, then STOP and output your report.
${avoidSection}
## Reference: Known UI Actions
Below is a reference of all known features and actions. Use these as inspiration, NOT as a checklist.

${reference}
${CHAOS_OUTPUT_INSTRUCTIONS}`
}

export function buildChaosFollowUpPrompt(bugsFound: string[]): string {
  const bugList = bugsFound.map((b, i) => `${i + 1}. ${b}`).join('\n')
  return `Good, you found ${bugsFound.length} bug(s) so far:\n${bugList}\n\nKeep going — explore areas you haven't touched yet and find the next bug. Avoid re-testing bugs you already found. As soon as you find a new bug, take a screenshot, then STOP and report it starting with [BUG_FOUND]. If no more bugs, output [NO_BUG_FOUND].`
}
