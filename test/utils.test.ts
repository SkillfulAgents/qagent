import { describe, expect, it, vi, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveRunId } from '../src/utils/run-id.ts'
import { computeSessionCost } from '../src/utils/cost-helper.ts'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('resolveRunId', () => {
  it('returns pr-N_base_head for pull_request events', () => {
    vi.stubEnv('GITHUB_EVENT_NAME', 'pull_request')
    vi.stubEnv('GITHUB_PR_NUMBER', '42')
    vi.stubEnv('GITHUB_SHA', 'abcdef1234567')
    vi.stubEnv('GITHUB_EVENT_BEFORE', '1111111234567')
    const id = resolveRunId()
    expect(id).toBe('pr-42_1111111_abcdef1')
  })

  it('returns before_after for push events with range', () => {
    vi.stubEnv('GITHUB_EVENT_NAME', 'push')
    vi.stubEnv('GITHUB_SHA', 'aaaaaaa1234567')
    vi.stubEnv('GITHUB_EVENT_BEFORE', 'bbbbbbb1234567')
    const id = resolveRunId()
    expect(id).toBe('bbbbbbb_aaaaaaa')
  })

  it('ignores all-zero before sha (initial push)', () => {
    vi.stubEnv('GITHUB_EVENT_NAME', 'push')
    vi.stubEnv('GITHUB_SHA', 'cccccc1234567')
    vi.stubEnv('GITHUB_EVENT_BEFORE', '0000000000000000000000000000000000000000')
    const id = resolveRunId()
    expect(id).toBe('commit_cccccc1')
  })

  it('returns local_<timestamp> without git or CI env', () => {
    vi.stubEnv('GITHUB_EVENT_NAME', '')
    vi.stubEnv('GITHUB_SHA', '')
    vi.stubEnv('GITHUB_EVENT_BEFORE', '')
    vi.stubEnv('GITHUB_PR_NUMBER', '')
    // Can't easily stub execSync; just assert shape
    const id = resolveRunId()
    expect(id).toMatch(/^(commit_|local_)/)
  })
})

describe('computeSessionCost', () => {
  async function writeSession(lines: object[]): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), 'qagent-cost-'))
    const dir = join(home, '.claude', 'projects', '-tmp-project')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'session-1.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
    vi.stubEnv('HOME', home)
    return home
  }

  const call = (id: string, model: string, usage: Record<string, number>) => ({
    type: 'assistant',
    message: { id, model, usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, ...usage } },
  })

  it('prices claude-haiku-5-5 at its own rates and counts each API call once', async () => {
    const usage = { input_tokens: 2, output_tokens: 300, cache_creation_input_tokens: 5000, cache_read_input_tokens: 20000 }
    await writeSession([
      { type: 'user', message: { content: 'Open example.com' } },
      call('msg_1', 'claude-haiku-5-5', usage),
      call('msg_1', 'claude-haiku-5-5', usage),
      call('msg_2', 'claude-haiku-5-5', usage),
    ])

    const cost = await computeSessionCost('session-1')

    // Per call: 2*0.1 + 300*0.5 + 5000*0.125 + 20000*0.01 = 975.2 per million tokens
    expect(cost?.cacheReadTokens).toBe(40000)
    expect(cost?.totalCostUsd).toBeCloseTo(2 * 975.2 / 1_000_000, 6)
  })

  it('uses long-context rates for a call whose prompt is over the threshold', async () => {
    await writeSession([call('msg_1', 'claude-haiku-5-5', { cache_read_input_tokens: 120000, output_tokens: 100 })])

    const cost = await computeSessionCost('session-1')

    expect(cost?.totalCostUsd).toBeCloseTo((120000 * 0.05 + 100 * 2.5) / 1_000_000, 6)
  })

  it('matches dated ids and prefers the longest model id', async () => {
    await writeSession([
      call('msg_1', 'claude-haiku-4-5-20251001', { output_tokens: 1000 }),
      call('msg_2', 'claude-sonnet-5-5', { cache_read_input_tokens: 1000 }),
    ])

    const cost = await computeSessionCost('session-1')

    expect(cost?.totalCostUsd).toBeCloseTo((1000 * 5 + 1000 * 0.1) / 1_000_000, 6)
  })

  it('reports no cost for a model without a price', async () => {
    await writeSession([call('msg_1', 'claude-future-9', { output_tokens: 1000 })])

    expect(await computeSessionCost('session-1')).toBeNull()
  })
})
