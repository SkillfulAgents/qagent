import { readFile, readdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { existsSync } from 'node:fs'
import yaml from 'js-yaml'
import type { Story } from '../types.js'

interface StoryWithPath {
  story: Story
  /** Path relative to stories/ dir, e.g. "detailed/core.yaml" */
  relPath: string
}

async function findYamlFiles(dir: string, base: string = dir): Promise<{ full: string; rel: string }[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files: { full: string; rel: string }[] = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...await findYamlFiles(full, base))
    } else if (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml')) {
      const rel = full.slice(base.length + 1)
      files.push({ full, rel })
    }
  }
  return files.sort((a, b) => a.rel.localeCompare(b.rel))
}

/**
 * Loads stories from `<projectDir>/stories/` recursively.
 *
 * --filter matches against story id, name, or file path relative to stories/.
 * E.g. `--filter detailed` matches all stories under `stories/detailed/`.
 */
export async function loadStories(
  projectDir: string,
  filter?: string,
): Promise<Story[]> {
  const storiesDir = resolve(projectDir, 'stories')
  if (!existsSync(storiesDir)) {
    throw new Error(`Stories directory not found: ${storiesDir}`)
  }

  const files = await findYamlFiles(storiesDir)

  if (files.length === 0) {
    throw new Error(`No story files found in ${storiesDir}`)
  }

  let loaded: StoryWithPath[] = []

  for (const { full, rel } of files) {
    const raw = await readFile(full, 'utf-8')
    const docs = yaml.loadAll(raw) as Story[]
    for (const doc of docs) {
      if (doc && typeof doc === 'object' && doc.id) {
        if (!doc.mode) doc.mode = 'feature-test'
        loaded.push({ story: doc, relPath: rel })
      }
    }
  }

  if (filter) {
    const pattern = filter.toLowerCase()
    loaded = loaded.filter(
      ({ story, relPath }) =>
        story.id.toLowerCase().includes(pattern) ||
        story.name.toLowerCase().includes(pattern) ||
        relPath.toLowerCase().includes(pattern),
    )
  }

  return loaded.map(({ story }) => story)
}

/**
 * Loads a single feature spec markdown file from `<projectDir>/features/<name>.md`.
 */
export async function loadFeatureFile(projectDir: string, name: string): Promise<string> {
  const filePath = resolve(projectDir, 'features', `${name}.md`)
  try {
    return (await readFile(filePath, 'utf-8')).trim()
  } catch {
    throw new Error(`Feature file not found: ${filePath}`)
  }
}

/**
 * Loads `<projectDir>/features/ignore.md` if it exists.
 * Content applies to all features — use it to list known behaviors
 * that should not be reported as bugs.
 */
export async function loadIgnoreFile(projectDir: string): Promise<string | null> {
  const filePath = resolve(projectDir, 'features', 'ignore.md')
  try {
    return (await readFile(filePath, 'utf-8')).trim() || null
  } catch {
    return null
  }
}

/**
 * Loads all feature spec files and concatenates them as a reference document.
 * Used for chaos-monkey mode where the agent needs awareness of all features.
 */
export async function loadAllFeatures(projectDir: string): Promise<string> {
  const featuresDir = resolve(projectDir, 'features')
  if (!existsSync(featuresDir)) return ''

  const files = (await readdir(featuresDir)).filter((f) => f.endsWith('.md')).sort()
  const parts: string[] = []

  for (const file of files) {
    const content = await readFile(resolve(featuresDir, file), 'utf-8')
    parts.push(`### ${file.replace('.md', '')}\n\n${content.trim()}`)
  }

  return parts.join('\n\n---\n\n')
}
