#!/usr/bin/env node

/**
 * QAgent CLI wrapper — this file exists for one reason:
 *
 * Node.js cannot `import()` TypeScript files natively. User-defined hooks
 * (e.g. `.qagent/hooks/seed-db.ts`) are loaded at runtime via dynamic import.
 * By calling tsx's `register()` here — before anything else runs — we patch
 * Node's module loader so that `.ts` imports "just work" everywhere, without
 * any special handling in the hook loader or elsewhere.
 */
import { register } from 'tsx/esm/api'

register()
const { startCLI } = await import('../dist/cli.js')
startCLI()
