import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import yaml from 'js-yaml'
import type { Story } from '../types.js'

/**
 * Loads stories from `<projectDir>/stories/*.yaml`.
 * Optionally filters by id/name substring and tag.
 */
export async function loadStories(
  projectDir: string,
  filter?: string,
  tag?: string,
): Promise<Story[]> {
  const storiesDir = resolve(projectDir, 'stories')
  if (!existsSync(storiesDir)) {
    throw new Error(`Stories directory not found: ${storiesDir}`)
  }

  const files = (await readdir(storiesDir)).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml')).sort()

  if (files.length === 0) {
    throw new Error(`No story files found in ${storiesDir}`)
  }

  let stories: Story[] = []

  for (const file of files) {
    const raw = await readFile(resolve(storiesDir, file), 'utf-8')
    const docs = yaml.loadAll(raw) as Story[]
    for (const doc of docs) {
      if (doc && typeof doc === 'object' && doc.id) {
        if (!doc.mode) doc.mode = 'feature-test'
        stories.push(doc)
      }
    }
  }

  if (filter) {
    const pattern = filter.toLowerCase()
    stories = stories.filter(
      (s) => s.id.toLowerCase().includes(pattern) || s.name.toLowerCase().includes(pattern),
    )
  }

  if (tag) {
    stories = stories.filter((s) => s.tags?.includes(tag))
  }

  return stories
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
