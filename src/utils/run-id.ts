/**
 * Resolves a human-readable run identifier from git/CI environment.
 *
 * Priority:
 *   1. PR:     pr-{number}_{baseSha}_{headSha}   (GITHUB_EVENT_NAME=pull_request)
 *   2. Range:  {beforeSha}_{afterSha}             (GITHUB_EVENT_BEFORE + GITHUB_SHA)
 *   3. Single: commit_{sha}                       (git rev-parse HEAD or GITHUB_SHA)
 *   4. Local:  local_{ISO-timestamp}
 */
import { execSync } from 'node:child_process'

function short(sha: string): string {
  return sha.slice(0, 7)
}

function gitHead(): string | null {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
  } catch {
    return null
  }
}

export function resolveRunId(): string {
  const eventName = process.env.GITHUB_EVENT_NAME
  const headSha = process.env.GITHUB_SHA
  const beforeSha = process.env.GITHUB_EVENT_BEFORE
  const prNumber = process.env.GITHUB_PR_NUMBER ?? process.env.PR_NUMBER

  // PR run
  if (eventName === 'pull_request' && prNumber && headSha) {
    const base = beforeSha ? short(beforeSha) : 'base'
    return `pr-${prNumber}_${base}_${short(headSha)}`
  }

  // Push with range (before → after)
  if (beforeSha && headSha && beforeSha !== '0000000000000000000000000000000000000000') {
    return `${short(beforeSha)}_${short(headSha)}`
  }

  // Single commit (CI or local git)
  const sha = headSha ? short(headSha) : gitHead()
  if (sha) {
    return `commit_${sha}`
  }

  // Fallback: local timestamp
  const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)
  return `local_${ts}`
}
