/**
 * OpenAI Decisions client: asks yes/no questions about a text and returns a
 * probability per question instead of generated text.
 * https://platform.openai.com/docs/guides/decisions
 */

const DECISIONS_MODEL = 'gpt-6-luna'
const DEFAULT_BASE_URL = 'https://api.openai.com/v1'
const TIMEOUT_MS = 30_000

export type FetchFn = typeof fetch

/** Question name → instructions. */
export type YesNoQuestions = Record<string, string>

/** Question name → probability of "yes", or null when the model refused. */
export type YesNoAnswers = Record<string, number | null>

export interface DecisionsOptions {
  apiKey: string
  /** Same convention as the OpenAI SDKs' OPENAI_BASE_URL. */
  baseUrl?: string
  fetchFn?: FetchFn
}

interface WireAnswer {
  type: string
  name: string
  probability?: number
}

export async function decideYesNo(
  input: string,
  questions: YesNoQuestions,
  { apiKey, baseUrl = DEFAULT_BASE_URL, fetchFn = fetch }: DecisionsOptions,
): Promise<YesNoAnswers> {
  const res = await fetchFn(`${baseUrl.replace(/\/+$/, '')}/decisions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: DECISIONS_MODEL,
      input,
      questions: Object.entries(questions).map(([name, instructions]) => ({ type: 'predicate', name, instructions })),
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) {
    throw new Error(`Decisions API returned ${res.status}: ${(await res.text()).slice(0, 300)}`)
  }

  const body = (await res.json()) as { answers?: WireAnswer[] }
  const answers: YesNoAnswers = Object.fromEntries(Object.keys(questions).map((name) => [name, null]))
  for (const answer of body.answers ?? []) {
    if (answer.type === 'predicate' && answer.name in answers && typeof answer.probability === 'number') {
      answers[answer.name] = answer.probability
    }
  }
  return answers
}
