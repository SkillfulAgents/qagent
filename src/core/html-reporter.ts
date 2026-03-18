/**
 * HTML report generator — renders summary + reports + screenshots + videos
 * into a single browsable index.html file, similar to Playwright's report.
 */
import { readdir, readFile, writeFile, stat } from 'node:fs/promises'
import { resolve, join, relative, extname, basename } from 'node:path'
import type { SuiteResult, ReportJson } from '../types.js'

interface MediaFile {
  relPath: string
  base64: string
  type: 'screenshot' | 'video'
  mimeType: string
}

interface ReportEntry {
  dirRelPath: string
  report: ReportJson
  media: MediaFile[]
}

async function collectMedia(dir: string, baseDir: string): Promise<MediaFile[]> {
  const media: MediaFile[] = []
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        media.push(...(await collectMedia(fullPath, baseDir)))
        continue
      }
      const ext = extname(entry.name).toLowerCase()
      if (ext === '.png' || ext === '.jpg' || ext === '.jpeg') {
        const data = await readFile(fullPath)
        media.push({
          relPath: relative(baseDir, fullPath),
          base64: data.toString('base64'),
          type: 'screenshot',
          mimeType: ext === '.png' ? 'image/png' : 'image/jpeg',
        })
      } else if (ext === '.webm' || ext === '.mp4') {
        const data = await readFile(fullPath)
        media.push({
          relPath: relative(baseDir, fullPath),
          base64: data.toString('base64'),
          type: 'video',
          mimeType: ext === '.webm' ? 'video/webm' : 'video/mp4',
        })
      }
    }
  } catch { /* dir may not exist */ }
  return media
}

async function collectReports(dir: string, baseDir: string): Promise<ReportEntry[]> {
  const entries: ReportEntry[] = []
  try {
    const items = await readdir(dir, { withFileTypes: true })
    for (const item of items) {
      const fullPath = join(dir, item.name)
      if (item.isDirectory()) {
        entries.push(...(await collectReports(fullPath, baseDir)))
      } else if (item.name === 'report.json') {
        const report = JSON.parse(await readFile(fullPath, 'utf-8')) as ReportJson
        const media = await collectMedia(dir, baseDir)
        entries.push({
          dirRelPath: relative(baseDir, dir),
          report,
          media: media.filter((m) => m.relPath.startsWith(relative(baseDir, dir))),
        })
      }
    }
  } catch { /* dir may not exist */ }
  return entries
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function statusBadge(passed: boolean): string {
  return passed
    ? '<span class="badge pass">PASSED</span>'
    : '<span class="badge fail">FAILED</span>'
}

function renderMedia(media: MediaFile[]): string {
  if (media.length === 0) return ''
  const screenshots = media.filter((m) => m.type === 'screenshot')
  const videos = media.filter((m) => m.type === 'video')
  let html = ''

  if (screenshots.length > 0) {
    html += '<div class="media-section"><h4>Screenshots</h4><div class="screenshots">'
    for (const s of screenshots) {
      html += `<figure>
        <img src="data:${s.mimeType};base64,${s.base64}" alt="${escapeHtml(basename(s.relPath))}" loading="lazy" onclick="this.classList.toggle('expanded')" />
        <figcaption>${escapeHtml(basename(s.relPath))}</figcaption>
      </figure>`
    }
    html += '</div></div>'
  }

  if (videos.length > 0) {
    html += '<div class="media-section"><h4>Videos</h4><div class="videos">'
    for (const v of videos) {
      html += `<figure>
        <video controls preload="metadata" src="data:${v.mimeType};base64,${v.base64}"></video>
        <figcaption>${escapeHtml(basename(v.relPath))}</figcaption>
      </figure>`
    }
    html += '</div></div>'
  }

  return html
}

function renderSteps(steps: string[]): string {
  if (steps.length === 0) return ''
  return `<details><summary>Steps (${steps.length})</summary><ol class="steps">
    ${steps.map((s) => `<li>${escapeHtml(s)}</li>`).join('\n    ')}
  </ol></details>`
}

function renderBugs(bugs: string[]): string {
  if (bugs.length === 0) return ''
  return `<div class="bugs"><h4>Bugs Found</h4><ul>
    ${bugs.map((b) => `<li>${escapeHtml(b)}</li>`).join('\n    ')}
  </ul></div>`
}

export async function generateHtmlReport(resultsDir: string): Promise<string> {
  const summaryPath = resolve(resultsDir, 'summary.json')
  let summary: SuiteResult
  try {
    summary = JSON.parse(await readFile(summaryPath, 'utf-8'))
  } catch {
    throw new Error(`Cannot read summary.json from ${resultsDir}`)
  }

  const allReports = await collectReports(resultsDir, resultsDir)
  const reportMap = new Map(allReports.map((r) => [r.dirRelPath, r]))

  const icon = (p: boolean) => (p ? '✅' : '❌')

  const storyCards = summary.results
    .map((story) => {
      let featureHtml = ''

      if (story.features && story.features.length > 0) {
        featureHtml = story.features
          .map((f) => {
            const entry = reportMap.get(f.reportPath.replace(/\/report\.json$/, ''))
            const detail = entry
              ? `<div class="report-detail">
                  ${entry.report.reason ? `<p class="reason"><strong>Result:</strong> ${escapeHtml(entry.report.reason)}</p>` : ''}
                  ${renderSteps(entry.report.steps)}
                  ${renderBugs(entry.report.bugs)}
                  ${renderMedia(entry.media)}
                </div>`
              : ''
            return `<div class="feature-card">
              <div class="feature-header">${statusBadge(f.passed)} <span class="feature-name">${escapeHtml(f.feature)}</span></div>
              ${detail}
            </div>`
          })
          .join('\n')
      } else if (story.reportPath) {
        const dir = story.reportPath.replace(/\/report\.json$/, '')
        const entry = reportMap.get(dir)
        if (entry) {
          featureHtml = `<div class="report-detail">
            ${entry.report.reason ? `<p class="reason"><strong>Result:</strong> ${escapeHtml(entry.report.reason)}</p>` : ''}
            ${renderSteps(entry.report.steps)}
            ${renderBugs(entry.report.bugs)}
            ${renderMedia(entry.media)}
          </div>`
        }
      }

      return `<div class="story-card ${story.passed ? 'passed' : 'failed'}">
        <div class="story-header" onclick="this.parentElement.classList.toggle('collapsed')">
          <span class="story-status">${icon(story.passed)}</span>
          <span class="story-name">${escapeHtml(story.storyId)}</span>
          <span class="story-mode">${escapeHtml(story.mode)}</span>
          <span class="story-meta">${story.durationSec.toFixed(1)}s · $${story.costUsd.toFixed(2)}</span>
        </div>
        <div class="story-body">
          <p class="story-desc">${escapeHtml(story.storyName)}</p>
          ${featureHtml}
        </div>
      </div>`
    })
    .join('\n')

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>QAgent Test Report</title>
<style>
  :root {
    --bg: #0d1117; --surface: #161b22; --border: #30363d;
    --text: #e6edf3; --text-dim: #8b949e; --green: #3fb950;
    --red: #f85149; --blue: #58a6ff; --yellow: #d29922;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    background: var(--bg); color: var(--text); line-height: 1.6; padding: 24px; max-width: 1200px; margin: 0 auto; }
  h1 { font-size: 24px; margin-bottom: 8px; }
  .subtitle { color: var(--text-dim); font-size: 14px; margin-bottom: 24px; }
  .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin-bottom: 32px; }
  .metric { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 16px; text-align: center; }
  .metric-value { font-size: 28px; font-weight: 700; }
  .metric-value.pass { color: var(--green); }
  .metric-value.fail { color: var(--red); }
  .metric-label { font-size: 12px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.5px; margin-top: 4px; }
  .story-card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; margin-bottom: 12px; overflow: hidden; }
  .story-card.passed { border-left: 3px solid var(--green); }
  .story-card.failed { border-left: 3px solid var(--red); }
  .story-header { display: flex; align-items: center; gap: 12px; padding: 16px; cursor: pointer; user-select: none; }
  .story-header:hover { background: rgba(255,255,255,0.03); }
  .story-name { font-weight: 600; flex: 1; }
  .story-mode { background: var(--border); padding: 2px 8px; border-radius: 4px; font-size: 12px; color: var(--text-dim); }
  .story-meta { font-size: 13px; color: var(--text-dim); white-space: nowrap; }
  .story-body { padding: 0 16px 16px; }
  .story-card.collapsed .story-body { display: none; }
  .story-desc { color: var(--text-dim); font-size: 14px; margin-bottom: 12px; }
  .feature-card { background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 12px; margin-bottom: 8px; }
  .feature-header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .feature-name { font-weight: 500; }
  .badge { font-size: 11px; font-weight: 700; padding: 2px 6px; border-radius: 3px; text-transform: uppercase; }
  .badge.pass { background: rgba(63,185,80,0.15); color: var(--green); }
  .badge.fail { background: rgba(248,81,73,0.15); color: var(--red); }
  .reason { font-size: 14px; margin-bottom: 8px; color: var(--text-dim); }
  details { margin: 8px 0; }
  summary { cursor: pointer; font-size: 14px; color: var(--blue); font-weight: 500; }
  .steps { padding-left: 24px; margin-top: 8px; font-size: 13px; color: var(--text-dim); }
  .steps li { margin-bottom: 4px; }
  .bugs { margin-top: 12px; }
  .bugs h4 { color: var(--red); font-size: 14px; margin-bottom: 4px; }
  .bugs ul { padding-left: 20px; font-size: 13px; }
  .bugs li { margin-bottom: 4px; }
  .media-section { margin-top: 16px; }
  .media-section h4 { font-size: 13px; color: var(--text-dim); margin-bottom: 8px; }
  .screenshots { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; }
  .screenshots figure { margin: 0; }
  .screenshots img { width: 100%; border-radius: 6px; border: 1px solid var(--border); cursor: pointer; transition: transform 0.2s; }
  .screenshots img.expanded { position: fixed; top: 5vh; left: 5vw; width: 90vw; height: 90vh; object-fit: contain;
    z-index: 1000; background: rgba(0,0,0,0.9); border: none; border-radius: 0; }
  .screenshots figcaption { font-size: 11px; color: var(--text-dim); margin-top: 4px; word-break: break-all; }
  .videos { display: grid; grid-template-columns: repeat(auto-fill, minmax(400px, 1fr)); gap: 12px; }
  .videos figure { margin: 0; }
  .videos video { width: 100%; border-radius: 6px; border: 1px solid var(--border); }
  .videos figcaption { font-size: 11px; color: var(--text-dim); margin-top: 4px; }
  .footer { margin-top: 32px; padding-top: 16px; border-top: 1px solid var(--border); font-size: 12px; color: var(--text-dim); text-align: center; }
</style>
</head>
<body>
<h1>QAgent Test Report</h1>
<p class="subtitle">${escapeHtml(summary.startedAt)} — ${summary.totalDurationSec.toFixed(1)}s</p>

<div class="metrics">
  <div class="metric">
    <div class="metric-value ${summary.passedStories === summary.totalStories ? 'pass' : 'fail'}">${summary.passedStories}/${summary.totalStories}</div>
    <div class="metric-label">Stories</div>
  </div>
  <div class="metric">
    <div class="metric-value ${summary.passedFeatures === summary.totalFeatures ? 'pass' : 'fail'}">${summary.passedFeatures}/${summary.totalFeatures}</div>
    <div class="metric-label">Features</div>
  </div>
  <div class="metric">
    <div class="metric-value">${summary.totalDurationSec.toFixed(1)}s</div>
    <div class="metric-label">Duration</div>
  </div>
  <div class="metric">
    <div class="metric-value">$${summary.totalCostUsd.toFixed(2)}</div>
    <div class="metric-label">Cost</div>
  </div>
</div>

${storyCards}

<div class="footer">Generated by <strong>qagent</strong></div>
</body>
</html>`

  const outputPath = resolve(resultsDir, 'index.html')
  await writeFile(outputPath, html, 'utf-8')
  console.log(`[report] HTML report written to ${outputPath}`)
  return outputPath
}
