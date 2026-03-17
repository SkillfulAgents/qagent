import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const DEFAULT_PROJECT_DIR = 'qagent'

/**
 * Resolves the project directory (where stories/, features/, hooks/ live).
 * Falls back to `<cwd>/qagent` if not explicitly provided.
 */
export function resolveProjectDir(explicit?: string): string {
  if (explicit) {
    const abs = resolve(explicit)
    if (!existsSync(abs)) {
      throw new Error(`Project directory not found: ${abs}`)
    }
    return abs
  }

  const candidate = resolve(process.cwd(), DEFAULT_PROJECT_DIR)
  if (existsSync(candidate)) return candidate

  return process.cwd()
}

/**
 * Loads `.env.local` (or `.env`) into process.env.
 * Searches in both the project directory and cwd (for the common case where
 * `.env.local` lives at the package root while `--project-dir` points elsewhere).
 * Existing env vars are NOT overwritten.
 */
export function loadEnvFile(projectDir: string): void {
  const searchDirs = [projectDir]
  const cwd = process.cwd()
  if (resolve(cwd) !== resolve(projectDir)) {
    searchDirs.push(cwd)
  }

  for (const dir of searchDirs) {
    for (const name of ['.env.local', '.env']) {
      const envPath = resolve(dir, name)
      if (!existsSync(envPath)) continue

      const content = readFileSync(envPath, 'utf-8')
      for (const line of content.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        const eqIdx = trimmed.indexOf('=')
        if (eqIdx === -1) continue
        const key = trimmed.slice(0, eqIdx).trim()
        const value = trimmed.slice(eqIdx + 1).trim()
        if (!process.env[key]) {
          process.env[key] = value
        }
      }
      console.log(`[config] Loaded env from ${envPath}`)
      return
    }
  }
}
