// ---------------------------------------------------------------------------
// Test modes
// ---------------------------------------------------------------------------

export type TestMode = 'happy-path' | 'feature-test' | 'chaos-monkey'

export type TestTarget = 'web' | 'electron'

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
  setup?: string[]
  teardown?: string[]
  tags?: string[]
  testData?: Record<string, Record<string, unknown>>
}

// ---------------------------------------------------------------------------
// Setup hooks
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
}

// ---------------------------------------------------------------------------
// Runner options (from CLI)
// ---------------------------------------------------------------------------

export interface RunOptions {
  filter?: string
  tag?: string
  verbose: boolean
  maxRetries: number
  baseUrl: string
  target: TestTarget
  model?: string
  budgetOverride?: number
  projectDir: string
  /** Enable video recording via Playwright MCP --save-video. */
  record?: boolean
  /** Append to existing run results instead of overwriting (adds numeric suffix). */
  append?: boolean
  /** Skip cleanup of temp screenshots, videos, and JSONL files after run. */
  noClean?: boolean
  /** Upload results to GitHub Artifacts after run. */
  upload?: boolean
}

// ---------------------------------------------------------------------------
// Results
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

export interface SuiteResult {
  startedAt: string
  finishedAt: string
  totalDurationMs: number
  totalStories: number
  passedStories: number
  failedStories: number
  totalFeatures: number
  passedFeatures: number
  failedFeatures: number
  totalCostUsd: number
  results: StoryResult[]
}
