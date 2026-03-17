import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import type { SetupContext, SetupHookFn } from '../types.js'

/**
 * Dynamically imports and runs hooks from the consumer's `hooks/` directory.
 * Each hook file must export a default async function.
 *
 * TypeScript support: the CLI runs under tsx, so .ts files are natively importable.
 *
 * Hook resolution order:
 *   1. <projectDir>/hooks/<name>.ts
 *   2. <projectDir>/hooks/<name>.js
 */
export async function runHooks(
  hookNames: string[],
  ctx: SetupContext,
  label: string = 'hook',
): Promise<void> {
  if (hookNames.length === 0) return

  const hooksDir = resolve(ctx.projectDir, 'hooks')

  for (const name of hookNames) {
    const tsPath = resolve(hooksDir, `${name}.ts`)
    const jsPath = resolve(hooksDir, `${name}.js`)

    let hookPath: string | undefined
    if (existsSync(tsPath)) hookPath = tsPath
    else if (existsSync(jsPath)) hookPath = jsPath

    if (!hookPath) {
      console.warn(`  [${label}] Hook not found: ${name} (looked in ${hooksDir})`)
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
