import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { loadStories, loadFeatureFile, loadAllFeatures } from '../src/loader/story-loader.ts'

const tempDirs: string[] = []

async function createProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qagent-loader-'))
  tempDirs.push(dir)
  await mkdir(join(dir, 'stories'), { recursive: true })
  await mkdir(join(dir, 'features'), { recursive: true })
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

describe('loadStories', () => {
  it('loads stories and defaults mode to feature-test', async () => {
    const dir = await createProject()
    await writeFile(join(dir, 'stories', 'a.yaml'), `id: smoke\nname: Smoke\n`)

    const stories = await loadStories(dir)
    expect(stories).toHaveLength(1)
    expect(stories[0].id).toBe('smoke')
    expect(stories[0].mode).toBe('feature-test')
  })

  it('supports multi-document YAML files', async () => {
    const dir = await createProject()
    await writeFile(
      join(dir, 'stories', 'multi.yaml'),
      `id: a\nname: A\n---\nid: b\nname: B\nmode: happy-path\n`,
    )
    const stories = await loadStories(dir)
    expect(stories).toHaveLength(2)
    expect(stories.map((s) => s.id)).toEqual(['a', 'b'])
  })

  it('filters by id/name substring', async () => {
    const dir = await createProject()
    await writeFile(join(dir, 'stories', 'login.yaml'), `id: login-smoke\nname: Login Smoke\n`)
    await writeFile(join(dir, 'stories', 'dash.yaml'), `id: dashboard\nname: Dashboard Test\n`)

    const byId = await loadStories(dir, 'login')
    expect(byId.map((s) => s.id)).toEqual(['login-smoke'])

    const byName = await loadStories(dir, 'dashboard test')
    expect(byName.map((s) => s.id)).toEqual(['dashboard'])
  })

  it('throws when stories directory does not exist', async () => {
    const dir = await createProject()
    await rm(join(dir, 'stories'), { recursive: true, force: true })
    await expect(loadStories(dir)).rejects.toThrow('Stories directory not found')
  })

  it('throws when no story files exist', async () => {
    const dir = await createProject()
    await expect(loadStories(dir)).rejects.toThrow('No story files found')
  })
})

describe('loadFeatureFile', () => {
  it('returns feature content', async () => {
    const dir = await createProject()
    await writeFile(join(dir, 'features', 'login.md'), '# Login\nLogin details.')

    const content = await loadFeatureFile(dir, 'login')
    expect(content).toBe('# Login\nLogin details.')
  })

  it('throws for missing feature file', async () => {
    const dir = await createProject()
    await expect(loadFeatureFile(dir, 'ghost')).rejects.toThrow('Feature file not found')
  })
})

describe('loadAllFeatures', () => {
  it('concatenates multiple feature files in sorted order', async () => {
    const dir = await createProject()
    await writeFile(join(dir, 'features', 'beta.md'), 'Beta content.')
    await writeFile(join(dir, 'features', 'alpha.md'), 'Alpha content.')

    const result = await loadAllFeatures(dir)
    expect(result.indexOf('### alpha')).toBeLessThan(result.indexOf('### beta'))
    expect(result).toContain('Alpha content.')
    expect(result).toContain('Beta content.')
  })

  it('returns empty string when features directory is missing', async () => {
    const dir = await createProject()
    await rm(join(dir, 'features'), { recursive: true, force: true })
    const result = await loadAllFeatures(dir)
    expect(result).toBe('')
  })
})
