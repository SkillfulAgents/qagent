/**
 * Parse Claude CLI JSONL session files and compute cost from token usage.
 */
import { readFile, readdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { homedir } from 'node:os'
import type { CostInfo } from '../types.js'

// USD per million tokens, copied from the platform proxy's model-pricing.json.
interface Rates {
  input: number
  output: number
  cacheCreation: number
  cacheRead: number
}

interface ModelPricing extends Rates {
  /** Rates for a call whose prompt is larger than thresholdTokens. */
  longContext?: Rates & { thresholdTokens: number }
}

const MODEL_PRICING: Record<string, ModelPricing> = {
  'claude-haiku-4-5':  { input: 1,   output: 5,  cacheCreation: 1.25,  cacheRead: 0.1 },
  'claude-haiku-5-5':  {
    input: 0.1, output: 0.5, cacheCreation: 0.125, cacheRead: 0.01,
    longContext: { thresholdTokens: 100_000, input: 0.5, output: 2.5, cacheCreation: 0.625, cacheRead: 0.05 },
  },
  'claude-sonnet-4-6': { input: 3,   output: 15, cacheCreation: 3.75,  cacheRead: 0.3 },
  'claude-sonnet-5':   { input: 2,   output: 10, cacheCreation: 2.5,   cacheRead: 0.2 },
  'claude-sonnet-5-5': { input: 2,   output: 10, cacheCreation: 2.5,   cacheRead: 0.1 },
  'claude-opus-4-6':   { input: 5,   output: 25, cacheCreation: 6.25,  cacheRead: 0.5 },
  'claude-opus-4-7':   { input: 5,   output: 25, cacheCreation: 6.25,  cacheRead: 0.5 },
  'claude-opus-4-8':   { input: 5,   output: 25, cacheCreation: 6.25,  cacheRead: 0.5 },
  'claude-opus-5':     { input: 5,   output: 25, cacheCreation: 6.25,  cacheRead: 0.5 },
  'claude-opus-5-5':   { input: 4,   output: 20, cacheCreation: 5,     cacheRead: 0.2 },
  'claude-fable-5':    { input: 10,  output: 50, cacheCreation: 12.5,  cacheRead: 1 },
  'claude-fable-5-1':  { input: 10,  output: 50, cacheCreation: 12.5,  cacheRead: 0.25 },
  'claude-fable-5-2':  { input: 8,   output: 40, cacheCreation: 10,    cacheRead: 0.2 },
  'claude-mythos-5':   { input: 10,  output: 50, cacheCreation: 12.5,  cacheRead: 1 },
}

/** Exact id, or the longest known id followed by a suffix such as a date (claude-haiku-4-5-20251001). */
export function getPricing(model: string): ModelPricing | null {
  const key = Object.keys(MODEL_PRICING)
    .filter((k) => model === k || model.startsWith(`${k}-`))
    .sort((a, b) => b.length - a.length)[0]
  return key ? MODEL_PRICING[key] : null
}

function callCost(pricing: ModelPricing, u: Required<JsonlUsage>): number {
  const prompt = u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens
  const long = pricing.longContext
  const r: Rates = long && prompt > long.thresholdTokens ? long : pricing
  return (
    u.input_tokens * r.input +
    u.output_tokens * r.output +
    u.cache_creation_input_tokens * r.cacheCreation +
    u.cache_read_input_tokens * r.cacheRead
  ) / 1_000_000
}

/**
 * Find a Claude CLI JSONL file by session ID.
 * Searches ~/.claude/projects/ since the encoded-cwd subfolder varies.
 */
export async function findSessionJsonl(sessionId: string): Promise<string | null> {
  const projectsDir = resolve(homedir(), '.claude', 'projects')
  const filename = `${sessionId}.jsonl`
  try {
    for (const dir of await readdir(projectsDir)) {
      const candidate = resolve(projectsDir, dir, filename)
      try { await readFile(candidate, { flag: 'r' }); return candidate } catch { /* next */ }
    }
  } catch { /* no projects dir */ }
  return null
}

interface JsonlUsage {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

interface JsonlEntry {
  type: string
  message?: {
    id?: string
    model?: string
    usage?: JsonlUsage
  }
}

/**
 * Read a Claude CLI JSONL session file and compute the total cost.
 */
export async function computeSessionCost(sessionId: string): Promise<CostInfo | null> {
  const jsonlPath = await findSessionJsonl(sessionId)
  if (!jsonlPath) {
    console.warn(`[cost] JSONL not found for session ${sessionId}`)
    return null
  }

  const content = await readFile(jsonlPath, 'utf-8')

  // Claude CLI writes one line per content block, each with the usage of the
  // whole API call, so count each message id once (its last line wins).
  const calls = new Map<string, { model: string; usage: Required<JsonlUsage> }>()
  let model = 'unknown'
  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    try {
      const entry: JsonlEntry = JSON.parse(line)
      const m = entry.message
      if (entry.type !== 'assistant' || !m?.usage) continue
      if (m.model) model = m.model
      calls.set(m.id ?? `line-${calls.size}`, {
        model,
        usage: {
          input_tokens: m.usage.input_tokens ?? 0,
          output_tokens: m.usage.output_tokens ?? 0,
          cache_creation_input_tokens: m.usage.cache_creation_input_tokens ?? 0,
          cache_read_input_tokens: m.usage.cache_read_input_tokens ?? 0,
        },
      })
    } catch {
      // skip malformed lines
    }
  }

  if (calls.size === 0) return null

  let totalInput = 0
  let totalOutput = 0
  let totalCacheCreation = 0
  let totalCacheRead = 0
  let totalCostUsd = 0
  for (const call of calls.values()) {
    const pricing = getPricing(call.model)
    if (!pricing) {
      console.warn(`[cost] No price for model ${call.model}; cost not reported for session ${sessionId}`)
      return null
    }
    totalInput += call.usage.input_tokens
    totalOutput += call.usage.output_tokens
    totalCacheCreation += call.usage.cache_creation_input_tokens
    totalCacheRead += call.usage.cache_read_input_tokens
    totalCostUsd += callCost(pricing, call.usage)
  }

  return {
    inputTokens: totalInput,
    outputTokens: totalOutput,
    cacheCreationTokens: totalCacheCreation,
    cacheReadTokens: totalCacheRead,
    model,
    totalCostUsd: Math.round(totalCostUsd * 1_000_000) / 1_000_000,
  }
}
