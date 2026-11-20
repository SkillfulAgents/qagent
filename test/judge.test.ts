import { describe, expect, it, vi } from 'vitest'
import { judgeChaosOutput, judgeFeatureOutput } from '../src/prompt/judge.ts'
import type { FetchFn } from '../src/decision/openai-decisions.ts'

interface SentRequest {
  url: string
  auth: string | null
  body: { model: string; input: string; questions: { type: string; name: string; instructions: string }[] }
}

function decisionsFetch(probabilities: Record<string, number | 'refusal'>, status = 200) {
  const sent: SentRequest[] = []
  const fetchFn: FetchFn = async (url, init) => {
    sent.push({
      url: String(url),
      auth: new Headers(init?.headers).get('authorization'),
      body: JSON.parse(String(init?.body)),
    })
    const answers = Object.entries(probabilities).map(([name, p]) =>
      p === 'refusal' ? { type: 'refusal', name } : { type: 'predicate', name, probability: p },
    )
    return new Response(status === 200 ? JSON.stringify({ answers }) : 'upstream error', { status })
  }
  return { fetchFn, sent }
}

const env = { OPENAI_API_KEY: 'test-key' }

const FREE_FORM_PASS = [
  'All good. The login page loaded and the sign-in worked.',
  '[STEP] open login page — loaded',
  '[STEP] sign in with the test account — dashboard shown',
].join('\n')

describe('judgeFeatureOutput', () => {
  it('asks Decisions and passes a report that has no verdict marker', async () => {
    const { fetchFn, sent } = decisionsFetch({ early_stop: 0.02, passed: 0.97 })

    const result = await judgeFeatureOutput(FREE_FORM_PASS, { env, fetchFn })

    expect(result.passed).toBe(true)
    expect(result.reason).toBe('All good. The login page loaded and the sign-in worked.')
    expect(result.steps).toEqual(['open login page — loaded', 'sign in with the test account — dashboard shown'])
    expect(sent).toHaveLength(1)
    expect(sent[0].url).toBe('https://api.openai.com/v1/decisions')
    expect(sent[0].auth).toBe('Bearer test-key')
    expect(sent[0].body.model).toBe('gpt-6-luna')
    expect(sent[0].body.input).toBe(FREE_FORM_PASS)
    expect(sent[0].body.questions.map((q) => [q.type, q.name])).toEqual([
      ['predicate', 'early_stop'],
      ['predicate', 'passed'],
    ])
  })

  it('lets Decisions override a wrong marker and keeps the bug lines', async () => {
    const { fetchFn } = decisionsFetch({ early_stop: 0.05, passed: 0.1 })
    const output = ['[TEST_PASS]', '[REASON] Checkout tested', '[BUG_FOUND] total shows NaN after removing an item'].join('\n')

    const result = await judgeFeatureOutput(output, { env, fetchFn })

    expect(result.passed).toBe(false)
    expect(result.bugs).toEqual(['total shows NaN after removing an item'])
    expect(result.reason).toContain('Checkout tested')
    expect(result.reason).toContain('total shows NaN after removing an item')
  })

  it('reports an early stop as a failure', async () => {
    const { fetchFn } = decisionsFetch({ early_stop: 0.9, passed: 0.6 })

    const result = await judgeFeatureOutput('The app returned 502 on every page, so I stopped.', { env, fetchFn })

    expect(result.passed).toBe(false)
    expect(result.reason).toBe('Early stop: The app returned 502 on every page, so I stopped.')
  })

  it('uses OPENAI_BASE_URL when it is set', async () => {
    const { fetchFn, sent } = decisionsFetch({ early_stop: 0, passed: 1 })

    await judgeFeatureOutput(FREE_FORM_PASS, { env: { ...env, OPENAI_BASE_URL: 'https://proxy.example.com/v1/openai/' }, fetchFn })

    expect(sent[0].url).toBe('https://proxy.example.com/v1/openai/decisions')
  })

  it('uses the markers when OPENAI_API_KEY is not set', async () => {
    const fetchFn = vi.fn<FetchFn>()

    const result = await judgeFeatureOutput('[TEST_PASS]\n[REASON] Login works', { env: {}, fetchFn })

    expect(fetchFn).not.toHaveBeenCalled()
    expect(result.passed).toBe(true)
    expect(result.reason).toBe('Login works')
  })

  it('uses the markers when the Decisions call fails or refuses', async () => {
    const failed = decisionsFetch({}, 500)
    const refused = decisionsFetch({ early_stop: 0, passed: 'refusal' })

    expect((await judgeFeatureOutput('[TEST_FAIL]\n[REASON] Broken', { env, fetchFn: failed.fetchFn })).passed).toBe(false)
    expect((await judgeFeatureOutput('[TEST_PASS]\n[REASON] Works', { env, fetchFn: refused.fetchFn })).passed).toBe(true)
  })
})

describe('judgeChaosOutput', () => {
  it('takes the bug text from the [BUG_FOUND] line', async () => {
    const { fetchFn, sent } = decisionsFetch({ bug_found: 0.95 })
    const output = 'Found one.\n[BUG_FOUND] renaming a project to an empty name crashes the page'

    const result = await judgeChaosOutput(output, { env, fetchFn })

    expect(result).toEqual({ bugFound: 'renaming a project to an empty name crashes the page', noBug: false })
    expect(sent[0].body.questions.map((q) => q.name)).toEqual(['bug_found'])
  })

  it('uses the first report line when a bug has no [BUG_FOUND] line', async () => {
    const { fetchFn } = decisionsFetch({ bug_found: 0.8 })

    const result = await judgeChaosOutput('\nThe search box freezes when I paste 5,000 characters.\nDetails follow.', { env, fetchFn })

    expect(result).toEqual({ bugFound: 'The search box freezes when I paste 5,000 characters.', noBug: false })
  })

  it('reports no bug when Decisions says no', async () => {
    const { fetchFn } = decisionsFetch({ bug_found: 0.1 })

    expect(await judgeChaosOutput('I tried many flows and everything worked.', { env, fetchFn })).toEqual({ bugFound: null, noBug: true })
  })
})
