/**
 * GitHub Actions artifact upload.
 */
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

async function getAllFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const files: string[] = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...await getAllFiles(full))
    } else {
      files.push(full)
    }
  }
  return files
}

export async function uploadArtifacts(resultsDir: string, runId: string): Promise<void> {
  if (!process.env.GITHUB_ACTIONS) {
    console.log('[upload] Not running in GitHub Actions, skipping upload.')
    return
  }
  try {
    const { DefaultArtifactClient } = await import('@actions/artifact' as any)
    const client = new DefaultArtifactClient()
    const files = await getAllFiles(resultsDir)
    await client.uploadArtifact(runId, files, resultsDir)
    console.log(`[upload] Uploaded artifact: ${runId}`)
  } catch (err) {
    console.warn(`[upload] Failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}
