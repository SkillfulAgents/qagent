/**
 * Actual CLI entry point — invoked by qagent.mjs with tsx loader pre-registered.
 */
const { startCLI } = await import('../dist/cli.js')
startCLI()
