import { describe, expect, it, vi } from 'vitest'
import { runFeatureWithRetries, type RunTestFn, type ComputeCostFn } from '../src/core/runner.ts'
import type { TestResult, DriverOptions } from '../src/types.ts'

function makeResult(overrides: Partial<TestResult> = {}): TestResult {
  return {
    passed: true,
    reason: '',
    steps: [],
    bugs: [],
    rawOutput: '',
    durationMs: 100,
    ...overrides,
  }
}

const dummyDriverOpts: DriverOptions = { verbose: false }
const noCost: ComputeCostFn = async () => null

describe('runFeatureWithRetries', () => {
  it('returns immediately when maxRetries < 1', async () => {
    const spy = vi.fn<RunTestFn>()
    const result = await runFeatureWithRetries('prompt', dummyDriverOpts, 0, spy, noCost)
    expect(result.passed).toBe(false)
    expect(result.reason).toContain('maxRetries must be >= 1')
    expect(spy).not.toHaveBeenCalled()
  })

  it('returns passing result on first attempt', async () => {
    const run: RunTestFn = async () => makeResult({ passed: true })
    const result = await runFeatureWithRetries('prompt', dummyDriverOpts, 3, run, noCost)
    expect(result.passed).toBe(true)
  })

  it('retries on failure up to maxRetries', async () => {
    let calls = 0
    const run: RunTestFn = async () => {
      calls++
      if (calls < 3) return makeResult({ passed: false, reason: `fail #${calls}` })
      return makeResult({ passed: true })
    }

    const result = await runFeatureWithRetries('prompt', dummyDriverOpts, 3, run, noCost)
    expect(calls).toBe(3)
    expect(result.passed).toBe(true)
  })

  it('returns last failure when all retries exhausted', async () => {
    const run: RunTestFn = async () => makeResult({ passed: false, reason: 'always fails' })
    const result = await runFeatureWithRetries('prompt', dummyDriverOpts, 2, run, noCost)
    expect(result.passed).toBe(false)
    expect(result.reason).toBe('always fails')
  })

  it('catches thrown errors and wraps them', async () => {
    const run: RunTestFn = async () => { throw new Error('spawn failed') }
    const result = await runFeatureWithRetries('prompt', dummyDriverOpts, 1, run, noCost)
    expect(result.passed).toBe(false)
    expect(result.reason).toContain('spawn failed')
  })

  it('attaches cost info when sessionId is present', async () => {
    const run: RunTestFn = async () => makeResult({ sessionId: 'sess-1' })
    const costFn: ComputeCostFn = async () => ({
      inputTokens: 1000,
      outputTokens: 500,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      model: 'sonnet',
      totalCostUsd: 0.01,
    })

    const result = await runFeatureWithRetries('prompt', dummyDriverOpts, 1, run, costFn)
    expect(result.cost).toBeDefined()
    expect(result.cost!.totalCostUsd).toBe(0.01)
  })

  it('includes failure context in retry prompts', async () => {
    const prompts: string[] = []
    const run: RunTestFn = async (prompt) => {
      prompts.push(prompt)
      if (prompts.length === 1) return makeResult({ passed: false, reason: 'button missing', steps: ['clicked nav'] })
      return makeResult({ passed: true })
    }

    await runFeatureWithRetries('base prompt', dummyDriverOpts, 2, run, noCost)
    expect(prompts[1]).toContain('Previous Attempt')
    expect(prompts[1]).toContain('button missing')
    expect(prompts[1]).toContain('clicked nav')
    expect(prompts[1]).toContain('base prompt')
  })
})
