import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { validate } from '../src/core/validate.ts'

const tempDirs: string[] = []

async function createProject(stories: Record<string, string> = {}, extras?: {
  features?: Record<string, string>
  hooks?: Record<string, string>
}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qagent-validate-'))
  tempDirs.push(dir)
  await mkdir(join(dir, 'stories'), { recursive: true })

  for (const [name, content] of Object.entries(stories)) {
    await writeFile(join(dir, 'stories', name), content, 'utf-8')
  }

  if (extras?.features) {
    await mkdir(join(dir, 'features'), { recursive: true })
    for (const [name, content] of Object.entries(extras.features)) {
      await writeFile(join(dir, 'features', name), content, 'utf-8')
    }
  }

  if (extras?.hooks) {
    await mkdir(join(dir, 'hooks'), { recursive: true })
    for (const [name, content] of Object.entries(extras.hooks)) {
      await writeFile(join(dir, 'hooks', name), content, 'utf-8')
    }
  }

  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

describe('validate', () => {
  it('passes for a valid happy-path story', async () => {
    const dir = await createProject({
      'smoke.yaml': 'id: smoke\nname: Smoke\nmode: happy-path\nsteps: |\n  1. Go to site\n',
    })
    const result = await validate(dir)
    const storyErrors = result.issues.filter((i) => i.storyId)
    expect(storyErrors).toHaveLength(0)
  })

  it('errors on unknown mode with suggestion', async () => {
    const dir = await createProject({
      'bad.yaml': 'id: bad\nname: Bad\nmode: hapypath\n',
    })
    const result = await validate(dir)
    const modeError = result.issues.find((i) => i.message.includes('unknown mode'))
    expect(modeError).toBeDefined()
    expect(modeError!.message).toContain('Did you mean "happy-path"')
  })

  it('errors when happy-path has no steps', async () => {
    const dir = await createProject({
      'no-steps.yaml': 'id: ns\nname: NoSteps\nmode: happy-path\n',
    })
    const result = await validate(dir)
    expect(result.issues.some((i) => i.message.includes('no "steps" field'))).toBe(true)
  })

  it('warns when feature-test has no features', async () => {
    const dir = await createProject({
      'empty.yaml': 'id: empty\nname: Empty\nmode: feature-test\n',
    })
    const result = await validate(dir)
    const warn = result.issues.find((i) => i.level === 'warn' && i.storyId === 'empty')
    expect(warn).toBeDefined()
    expect(warn!.message).toContain('no "features" defined')
  })

  it('errors when referenced feature file is missing', async () => {
    const dir = await createProject({
      'feat.yaml': 'id: feat\nname: Feat\nmode: feature-test\nfeatures:\n  - login\n',
    })
    const result = await validate(dir)
    expect(result.issues.some((i) => i.message.includes('features/login.md'))).toBe(true)
  })

  it('passes when referenced feature file exists', async () => {
    const dir = await createProject(
      { 'feat.yaml': 'id: feat\nname: Feat\nmode: feature-test\nfeatures:\n  - login\n' },
      { features: { 'login.md': '# Login\n' } },
    )
    const result = await validate(dir)
    const featureErrors = result.issues.filter((i) => i.storyId === 'feat' && i.level === 'error')
    expect(featureErrors).toHaveLength(0)
  })

  it('errors when referenced hook file is missing', async () => {
    const dir = await createProject({
      'hook.yaml': 'id: hook\nname: Hook\nmode: happy-path\nsteps: |\n  1. Go\nsetup:\n  - seed-db\n',
    })
    const result = await validate(dir)
    expect(result.issues.some((i) => i.message.includes('hooks/seed-db'))).toBe(true)
  })

  it('passes when referenced hook file exists', async () => {
    const dir = await createProject(
      { 'hook.yaml': 'id: hook\nname: Hook\nmode: happy-path\nsteps: |\n  1. Go\nsetup:\n  - seed-db\n' },
      { hooks: { 'seed-db.ts': 'export default async () => {}' } },
    )
    const result = await validate(dir)
    const hookErrors = result.issues.filter((i) => i.message.includes('hook file not found'))
    expect(hookErrors).toHaveLength(0)
  })

  it('errors when stories directory is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qagent-validate-'))
    tempDirs.push(dir)
    await rm(join(dir, 'stories'), { recursive: true, force: true })
    const result = await validate(dir)
    expect(result.ok).toBe(false)
    expect(result.issues.some((i) => i.message.includes('Stories directory not found'))).toBe(true)
  })
})
