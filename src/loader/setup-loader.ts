import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import type { SetupContext, SetupHookFn } from '../types.js'

/**
 * Dynamically imports and runs setup (or teardown) hooks from the consumer's
 * `setup/` directory. Each hook file must export a default async function.
 *
 * Hook resolution order:
 *   1. <projectDir>/setup/<name>.ts
 *   2. <projectDir>/setup/<name>.js
 */
export async function runHooks(
  hookNames: string[],
  ctx: SetupContext,
  label: 'setup' | 'teardown' = 'setup',
): Promise<void> {
  if (hookNames.length === 0) return

  const setupDir = resolve(ctx.projectDir, 'setup')

  for (const name of hookNames) {
    const tsPath = resolve(setupDir, `${name}.ts`)
    const jsPath = resolve(setupDir, `${name}.js`)

    let hookPath: string | undefined
    if (existsSync(tsPath)) hookPath = tsPath
    else if (existsSync(jsPath)) hookPath = jsPath

    if (!hookPath) {
      console.warn(`  [${label}] Hook not found: ${name} (looked in ${setupDir})`)
      continue
    }

    console.log(`  [${label}] Running ${name}...`)
    try {
      const mod = await import(hookPath)
      const fn: SetupHookFn = mod.default ?? mod[name]
      if (typeof fn !== 'function') {
        throw new Error(`Hook "${name}" does not export a default function`)
      }
      await fn(ctx)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`[${label}] Hook "${name}" failed: ${msg}`)
    }
  }
}
