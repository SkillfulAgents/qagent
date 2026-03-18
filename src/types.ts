// ---------------------------------------------------------------------------
// Test modes
// ---------------------------------------------------------------------------

export type TestMode = 'happy-path' | 'feature-test' | 'chaos-monkey'

// ---------------------------------------------------------------------------
// Story (loaded from YAML)
// ---------------------------------------------------------------------------

export interface Story {
  id: string
  name: string
  mode: TestMode
  features?: string[]
  /** Exact steps for happy-path mode (multiline string, ignored in other modes). */
  steps?: string
  /** Override the CLI --base-url for this story. */
  baseUrl?: string
  /** Time limit for chaos-monkey mode, e.g. "10m", "1h". Default: "1h". */
  duration?: string
  setup?: string[]
  teardown?: string[]
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export interface SetupContext {
  baseUrl: string
  env: Record<string, string | undefined>
  store: Map<string, unknown>
  projectDir: string
}

export type SetupHookFn = (ctx: SetupContext) => Promise<void>

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

export interface CostInfo {
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  model: string
  totalCostUsd: number
}

export interface TestResult {
  passed: boolean
  reason: string
  steps: string[]
  bugs: string[]
  rawOutput: string
  durationMs: number
  sessionId?: string
  cost?: CostInfo
}

export interface DriverOptions {
  systemPrompt?: string
  mcpConfigPath?: string
  model?: string
  verbose?: boolean
  timeoutMs?: number
  resumeSessionId?: string
  sessionId?: string
  maxTurns?: number
  maxBudgetUsd?: number
  /** Enable video recording via Playwright MCP --save-video. */
  record?: boolean
  /** Run browser in headless mode. Defaults to true when DISPLAY env var is absent (CI). */
  headless?: boolean
  /** Directory where Playwright MCP stores screenshots and videos. Defaults to process.cwd(). */
  outputDir?: string
  /** Working directory for the claude CLI process (session storage). Defaults to outputDir. */
  cwd?: string
}

// ---------------------------------------------------------------------------
// Runner options (from CLI)
// ---------------------------------------------------------------------------

export interface RunOptions {
  filter?: string
  verbose: boolean
  maxRetries: number
  parallel?: number
  baseUrl: string
  model?: string
  budgetOverride?: number
  projectDir: string
  /** Enable video recording via Playwright MCP --save-video. */
  record?: boolean
  /** Append to existing run results instead of overwriting (adds numeric suffix). */
  append?: boolean
  /** Upload results to GitHub Artifacts after run. */
  upload?: boolean
  /**
   * Force headless browser mode. When not set, the driver decides
   * automatically (headless in CI when DISPLAY is absent, visible otherwise).
   */
  headless?: boolean
  /** Print what would be executed without spawning the agent. */
  dryRun?: boolean
}

// ---------------------------------------------------------------------------
// Story run context — everything needed to execute a single story
// ---------------------------------------------------------------------------

export interface StoryRunContext {
  story: Story
  setupCtx: SetupContext
  driverOptions: DriverOptions
  maxRetries: number
  resultsDir: string
}

// ---------------------------------------------------------------------------
// Results (internal — used during the run)
// ---------------------------------------------------------------------------

export interface FeatureResult {
  feature: string
  result: TestResult
}

export interface StoryResult {
  story: Story
  featureResults: FeatureResult[]
  overallPassed: boolean
}

// ---------------------------------------------------------------------------
// report.json — per-feature structured result (written next to report.md)
// ---------------------------------------------------------------------------

export interface ReportJson {
  storyId: string
  /** Only present for feature-test and chaos-monkey modes. */
  feature?: string
  passed: boolean
  reason: string
  steps: string[]
  bugs: string[]
  durationMs: number
  sessionId?: string
  cost?: CostInfo
}

// ---------------------------------------------------------------------------
// summary.json — lightweight navigation index (one per run)
// ---------------------------------------------------------------------------

export interface SummaryFeatureEntry {
  feature: string
  passed: boolean
  reportPath: string
}

export interface SummaryStoryEntry {
  storyId: string
  storyName: string
  mode: TestMode
  passed: boolean
  durationSec: number
  costUsd: number
  /** happy-path / chaos-monkey: single report path. */
  reportPath?: string
  /** feature-test: per-feature results. */
  features?: SummaryFeatureEntry[]
}

export interface SuiteResult {
  startedAt: string
  finishedAt: string
  totalDurationSec: number
  totalStories: number
  passedStories: number
  failedStories: number
  totalFeatures: number
  passedFeatures: number
  failedFeatures: number
  totalCostUsd: number
  results: SummaryStoryEntry[]
}
