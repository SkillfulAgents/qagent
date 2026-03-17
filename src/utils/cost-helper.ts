/**
 * Parse Claude CLI JSONL session files and compute cost from token usage.
 */
import { readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { homedir } from 'node:os'
import type { CostInfo } from '../types.js'

// Per-million-token pricing (USD). Cache reads = 10% of input, cache writes = 125% of input.
interface ModelPricing {
  inputPerMTok: number
  outputPerMTok: number
}

const MODEL_PRICING: Record<string, ModelPricing> = {
  'claude-opus-4-6':   { inputPerMTok: 5,  outputPerMTok: 25 },
  'claude-sonnet-4-6': { inputPerMTok: 3,  outputPerMTok: 15 },
  'claude-haiku-4-5':  { inputPerMTok: 1,  outputPerMTok: 5 },
  // Aliases used by claude CLI
  'opus':   { inputPerMTok: 5,  outputPerMTok: 25 },
  'sonnet': { inputPerMTok: 3,  outputPerMTok: 15 },
  'haiku':  { inputPerMTok: 1,  outputPerMTok: 5 },
}

const DEFAULT_PRICING: ModelPricing = { inputPerMTok: 3, outputPerMTok: 15 }

function getPricing(model: string): ModelPricing {
  const key = Object.keys(MODEL_PRICING).find((k) => model.includes(k))
  return key ? MODEL_PRICING[key] : DEFAULT_PRICING
}

function computeCost(
  pricing: ModelPricing,
  inputTokens: number,
  outputTokens: number,
  cacheCreationTokens: number,
  cacheReadTokens: number,
): number {
  const inputCost = (inputTokens / 1_000_000) * pricing.inputPerMTok
  const outputCost = (outputTokens / 1_000_000) * pricing.outputPerMTok
  const cacheWriteCost = (cacheCreationTokens / 1_000_000) * pricing.inputPerMTok * 1.25
  const cacheReadCost = (cacheReadTokens / 1_000_000) * pricing.inputPerMTok * 0.10
  return inputCost + outputCost + cacheWriteCost + cacheReadCost
}

/**
 * Locate the Claude CLI JSONL file for a given session.
 * Claude CLI stores sessions at: ~/.claude/projects/{encoded-cwd}/{sessionId}.jsonl
 */
export function getSessionJsonlPath(sessionId: string, cwd?: string): string {
  const projectCwd = cwd ?? process.cwd()
  const encodedCwd = projectCwd.replace(/\//g, '-')
  return resolve(homedir(), '.claude', 'projects', encodedCwd, `${sessionId}.jsonl`)
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
    model?: string
    usage?: JsonlUsage
  }
}

/**
 * Read a Claude CLI JSONL session file and compute the total cost.
 */
export async function computeSessionCost(sessionId: string, cwd?: string): Promise<CostInfo | null> {
  const jsonlPath = getSessionJsonlPath(sessionId, cwd)

  let content: string
  try {
    content = await readFile(jsonlPath, 'utf-8')
  } catch {
    console.warn(`[cost] JSONL not found: ${jsonlPath}`)
    return null
  }

  let model = 'unknown'
  let totalInput = 0
  let totalOutput = 0
  let totalCacheCreation = 0
  let totalCacheRead = 0

  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    try {
      const entry: JsonlEntry = JSON.parse(line)
      if (entry.type === 'assistant' && entry.message?.usage) {
        const u = entry.message.usage
        if (entry.message.model) model = entry.message.model
        totalInput += u.input_tokens ?? 0
        totalOutput += u.output_tokens ?? 0
        totalCacheCreation += u.cache_creation_input_tokens ?? 0
        totalCacheRead += u.cache_read_input_tokens ?? 0
      }
    } catch {
      // skip malformed lines
    }
  }

  if (totalInput === 0 && totalOutput === 0 && totalCacheCreation === 0 && totalCacheRead === 0) {
    return null
  }

  const pricing = getPricing(model)
  const totalCostUsd = computeCost(pricing, totalInput, totalOutput, totalCacheCreation, totalCacheRead)

  return {
    inputTokens: totalInput,
    outputTokens: totalOutput,
    cacheCreationTokens: totalCacheCreation,
    cacheReadTokens: totalCacheRead,
    model,
    totalCostUsd: Math.round(totalCostUsd * 1_000_000) / 1_000_000,
  }
}
