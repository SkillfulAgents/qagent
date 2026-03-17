# QAgent

An agentic E2E testing framework. An AI agent drives a real browser to test your application — no brittle selectors, no flaky waits. Describe features in markdown, define test stories in YAML, and let the agent explore.

## How It Works

```
stories/*.yaml          YAML test definitions (what to test)
       │
       ▼
  ┌──────────┐    features/*.md     system-prompt.md
  │  Runner   │◄── (UI specs)   ◄── (custom instructions)
  └────┬─────┘
       │  builds prompt
       ▼
  ┌──────────┐
  │  Driver   │──► spawns `claude` CLI with Playwright MCP
  └────┬─────┘
       │  structured output ([TEST_PASS], [BUG_FOUND], ...)
       ▼
  ┌──────────┐
  │  Parser   │──► results/summary.json + reports + screenshots + videos
  └──────────┘
```

The runner loads your YAML stories, builds tailored prompts for each test mode, spawns the Claude CLI with a Playwright MCP browser, and parses the structured output into machine-readable results.

## Quick Start

**Prerequisites:** Node.js >= 20, `claude` CLI installed and authenticated.

```bash
# 1. Install
npm install qagent

# 2. Create a project directory with a story
mkdir -p my-tests/stories my-tests/features

# 3. Write a story (my-tests/stories/smoke.yaml)
cat > my-tests/stories/smoke.yaml << 'EOF'
id: homepage-smoke
name: "Homepage smoke test"
mode: happy-path
steps: |
  1. Navigate to https://example.com
  2. Verify the page title is visible
  3. Take a screenshot
EOF

# 4. Run
npx qagent run --project-dir ./my-tests
```

## Project Structure

Create a project directory (defaults to `./qagent` or use `--project-dir`):

```
my-tests/
  stories/                      # required: YAML test stories (recursive)
    smoke.yaml
    detailed/                   # subdirectories for organization
      core.yaml
      integrations.yaml
  features/                     # optional: feature spec markdown files
    login.md
    dashboard.md
  hooks/                        # optional: lifecycle hook scripts
    seed-db.ts
  system-prompt.md              # optional: overrides built-in system prompt
  .env.local                    # optional: loaded into process.env
```

Stories are loaded recursively from `stories/`. Use subdirectories to organize tests — then filter by path:

```bash
# Run all stories under stories/detailed/
npx qagent run --project-dir ./my-tests --filter detailed/
```

## Story Format

Stories are YAML files in `stories/` (scanned recursively). Each file can contain one or multiple YAML documents.

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Unique identifier |
| `name` | string | yes | Human-readable name |
| `mode` | string | no | `happy-path` \| `feature-test` \| `chaos-monkey` (default: `feature-test`) |
| `features` | string[] | no | Feature names (map to `features/<name>.md`) |
| `steps` | string | no | Explicit steps for `happy-path` mode (multiline) |
| `baseUrl` | string | no | Override the CLI `--base-url` for this story |
| `setup` | string[] | no | Hook names to run before the test (from `hooks/`) |
| `teardown` | string[] | no | Hook names to run after the test (from `hooks/`) |

### Example: happy-path

```yaml
id: login-smoke
name: "Login happy path"
mode: happy-path
features:
  - login
steps: |
  1. Navigate to http://localhost:3000/login
  2. Type "user@test.com" into the email field
  3. Type "password123" into the password field
  4. Click the "Sign In" button
  5. Verify the dashboard is visible
```

### Example: feature-test

```yaml
id: dashboard-deep
name: "Dashboard deep test"
mode: feature-test
features:
  - dashboard
  - settings
setup:
  - seed-db
teardown:
  - cleanup-db
```

### Example: chaos-monkey

```yaml
id: chaos-hunt
name: "Bug hunting session"
mode: chaos-monkey
```

## Test Modes

### happy-path

The agent follows explicit steps precisely. Best for CI smoke tests where you want deterministic, repeatable checks.

- Requires `steps` field with numbered instructions
- `features` are optional (used as UI reference only)
- Agent executes steps exactly as written, reports any failures as bugs

### feature-test

The agent uses feature spec files as a guide, then explores beyond them. Best for deep feature verification.

- Requires `features` field pointing to `features/<name>.md` files
- Agent tests the complete surface area, not just the happy path
- Each feature is tested in a separate session with its own report

### chaos-monkey

The agent freely explores the application to find bugs. Best for fuzz testing and bug hunting.

- Loads all feature specs as reference (not a checklist)
- Runs in rounds — each round finds one bug, then continues
- Uses session resumption to maintain browser state across rounds
- Stops when no more bugs are found

## CLI Reference

```
qagent run [options]
```

| Flag | Description | Default |
|------|-------------|---------|
| `--filter <pattern>` | Filter stories by id, name, or path (substring) | — |
| `--verbose` | Show full agent output | `false` |
| `--retries <n>` | Max retries per feature | `1` |
| `--base-url <url>` | Application base URL | `http://localhost:3000` |
| `--target <web\|electron>` | Test target platform | `web` |
| `--model <model>` | Model to use | `sonnet` |
| `--budget <usd>` | Per-test spending cap in USD | `5` |
| `--project-dir <path>` | Path to project directory | `./qagent` |
| `--record` | Record video of browser sessions | `false` |
| `--append` | Append results instead of overwriting | `false` |
| `--upload` | Upload results to GitHub Artifacts | `false` |

## Hooks

Place `.ts` or `.js` files in `hooks/` that export a default async function:

```typescript
import type { SetupContext } from 'qagent'

export default async function(ctx: SetupContext): Promise<void> {
  // ctx.baseUrl    — the application URL
  // ctx.env        — process.env
  // ctx.store      — Map for sharing state between hooks
  // ctx.projectDir — path to the project directory

  await fetch(`${ctx.baseUrl}/api/seed`, { method: 'POST' })
}
```

Reference hooks by filename (without extension) in your story's `setup` and `teardown` arrays:

```yaml
setup:
  - seed-db
teardown:
  - cleanup-db
```

## Custom System Prompt

Create `system-prompt.md` in your project directory to **replace** the built-in system prompt entirely. The built-in default is minimal (`You are a QA automation engineer performing end-to-end tests via browser automation.`), so your custom version should include any role framing you want plus app-specific context:

```markdown
You are a QA automation engineer testing MyApp, a project management tool.

## Application Knowledge

- After login, wait for the dashboard skeleton to disappear before interacting.
- The sidebar is collapsible — click the hamburger icon to expand it.
- The app uses a custom date picker: click the input first, then select from the dropdown.
```

If no `system-prompt.md` exists in your project directory, the built-in default is used.

## Results & Artifacts

After a run, results are written to `<project-dir>/results/<run-id>/`:

```
results/
  commit_abc1234/                  # run ID (from git/CI or timestamp)
    summary.json                   # navigation index (pass/fail, paths, cost)
    happy-path/
      login-smoke/
        report.md                  # raw agent output (human-readable)
        report.json                # structured result (machine-readable)
        screenshots/               # captured during test
        videos/                    # recorded sessions (if --record)
    feature-test/
      dashboard-deep/
        dashboard/
          report.md
          report.json
          screenshots/
        settings/
          report.md
          report.json
    chaos-monkey/
      chaos-hunt/
        round-1/
          report.md
          report.json
          screenshots/
```

Each test produces three complementary files:

| File | Purpose | Consumer |
|------|---------|----------|
| `summary.json` | Lightweight index: lists all stories/features with pass/fail, duration (seconds), cost, and `reportPath` pointers | CI dashboards, scripts |
| `report.json` | Full structured result for one test: steps, bugs, reason, cost, sessionId | Programmatic analysis, diff |
| `report.md` | Raw agent output with full context | Human debugging, review |

Run IDs are derived automatically:
- **CI pull request:** `pr-123_base123_head456`
- **CI push:** `abc1234_def5678`
- **Local with git:** `commit_abc1234`
- **Local without git:** `local_2026-03-16_12-00-00`

## CI Integration

```yaml
# .github/workflows/e2e.yml
name: E2E Tests
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - run: npm start &  # start your app
      - run: npx qagent run --project-dir ./e2e --upload
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

The `--upload` flag uploads the results directory as a GitHub Actions artifact when running in CI.

## Configuration

### Environment Variables

Create `.env.local` in your project directory (or the working directory). Variables are loaded into `process.env` without overwriting existing values.

```
ANTHROPIC_API_KEY=sk-ant-...
APP_SECRET=test-secret
```

### Permissions

QAgent runs the Claude CLI with `--dangerously-skip-permissions` to enable fully non-interactive automation. This means the agent can invoke any MCP tool without manual confirmation. By default only Playwright browser tools are available, but if you provide a custom `mcpConfigPath` with additional MCP servers, be aware that the agent will have unrestricted access to all of them.

### Budget Control

Use `--budget <usd>` to set a per-test spending cap (default: `$5`).

## Programmatic API

```typescript
import { run, loadEnvFile, resolveProjectDir } from 'qagent'

const projectDir = resolveProjectDir('./my-tests')
loadEnvFile(projectDir)

const result = await run({
  projectDir,
  baseUrl: 'http://localhost:3000',
  target: 'web',
  verbose: false,
  maxRetries: 2,
})

console.log(`${result.passedStories}/${result.totalStories} stories passed`)
process.exit(result.failedStories > 0 ? 1 : 0)
```

## Bootstrap with AI

Don't want to write stories and feature specs by hand? Copy the contents of [`BOOTSTRAP.md`](./BOOTSTRAP.md) into your favorite AI assistant (Claude, GPT, Gemini, etc.), describe your application, and it will generate a complete qagent test configuration for you.
