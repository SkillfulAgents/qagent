import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { initProject } from '../src/core/init.ts'

const tempDirs: string[] = []

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qagent-init-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

describe('initProject', () => {
  it('creates all expected directories and files in a fresh directory', async () => {
    const dir = join(await createTempDir(), 'my-tests')
    const result = await initProject(dir)

    expect(existsSync(join(dir, 'stories'))).toBe(true)
    expect(existsSync(join(dir, 'features'))).toBe(true)
    expect(existsSync(join(dir, 'hooks'))).toBe(true)
    expect(existsSync(join(dir, 'stories', 'smoke.yaml'))).toBe(true)
    expect(existsSync(join(dir, 'features', 'login.md'))).toBe(true)
    expect(existsSync(join(dir, 'system-prompt.md'))).toBe(true)
    expect(existsSync(join(dir, '.env.local'))).toBe(true)

    expect(result.created).toContain('stories/')
    expect(result.created).toContain('stories/smoke.yaml')
    expect(result.created).toContain('features/login.md')
    expect(result.created).toContain('.env.local')
    expect(result.skipped).toHaveLength(0)
  })

  it('generates a valid YAML story', async () => {
    const dir = join(await createTempDir(), 'proj')
    await initProject(dir)

    const content = await readFile(join(dir, 'stories', 'smoke.yaml'), 'utf-8')
    expect(content).toContain('id: smoke')
    expect(content).toContain('mode: happy-path')
    expect(content).toContain('steps:')
  })

  it('skips existing files without overwriting', async () => {
    const dir = join(await createTempDir(), 'proj')
    await initProject(dir)

    await writeFile(join(dir, 'stories', 'smoke.yaml'), 'custom content', 'utf-8')
    const result = await initProject(dir)

    expect(result.skipped).toContain('stories/smoke.yaml')
    const content = await readFile(join(dir, 'stories', 'smoke.yaml'), 'utf-8')
    expect(content).toBe('custom content')
  })

  it('is idempotent — second run skips everything', async () => {
    const dir = join(await createTempDir(), 'proj')
    await initProject(dir)
    const result = await initProject(dir)

    expect(result.created).toHaveLength(0)
    expect(result.skipped.length).toBeGreaterThan(0)
  })
})
